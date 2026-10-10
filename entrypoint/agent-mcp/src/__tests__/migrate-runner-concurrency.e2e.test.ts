/**
 * 8333f755 AC3 (migration 0015) -- REAL concurrent openers (ADR-0009 e2e lane; not env-gated).
 *
 * Several real node processes open ONE database file at schema 0014 and call the real `runMigrationsOn` at the same
 * instant (a start barrier). The store is parallel-process enabled (ADR-0012): every opener must come up migrated,
 * none may fail, and the new column must exist exactly once. Deterministic counterpart: migrate-runner-race.test.ts.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { MIGRATIONS_FOLDER } from "../db/migrate-runner.js";

const CHILD = fileURLToPath(new URL("./fixtures/migrate-child.mjs", import.meta.url));
const OPENERS = 8;
const ROUNDS = 6;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seedAt0014(dir: string, file: string): void {
  const old = join(dir, "upto-14");
  mkdirSync(join(old, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
  journal.entries = journal.entries.filter((e) => e.idx <= 14);
  writeFileSync(join(old, "meta/_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries) cpSync(join(MIGRATIONS_FOLDER, `${e.tag}.sql`), join(old, `${e.tag}.sql`));
  const c = new Database(file);
  c.pragma("journal_mode = WAL");
  migrate(drizzle(c), { migrationsFolder: old });
  c.close();
}

function runChild(dbFile: string, goFile: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CHILD, dbFile, goFile], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    p.on("close", (code) => resolve({ code, out }));
  });
}

describe("8333f755 AC3: parallel-process openers of one old-schema database", () => {
  it(`8333f755 AC3: ${OPENERS} processes migrating one 0014 database at once all succeed, ${ROUNDS} rounds, column added exactly once`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "adhd-mig-conc-")));
      dirs.push(dir);
      const file = join(dir, "agent.db");
      const go = join(dir, "go");
      seedAt0014(dir, file);
      const running = Array.from({ length: OPENERS }, () => runChild(file, go));
      writeFileSync(go, "go");
      const results = await Promise.all(running);
      expect(results.filter((r) => r.code !== 0).map((r) => r.out), `round ${round}`).toEqual([]);
      const c = new Database(file);
      const cols = (c.prepare("PRAGMA table_info(task_usage)").all() as Array<{ name: string }>).filter((x) => x.name === "cache_creation_1h_tokens");
      expect(cols).toHaveLength(1);
      expect((c.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n).toBe(16);
      c.close();
    }
  }, 120_000);
});
