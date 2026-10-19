// SQLite storage using Node's built-in driver. All money is stored in cents.
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('contractor','homeowner','inspector','staff')),
  company TEXT,
  license_no TEXT,
  license_verified INTEGER NOT NULL DEFAULT 0,
  stripe_account_id TEXT,
  payouts_ready INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  address TEXT NOT NULL,
  contractor_id INTEGER NOT NULL REFERENCES users(id),
  homeowner_id INTEGER REFERENCES users(id),
  homeowner_name TEXT NOT NULL,
  homeowner_email TEXT NOT NULL,
  invite_token TEXT NOT NULL UNIQUE,
  permit_budget_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited','accepted','funded','disputed','complete','closed')),
  funded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  proof TEXT NOT NULL CHECK (proof IN ('inspector','permit')),
  status TEXT NOT NULL DEFAULT 'upcoming'
    CHECK (status IN ('upcoming','submitted','inspection','changes','approved','paid','refunded')),
  note TEXT,
  permit_no TEXT,
  inspector_id INTEGER REFERENCES users(id),
  inspection_date TEXT,
  result_note TEXT,
  verified_by TEXT,
  transfer_id TEXT,
  submitted_at TEXT,
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  milestone_id INTEGER NOT NULL REFERENCES milestones(id),
  filename TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per homeowner payment (the first deposit, and any permit fund top-ups).
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL CHECK (kind IN ('deposit','permit_topup')),
  amount_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
  checkout_id TEXT,
  payment_intent_id TEXT,
  charge_id TEXT,
  transferred_cents INTEGER NOT NULL DEFAULT 0,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS permits (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  permit_no TEXT NOT NULL,
  description TEXT NOT NULL,
  fee_cents INTEGER NOT NULL CHECK (fee_cents > 0),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','reimbursed')),
  transfer_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  milestone_id INTEGER REFERENCES milestones(id),
  raised_by INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  outcome TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

-- Every dollar in or out, with the payment provider's reference.
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out','fee')),
  amount_cents INTEGER NOT NULL,
  party TEXT NOT NULL,
  reference TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  who TEXT NOT NULL,
  text TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

// Runs fn inside a transaction, rolling back if it throws.
function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { openDb, tx };
