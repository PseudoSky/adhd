// Child process for migrate-runner-concurrency.e2e.test.ts (R9-hist AC11): the NEW binary. Like migrate-child.mjs, but it
// announces on stdout when it is about to run (`started`) and every time drizzle opens a migration transaction (`begin`),
// so the parent can sequence a competing previous-version writer against it without sleeping. Output uses writeSync so a
// line is on the pipe before the process blocks inside SQLite's busy handler.
// argv: <dbFile> <goFile> [migrationsFolder]. Prints `ok` and exits 0; on failure `ERR <message>` and exit 1.
import Database from 'better-sqlite3';
import { existsSync, writeSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { MIGRATIONS_FOLDER, runMigrationsOn } from '../../src/db/migrate-runner.ts';

const [, , dbFile, goFile, folder] = process.argv;
const say = (line) => writeSync(1, line + '\n');
const conn = new Database(dbFile);
conn.pragma('journal_mode = WAL');
conn.pragma('busy_timeout = 30000');
conn.pragma('foreign_keys = ON');
while (!existsSync(goFile)) await new Promise((r) => setImmediate(r));
const db = drizzle(conn, { logger: { logQuery(query) { if (query === 'BEGIN') say('begin'); } } });
try {
  say('started');
  runMigrationsOn(conn, db, folder ?? MIGRATIONS_FOLDER);
  say('ok');
} catch (e) {
  say('ERR ' + (e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
}
