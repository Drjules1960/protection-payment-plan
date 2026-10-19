// The Protection Plan's rules: who can do what to a job, and what money moves when.
const crypto = require('node:crypto');
const { tx } = require('./db');

// The plan's 2.5% service fee is split evenly: the homeowner pays 1.25% on top of
// the contract when they deposit, and 1.25% is taken from each draw to the contractor.
const FEE_RATE_EACH_SIDE = 0.0125;
const feeOf = (cents) => Math.round(cents * FEE_RATE_EACH_SIDE);

class UserError extends Error {}

function createServices(db, payments) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);

  // Serializes money-moving work per job so a double click can't pay twice.
  const locks = new Map();
  function withJobLock(jobId, fn) {
    const prev = locks.get(jobId) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    locks.set(jobId, next.finally(() => { if (locks.get(jobId) === next) locks.delete(jobId); }));
    return next;
  }

  const getJob = (id) => one('SELECT * FROM jobs WHERE id = ?', id);
  const getUser = (id) => one('SELECT * FROM users WHERE id = ?', id);
  const milestonesOf = (jobId) => all('SELECT * FROM milestones WHERE job_id = ? ORDER BY position', jobId);
  const getMilestone = (id) => one('SELECT * FROM milestones WHERE id = ?', id);
  const openDispute = (jobId) => one("SELECT * FROM disputes WHERE job_id = ? AND status = 'open'", jobId);
  const log = (jobId, who, text) => run('INSERT INTO activity (job_id, who, text) VALUES (?, ?, ?)', jobId, who, text);
  const ledger = (jobId, kind, direction, cents, party, reference) =>
    run('INSERT INTO ledger (job_id, kind, direction, amount_cents, party, reference) VALUES (?, ?, ?, ?, ?, ?)',
      jobId, kind, direction, cents, party, reference || null);
  const contractorName = (job) => {
    const c = getUser(job.contractor_id);
    return c.company || c.name;
  };

  function totals(job) {
    const ms = milestonesOf(job.id);
    const total = ms.reduce((a, m) => a + m.amount_cents, 0);
    const sum = (st) => ms.filter((m) => st.includes(m.status)).reduce((a, m) => a + m.amount_cents, 0);
    const paid = sum(['paid']);
    const refunded = sum(['refunded']);
    const funded = ['funded', 'disputed', 'complete', 'closed'].includes(job.status);
    const topups = one("SELECT COALESCE(SUM(amount_cents),0) AS c FROM payments WHERE job_id = ? AND kind = 'permit_topup' AND status = 'paid'", job.id).c;
    const permitFunded = funded ? job.permit_budget_cents + topups : 0;
    const permitReimbursed = one("SELECT COALESCE(SUM(fee_cents),0) AS c FROM permits WHERE job_id = ? AND status = 'reimbursed'", job.id).c;
    const permitOwed = one("SELECT COALESCE(SUM(fee_cents),0) AS c FROM permits WHERE job_id = ? AND status = 'waiting'", job.id).c;
    const permitRefunded = one("SELECT COALESCE(SUM(amount_cents),0) AS c FROM ledger WHERE job_id = ? AND kind = 'Permit fund refund'", job.id).c;
    return {
      total, paid, refunded,
      held: funded ? total - paid - refunded : 0,
      permitFunded, permitReimbursed, permitOwed,
      permitLeft: Math.max(0, permitFunded - permitReimbursed - permitRefunded),
      homeownerFee: feeOf(total),
    };
  }

  // A dispute on one step freezes only that step; a dispute on the whole job freezes all of it.
  function isFrozen(job, milestone) {
    const d = openDispute(job.id);
    return Boolean(d && (!d.milestone_id || d.milestone_id === milestone.id));
  }

  function canView(user, job) {
    if (!user || !job) return false;
    if (user.role === 'staff') return true;
    if (user.role === 'contractor') return job.contractor_id === user.id;
    if (user.role === 'homeowner') return job.homeowner_id === user.id;
    if (user.role === 'inspector') {
      return Boolean(one('SELECT 1 FROM milestones WHERE job_id = ? AND inspector_id = ?', job.id, user.id));
    }
    return false;
  }

  // ---------- jobs and invites ----------

  function createJob(contractor, input) {
    const title = (input.title || '').trim();
    const address = (input.address || '').trim();
    const homeownerName = (input.homeownerName || '').trim();
    const homeownerEmail = (input.homeownerEmail || '').trim().toLowerCase();
    if (!title || !address || !homeownerName || !homeownerEmail) throw new UserError('Fill in the job, address, and homeowner details.');
    const steps = (input.milestones || []).filter((m) => m.name && m.name.trim());
    if (steps.length === 0) throw new UserError('Add at least one payment step.');
    for (const s of steps) {
      if (!(s.cents > 0)) throw new UserError(`Give "${s.name}" an amount above $0.`);
      if (!['inspector', 'permit'].includes(s.proof)) throw new UserError('Choose who checks each step.');
    }
    if (!(input.permitBudgetCents >= 0)) throw new UserError('Permit fees must be $0 or more.');
    const token = crypto.randomBytes(18).toString('base64url');
    return tx(db, () => {
      const r = run(`INSERT INTO jobs (title, address, contractor_id, homeowner_name, homeowner_email, invite_token, permit_budget_cents)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, title, address, contractor.id, homeownerName, homeownerEmail, token, input.permitBudgetCents);
      const jobId = Number(r.lastInsertRowid);
      steps.forEach((s, i) => run('INSERT INTO milestones (job_id, position, name, amount_cents, proof) VALUES (?, ?, ?, ?, ?)',
        jobId, i + 1, s.name.trim(), s.cents, s.proof));
      log(jobId, contractor.company || contractor.name, `Offered the Protection Plan on this job and invited ${homeownerName}.`);
      return jobId;
    });
  }

  function acceptInvite(job, homeowner) {
    if (job.status !== 'invited') throw new UserError('This offer was already accepted.');
    if (job.homeowner_id && job.homeowner_id !== homeowner.id) throw new UserError('This offer belongs to another homeowner.');
    tx(db, () => {
      run("UPDATE jobs SET homeowner_id = ?, status = 'accepted' WHERE id = ?", homeowner.id, job.id);
      log(job.id, homeowner.name, `Accepted the contract and the ${milestonesOf(job.id).length}-step payment schedule.`);
    });
  }

  // ---------- homeowner payments ----------

  async function startDeposit(job, homeowner, baseUrl) {
    if (job.homeowner_id !== homeowner.id) throw new UserError('Only the homeowner on this job can deposit.');
    if (job.status !== 'accepted') throw new UserError('This job is not waiting for a deposit.');
    const t = totals(job);
    const amount = t.total + t.homeownerFee + job.permit_budget_cents;
    const r = run("INSERT INTO payments (job_id, kind, amount_cents, fee_cents) VALUES (?, 'deposit', ?, ?)", job.id, amount, t.homeownerFee);
    const payment = one('SELECT * FROM payments WHERE id = ?', r.lastInsertRowid);
    const lineItems = [
      { name: `${job.title}: project funds`, cents: t.total },
      { name: 'Protection Plan service fee (1.25%)', cents: t.homeownerFee },
    ];
    if (job.permit_budget_cents > 0) lineItems.push({ name: 'Permit fee fund (unused money comes back to you)', cents: job.permit_budget_cents });
    const { checkoutId, url } = await payments.startCheckout({
      payment, job, lineItems, email: homeowner.email,
      successUrl: `${baseUrl}/payments/${payment.id}/return`,
      cancelUrl: `${baseUrl}/jobs/${job.id}`,
    });
    run('UPDATE payments SET checkout_id = ? WHERE id = ?', checkoutId, payment.id);
    return url;
  }

  async function startPermitTopup(job, homeowner, baseUrl) {
    if (job.homeowner_id !== homeowner.id) throw new UserError('Only the homeowner on this job can add permit money.');
    const t = totals(job);
    const need = t.permitOwed - t.permitLeft;
    if (need <= 0) throw new UserError('The permit fund already covers every permit.');
    const r = run("INSERT INTO payments (job_id, kind, amount_cents) VALUES (?, 'permit_topup', ?)", job.id, need);
    const payment = one('SELECT * FROM payments WHERE id = ?', r.lastInsertRowid);
    const { checkoutId, url } = await payments.startCheckout({
      payment, job, email: homeowner.email,
      lineItems: [{ name: `${job.title}: permit fee top-up`, cents: need }],
      successUrl: `${baseUrl}/payments/${payment.id}/return`,
      cancelUrl: `${baseUrl}/jobs/${job.id}`,
    });
    run('UPDATE payments SET checkout_id = ? WHERE id = ?', checkoutId, payment.id);
    return url;
  }

  // Called from the checkout return page and from Stripe's webhook. Safe to call twice.
  async function confirmCheckout(checkoutId) {
    const payment = one('SELECT * FROM payments WHERE checkout_id = ?', checkoutId);
    if (!payment) return null;
    return withJobLock(payment.job_id, async () => {
      const fresh = one('SELECT * FROM payments WHERE id = ?', payment.id);
      if (fresh.status === 'paid') return fresh;
      const result = await payments.checkoutResult(checkoutId);
      if (!result) return fresh;
      const job = getJob(fresh.job_id);
      const homeowner = getUser(job.homeowner_id);
      tx(db, () => {
        run("UPDATE payments SET status = 'paid', payment_intent_id = ?, charge_id = ?, paid_at = datetime('now') WHERE id = ?",
          result.paymentIntentId, result.chargeId, fresh.id);
        if (fresh.kind === 'deposit') {
          const projectCents = fresh.amount_cents - fresh.fee_cents - job.permit_budget_cents;
          run("UPDATE jobs SET status = 'funded', funded_at = datetime('now') WHERE id = ?", job.id);
          ledger(job.id, 'Project deposit', 'in', projectCents, `From ${homeowner.name}`, result.paymentIntentId);
          ledger(job.id, 'Service fee (homeowner)', 'fee', fresh.fee_cents, `From ${homeowner.name}`, result.paymentIntentId);
          if (job.permit_budget_cents) ledger(job.id, 'Permit fund deposit', 'in', job.permit_budget_cents, `From ${homeowner.name}`, result.paymentIntentId);
          log(job.id, homeowner.name, `Deposited ${usd(projectCents)} in project funds${job.permit_budget_cents ? ` plus ${usd(job.permit_budget_cents)} for permit fees` : ''}. The money is secured.`);
        } else {
          ledger(job.id, 'Permit fund deposit', 'in', fresh.amount_cents, `From ${homeowner.name}`, result.paymentIntentId);
          log(job.id, homeowner.name, `Added ${usd(fresh.amount_cents)} to the permit fund.`);
        }
      });
      await reimbursePermitsLocked(getJob(job.id));
      return one('SELECT * FROM payments WHERE id = ?', fresh.id);
    });
  }

  // Picks a homeowner payment that still has room to fund a transfer of `cents`.
  function sourcePaymentFor(jobId, cents) {
    return all("SELECT * FROM payments WHERE job_id = ? AND status = 'paid' ORDER BY id", jobId)
      .find((p) => p.amount_cents - p.transferred_cents - p.refunded_cents >= cents);
  }

  async function refundHomeowner(job, cents, label) {
    let left = cents;
    const paid = all("SELECT * FROM payments WHERE job_id = ? AND status = 'paid' ORDER BY id DESC", job.id);
    const homeowner = getUser(job.homeowner_id);
    for (const p of paid) {
      if (left <= 0) break;
      const room = p.amount_cents - p.transferred_cents - p.refunded_cents;
      const take = Math.min(room, left);
      if (take <= 0) continue;
      const refundId = await payments.refund({
        paymentIntentId: p.payment_intent_id, cents: take,
        idempotencyKey: `refund-${label.replace(/\W+/g, '-')}-job${job.id}-pay${p.id}-${p.refunded_cents}`,
      });
      tx(db, () => {
        run('UPDATE payments SET refunded_cents = refunded_cents + ? WHERE id = ?', take, p.id);
        ledger(job.id, label, 'out', take, `To ${homeowner.name}`, refundId);
      });
      left -= take;
    }
    if (left > 0) throw new Error(`Could not refund ${usd(left)} for job ${job.id}`);
  }

  // ---------- permits ----------

  function recordPermit(contractor, job, { permitNo, description, feeCents }) {
    if (job.contractor_id !== contractor.id) throw new UserError('Only this job\'s contractor can record permits.');
    if (!['funded', 'disputed'].includes(job.status)) throw new UserError('Permits can be recorded once the job is funded.');
    if (!permitNo || !description || !(feeCents > 0)) throw new UserError('Enter the permit number, what it covers, and the fee you paid.');
    run('INSERT INTO permits (job_id, permit_no, description, fee_cents) VALUES (?, ?, ?, ?)', job.id, permitNo.trim(), description.trim(), feeCents);
    log(job.id, contractorName(job), `Pulled permit ${permitNo.trim()} (${description.trim()}) and paid the ${usd(feeCents)} fee.`);
    return withJobLock(job.id, () => reimbursePermitsLocked(getJob(job.id)));
  }

  // Pays the contractor back for permit fees out of the homeowner's permit fund.
  async function reimbursePermitsLocked(job) {
    const contractor = getUser(job.contractor_id);
    if (!contractor.payouts_ready) return;
    for (const pm of all("SELECT * FROM permits WHERE job_id = ? AND status = 'waiting' ORDER BY id", job.id)) {
      if (totals(job).permitLeft < pm.fee_cents) break;
      const source = sourcePaymentFor(job.id, pm.fee_cents);
      if (!source) break;
      const transferId = await payments.transfer({
        accountId: contractor.stripe_account_id, cents: pm.fee_cents, chargeId: source.charge_id, jobId: job.id,
        idempotencyKey: `permit-${pm.id}`, description: `Permit ${pm.permit_no} fee reimbursement`,
      });
      tx(db, () => {
        run("UPDATE permits SET status = 'reimbursed', transfer_id = ? WHERE id = ?", transferId, pm.id);
        run('UPDATE payments SET transferred_cents = transferred_cents + ? WHERE id = ?', pm.fee_cents, source.id);
        ledger(job.id, 'Permit fee reimbursed', 'out', pm.fee_cents, `To ${contractorName(job)}`, transferId);
        log(job.id, 'Protection Plan', `Paid ${contractorName(job)} back ${usd(pm.fee_cents)} for permit ${pm.permit_no} from the homeowner's permit fund.`);
      });
    }
  }

  // ---------- draws ----------

  function submitProof(contractor, job, milestone, { note, permitNo, photoFiles }) {
    if (job.contractor_id !== contractor.id) throw new UserError('Only this job\'s contractor can request a draw.');
    if (!['funded', 'disputed'].includes(job.status)) throw new UserError('You can request draws once the homeowner has deposited the project funds.');
    if (!['upcoming', 'changes'].includes(milestone.status)) throw new UserError('This step was already submitted.');
    if (!photoFiles.length) throw new UserError('Add at least one progress photo.');
    if (milestone.proof === 'permit' && !(permitNo || milestone.permit_no)) throw new UserError('Enter the permit number so we can check the inspection result.');
    tx(db, () => {
      for (const f of photoFiles) run('INSERT INTO photos (milestone_id, filename) VALUES (?, ?)', milestone.id, f);
      run(`UPDATE milestones SET status = 'submitted', note = ?, permit_no = COALESCE(?, permit_no), result_note = NULL,
        inspector_id = NULL, inspection_date = NULL, submitted_at = datetime('now') WHERE id = ?`,
        note || null, permitNo || null, milestone.id);
      log(job.id, contractorName(job), `Submitted ${photoFiles.length} photo${photoFiles.length === 1 ? '' : 's'} for "${milestone.name}" and asked for the ${usd(milestone.amount_cents)} draw.`);
    });
  }

  function assignInspector(staff, job, milestone, inspectorId, date) {
    if (staff.role !== 'staff') throw new UserError('Only staff can assign inspectors.');
    if (!['submitted', 'inspection'].includes(milestone.status)) throw new UserError('This step is not waiting for a check.');
    const inspector = getUser(inspectorId);
    if (!inspector || inspector.role !== 'inspector') throw new UserError('Choose an inspector.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new UserError('Choose a visit date.');
    tx(db, () => {
      run("UPDATE milestones SET status = 'inspection', inspector_id = ?, inspection_date = ? WHERE id = ?", inspector.id, date, milestone.id);
      log(job.id, 'Protection Plan', `Assigned ${inspector.name}${inspector.company ? ` (${inspector.company})` : ''} to inspect "${milestone.name}" on ${date}.`);
    });
  }

  // The only ways a step gets approved: an assigned independent inspector, or
  // staff recording what the permit office's own record shows.
  async function recordCheck(user, job, milestone, { passed, note }) {
    let who;
    if (milestone.proof === 'inspector') {
      if (user.role !== 'inspector' || milestone.inspector_id !== user.id || milestone.status !== 'inspection') {
        throw new UserError('Only the inspector assigned to this step can record the result.');
      }
      who = `${user.name}${user.company ? `, ${user.company}` : ''}`;
    } else {
      if (user.role !== 'staff' || milestone.status !== 'submitted') throw new UserError('Only staff can record a permit office result.');
      who = `Permit office record (entered by ${user.name})`;
    }
    if (!note || !note.trim()) throw new UserError('Add a short note about what was checked.');
    if (passed && isFrozen(job, milestone)) throw new UserError('This step is in dispute, so its money stays on hold.');
    const kind = milestone.proof === 'permit' ? 'Permit inspection' : 'Independent inspection';
    if (!passed) {
      tx(db, () => {
        run("UPDATE milestones SET status = 'changes', result_note = ? WHERE id = ?", note.trim(), milestone.id);
        log(job.id, who, `${kind} did not pass for "${milestone.name}": ${note.trim()}`);
      });
      return;
    }
    tx(db, () => {
      run("UPDATE milestones SET status = 'approved', verified_by = ?, result_note = ? WHERE id = ?", who, note.trim(), milestone.id);
      log(job.id, who, `${kind} passed for "${milestone.name}".`);
    });
    await payOut(job.id, milestone.id);
  }

  // Sends an approved step's money to the contractor. If the contractor hasn't
  // finished payout setup, the step stays approved and staff can retry later.
  function payOut(jobId, milestoneId) {
    return withJobLock(jobId, async () => {
      const job = getJob(jobId);
      const m = getMilestone(milestoneId);
      if (m.status !== 'approved') return false;
      const contractor = getUser(job.contractor_id);
      if (!contractor.stripe_account_id || !contractor.payouts_ready) {
        log(job.id, 'Protection Plan', `"${m.name}" passed, but ${contractorName(job)} hasn't finished payout setup. The money is paid as soon as they do.`);
        return false;
      }
      const fee = feeOf(m.amount_cents);
      const net = m.amount_cents - fee;
      const source = sourcePaymentFor(job.id, net);
      if (!source) throw new Error(`No homeowner payment can fund milestone ${m.id}`);
      const transferId = await payments.transfer({
        accountId: contractor.stripe_account_id, cents: net, chargeId: source.charge_id, jobId: job.id,
        idempotencyKey: `milestone-${m.id}`, description: `${job.title}: ${m.name}`,
      });
      tx(db, () => {
        run("UPDATE milestones SET status = 'paid', transfer_id = ?, paid_at = datetime('now') WHERE id = ?", transferId, m.id);
        run('UPDATE payments SET transferred_cents = transferred_cents + ? WHERE id = ?', net, source.id);
        ledger(job.id, 'Draw paid', 'out', net, `To ${contractorName(job)}`, transferId);
        ledger(job.id, 'Service fee (contractor)', 'fee', fee, `From ${contractorName(job)}'s draw`, transferId);
        log(job.id, 'Protection Plan', `Paid ${contractorName(job)} ${usd(net)} for "${m.name}" (${usd(m.amount_cents)} less the ${usd(fee)} service fee).`);
      });
      await finishIfDone(getJob(job.id));
      return true;
    });
  }

  async function finishIfDone(job) {
    const ms = milestonesOf(job.id);
    if (job.status !== 'funded' || !ms.every((m) => ['paid', 'refunded'].includes(m.status))) return;
    const t = totals(job);
    if (t.permitOwed > 0) return; // wait until every permit fee is settled
    if (t.permitLeft > 0) await refundHomeowner(job, t.permitLeft, 'Permit fund refund');
    tx(db, () => {
      run("UPDATE jobs SET status = 'complete' WHERE id = ?", job.id);
      log(job.id, 'Protection Plan', `Every step is paid. Job complete${t.permitLeft ? `, and ${usd(t.permitLeft)} of unused permit money went back to the homeowner` : ''}.`);
    });
  }

  // ---------- disputes ----------

  function raiseDispute(user, job, milestoneId, reason) {
    if (!['homeowner', 'contractor'].includes(user.role) || !canView(user, job)) throw new UserError('Only the homeowner or contractor can report a problem.');
    if (!['funded', 'disputed'].includes(job.status)) throw new UserError('Problems can be reported once the job is funded.');
    if (openDispute(job.id)) throw new UserError('There is already an open dispute on this job.');
    if (!reason || !reason.trim()) throw new UserError('Tell us what is wrong.');
    const m = milestoneId ? getMilestone(milestoneId) : null;
    if (m && (m.job_id !== job.id || ['paid', 'refunded'].includes(m.status))) throw new UserError('That step can no longer be disputed.');
    tx(db, () => {
      run('INSERT INTO disputes (job_id, milestone_id, raised_by, reason) VALUES (?, ?, ?, ?)', job.id, m ? m.id : null, user.id, reason.trim());
      run("UPDATE jobs SET status = 'disputed' WHERE id = ?", job.id);
      log(job.id, user.role === 'contractor' ? contractorName(job) : user.name,
        m ? `Reported a problem with "${m.name}". That step's money is on hold.` : 'Reported a problem with the job. All payments are on hold.');
    });
  }

  async function resolveDispute(staff, dispute, outcome) {
    if (staff.role !== 'staff') throw new UserError('Only staff can decide disputes.');
    if (dispute.status !== 'open') throw new UserError('This dispute is already closed.');
    const job = getJob(dispute.job_id);
    const close = (text, jobStatus) => tx(db, () => {
      run("UPDATE disputes SET status = 'resolved', outcome = ?, resolved_at = datetime('now') WHERE id = ?", outcome, dispute.id);
      if (jobStatus) run('UPDATE jobs SET status = ? WHERE id = ?', jobStatus, job.id);
      log(job.id, 'Protection Plan', text);
    });

    if (outcome === 'resume') {
      close('Dispute settled by agreement. Work and payments continue.', 'funded');
    } else if (outcome === 'pay') {
      const m = dispute.milestone_id && getMilestone(dispute.milestone_id);
      if (!m || ['paid', 'refunded'].includes(m.status)) throw new UserError('There is no unpaid step on this dispute to pay.');
      close(`Dispute decided for the contractor after an independent inspection. "${m.name}" is approved.`, 'funded');
      run("UPDATE milestones SET status = 'approved', verified_by = 'Dispute decision' WHERE id = ?", m.id);
      await payOut(job.id, m.id);
    } else if (outcome === 'refund') {
      await withJobLock(job.id, async () => {
        // Permit fees the contractor already paid are theirs to get back first.
        await reimbursePermitsLocked(getJob(job.id));
        const t = totals(getJob(job.id));
        const amount = t.held + t.permitLeft;
        if (amount > 0) await refundHomeowner(job, amount, 'Refund to homeowner');
        run("UPDATE milestones SET status = 'refunded' WHERE job_id = ? AND status <> 'paid'", job.id);
        close(`Dispute decided for the homeowner. Refunded ${usd(amount)} to ${getUser(job.homeowner_id).name}. Job closed.`, 'closed');
      });
    } else {
      throw new UserError('Unknown decision.');
    }
  }

  // ---------- contractor payouts ----------

  async function refreshPayoutStatus(user) {
    if (!user.stripe_account_id) return false;
    const ready = await payments.payoutsReady(user.stripe_account_id);
    run('UPDATE users SET payouts_ready = ? WHERE id = ?', ready ? 1 : 0, user.id);
    if (ready) {
      // Pay anything that passed while setup was unfinished.
      const waiting = all(`SELECT m.id, m.job_id FROM milestones m JOIN jobs j ON j.id = m.job_id
        WHERE j.contractor_id = ? AND m.status = 'approved'`, user.id);
      for (const w of waiting) await payOut(w.job_id, w.id);
      for (const j of all("SELECT * FROM jobs WHERE contractor_id = ? AND status IN ('funded','disputed')", user.id)) {
        await withJobLock(j.id, () => reimbursePermitsLocked(getJob(j.id)));
      }
    }
    return ready;
  }

  return {
    totals, isFrozen, canView, getJob, getUser, milestonesOf, getMilestone, openDispute,
    createJob, acceptInvite, startDeposit, startPermitTopup, confirmCheckout,
    recordPermit, submitProof, assignInspector, recordCheck, payOut,
    raiseDispute, resolveDispute, refreshPayoutStatus,
  };
}

function usd(cents) {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

module.exports = { createServices, UserError, feeOf, usd, FEE_RATE_EACH_SIDE };
