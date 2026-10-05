// Worker-thread fixture that holds a SQLite IMMEDIATE write lock on
// `workerData.path` for `workerData.holdMs` ms, then commits. Used by
// sqlite-locking-concurrency.test.ts to create genuine cross-thread writer
// contention (a separate event loop is required: better-sqlite3's busy handler
// blocks the calling thread, so the lock holder must live elsewhere).
const { parentPort, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3');

const db = new Database(workerData.path);
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS t (x INTEGER)');
db.exec('BEGIN IMMEDIATE');
db.prepare('INSERT INTO t (x) VALUES (?)').run(1);
parentPort.postMessage({ type: 'locked' });

setTimeout(() => {
  db.exec('COMMIT');
  parentPort.postMessage({ type: 'committed' });
  db.close();
}, workerData.holdMs);
