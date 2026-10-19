// Starts the web server. Settings come from environment variables (see .env.example).
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb } = require('./db');
const { paymentsFromEnv } = require('./payments');
const { createApp } = require('./app');
const { hashPassword } = require('./auth');

try { process.loadEnvFile(); } catch { /* no .env file; use the real environment */ }

const port = Number(process.env.PORT || 3000);
const baseUrl = (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
require('node:fs').mkdirSync(dataDir, { recursive: true });

const db = openDb(path.join(dataDir, 'app.db'));
const payments = paymentsFromEnv();

// Creates the first staff login from STAFF_EMAIL / STAFF_PASSWORD if it doesn't exist yet.
if (process.env.STAFF_EMAIL && process.env.STAFF_PASSWORD) {
  const email = process.env.STAFF_EMAIL.trim().toLowerCase();
  if (!db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?, 'Review desk', ?, 'staff')")
      .run(email, hashPassword(process.env.STAFF_PASSWORD));
    console.log(`Created staff login ${email}`);
  }
}

const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET is not set, so everyone is logged out on restart.');

createApp({ db, payments, uploadDir: path.join(dataDir, 'uploads'), sessionSecret, baseUrl })
  .listen(port, () => {
    console.log(`Protection Payment Plan running at ${baseUrl}`);
    console.log(payments.mode === 'simulated'
      ? 'Payments: SIMULATED (no Stripe key set, no money moves)'
      : `Payments: Stripe ${payments.mode} mode`);
  });
