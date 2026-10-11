/**
 * ad988fda AC2: `usage_query` derives `usage_lower_bound` from `task_events` filtered by task_id + type + a
 * json_extract on the payload. Measured on 400k events: the json_extract adds nothing (79.6ms vs 80.1ms per
 * 100-task lookup); the cost is the missing task_id index (full scan). Migration 0016 adds
 * `idx_task_events_task_id_type`; this proves a freshly migrated database serves that query from it, and that an
 * already-migrated (pre-0016) database picks it up.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrationsOn } from "../db/migrate-runner.js";

const PLAN_SQL =
  "EXPLAIN QUERY PLAN SELECT DISTINCT task_id FROM task_events WHERE task_id IN ('a','b') AND type = 'MODEL_RESPONSE' AND json_extract(payload, '$.usageLowerBound') = 1";

const planOf = (c: Database.Database): string =>
  (c.prepare(PLAN_SQL).all() as Array<{ detail: string }>).map((r) => r.detail).join("\n");

describe("ad988fda AC2: task_events is indexed for the per-task usage lookups", () => {
  it("ad988fda AC2: the usageLowerBound lookup is served by idx_task_events_task_id_type, not a table scan", () => {
    const conn = new Database(":memory:");
    runMigrationsOn(conn, drizzle(conn));
    const plan = planOf(conn);
    expect(plan).toMatch(/idx_task_events_task_id_type/);
    expect(plan).not.toMatch(/SCAN task_events/);
    conn.close();
  });

  it("ad988fda AC2: running the migrations twice leaves exactly one such index", () => {
    const conn = new Database(":memory:");
    runMigrationsOn(conn, drizzle(conn));
    runMigrationsOn(conn, drizzle(conn));
    const n = conn
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_task_events_task_id_type'")
      .get() as { n: number };
    expect(n.n).toBe(1);
    conn.close();
  });
});
