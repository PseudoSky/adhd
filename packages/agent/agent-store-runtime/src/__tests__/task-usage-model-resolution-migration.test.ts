/**
 * 79aebb26 (plan 9ed453c1-b113-473d-8c35-fc6dc2541306) BK8 -- migration 0013: requested_model,
 * cli_reported_cost_usd, model_breakdown_json on task_usage. Built through the migrations
 * agent-mcp ships (no mocks); additive and legacy-safe.
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

/** Copy the real migrations folder, keeping only entries with idx <= maxIdx. */
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

describe("migration 0013: task_usage model resolution columns", () => {
  let scratch: string;
  let conn: Database.Database;

  beforeEach(() => {
    mkdirSync(SCRATCH_ROOT, { recursive: true });
    scratch = mkdtempSync(join(SCRATCH_ROOT, "model-res-mig-"));
    conn = new Database(":memory:");
  });
  afterEach(() => {
    conn.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("79aebb26 BK8: adds exactly the three nullable columns and keeps a legacy row byte-for-byte", () => {
    migrate(drizzle(conn), { migrationsFolder: folderUpTo(scratch, 12) });
    const before = columnsOf(conn, "task_usage");
    expect(before).not.toContain("requested_model");
    conn
      .prepare(
        "INSERT INTO task_usage (task_id, agent_name, provider_type, model, input_tokens, output_tokens, tool_call_count, model_calls, latency_ms, is_complete, stop_reason, est_cost_usd, created_at) VALUES ('t1','a','claudecli','haiku',1,1,0,1,0,1,'stop',0.5,'2026-10-09T00:00:00.000Z')"
      )
      .run();

    migrate(drizzle(conn), { migrationsFolder: REAL_FOLDER });

    const added = columnsOf(conn, "task_usage").filter((c) => !before.includes(c));
    expect(added.sort()).toEqual(["cli_reported_cost_usd", "model_breakdown_json", "requested_model"]);
    const legacy = conn.prepare("SELECT model, est_cost_usd, requested_model, cli_reported_cost_usd, model_breakdown_json FROM task_usage WHERE task_id='t1'").get();
    expect(legacy).toEqual({ model: "haiku", est_cost_usd: 0.5, requested_model: null, cli_reported_cost_usd: null, model_breakdown_json: null });
  });

  it("79aebb26 BK8: drizzle schema.ts columns match the migrated DB exactly (no schema/migration drift)", () => {
    migrate(drizzle(conn), { migrationsFolder: REAL_FOLDER });
    const schemaCols = Object.values(getTableColumns(taskUsageTable)).map((c) => c.name).sort();
    expect(columnsOf(conn, "task_usage").sort()).toEqual(schemaCols);
  });
});
