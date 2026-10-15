/**
 * guards: the turn-grain usage reader attributes tool-result tokens to the wrong turn or drops them, or pulls every TOOL_RESULT payload (up to 16000 chars each) out of SQLite just to read one number
 * tier: S
 * cites: plan discovery-sweep-1014 blind-review A2 TEB-C1
 *
 * plan discovery-sweep-1014 blind-review A2 TEB-C1 — `usageQueryByGrain(..., grain: "turn")` rows on a mixed
 * fixture equal a golden captured BEFORE the change, and the reader no longer selects the payload text of a
 * TOOL_RESULT row.
 *
 * Failure modes: (a) the extracted column is read wrong (a missing, null or non-numeric `tool_call_est_result_tokens`
 * counts as something other than 0, or a TOOL_RESULT between two responses is attributed to the wrong turn), so
 * `tool_call_est_result_tokens` differs from the golden; (b) the reader still returns the whole TOOL_RESULT payload
 * (it contains a sentinel only the large `result` field carries), the cost this change removes.
 *
 * Tier: S. Real `usageQueryByGrain`, real migrated SQLite (`createMigratedSqlite`); rows are seeded through the
 * real `task_events` / `task_usage` tables. The statement spy wraps the real better-sqlite3 handle and records the
 * rows each `all()` returns. Nothing is mocked.
 *
 * Red run: the golden and attribution cases hold before and after the change by design (output rows identical; the
 * golden was captured on the pre-change reader). Against the pre-change reader (`SELECT ... payload` of every
 * TOOL_RESULT row) the spy case fails on `expect(everything).not.toContain(SENTINEL)` (the large `result` text came
 * back from SQLite); after the change it passes.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";

import * as schema from "@adhd/agent-store-runtime";

import { usageQueryByGrain, type Database as OrchestratorDb } from "../tools/usage.js";
import { createMigratedSqlite } from "./fixtures/real-schema-db.js";

const SENTINEL = "SENTINEL_LARGE_TOOL_RESULT_BODY";

function makeDb(): { db: OrchestratorDb; sqlite: InstanceType<typeof Database> } {
  const sqlite = createMigratedSqlite();
  return { db: drizzle(sqlite, { schema }) as unknown as OrchestratorDb, sqlite };
}

function seedTask(sqlite: InstanceType<typeof Database>, id: string): void {
  const at = "2026-01-01T00:00:00.000Z";
  sqlite
    .prepare(`INSERT INTO tasks (id, session_id, status, prompt, created_at, updated_at) VALUES (?, ?, 'completed', 'p', ?, ?)`)
    .run(id, `sess-${id}`, at, at);
  sqlite
    .prepare(
      `INSERT INTO task_usage
        (task_id, agent_name, provider_type, model, input_tokens, output_tokens, model_calls, is_complete,
         uncached_input_tokens, cache_read_input_tokens, cache_creation_input_tokens, peak_context_tokens, created_at)
       VALUES (?, 'agent-a', 'openai', 'gpt-4o', 100, 10, 2, 1, 100, 0, 0, 100, ?)`,
    )
    .run(id, at);
}

let seq = 0;
function seedEvent(sqlite: InstanceType<typeof Database>, taskId: string, type: string, at: string, payload: string | null): void {
  seq += 1;
  sqlite.prepare(`INSERT INTO task_events (id, task_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)`).run(`e-${seq}`, taskId, type, payload, at);
}

const usagePayload = JSON.stringify({ inputTokens: 100, outputTokens: 10, uncachedInputTokens: 100, stopReason: "tool_calls", toolCallCount: 1 });
const big = (n: number): string => `${SENTINEL}${"b".repeat(n)}`;

/** Two tasks; tool results of every shape the reader meets: number, missing field, null column, string-typed number, large result. */
function seedMixed(sqlite: InstanceType<typeof Database>): void {
  seedTask(sqlite, "ta");
  seedTask(sqlite, "tb");
  seedEvent(sqlite, "ta", "MODEL_REQUEST", "2026-01-01T00:00:01.000Z", JSON.stringify({ advertisedToolNames: [] }));
  seedEvent(sqlite, "ta", "MODEL_RESPONSE", "2026-01-01T00:00:02.000Z", usagePayload);
  seedEvent(sqlite, "ta", "TOOL_RESULT", "2026-01-01T00:00:03.000Z", JSON.stringify({ tool_call_est_result_tokens: 7, result: big(15_000) }));
  seedEvent(sqlite, "ta", "TOOL_RESULT", "2026-01-01T00:00:04.000Z", JSON.stringify({ tool_call_est_result_tokens: 5, result: "short" }));
  seedEvent(sqlite, "ta", "TOOL_RESULT", "2026-01-01T00:00:05.000Z", JSON.stringify({ result: "no estimate recorded" }));
  seedEvent(sqlite, "ta", "TOOL_RESULT", "2026-01-01T00:00:06.000Z", null);
  seedEvent(sqlite, "ta", "MODEL_REQUEST", "2026-01-01T00:00:07.000Z", JSON.stringify({ advertisedToolNames: [] }));
  seedEvent(sqlite, "ta", "MODEL_RESPONSE", "2026-01-01T00:00:08.000Z", usagePayload);
  seedEvent(sqlite, "ta", "TOOL_RESULT", "2026-01-01T00:00:09.000Z", JSON.stringify({ tool_call_est_result_tokens: 11 }));
  seedEvent(sqlite, "tb", "MODEL_REQUEST", "2026-01-01T00:00:01.000Z", JSON.stringify({ advertisedToolNames: [] }));
  seedEvent(sqlite, "tb", "MODEL_RESPONSE", "2026-01-01T00:00:02.000Z", usagePayload);
  seedEvent(sqlite, "tb", "TOOL_RESULT", "2026-01-01T00:00:03.000Z", JSON.stringify({ tool_call_est_result_tokens: 3, result: big(15_500) }));
}

function turnRows(db: OrchestratorDb): Array<Record<string, unknown>> {
  return usageQueryByGrain(db, { include_incomplete: true, limit: 50, grain: "turn" }).rows as unknown as Array<Record<string, unknown>>;
}

/** Turn rows for the fixture above, captured from the reader BEFORE it was changed to extract the token column in SQL. */
const GOLDEN_TURN_ROWS: unknown = [
    {
      "session_id": "sess-ta",
      "task_id": "ta",
      "root_task_id": null,
      "call_index": 2,
      "agent_name": "agent-a",
      "provider_type": "openai",
      "model": "gpt-4o",
      "created_at": "2026-01-01T00:00:08.000Z",
      "is_complete": true,
      "stop_reason": "tool_calls",
      "input_tokens": 100,
      "output_tokens": 10,
      "uncached_input_tokens": 100,
      "cache_read_tokens": 0,
      "cache_creation_tokens": 0,
      "reasoning_tokens": 0,
      "tool_call_count": 1,
      "model_calls": 1,
      "compute_ms": 0,
      "total_ms": 0,
      "tool_call_est_result_tokens": 11,
      "est_cost_usd": null,
      "response_model": null,
      "cost_status": "unpriced_model",
      "cost_basis": null,
      "pricing_ref": null,
      "context_size": 100,
      "context_size_at": {
        "task_id": "ta",
        "call_index": 2
      },
      "task_status": "completed",
      "requested_model": null,
      "cli_reported_cost_usd": null,
      "cache_creation_1h_tokens": null,
      "first_turn": null,
      "per_turn": null,
      "per_turn_truncated": false,
      "usage_lower_bound": false
    },
    {
      "session_id": "sess-ta",
      "task_id": "ta",
      "root_task_id": null,
      "call_index": 1,
      "agent_name": "agent-a",
      "provider_type": "openai",
      "model": "gpt-4o",
      "created_at": "2026-01-01T00:00:02.000Z",
      "is_complete": true,
      "stop_reason": "tool_calls",
      "input_tokens": 100,
      "output_tokens": 10,
      "uncached_input_tokens": 100,
      "cache_read_tokens": 0,
      "cache_creation_tokens": 0,
      "reasoning_tokens": 0,
      "tool_call_count": 1,
      "model_calls": 1,
      "compute_ms": 0,
      "total_ms": 0,
      "tool_call_est_result_tokens": 12,
      "est_cost_usd": null,
      "response_model": null,
      "cost_status": "unpriced_model",
      "cost_basis": null,
      "pricing_ref": null,
      "context_size": 100,
      "context_size_at": {
        "task_id": "ta",
        "call_index": 1
      },
      "task_status": "completed",
      "requested_model": null,
      "cli_reported_cost_usd": null,
      "cache_creation_1h_tokens": null,
      "first_turn": null,
      "per_turn": null,
      "per_turn_truncated": false,
      "usage_lower_bound": false
    },
    {
      "session_id": "sess-tb",
      "task_id": "tb",
      "root_task_id": null,
      "call_index": 1,
      "agent_name": "agent-a",
      "provider_type": "openai",
      "model": "gpt-4o",
      "created_at": "2026-01-01T00:00:02.000Z",
      "is_complete": true,
      "stop_reason": "tool_calls",
      "input_tokens": 100,
      "output_tokens": 10,
      "uncached_input_tokens": 100,
      "cache_read_tokens": 0,
      "cache_creation_tokens": 0,
      "reasoning_tokens": 0,
      "tool_call_count": 1,
      "model_calls": 1,
      "compute_ms": 0,
      "total_ms": 0,
      "tool_call_est_result_tokens": 3,
      "est_cost_usd": null,
      "response_model": null,
      "cost_status": "unpriced_model",
      "cost_basis": null,
      "pricing_ref": null,
      "context_size": 100,
      "context_size_at": {
        "task_id": "tb",
        "call_index": 1
      },
      "task_status": "completed",
      "requested_model": null,
      "cli_reported_cost_usd": null,
      "cache_creation_1h_tokens": null,
      "first_turn": null,
      "per_turn": null,
      "per_turn_truncated": false,
      "usage_lower_bound": false
    }
  ];

/** Wraps the handle so every `all()` result is recorded; returns what SQLite handed back to the reader. */
function spyOnRows(sqlite: InstanceType<typeof Database>): unknown[][] {
  const returned: unknown[][] = [];
  const prepare = sqlite.prepare.bind(sqlite) as (sql: string) => ReturnType<typeof sqlite.prepare>;
  (sqlite as unknown as { prepare: unknown }).prepare = (sql: string) => {
    const statement = prepare(sql);
    const all = statement.all.bind(statement) as (...args: unknown[]) => unknown[];
    (statement as unknown as { all: unknown }).all = (...args: unknown[]) => {
      const rows = all(...args);
      returned.push(rows);
      return rows;
    };
    return statement;
  };
  return returned;
}

describe("plan discovery-sweep-1014 blind-review A2 TEB-C1 turn-grain reader", () => {
  it("plan discovery-sweep-1014 blind-review A2 TEB-C1: turn rows on a mixed fixture equal the golden captured before the change", () => {
    const { db, sqlite } = makeDb();
    seedMixed(sqlite);
    expect(turnRows(db)).toEqual(GOLDEN_TURN_ROWS);
    sqlite.close();
  });

  it("plan discovery-sweep-1014 blind-review A2 TEB-C1: tool-result tokens are attributed per turn (11, 7 + 5 + 0 + 0, 3), never from a missing or null payload", () => {
    const { db, sqlite } = makeDb();
    seedMixed(sqlite);
    const byKey = new Map(turnRows(db).map((r) => [`${String(r["task_id"])}#${String(r["call_index"])}`, r["tool_call_est_result_tokens"]]));
    expect(byKey.get("ta#1")).toBe(12);
    expect(byKey.get("ta#2")).toBe(11);
    expect(byKey.get("tb#1")).toBe(3);
    sqlite.close();
  });

  it("plan discovery-sweep-1014 blind-review A2 TEB-C1: the payload text of a TOOL_RESULT row never leaves SQLite", () => {
    const { db, sqlite } = makeDb();
    seedMixed(sqlite);
    const returned = spyOnRows(sqlite);
    const rows = turnRows(db);

    expect(rows).toHaveLength(3);
    const everything = JSON.stringify(returned);
    expect(returned.length).toBeGreaterThan(0);
    expect(everything).not.toContain(SENTINEL);
    // The MODEL_RESPONSE payloads are still read (the spy sees them), so the spy is not blind.
    expect(everything).toContain("stopReason");
    sqlite.close();
  });
});
