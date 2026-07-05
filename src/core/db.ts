import { DatabaseSync } from "node:sqlite";
import { ensureDirFor } from "./config.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  on_budget INTEGER NOT NULL,
  closed INTEGER NOT NULL,
  balance INTEGER NOT NULL,
  deleted INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  group_name TEXT NOT NULL,
  name TEXT NOT NULL,
  hidden INTEGER NOT NULL,
  budgeted INTEGER NOT NULL,
  activity INTEGER NOT NULL,
  balance INTEGER NOT NULL,
  deleted INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  deleted INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  month TEXT,          -- yyyy-mm the observation applies to (optional)
  category TEXT,       -- category name it applies to (optional)
  payee TEXT,          -- payee name it applies to (optional)
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  memo TEXT,
  cleared TEXT NOT NULL,
  approved INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  account_name TEXT NOT NULL,
  payee_id TEXT,
  payee_name TEXT,
  category_id TEXT,
  category_name TEXT,
  transfer_account_id TEXT,
  has_subtransactions INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category_id);

CREATE TABLE IF NOT EXISTS subtransactions (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  memo TEXT,
  payee_name TEXT,
  category_id TEXT,
  category_name TEXT,
  transfer_account_id TEXT,
  deleted INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subtx_parent ON subtransactions(transaction_id);

-- "Effective" transactions: split parents are replaced by their subtransactions
-- (which carry the real categories); everything else passes through.
-- approved=0 rows are bank imports matched to a manually-entered transaction —
-- the approved=1 entry covers them, so excluding here prevents double-counting.
DROP VIEW IF EXISTS effective_tx;
CREATE VIEW effective_tx AS
SELECT
  t.id            AS id,
  t.id            AS parent_id,
  t.date          AS date,
  t.amount        AS amount,
  t.memo          AS memo,
  t.account_id    AS account_id,
  t.account_name  AS account_name,
  t.payee_name    AS payee_name,
  t.category_id   AS category_id,
  t.category_name AS category_name,
  t.transfer_account_id AS transfer_account_id
FROM transactions t
WHERE t.deleted = 0 AND t.approved = 1 AND t.has_subtransactions = 0
UNION ALL
SELECT
  s.id            AS id,
  t.id            AS parent_id,
  t.date          AS date,
  s.amount        AS amount,
  COALESCE(s.memo, t.memo) AS memo,
  t.account_id    AS account_id,
  t.account_name  AS account_name,
  COALESCE(s.payee_name, t.payee_name) AS payee_name,
  s.category_id   AS category_id,
  s.category_name AS category_name,
  s.transfer_account_id AS transfer_account_id
FROM subtransactions s
JOIN transactions t ON t.id = s.transaction_id
WHERE s.deleted = 0 AND t.deleted = 0 AND t.approved = 1;
`;

export function openDb(dbPath: string): DatabaseSync {
  ensureDirFor(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

export function getMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}
