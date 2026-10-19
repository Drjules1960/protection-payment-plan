const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const multer = require('multer');
const { createServices, UserError, usd, feeOf } = require('./services');
const { hashPassword, checkPassword } = require('./auth');

const APP_NAME = 'North Carolina Contractors and Homeowners Protection Payment Plan';

// Turns "12,500.50" or "$12500" into cents. Returns NaN for anything else.
function toCents(v) {
  const s = String(v ?? '').replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100);
}

function createApp({ db, payments, uploadDir, sessionSecret, baseUrl }) {
  const svc = createServices(db, payments);
  const app = express();
  fs.mkdirSync(uploadDir, { recursive: true });

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', 1);

  // Stripe needs the untouched body to check the webhook signature.
  app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    let event;
    try {
      event = payments.parseWebhook(req.body, req.get('stripe-signature'));
    } catch (e) {
      return res.status(400).send(`Webhook error: ${e.message}`);
    }
    try {
      if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        await svc.confirmCheckout(event.data.object.id);
      } else if (event.type === 'account.updated') {
        const user = db.prepare('SELECT * FROM users WHERE stripe_account_id = ?').get(event.data.object.id);
        if (user) await svc.refreshPayoutStatus(user);
      }
      res.json({ received: true });
    } catch (e) {
      console.error('Webhook handling failed', e);
      res.status(500).send('Webhook handling failed');
    }
  });

  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(cookieSession({
    name: 'ppp',
    secret: sessionSecret,
    sameSite: 'lax',
    httpOnly: true,
    secure: baseUrl.startsWith('https://'),
    maxAge: 1000 * 60 * 60 * 24 * 14,
  }));

  app.use((req, res, next) => {
    req.user = req.session.userId ? svc.getUser(req.session.userId) : null;
    res.locals.user = req.user;
    res.locals.appName = APP_NAME;
    res.locals.usd = usd;
    res.locals.paymentMode = payments.mode;
    res.locals.flash = req.session.flash || null;
    req.session.flash = null;
    next();
  });

  const flash = (req, kind, text) => { req.session.flash = { kind, text }; };
  const needLogin = (req, res, next) => (req.user ? next() : res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`));
  const needRole = (...roles) => (req, res, next) => {
    if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    if (!roles.includes(req.user.role)) return res.status(403).render('message', { title: 'Not allowed', text: 'Your account can\'t open this page.' });
    next();
  };
  // Wraps a POST handler so a UserError shows as a message on the job page.
  const action = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (!(e instanceof UserError)) return next(e);
      flash(req, 'bad', e.message);
      res.redirect(req.get('referer') || '/dashboard');
    }
  };
  function loadJob(req, res, next) {
    const job = svc.getJob(Number(req.params.id));
    if (!job || !svc.canView(req.user, job)) return res.status(404).render('message', { title: 'Not found', text: 'We couldn\'t find that job.' });
    req.job = job;
    next();
  }
  function loadMilestone(req, res, next) {
    const m = svc.getMilestone(Number(req.params.id));
    const job = m && svc.getJob(m.job_id);
    if (!job || !svc.canView(req.user, job)) return res.status(404).render('message', { title: 'Not found', text: 'We couldn\'t find that step.' });
    req.milestone = m;
    req.job = job;
    next();
  }

  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + (path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg')),
    }),
    limits: { fileSize: 10 * 1024 * 1024, files: 10 },
    fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|heic|heif|gif)$/.test(file.mimetype)),
  });

  // ---------- accounts ----------

  app.get('/', (req, res) => (req.user ? res.redirect('/dashboard') : res.render('home')));

  app.get('/login', (req, res) => res.render('login', { next: req.query.next || '/dashboard', email: '' }));
  app.post('/login', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const next = String(req.body.next || '/dashboard');
    if (!user || !checkPassword(String(req.body.password || ''), user.password_hash)) {
      return res.status(401).render('login', { next, email, error: 'That email and password don\'t match an account.' });
    }
    req.session.userId = user.id;
    res.redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard');
  });
  app.post('/logout', (req, res) => { req.session = null; res.redirect('/'); });

  app.get('/signup', (req, res) => res.render('signup', { form: {} }));
  app.post('/signup', (req, res) => {
    const f = {
      name: String(req.body.name || '').trim(), company: String(req.body.company || '').trim(),
      license: String(req.body.license || '').trim(), email: String(req.body.email || '').trim().toLowerCase(),
    };
    const password = String(req.body.password || '');
    let error;
    if (!f.name || !f.company || !f.license || !f.email) error = 'Fill in every field.';
    else if (password.length < 8) error = 'Use a password with at least 8 characters.';
    else if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(f.email)) error = 'There is already an account with that email. Try logging in.';
    if (error) return res.status(400).render('signup', { form: f, error });
    const r = db.prepare("INSERT INTO users (email, name, password_hash, role, company, license_no) VALUES (?, ?, ?, 'contractor', ?, ?)")
      .run(f.email, f.name, hashPassword(password), f.company, f.license);
    req.session.userId = Number(r.lastInsertRowid);
    flash(req, 'ok', 'Your contractor account is ready. Next, set up payouts so you can get paid.');
    res.redirect('/payouts');
  });

  // Homeowners arrive through the invite link their contractor sends them.
  app.get('/invite/:token', (req, res) => {
    const job = db.prepare('SELECT * FROM jobs WHERE invite_token = ?').get(req.params.token);
    if (!job) return res.status(404).render('message', { title: 'Invite not found', text: 'This invite link isn\'t valid. Ask your contractor to send it again.' });
    if (req.user && req.user.role === 'homeowner') {
      if (!job.homeowner_id) db.prepare('UPDATE jobs SET homeowner_id = ? WHERE id = ?').run(req.user.id, job.id);
      if (!job.homeowner_id || job.homeowner_id === req.user.id) return res.redirect(`/jobs/${job.id}`);
      return res.status(403).render('message', { title: 'Invite already used', text: 'Another homeowner account already accepted this invite. Ask your contractor to check it.' });
    }
    if (job.homeowner_id && !req.user) return res.redirect(`/login?next=${encodeURIComponent(`/jobs/${job.id}`)}`);
    const contractor = svc.getUser(job.contractor_id);
    res.render('invite', { job, contractor, milestones: svc.milestonesOf(job.id), totals: svc.totals(job), form: { name: job.homeowner_name, email: job.homeowner_email } });
  });
  app.post('/invite/:token', (req, res) => {
    const job = db.prepare('SELECT * FROM jobs WHERE invite_token = ?').get(req.params.token);
    if (!job || job.homeowner_id) return res.redirect(`/invite/${req.params.token}`);
    const form = { name: String(req.body.name || '').trim(), email: String(req.body.email || '').trim().toLowerCase() };
    const password = String(req.body.password || '');
    let error;
    if (!form.name || !form.email) error = 'Enter your name and email.';
    else if (password.length < 8) error = 'Use a password with at least 8 characters.';
    else if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(form.email)) error = 'There is already an account with that email. Log in instead, then open the invite link again.';
    if (error) {
      return res.status(400).render('invite', { job, contractor: svc.getUser(job.contractor_id), milestones: svc.milestonesOf(job.id), totals: svc.totals(job), form, error });
    }
    const r = db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'homeowner')").run(form.email, form.name, hashPassword(password));
    const userId = Number(r.lastInsertRowid);
    db.prepare('UPDATE jobs SET homeowner_id = ? WHERE id = ?').run(userId, job.id);
    req.session.userId = userId;
    res.redirect(`/jobs/${job.id}`);
  });

  // ---------- dashboard ----------

  app.get('/dashboard', needLogin, (req, res) => {
    const u = req.user;
    let jobs;
    if (u.role === 'contractor') jobs = db.prepare('SELECT * FROM jobs WHERE contractor_id = ? ORDER BY id DESC').all(u.id);
    else if (u.role === 'homeowner') jobs = db.prepare('SELECT * FROM jobs WHERE homeowner_id = ? ORDER BY id DESC').all(u.id);
    else if (u.role === 'inspector') jobs = db.prepare('SELECT DISTINCT j.* FROM jobs j JOIN milestones m ON m.job_id = j.id WHERE m.inspector_id = ? ORDER BY j.id DESC').all(u.id);
    else jobs = db.prepare('SELECT * FROM jobs ORDER BY id DESC').all();
    const cards = jobs.map((j) => ({ job: j, totals: svc.totals(j), contractor: svc.getUser(j.contractor_id) }));
    const queue = u.role === 'staff'
      ? db.prepare(`SELECT m.*, j.title AS job_title, j.address FROM milestones m JOIN jobs j ON j.id = m.job_id
          WHERE m.status IN ('submitted','inspection','approved') ORDER BY m.submitted_at`).all()
      : [];
    const inspections = u.role === 'inspector'
      ? db.prepare(`SELECT m.*, j.title AS job_title, j.address FROM milestones m JOIN jobs j ON j.id = m.job_id
          WHERE m.inspector_id = ? ORDER BY m.status = 'inspection' DESC, m.inspection_date`).all(u.id)
      : [];
    const disputes = u.role === 'staff'
      ? db.prepare("SELECT d.*, j.title AS job_title FROM disputes d JOIN jobs j ON j.id = d.job_id WHERE d.status = 'open'").all()
      : [];
    res.render('dashboard', { cards, queue, inspections, disputes });
  });

  // ---------- jobs ----------

  app.get('/jobs/new', needRole('contractor'), (req, res) => res.render('job-new', { form: null }));
  app.post('/jobs', needRole('contractor'), (req, res) => {
    const names = [].concat(req.body.step_name || []);
    const amounts = [].concat(req.body.step_amount || []);
    const proofs = [].concat(req.body.step_proof || []);
    const input = {
      title: req.body.title, address: req.body.address,
      homeownerName: req.body.homeowner_name, homeownerEmail: req.body.homeowner_email,
      permitBudgetCents: req.body.permit_budget ? toCents(req.body.permit_budget) : 0,
      milestones: names.map((n, i) => ({ name: n, cents: toCents(amounts[i]), proof: proofs[i] })),
    };
    try {
      const id = svc.createJob(req.user, input);
      flash(req, 'ok', 'Offer created. Copy the invite link below and send it to your homeowner.');
      res.redirect(`/jobs/${id}`);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      res.status(400).render('job-new', { form: { ...req.body, steps: names.map((n, i) => ({ name: n, amount: amounts[i], proof: proofs[i] })) }, error: e.message });
    }
  });

  app.get('/jobs/:id', needLogin, loadJob, (req, res) => {
    const job = req.job;
    const milestones = svc.milestonesOf(job.id).map((m) => ({
      ...m,
      photos: db.prepare('SELECT * FROM photos WHERE milestone_id = ? ORDER BY id').all(m.id),
      inspector: m.inspector_id ? svc.getUser(m.inspector_id) : null,
      frozen: svc.isFrozen(job, m),
    }));
    res.render('job', {
      job, milestones,
      totals: svc.totals(job),
      contractor: svc.getUser(job.contractor_id),
      homeowner: job.homeowner_id ? svc.getUser(job.homeowner_id) : null,
      permits: db.prepare('SELECT * FROM permits WHERE job_id = ? ORDER BY id').all(job.id),
      dispute: svc.openDispute(job.id),
      activity: db.prepare('SELECT * FROM activity WHERE job_id = ? ORDER BY id DESC').all(job.id),
      inspectors: req.user.role === 'staff' ? db.prepare("SELECT * FROM users WHERE role = 'inspector' ORDER BY name").all() : [],
      inviteUrl: `${baseUrl}/invite/${job.invite_token}`,
      feeOf,
    });
  });

  app.post('/jobs/:id/accept', needRole('homeowner'), loadJob, action(async (req, res) => {
    svc.acceptInvite(req.job, req.user);
    res.redirect(`/jobs/${req.job.id}`);
  }));
  app.post('/jobs/:id/deposit', needRole('homeowner'), loadJob, action(async (req, res) => {
    res.redirect(303, await svc.startDeposit(req.job, req.user, baseUrl));
  }));
  app.post('/jobs/:id/permit-topup', needRole('homeowner'), loadJob, action(async (req, res) => {
    res.redirect(303, await svc.startPermitTopup(req.job, req.user, baseUrl));
  }));
  app.post('/jobs/:id/permits', needRole('contractor'), loadJob, action(async (req, res) => {
    await svc.recordPermit(req.user, req.job, {
      permitNo: String(req.body.permit_no || ''), description: String(req.body.description || ''), feeCents: toCents(req.body.fee),
    });
    flash(req, 'ok', 'Permit recorded. Its fee is paid back to you from the homeowner\'s permit fund.');
    res.redirect(`/jobs/${req.job.id}`);
  }));
  app.post('/jobs/:id/dispute', needRole('homeowner', 'contractor'), loadJob, action(async (req, res) => {
    svc.raiseDispute(req.user, req.job, req.body.milestone_id ? Number(req.body.milestone_id) : null, String(req.body.reason || ''));
    flash(req, 'ok', 'We\'ve put that money on hold and our team will follow up with both sides.');
    res.redirect(`/jobs/${req.job.id}`);
  }));

  app.post('/milestones/:id/proof', needRole('contractor'), loadMilestone, upload.array('photos', 10), action(async (req, res) => {
    const files = (req.files || []).map((f) => f.filename);
    try {
      svc.submitProof(req.user, req.job, req.milestone, {
        note: String(req.body.note || '').trim(), permitNo: String(req.body.permit_no || '').trim() || null, photoFiles: files,
      });
    } catch (e) {
      for (const f of files) fs.rm(path.join(uploadDir, f), () => {});
      throw e;
    }
    flash(req, 'ok', 'Submitted. You\'re paid as soon as the check passes.');
    res.redirect(`/jobs/${req.job.id}`);
  }));
  app.post('/milestones/:id/assign', needRole('staff'), loadMilestone, action(async (req, res) => {
    svc.assignInspector(req.user, req.job, req.milestone, Number(req.body.inspector_id), String(req.body.date || ''));
    res.redirect(`/jobs/${req.job.id}`);
  }));
  app.post('/milestones/:id/check', needRole('staff', 'inspector'), loadMilestone, action(async (req, res) => {
    await svc.recordCheck(req.user, req.job, req.milestone, { passed: req.body.result === 'pass', note: String(req.body.note || '') });
    res.redirect(`/jobs/${req.job.id}`);
  }));
  app.post('/milestones/:id/retry-payout', needRole('staff'), loadMilestone, action(async (req, res) => {
    const contractor = svc.getUser(req.job.contractor_id);
    await svc.refreshPayoutStatus(contractor);
    if (!(await svc.payOut(req.job.id, req.milestone.id)) && svc.getMilestone(req.milestone.id).status !== 'paid') {
      flash(req, 'bad', 'The contractor still needs to finish payout setup.');
    }
    res.redirect(`/jobs/${req.job.id}`);
  }));
  app.post('/disputes/:id/resolve', needRole('staff'), action(async (req, res) => {
    const d = db.prepare('SELECT * FROM disputes WHERE id = ?').get(Number(req.params.id));
    if (!d) throw new UserError('Dispute not found.');
    await svc.resolveDispute(req.user, d, String(req.body.outcome || ''));
    res.redirect(`/jobs/${d.job_id}`);
  }));

  // Progress photos are only shown to people on the job.
  app.get('/photos/:id', needLogin, (req, res) => {
    const p = db.prepare('SELECT p.*, m.job_id FROM photos p JOIN milestones m ON m.id = p.milestone_id WHERE p.id = ?').get(Number(req.params.id));
    if (!p || !svc.canView(req.user, svc.getJob(p.job_id))) return res.sendStatus(404);
    res.sendFile(path.join(path.resolve(uploadDir), path.basename(p.filename)));
  });

  // ---------- payments ----------

  app.get('/payments/:id/return', needLogin, async (req, res, next) => {
    try {
      const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(req.params.id));
      if (!p || !svc.canView(req.user, svc.getJob(p.job_id))) return res.redirect('/dashboard');
      const done = await svc.confirmCheckout(p.checkout_id);
      flash(req, done && done.status === 'paid' ? 'ok' : 'info', done && done.status === 'paid'
        ? 'Payment received. Your money is secured and is only paid out as each step passes its check.'
        : 'Your payment is processing. Bank transfers can take a few business days, and this page updates when it clears.');
      res.redirect(`/jobs/${p.job_id}`);
    } catch (e) { next(e); }
  });

  if (payments.mode === 'simulated') {
    app.get('/simulate/checkout/:id', needRole('homeowner'), (req, res) => {
      const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(req.params.id));
      if (!p || p.checkout_id !== req.query.session_id) return res.sendStatus(404);
      res.render('simulated-checkout', { payment: p, job: svc.getJob(p.job_id) });
    });
    app.post('/simulate/checkout/:id', needRole('homeowner'), (req, res) => {
      const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(req.params.id));
      if (!p) return res.sendStatus(404);
      payments.markCheckoutPaid(p.checkout_id);
      res.redirect(`/payments/${p.id}/return?session_id=${p.checkout_id}`);
    });
  }

  // ---------- contractor payouts ----------

  app.get('/payouts', needRole('contractor'), (req, res) => res.render('payouts'));
  app.post('/payouts/setup', needRole('contractor'), action(async (req, res) => {
    const { accountId, url } = await payments.onboardingLink(req.user, {
      returnUrl: `${baseUrl}/payouts/return`, refreshUrl: `${baseUrl}/payouts`,
    });
    db.prepare('UPDATE users SET stripe_account_id = ? WHERE id = ?').run(accountId, req.user.id);
    res.redirect(303, url);
  }));
  app.get('/payouts/return', needRole('contractor'), async (req, res, next) => {
    try {
      const ready = await svc.refreshPayoutStatus(svc.getUser(req.user.id));
      flash(req, ready ? 'ok' : 'info', ready ? 'Payouts are set up. Draws go straight to your bank account.' : 'Stripe still needs a few details from you before payouts can start.');
      res.redirect('/payouts');
    } catch (e) { next(e); }
  });

  // ---------- staff ----------

  app.get('/staff/team', needRole('staff'), (req, res) => {
    res.render('team', {
      inspectors: db.prepare("SELECT * FROM users WHERE role = 'inspector' ORDER BY name").all(),
      contractors: db.prepare("SELECT * FROM users WHERE role = 'contractor' ORDER BY company").all(),
      created: null,
    });
  });
  app.post('/staff/inspectors', needRole('staff'), (req, res) => {
    const name = String(req.body.name || '').trim();
    const company = String(req.body.company || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const reload = (extra) => res.render('team', {
      inspectors: db.prepare("SELECT * FROM users WHERE role = 'inspector' ORDER BY name").all(),
      contractors: db.prepare("SELECT * FROM users WHERE role = 'contractor' ORDER BY company").all(),
      created: null, ...extra,
    });
    if (!name || !email) return reload({ error: 'Enter the inspector\'s name and email.' });
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return reload({ error: 'That email already has an account.' });
    const tempPassword = crypto.randomBytes(6).toString('base64url');
    db.prepare("INSERT INTO users (email, name, password_hash, role, company) VALUES (?, ?, ?, 'inspector', ?)").run(email, name, hashPassword(tempPassword), company || null);
    reload({ created: { name, email, tempPassword } });
  });
  app.post('/staff/contractors/:id/verify', needRole('staff'), (req, res) => {
    db.prepare("UPDATE users SET license_verified = ? WHERE id = ? AND role = 'contractor'").run(req.body.verified === '1' ? 1 : 0, Number(req.params.id));
    res.redirect('/staff/team');
  });
  app.get('/staff/ledger', needRole('staff'), (req, res) => {
    res.render('ledger', { rows: db.prepare('SELECT l.*, j.title AS job_title FROM ledger l JOIN jobs j ON j.id = l.job_id ORDER BY l.id DESC').all() });
  });

  app.use((req, res) => res.status(404).render('message', { title: 'Not found', text: 'That page doesn\'t exist.' }));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error(err);
    res.status(500).render('message', { title: 'Something went wrong', text: 'The problem was logged. Please try again.' });
  });

  return app;
}

module.exports = { createApp, toCents, APP_NAME };
