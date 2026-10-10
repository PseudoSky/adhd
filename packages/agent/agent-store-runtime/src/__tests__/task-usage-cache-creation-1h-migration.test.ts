/**
 * 8333f755 AC3 -- migration 0015: task_usage.cache_creation_1h_tokens. Built through the migrations agent-mcp
 * ships (no mocks); additive, legacy-safe, and in lockstep with the drizzle schema.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getTableColumns } from "drizzle-orm";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { taskUsageTable } from "../db/schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const REAL_FOLDER = join(REPO_ROOT, "entrypoint/agent-mcp/drizzle");
const SCRATCH_ROOT = join(REPO_ROOT, "tmp/agent-store-runtime");

interface IJournal {
  entries: Array<{ idx: number; tag: string }>;
}

function folderUpTo(dest: string, maxIdx: number): string {
  const out = join(dest, `upto-${maxIdx}`);
  mkdirSync(join(out, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(join(REAL_FOLDER, "meta/_journal.json"), "utf8")) as IJournal & Record<string, unknown>;
  journal.entries = journal.entries.filter((e) => e.idx <= maxIdx);
  writeFileSync(join(out, "meta/_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries) cpSync(join(REAL_FOLDER, `${e.tag}.sql`), join(out, `${e.tag}.sql`));
  return out;
}

const columnsOf = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);

describe("migration 0015: task_usage.cache_creation_1h_tokens", () => {
  let scratch: string;
  let conn: Database.Database;

  beforeEach(() => {
    mkdirSync(SCRATCH_ROOT, { recursive: true });
    scratch = mkdtempSync(join(SCRATCH_ROOT, "cc1h-mig-"));
    conn = new Database(":memory:");
  });
  afterEach(() => {
    conn.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("8333f755 AC3: adds exactly one nullable integer column and keeps a legacy row byte-for-byte", () => {
    migrate(drizzle(conn), { migrationsFolder: folderUpTo(scratch, 14) });
    const before = columnsOf(conn, "task_usage");
    expect(before).not.toContain("cache_creation_1h_tokens");
    conn
      .prepare(
        "INSERT INTO task_usage (task_id, agent_name, provider_type, model, input_tokens, output_tokens, tool_call_count, model_calls, latency_ms, is_complete, stop_reason, cache_creation_input_tokens, est_cost_usd, created_at) VALUES ('t1','a','claudecli','haiku',1,1,0,1,0,1,'stop',77,0.5,'2026-10-09T00:00:00.000Z')"
      )
      .run();

    migrate(drizzle(conn), { migrationsFolder: REAL_FOLDER });

    expect(columnsOf(conn, "task_usage").filter((c) => !before.includes(c))).toEqual(["cache_creation_1h_tokens"]);
    const info = (conn.prepare("PRAGMA table_info(task_usage)").all() as Array<{ name: string; type: string; notnull: number }>).find((c) => c.name === "cache_creation_1h_tokens");
    expect(info?.type.toLowerCase()).toBe("integer");
    expect(info?.notnull).toBe(0);
    expect(conn.prepare("SELECT cache_creation_input_tokens AS w, est_cost_usd AS c, cache_creation_1h_tokens AS v FROM task_usage WHERE task_id='t1'").get()).toEqual({ w: 77, c: 0.5, v: null });
  });

  it("8333f755 AC3: re-running the migrator on a migrated database is a no-op (idempotent)", () => {
    migrate(drizzle(conn), { migrationsFolder: REAL_FOLDER });
    expect(() => migrate(drizzle(conn), { migrationsFolder: REAL_FOLDER })).not.toThrow();
    expect(columnsOf(conn, "task_usage").filter((c) => c === "cache_creation_1h_tokens")).toHaveLength(1);
  });

  it("8333f755 AC3: drizzle schema.ts columns match the migrated DB exactly (no schema/migration drift)", () => {
    migrate(drizzle(conn), { migrationsFolder: REAL_FOLDER });
    const schemaCols = Object.values(getTableColumns(taskUsageTable)).map((c) => c.name).sort();
    expect(columnsOf(conn, "task_usage").sort()).toEqual(schemaCols);
  });
});
