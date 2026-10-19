// End-to-end tests of the whole job flow, using simulated payments that record
// every transfer and refund so the money math can be checked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { simulatedPayments } = require('../src/payments');
const { hashPassword } = require('../src/auth');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppp-'));
  const db = openDb(path.join(dir, 'test.db'));
  const payments = simulatedPayments();
  const moves = [];
  const transfer = payments.transfer;
  const refund = payments.refund;
  payments.transfer = async (a) => { moves.push({ type: 'transfer', ...a }); return transfer(a); };
  payments.refund = async (a) => { moves.push({ type: 'refund', ...a }); return refund(a); };
  const app = createApp({ db, payments, uploadDir: path.join(dir, 'uploads'), sessionSecret: 'test', baseUrl: 'http://localhost' });
  const addUser = (email, role, extra = {}) => db.prepare(
    'INSERT INTO users (email, name, password_hash, role, company) VALUES (?, ?, ?, ?, ?)'
  ).run(email, extra.name || email, hashPassword('password123'), role, extra.company || null);
  addUser('staff@t.test', 'staff', { name: 'Review desk' });
  addUser('insp@t.test', 'inspector', { name: 'Hannah Cole', company: 'Piedmont Inspections' });
  return { db, app, moves };
}

async function login(app, email) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ email, password: 'password123' }).expect(302);
  return agent;
}

const jobRow = (db) => db.prepare('SELECT * FROM jobs ORDER BY id DESC').get();
const steps = (db, jobId) => db.prepare('SELECT * FROM milestones WHERE job_id = ? ORDER BY position').all(jobId);

async function fundedJob() {
  const ctx = setup();
  const { app, db } = ctx;

  // Contractor signs up and sets up payouts.
  const contractor = request.agent(app);
  await contractor.post('/signup').type('form').send({
    name: 'Marcus Ruiz', company: 'Ruiz Brothers', license: '84211', email: 'gc@t.test', password: 'password123',
  }).expect(302);
  await contractor.post('/payouts/setup').expect(303);
  await contractor.get('/payouts/return').expect(302);

  // Contractor offers the plan: $10,000 in two steps plus $500 of permit fees.
  await contractor.post('/jobs').type('form').send(
    'title=Bath+remodel&address=1+Main+St%2C+Charlotte%2C+NC&homeowner_name=Dana&homeowner_email=dana%40t.test' +
    '&step_name=Rough-in&step_amount=4%2C000&step_proof=permit' +
    '&step_name=Tile+and+vanity&step_amount=6000&step_proof=inspector&permit_budget=500'
  ).expect(302);
  const job = jobRow(db);

  // Homeowner joins through the invite link, accepts and deposits.
  const homeowner = request.agent(app);
  await homeowner.post(`/invite/${job.invite_token}`).type('form').send({ name: 'Dana', email: 'dana@t.test', password: 'password123' }).expect(302);
  await homeowner.post(`/jobs/${job.id}/accept`).expect(302);
  const pay = await homeowner.post(`/jobs/${job.id}/deposit`).expect(303);
  const checkout = pay.headers.location;
  await homeowner.get(checkout).expect(200);
  const paymentId = checkout.match(/checkout\/(\d+)/)[1];
  const back = await homeowner.post(`/simulate/checkout/${paymentId}`).expect(302);
  await homeowner.get(back.headers.location).expect(302);

  return { ...ctx, contractor, homeowner, job: jobRow(db) };
}

test('deposit covers project funds, permit fund and the homeowner fee', async () => {
  const { db, job } = await fundedJob();
  assert.equal(job.status, 'funded');
  const payment = db.prepare('SELECT * FROM payments WHERE job_id = ?').get(job.id);
  assert.equal(payment.status, 'paid');
  assert.equal(payment.amount_cents, 1_000_000 + 50_000 + 12_500); // $10,000 + $500 + 1.25%
});

test('an inspector pass pays the contractor the step less 1.25%', async () => {
  const { app, db, job, contractor, moves } = await fundedJob();
  const [, tile] = steps(db, job.id);

  await contractor.post(`/milestones/${tile.id}/proof`).attach('photos', PNG, 'tile.png').field('note', 'Tile done').expect(302);
  const staff = await login(app, 'staff@t.test');
  const insp = db.prepare("SELECT id FROM users WHERE role = 'inspector'").get();
  await staff.post(`/milestones/${tile.id}/assign`).type('form').send({ inspector_id: insp.id, date: '2026-11-02' }).expect(302);

  // Staff and the homeowner cannot pass an inspector step themselves.
  await staff.post(`/milestones/${tile.id}/check`).type('form').send({ result: 'pass', note: 'ok' }).expect(302);
  assert.equal(steps(db, job.id)[1].status, 'inspection');

  const inspector = await login(app, 'insp@t.test');
  await inspector.post(`/milestones/${tile.id}/check`).type('form').send({ result: 'pass', note: 'Tile and vanity installed' }).expect(302);
  const paid = steps(db, job.id)[1];
  assert.equal(paid.status, 'paid');
  const t = moves.find((m) => m.type === 'transfer' && m.idempotencyKey === `milestone-${tile.id}`);
  assert.equal(t.cents, 600_000 - 7_500);
});

test('a failed inspection sends the step back, and a resubmit can pass', async () => {
  const { app, db, job, contractor } = await fundedJob();
  const [, tile] = steps(db, job.id);
  await contractor.post(`/milestones/${tile.id}/proof`).attach('photos', PNG, 'a.png').expect(302);
  const staff = await login(app, 'staff@t.test');
  const insp = db.prepare("SELECT id FROM users WHERE role = 'inspector'").get();
  await staff.post(`/milestones/${tile.id}/assign`).type('form').send({ inspector_id: insp.id, date: '2026-11-02' });
  const inspector = await login(app, 'insp@t.test');
  await inspector.post(`/milestones/${tile.id}/check`).type('form').send({ result: 'fail', note: 'Grout missing' });
  assert.equal(steps(db, job.id)[1].status, 'changes');
  await contractor.post(`/milestones/${tile.id}/proof`).attach('photos', PNG, 'b.png').expect(302);
  await staff.post(`/milestones/${tile.id}/assign`).type('form').send({ inspector_id: insp.id, date: '2026-11-04' });
  await inspector.post(`/milestones/${tile.id}/check`).type('form').send({ result: 'pass', note: 'Fixed' });
  assert.equal(steps(db, job.id)[1].status, 'paid');
});

test('permits are paid back from the permit fund, and leftovers are refunded at the end', async () => {
  const { app, db, job, contractor, moves } = await fundedJob();
  await contractor.post(`/jobs/${job.id}/permits`).type('form').send({ permit_no: 'BLD-1', description: 'Bath alteration', fee: '320' }).expect(302);
  assert.equal(db.prepare('SELECT status FROM permits').get().status, 'reimbursed');
  assert.ok(moves.some((m) => m.type === 'transfer' && m.cents === 32_000));

  const [rough, tile] = steps(db, job.id);
  const staff = await login(app, 'staff@t.test');
  await contractor.post(`/milestones/${rough.id}/proof`).attach('photos', PNG, 'r.png').field('permit_no', 'BLD-1').expect(302);
  await staff.post(`/milestones/${rough.id}/check`).type('form').send({ result: 'pass', note: 'Rough-in passed on BLD-1' }).expect(302);
  await contractor.post(`/milestones/${tile.id}/proof`).attach('photos', PNG, 't.png').expect(302);
  const insp = db.prepare("SELECT id FROM users WHERE role = 'inspector'").get();
  await staff.post(`/milestones/${tile.id}/assign`).type('form').send({ inspector_id: insp.id, date: '2026-11-02' });
  const inspector = await login(app, 'insp@t.test');
  await inspector.post(`/milestones/${tile.id}/check`).type('form').send({ result: 'pass', note: 'Done' });

  assert.equal(jobRow(db).status, 'complete');
  const refund = moves.find((m) => m.type === 'refund');
  assert.equal(refund.cents, 50_000 - 32_000);
});

test('a permit costing more than the fund waits for the homeowner to top up', async () => {
  const { db, job, contractor, homeowner } = await fundedJob();
  await contractor.post(`/jobs/${job.id}/permits`).type('form').send({ permit_no: 'BLD-2', description: 'Big permit', fee: '700' }).expect(302);
  assert.equal(db.prepare('SELECT status FROM permits').get().status, 'waiting');
  const r = await homeowner.post(`/jobs/${job.id}/permit-topup`).expect(303);
  const id = r.headers.location.match(/checkout\/(\d+)/)[1];
  assert.equal(db.prepare('SELECT amount_cents FROM payments WHERE id = ?').get(id).amount_cents, 20_000);
  const back = await homeowner.post(`/simulate/checkout/${id}`).expect(302);
  await homeowner.get(back.headers.location).expect(302);
  assert.equal(db.prepare('SELECT status FROM permits').get().status, 'reimbursed');
});

test('a dispute freezes only its step, and a refund decision returns the secured money', async () => {
  const { app, db, job, contractor, homeowner, moves } = await fundedJob();
  const [rough, tile] = steps(db, job.id);
  await contractor.post(`/milestones/${rough.id}/proof`).attach('photos', PNG, 'r.png').field('permit_no', 'BLD-9').expect(302);
  await homeowner.post(`/jobs/${job.id}/dispute`).type('form').send({ milestone_id: rough.id, reason: 'Pipes leaking' }).expect(302);
  assert.equal(jobRow(db).status, 'disputed');

  const staff = await login(app, 'staff@t.test');
  await staff.post(`/milestones/${rough.id}/check`).type('form').send({ result: 'pass', note: 'passed' }).expect(302);
  assert.equal(steps(db, job.id)[0].status, 'submitted', 'a disputed step cannot be paid');

  // The other step keeps moving.
  await contractor.post(`/milestones/${tile.id}/proof`).attach('photos', PNG, 't.png').expect(302);
  assert.equal(steps(db, job.id)[1].status, 'submitted');

  const d = db.prepare('SELECT id FROM disputes').get();
  await staff.post(`/disputes/${d.id}/resolve`).type('form').send({ outcome: 'refund' }).expect(302);
  assert.equal(jobRow(db).status, 'closed');
  const refunded = moves.filter((m) => m.type === 'refund').reduce((a, m) => a + m.cents, 0);
  assert.equal(refunded, 1_000_000 + 50_000);
});

test('people can only see their own jobs', async () => {
  const { app, job } = await fundedJob();
  const other = request.agent(app);
  await other.post('/signup').type('form').send({ name: 'X', company: 'Other Co', license: '1', email: 'x@t.test', password: 'password123' });
  await other.get(`/jobs/${job.id}`).expect(404);
  const inspector = await login(app, 'insp@t.test');
  await inspector.get(`/jobs/${job.id}`).expect(404); // not assigned to any step yet
  await request(app).get(`/jobs/${job.id}`).expect(302); // logged out goes to login
});

test('every page renders for every role', async () => {
  const { app, job, contractor, homeowner } = await fundedJob();
  const staff = await login(app, 'staff@t.test');
  const inspector = await login(app, 'insp@t.test');
  await request(app).get('/').expect(200);
  await request(app).get('/signup').expect(200);
  await request(app).get(`/invite/${job.invite_token}`).expect(302);
  for (const [agent, pages] of [
    [contractor, ['/dashboard', '/jobs/new', `/jobs/${job.id}`, '/payouts']],
    [homeowner, ['/dashboard', `/jobs/${job.id}`]],
    [staff, ['/dashboard', `/jobs/${job.id}`, '/staff/team', '/staff/ledger']],
    [inspector, ['/dashboard']],
  ]) {
    for (const p of pages) await agent.get(p).expect(200);
  }
});
