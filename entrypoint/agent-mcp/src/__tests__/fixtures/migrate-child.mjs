// Child process for migrate-runner-concurrency.e2e.test.ts: open a SQLite file the way the host does (WAL, busy
// timeout), wait at a start barrier so all siblings overlap, then run the real `runMigrationsOn`.
// argv: <dbFile> <goFile>. Prints `ok` and exits 0; on failure prints `ERR <message>` and exits 1.
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { runMigrationsOn } from '../../db/migrate-runner.ts';

const [, , dbFile, goFile] = process.argv;
const conn = new Database(dbFile);
conn.pragma('journal_mode = WAL');
conn.pragma('busy_timeout = 5000');
while (!existsSync(goFile)) await new Promise((r) => setImmediate(r));
try {
  runMigrationsOn(conn, drizzle(conn));
  console.log('ok');
} catch (e) {
  console.log('ERR ' + (e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
}
