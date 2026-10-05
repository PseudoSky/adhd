// Worker-thread fixture that holds a SQLite IMMEDIATE write lock on the
// `agents` table in `workerData.path` for `workerData.holdMs` ms, then commits.
//
// Used by agent-store-atomicity.test.ts (backlog 331508ac) to create genuine
// cross-thread writer contention against AgentStore's read-modify-write paths.
// A separate event loop is required: better-sqlite3's native busy handler
// blocks the calling thread, so the lock holder must live elsewhere.
//
// Optional `workerData.seedName` inserts one `agents` row (with
// `workerData.seedData` as its `data` JSON) INSIDE the held transaction, so a
// concurrent `create()` that correctly takes the write lock at BEGIN will
// observe it (and raise the clean AGENT_ALREADY_EXISTS), while a deferred
// transaction races to a raw UNIQUE-constraint error.
const { parentPort, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3');

const db = new Database(workerData.path);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS agents (
  name TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
db.exec('BEGIN IMMEDIATE');

if (workerData.seedName) {
  const at = new Date().toISOString();
  db.prepare(
    'INSERT INTO agents (name, version, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(workerData.seedName, 1, workerData.seedData ?? '{}', at, at);
}

parentPort.postMessage({ type: 'locked' });

setTimeout(() => {
  db.exec('COMMIT');
  parentPort.postMessage({ type: 'committed' });
  db.close();
}, workerData.holdMs);
