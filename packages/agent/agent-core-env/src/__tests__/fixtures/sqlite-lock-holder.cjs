// Forked (OS-process) fixture for registry-adapter-concurrency.test.ts's
// NEGATIVE CONTROL (ADR-0001 D5). This is the PRE-MIGRATION better-sqlite3
// shape: a bare connection with `busy_timeout = 0`, an explicit
// `BEGIN IMMEDIATE` write lock, insert, hold `argv[3]` ms, COMMIT.
//
// The identical contention that the adapter path recovers from must make a
// pre-migration better-sqlite3 contender throw a raw SQLITE_BUSY — proving the
// D5 test goes RED against the retired substrate.
const Database = require('better-sqlite3');

const dbPath = process.argv[2];
const holdMs = Number(process.argv[3] ?? 300);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 0');
db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, who TEXT)');
db.exec('BEGIN IMMEDIATE');
db.prepare("INSERT INTO t (who) VALUES ('holder')").run();
process.send({ type: 'locked' });

setTimeout(() => {
  db.exec('COMMIT');
  process.send({ type: 'committed' });
  db.close();
  process.exit(0);
}, holdMs);
