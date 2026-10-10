/**
 * 8333f755 AC3 (migration 0015: task_usage.cache_creation_1h_tokens) -- the store is parallel-process enabled
 * (ADR-0012), so the migration runner must be safe when several openers migrate one file at once.
 *
 * drizzle's SQLite migrator reads the applied-migrations ledger BEFORE it opens its write transaction. A rival
 * opener that migrates inside that window leaves the loser to run `ALTER TABLE ... ADD` for a column that now
 * exists (`duplicate column name`). This test makes that interleaving deterministic -- a rival connection runs the
 * whole migration at the exact instant the loser reaches its `BEGIN` -- and proves the loser converges instead of
 * failing. The real multi-process counterpart is migrate-runner-concurrency.e2e.test.ts.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MIGRATIONS_FOLDER, isConcurrentMigrationRace, runMigrationsOn } from "../db/migrate-runner.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A copy of the shipped migrations folder holding only entries with idx <= maxIdx. */
function folderUpTo(maxIdx: number): string {
  const root = mkdtempSync(join(tmpdir(), "adhd-mig-race-"));
  dirs.push(root);
  mkdirSync(join(root, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
  journal.entries = journal.entries.filter((e) => e.idx <= maxIdx);
  writeFileSync(join(root, "meta/_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries) cpSync(join(MIGRATIONS_FOLDER, `${e.tag}.sql`), join(root, `${e.tag}.sql`));
  return root;
}

const columns = (c: Database.Database): string[] =>
  (c.prepare("PRAGMA table_info(task_usage)").all() as Array<{ name: string }>).map((r) => r.name);

/** Open `file`, and run `onFirstBegin` exactly once, at the moment drizzle opens its migration transaction. */
function racingDb(file: string, onFirstBegin: () => void) {
  const conn = new Database(file);
  const db = drizzle(conn);
  const session = (db as unknown as { session: { run: (q: unknown) => unknown } }).session;
  const run = session.run.bind(session);
  let fired = false;
  session.run = (q: unknown) => {
    const text = (q as { queryChunks?: Array<{ value?: string[] }> }).queryChunks?.[0]?.value?.[0];
    if (!fired && text === "BEGIN") {
      fired = true;
      onFirstBegin();
    }
    return run(q);
  };
  return { conn, db };
}

describe("8333f755 AC3: concurrent openers converge on the migrated schema", () => {
  it("8333f755 AC3: a loser of the ledger-read/BEGIN race re-reads the ledger and succeeds; the column exists exactly once", () => {
    const file = join(mkdtempSync(join(tmpdir(), "adhd-mig-race-db-")), "agent.db");
    dirs.push(file.replace(/\/agent\.db$/, ""));
    const seed = new Database(file);
    migrate(drizzle(seed), { migrationsFolder: folderUpTo(14) });
    seed.close();

    const loser = racingDb(file, () => {
      const rival = new Database(file);
      migrate(drizzle(rival), { migrationsFolder: MIGRATIONS_FOLDER });
      rival.close();
    });
    expect(() => runMigrationsOn(loser.conn, loser.db)).not.toThrow();
    expect(columns(loser.conn).filter((c) => c === "cache_creation_1h_tokens")).toHaveLength(1);
    expect((loser.conn.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n).toBe(16);
    loser.conn.close();
  });

  it("8333f755 AC3: an old-schema database (legacy rows, no column) reopens cleanly -- the legacy row keeps NULL, nothing back-filled", () => {
    const file = join(mkdtempSync(join(tmpdir(), "adhd-mig-race-db-")), "agent.db");
    dirs.push(file.replace(/\/agent\.db$/, ""));
    const old = new Database(file);
    migrate(drizzle(old), { migrationsFolder: folderUpTo(14) });
    old
      .prepare("INSERT INTO task_usage (task_id, agent_name, provider_type, model, input_tokens, output_tokens, tool_call_count, model_calls, latency_ms, is_complete, stop_reason, created_at) VALUES ('t1','a','claudecli','haiku',1,1,0,1,0,1,'stop','2026-10-09T00:00:00.000Z')")
      .run();
    expect(columns(old)).not.toContain("cache_creation_1h_tokens");
    old.close();

    const reopened = new Database(file);
    runMigrationsOn(reopened, drizzle(reopened));
    runMigrationsOn(reopened, drizzle(reopened)); // idempotent: a second open is a no-op
    expect(columns(reopened)).toContain("cache_creation_1h_tokens");
    expect(reopened.prepare("SELECT input_tokens, cache_creation_1h_tokens AS v FROM task_usage WHERE task_id='t1'").get()).toEqual({ input_tokens: 1, v: null });
    reopened.close();
  });

  it("8333f755 AC3: only genuine race signatures are retried; any other migration failure still surfaces", () => {
    expect(isConcurrentMigrationRace(new Error("duplicate column name: x"))).toBe(true);
    expect(isConcurrentMigrationRace(new Error("outer", { cause: new Error("SQLITE_BUSY: database is locked") }))).toBe(true);
    expect(isConcurrentMigrationRace(new Error("near \"ALTR\": syntax error"))).toBe(false);

    const file = join(mkdtempSync(join(tmpdir(), "adhd-mig-race-db-")), "agent.db");
    dirs.push(file.replace(/\/agent\.db$/, ""));
    const root = folderUpTo(14);
    writeFileSync(join(root, "0014_task_cwd.sql"), "ALTR TABLE tasks ADD cwd text;");
    const conn = new Database(file);
    expect(() => runMigrationsOn(conn, drizzle(conn), root)).toThrow(/Failed to run the query .ALTR TABLE/);
    conn.close();
  });

  /** A db whose Nth `BEGIN` (1-based) calls `onBegin(n)`; throwing from it makes that migrate attempt fail. */
  function countingDb(file: string, onBegin: (n: number) => void) {
    const conn = new Database(file);
    const db = drizzle(conn);
    const session = (db as unknown as { session: { run: (q: unknown) => unknown } }).session;
    const run = session.run.bind(session);
    let begins = 0;
    session.run = (q: unknown) => {
      const text = (q as { queryChunks?: Array<{ value?: string[] }> }).queryChunks?.[0]?.value?.[0];
      if (text === "BEGIN") onBegin(++begins);
      return run(q);
    };
    return { conn, db, begins: () => begins };
  }
  const migratedTo = (maxIdx: number): string => {
    const file = join(mkdtempSync(join(tmpdir(), "adhd-mig-race-db-")), "agent.db");
    dirs.push(file.replace(/\/agent\.db$/, ""));
    const seed = new Database(file);
    migrate(drizzle(seed), { migrationsFolder: folderUpTo(maxIdx) });
    seed.close();
    return file;
  };

  it("8333f755 AC3: a lost race backs off (jittered) before the retry instead of spinning", () => {
    const file = migratedTo(14);
    const sleeps: number[] = [];
    const loser = racingDb(file, () => {
      const rival = new Database(file);
      migrate(drizzle(rival), { migrationsFolder: MIGRATIONS_FOLDER });
      rival.close();
    });
    runMigrationsOn(loser.conn, loser.db, MIGRATIONS_FOLDER, { sleepMs: (ms) => sleeps.push(ms), random: () => 0.5 });
    expect(sleeps).toEqual([5]); // one retry, floor(0.5 * base 10ms)
    loser.conn.close();
  });

  it("8333f755 AC3: contention (SQLITE_BUSY) is retried with capped exponential jittered backoff, then converges", () => {
    const file = migratedTo(14);
    const sleeps: number[] = [];
    const busy = countingDb(file, (n) => {
      if (n <= 3) throw Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" });
    });
    runMigrationsOn(busy.conn, busy.db, MIGRATIONS_FOLDER, { sleepMs: (ms) => sleeps.push(ms), random: () => 0.999 });
    expect(sleeps).toEqual([9, 19, 39]); // 10ms, 20ms, 40ms windows, each jittered to just under the window
    expect(busy.begins()).toBe(4);
    busy.conn.close();
  });

  it("8333f755 AC3: persistent contention is bounded: 8 attempts, 7 sleeps, then the error surfaces", () => {
    const file = migratedTo(14);
    const sleeps: number[] = [];
    const busy = countingDb(file, () => {
      throw new Error("SQLITE_BUSY: database is locked");
    });
    expect(() => runMigrationsOn(busy.conn, busy.db, MIGRATIONS_FOLDER, { sleepMs: (ms) => sleeps.push(ms), random: () => 1 - Number.EPSILON })).toThrow(/SQLITE_BUSY/);
    expect(busy.begins()).toBe(8);
    expect(sleeps).toHaveLength(7);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(250); // capped
    busy.conn.close();
  });

  it("8333f755 AC3: drift (object exists but the ledger never recorded the migration) surfaces after ONE confirming retry, not eight", () => {
    const file = migratedTo(14);
    const prep = new Database(file);
    prep.exec("ALTER TABLE task_usage ADD COLUMN cache_creation_1h_tokens integer"); // applied out of band: no ledger row
    prep.close();
    const sleeps: number[] = [];
    const drifted = countingDb(file, (_n) => undefined);
    let thrown: unknown;
    try {
      runMigrationsOn(drifted.conn, drifted.db, MIGRATIONS_FOLDER, { sleepMs: (ms) => sleeps.push(ms) });
    } catch (e) {
      thrown = e;
    }
    expect(String((thrown as { cause?: unknown }).cause)).toMatch(/duplicate column name/); // drizzle wraps the SQLite error as `cause`
    expect(drifted.begins()).toBe(2); // the failing attempt + one confirming retry
    expect(sleeps).toHaveLength(1);
    drifted.conn.close();
  });

  it("8333f755 AC3: the race signatures are narrow -- a bare 'exists' in unrelated text is not a race", () => {
    expect(isConcurrentMigrationRace(new Error("table task_usage already exists"))).toBe(true);
    expect(isConcurrentMigrationRace(new Error("index idx_x already exists"))).toBe(true);
    expect(isConcurrentMigrationRace(new Error("the agent already exists in the registry"))).toBe(false);
    expect(isConcurrentMigrationRace(new Error("no such table: nowhere"))).toBe(false);
  });
});
