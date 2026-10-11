/**
 * b3999dfa AC2: the usage read path never binds more ids into one `IN (...)` than SQLite allows.
 *
 * A scope with more tasks than SQLITE_MAX_VARIABLE_NUMBER used to throw "too many SQL variables" from the
 * task/session grains (`lowerBoundTaskIds`) and the turn grain. Real migrated SQLite; the id count is chosen
 * ABOVE the limit of stock SQLite builds (the test asserts a single statement of that size is rejected), so the test fails
 * if chunking is removed.
 */
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";

import * as schema from "@adhd/agent-store-runtime";

import { SQL_IN_CHUNK_SIZE, usageQueryByGrain, type Database as OrchestratorDb } from "../tools/usage.js";
import { createMigratedSqlite } from "./fixtures/real-schema-db.js";

/** More ids than any stock SQLite build binds in one statement (999 before 3.32, 32766 after). */
const ID_COUNT = 33_000;

/** True when ONE statement binding `n` parameters is rejected by this SQLite build. */
function singleStatementRejects(sqlite: ReturnType<typeof createMigratedSqlite>, n: number): boolean {
  try {
    sqlite.prepare(`SELECT 1 WHERE 1 IN (${Array.from({ length: n }, () => "?").join(",")})`);
    return false;
  } catch (e) {
    return /too many SQL variables/i.test(String(e));
  }
}

describe("b3999dfa AC2: id lists are chunked under the SQLite host-parameter limit", () => {
  it("b3999dfa AC2: task, session and turn grains answer for more tasks than one IN clause can bind, and flag the lower-bound task", () => {
    const sqlite = createMigratedSqlite();
    expect(SQL_IN_CHUNK_SIZE).toBeLessThan(999); // under the oldest SQLite limit too
    const count = ID_COUNT;
    // Precondition (fails loudly on a SQLite build with a larger limit): an unchunked IN over `count` ids cannot work.
    expect(singleStatementRejects(sqlite, count)).toBe(true);
    const db = drizzle(sqlite, { schema }) as unknown as OrchestratorDb;
    const at = "2026-01-01T00:00:00.000Z";
    const insTask = sqlite.prepare(`INSERT INTO tasks (id, session_id, status, prompt, created_at, updated_at) VALUES (?, 'sess-big', 'completed', 'p', ?, ?)`);
    const insUsage = sqlite.prepare(
      `INSERT INTO task_usage (task_id, agent_name, provider_type, model, input_tokens, output_tokens, model_calls, is_complete,
         uncached_input_tokens, cache_read_input_tokens, cache_creation_input_tokens, peak_context_tokens, created_at)
       VALUES (?, 'a', 'openai', 'm', 10, 1, 1, 1, 10, 0, 0, 10, ?)`
    );
    const insEvent = sqlite.prepare(`INSERT INTO task_events (id, task_id, type, payload, created_at) VALUES (?, ?, 'MODEL_RESPONSE', ?, ?)`);
    const lowerBoundTask = `t-${String(count - 1).padStart(6, "0")}`; // lands in the LAST chunk
    sqlite.transaction(() => {
      for (let i = 0; i < count; i++) {
        const id = `t-${String(i).padStart(6, "0")}`;
        insTask.run(id, at, at);
        insUsage.run(id, at);
        insEvent.run(`e-${i}`, id, JSON.stringify({ inputTokens: 10, outputTokens: 1, ...(id === lowerBoundTask ? { usageLowerBound: true } : {}) }), at);
      }
    })();

    const task = usageQueryByGrain(db, { include_incomplete: true, limit: count, grain: "task" });
    expect(task.rows).toHaveLength(count);
    expect(task.rows.filter((r) => r.usage_lower_bound).map((r) => r.task_id)).toEqual([lowerBoundTask]);

    const session = usageQueryByGrain(db, { include_incomplete: true, limit: count, grain: "session" });
    expect(session.rows).toHaveLength(1);
    expect(session.rows[0]?.usage_lower_bound).toBe(true);

    const turn = usageQueryByGrain(db, { include_incomplete: true, limit: count, grain: "turn" });
    expect(turn.rows).toHaveLength(count);
    sqlite.close();
  });
});
