import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paypal_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  due_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispute_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  json TEXT NOT NULL,
  score INTEGER NOT NULL,
  score_json TEXT NOT NULL,
  trace_json TEXT NOT NULL,
  model TEXT NOT NULL,
  source TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL REFERENCES drafts(id),
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject','edit')),
  edited_json TEXT,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id INTEGER NOT NULL REFERENCES approvals(id),
  kind TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','in_flight','ok','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  paypal_request_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  event TEXT NOT NULL,
  dispute_id TEXT,
  payload_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_head (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  count INTEGER NOT NULL,
  head_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mock_disputes (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mock_requests (
  request_id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  response_json TEXT NOT NULL
);
`;

function migrateActionStatus(db: Db): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'actions'").get() as
    | { sql: string }
    | undefined;
  if (!row || row.sql.includes("in_flight")) return;
  db.pragma("foreign_keys = OFF");
  db.transaction(() => {
    db.exec("ALTER TABLE actions RENAME TO actions_old");
    db.exec(SCHEMA);
    db.exec("INSERT INTO actions SELECT * FROM actions_old");
    db.exec("DROP TABLE actions_old");
  })();
  db.pragma("foreign_keys = ON");
}

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrateActionStatus(db);
  db.exec(`INSERT OR IGNORE INTO audit_head (id, count, head_hash)
    SELECT 1, (SELECT COUNT(*) FROM audit), COALESCE((SELECT hash FROM audit ORDER BY id DESC LIMIT 1), '${"0".repeat(64)}')`);
  db.prepare("UPDATE actions SET status = 'failed' WHERE status = 'in_flight'").run();
  return db;
}
