// Adds sample logins and one sample job so you can try every role.
// Usage: npm run seed   (password for every sample login: demo-password)
const path = require('node:path');
const { openDb } = require('../src/db');
const { hashPassword } = require('../src/auth');
const { createServices } = require('../src/services');
const { simulatedPayments } = require('../src/payments');

try { process.loadEnvFile(); } catch { /* no .env file */ }
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
require('node:fs').mkdirSync(dataDir, { recursive: true });
const db = openDb(path.join(dataDir, 'app.db'));
const usingStripe = Boolean(process.env.STRIPE_SECRET_KEY);

const PASSWORD = 'demo-password';
const people = [
  { email: 'staff@demo.test', name: 'Review desk', role: 'staff' },
  { email: 'inspector@demo.test', name: 'Hannah Cole', role: 'inspector', company: 'Piedmont Independent Inspections' },
  { email: 'contractor@demo.test', name: 'Marcus Ruiz', role: 'contractor', company: 'Ruiz Brothers Remodeling', license_no: '84211', license_verified: 1 },
  { email: 'homeowner@demo.test', name: 'Dana Whitfield', role: 'homeowner' },
];
for (const p of people) {
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(p.email)) continue;
  db.prepare(`INSERT INTO users (email, name, password_hash, role, company, license_no, license_verified, stripe_account_id, payouts_ready)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    p.email, p.name, hashPassword(PASSWORD), p.role, p.company || null, p.license_no || null, p.license_verified || 0,
    // In practice mode the sample contractor is ready to be paid. With Stripe they set up payouts themselves.
    p.role === 'contractor' && !usingStripe ? 'acct_sim_demo' : null, p.role === 'contractor' && !usingStripe ? 1 : 0);
}

const contractor = db.prepare("SELECT * FROM users WHERE email = 'contractor@demo.test'").get();
const homeowner = db.prepare("SELECT * FROM users WHERE email = 'homeowner@demo.test'").get();
if (!db.prepare('SELECT 1 FROM jobs WHERE contractor_id = ?').get(contractor.id)) {
  const svc = createServices(db, simulatedPayments());
  const id = svc.createJob(contractor, {
    title: 'Kitchen remodel', address: '2318 Selwyn Ave, Charlotte, NC 28207',
    homeownerName: homeowner.name, homeownerEmail: homeowner.email, permitBudgetCents: 65000,
    milestones: [
      { name: 'Materials delivered', cents: 630000, proof: 'inspector' },
      { name: 'Demolition and rough-in', cents: 1050000, proof: 'permit' },
      { name: 'Cabinets installed', cents: 1260000, proof: 'inspector' },
      { name: 'Countertops, backsplash and fixtures', cents: 840000, proof: 'inspector' },
      { name: 'Final building inspection', cents: 420000, proof: 'permit' },
    ],
  });
  db.prepare('UPDATE jobs SET homeowner_id = ? WHERE id = ?').run(homeowner.id, id);
}
console.log(`Sample logins ready (password "${PASSWORD}"): ${people.map((p) => p.email).join(', ')}`);
