/**
 * b3999dfa AC2: the usage read path never binds more ids into one `IN (...)` than SQLite allows.
 *
 * A scope with more tasks than SQLITE_MAX_VARIABLE_NUMBER used to throw "too many SQL variables" from the
 * task/session grains (`lowerBoundTaskIds`) and the turn grain. Real migrated SQLite; the id count is chosen
 * ABOVE the limit of stock SQLite builds (the test asserts a single statement of that size is rejected), so the test fails
 * if chunking is removed.
 *
 * b941dcd3 AC2: the 33k-task seed (99k inserts) and the three full-scope grain queries (~0.3-0.4 s CPU each, measured
 * 1.1-4.7 s per query on a host at load average 100-200) are paid once in `beforeAll` with an explicit budget. The
 * grain assertions are separate `it`s over those captured results, so CPU contention on the host cannot push an
 * assertion past the default 5 s test timeout. A query that throws (e.g. "too many SQL variables") is captured and
 * rethrown by exactly the `it` for its grain.
 */
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@adhd/agent-store-runtime";

import { SQL_IN_CHUNK_SIZE, usageQueryByGrain, type Database as OrchestratorDb } from "../../src/tools/usage.js";
import { createMigratedSqlite } from "../fixtures/real-schema-db.js";

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

/** Explicit budget for the one-time seed plus the three grain queries (mirrors COLD_IMPORT_TIMEOUT_MS in claudecli-temp-root.test.ts). */
const SEED_TIMEOUT_MS = 60_000;

type Usage = ReturnType<typeof usageQueryByGrain>;
type Settled = { ok: true; value: Usage } | { ok: false; error: unknown };

/** Runs one grain query, capturing a throw so the `it` for that grain (not the hook) reports it. */
function settle(run: () => Usage): Settled {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return { ok: false, error };
  }
}

function unwrap(r: Settled | undefined): Usage {
  if (!r) throw new Error("grain query did not run: beforeAll seed failed");
  if (!r.ok) throw r.error;
  return r.value;
}

describe("b3999dfa AC2: id lists are chunked under the SQLite host-parameter limit", () => {
  it("b3999dfa AC2 / b941dcd3 AC2: an unchunked IN over ID_COUNT ids is rejected by this SQLite build and SQL_IN_CHUNK_SIZE is under the oldest limit", () => {
    const sqlite = createMigratedSqlite();
    try {
      expect(SQL_IN_CHUNK_SIZE).toBeLessThan(999); // under the oldest SQLite limit too
      // Precondition (fails loudly on a SQLite build with a larger limit): an unchunked IN over `count` ids cannot work.
      expect(singleStatementRejects(sqlite, ID_COUNT)).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  describe("over one seeded database", () => {
    const count = ID_COUNT;
    const lowerBoundTask = `t-${String(count - 1).padStart(6, "0")}`; // lands in the LAST chunk
    let sqlite: ReturnType<typeof createMigratedSqlite>;
    let db: OrchestratorDb;
    let taskRes: Settled | undefined;
    let sessionRes: Settled | undefined;
    let turnRes: Settled | undefined;

    beforeAll(() => {
      sqlite = createMigratedSqlite();
      db = drizzle(sqlite, { schema }) as unknown as OrchestratorDb;
      const at = "2026-01-01T00:00:00.000Z";
      const insTask = sqlite.prepare(`INSERT INTO tasks (id, session_id, status, prompt, created_at, updated_at) VALUES (?, 'sess-big', 'completed', 'p', ?, ?)`);
      const insUsage = sqlite.prepare(
        `INSERT INTO task_usage (task_id, agent_name, provider_type, model, input_tokens, output_tokens, model_calls, is_complete,
           uncached_input_tokens, cache_read_input_tokens, cache_creation_input_tokens, peak_context_tokens, created_at)
         VALUES (?, 'a', 'openai', 'm', 10, 1, 1, 1, 10, 0, 0, 10, ?)`
      );
      const insEvent = sqlite.prepare(`INSERT INTO task_events (id, task_id, type, payload, created_at) VALUES (?, ?, 'MODEL_RESPONSE', ?, ?)`);
      sqlite.transaction(() => {
        for (let i = 0; i < count; i++) {
          const id = `t-${String(i).padStart(6, "0")}`;
          insTask.run(id, at, at);
          insUsage.run(id, at);
          insEvent.run(`e-${i}`, id, JSON.stringify({ inputTokens: 10, outputTokens: 1, ...(id === lowerBoundTask ? { usageLowerBound: true } : {}) }), at);
        }
      })();
      taskRes = settle(() => usageQueryByGrain(db, { include_incomplete: true, limit: count, grain: "task" }));
      sessionRes = settle(() => usageQueryByGrain(db, { include_incomplete: true, limit: count, grain: "session" }));
      turnRes = settle(() => usageQueryByGrain(db, { include_incomplete: true, limit: count, grain: "turn" }));
    }, SEED_TIMEOUT_MS);

    afterAll(() => {
      sqlite?.close();
    });

    it("b3999dfa AC2 / b941dcd3 AC2: task grain answers for more tasks than one IN clause can bind, and flags exactly the last-chunk lower-bound task", () => {
      const task = unwrap(taskRes);
      expect(task.rows).toHaveLength(count);
      expect(task.rows.filter((r) => r.usage_lower_bound).map((r) => r.task_id)).toEqual([lowerBoundTask]);
    });

    it("b3999dfa AC2 / b941dcd3 AC2: session grain answers for more tasks than one IN clause can bind, and carries the lower-bound flag", () => {
      const session = unwrap(sessionRes);
      expect(session.rows).toHaveLength(1);
      expect(session.rows[0]?.usage_lower_bound).toBe(true);
    });

    it("b3999dfa AC2 / b941dcd3 AC2: turn grain answers for more tasks than one IN clause can bind", () => {
      const turn = unwrap(turnRes);
      expect(turn.rows).toHaveLength(count);
    });
  });
});
