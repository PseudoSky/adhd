/**
 * debd934d (plan 9ed453c1) -- claudecli first-turn context + bounded per-turn array.
 *
 *  AC1  usage_query turn grain returns first-turn input/cache tokens for claudecli tasks.
 *  AC2  the MODEL_RESPONSE payload carries firstTurnContextTokens and a per-turn array (bounded).
 *  AC3  existing peakContextTokens is unchanged.
 *
 * Real ClaudeCliProvider + Orchestrator + UsagePlugin + migrated SQLite (fixtures/claudecli-replay-harness.ts);
 * only `child_process.spawn` is replaced, by recorded `claude -p` transcripts (B1: task 62bf63b1, whose first
 * assistant message reports input 10 + cache_creation 5,637 + cache_read 0 = 5,647).
 */
import { describe, expect, it, vi } from "vitest";

import { CliTurnTracker } from "../providers/claudecli.js";
import { MAX_PER_TURN_USAGE } from "../providers/partial-usage.js";
import { usageQueryByGrain } from "../tools/usage.js";
import { fixture, parseStream, replayStream, serializeStream } from "./fixtures/claudecli-replay-harness.js";
import type { StreamEvent } from "./fixtures/claudecli-replay-harness.js";

vi.mock("child_process", () => ({ spawn: vi.fn() }));

const B1 = fixture("claudecli-b1-multiturn.stream.jsonl");

/** B1's per-call contexts, read from the recorded stream itself (one entry per distinct message id). */
const B1_TURNS = [
  { uncached: 10, read: 0, write: 5_637, out: 6 },
  { uncached: 8, read: 5_637, write: 513, out: 2 },
  { uncached: 8, read: 6_150, write: 762, out: 1 },
  { uncached: 8, read: 6_912, write: 1_795, out: 4 },
  { uncached: 8, read: 8_707, write: 434, out: 1 },
];

/** A synthetic stream of `n` model calls (distinct message ids, two content-block events each) ending in a success result. */
function manyTurns(n: number): string {
  const events: StreamEvent[] = [{ type: "system", subtype: "init", model: "claude-haiku-4-5" }];
  for (let i = 1; i <= n; i++) {
    const usage = { input_tokens: 1, cache_read_input_tokens: i * 100, cache_creation_input_tokens: 10, output_tokens: 2 };
    for (const block of ["text", "tool_use"]) {
      events.push({ type: "assistant", message: { id: `msg_${i}`, role: "assistant", content: [{ type: block }], usage } });
    }
  }
  events.push({
    type: "result", subtype: "success", is_error: false, result: "done", num_turns: n,
    usage: { input_tokens: n, output_tokens: 2 * n, cache_read_input_tokens: 100 * n, cache_creation_input_tokens: 10 * n },
  });
  return serializeStream(events);
}

describe("debd934d: claudecli first-turn context and per-turn breakdown", () => {
  it("debd934d AC2: the MODEL_RESPONSE payload carries firstTurnContextTokens and one per-turn entry per model call (deduped by message id)", async () => {
    const r = await replayStream(B1);
    expect(r.error).toBeUndefined();
    const [payload] = r.modelResponseEvents();
    expect(payload?.["firstTurnContextTokens"]).toBe(5_647);
    const perTurn = payload?.["perTurnUsage"] as Array<Record<string, number>>;
    expect(perTurn).toHaveLength(5); // 10 assistant events, 5 distinct message ids
    expect(perTurn.map((t) => t["contextTokens"])).toEqual(B1_TURNS.map((t) => t.uncached + t.read + t.write));
    expect(perTurn[0]).toEqual({
      uncachedInputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 5_637, outputTokens: 6, contextTokens: 5_647,
    });
    expect(payload?.["perTurnUsageTruncated"]).toBeUndefined();
    r.close();
  });

  it("debd934d AC2: the per-turn array is bounded; the first turns are kept and the truncation is flagged", async () => {
    const n = MAX_PER_TURN_USAGE + 20;
    const r = await replayStream(manyTurns(n));
    const [payload] = r.modelResponseEvents();
    const perTurn = payload?.["perTurnUsage"] as Array<Record<string, number>>;
    expect(perTurn).toHaveLength(MAX_PER_TURN_USAGE);
    expect(perTurn[0]?.["contextTokens"]).toBe(1 + 100 + 10);
    expect(payload?.["perTurnUsageTruncated"]).toBe(true);
    // The peak still reflects EVERY call, not just the retained ones.
    expect(payload?.["peakContextTokens"]).toBe(1 + n * 100 + 10);
    r.close();
  });

  it("debd934d AC1: usage_query turn grain returns the first-turn input and cache tokens for the claudecli task", async () => {
    const r = await replayStream(B1);
    const turn = usageQueryByGrain(r.db, { include_incomplete: true, limit: 50, grain: "turn" });
    expect(turn.rows).toHaveLength(1);
    expect(turn.rows[0]?.first_turn).toEqual({
      uncached_input_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 5_637, output_tokens: 6, context_tokens: 5_647,
    });
    expect(turn.rows[0]?.per_turn).toHaveLength(5);
    expect(turn.rows[0]?.per_turn_truncated).toBe(false);
    // The first turn is NOT the folded sum (36,589) and NOT the peak (9,149): the gate needs exactly this number.
    expect(turn.rows[0]?.first_turn?.context_tokens).not.toBe(turn.rows[0]?.input_tokens);
    expect(turn.rows[0]?.first_turn?.context_tokens).not.toBe(turn.rows[0]?.context_size);
    r.close();
  });

  it("debd934d AC3: peakContextTokens is unchanged -- 9,149 in the payload, the task row and every grain", async () => {
    const r = await replayStream(B1);
    const [payload] = r.modelResponseEvents();
    expect(payload?.["peakContextTokens"]).toBe(9_149);
    const row = r.sqlite.prepare("SELECT peak_context_tokens, input_tokens FROM task_usage WHERE task_id = ?").get(r.taskId) as { peak_context_tokens: number; input_tokens: number };
    expect(row.peak_context_tokens).toBe(9_149);
    expect(row.input_tokens).toBe(36_589);
    expect(usageQueryByGrain(r.db, { include_incomplete: true, limit: 5, grain: "turn" }).rows[0]?.context_size).toBe(9_149);
    r.close();
  });

  it("debd934d AC1: a stream with no assistant usage reports no first turn (null, never a fabricated 0)", async () => {
    const stripped = serializeStream(parseStream(B1).map((e) => {
      if (e.type === "assistant") delete (e["message"] as Record<string, unknown>)["usage"];
      return e;
    }));
    const r = await replayStream(stripped);
    const [payload] = r.modelResponseEvents();
    expect(payload?.["firstTurnContextTokens"]).toBeUndefined();
    expect(usageQueryByGrain(r.db, { include_incomplete: true, limit: 5, grain: "turn" }).rows[0]?.first_turn).toBeNull();
    r.close();
  });

  it("debd934d AC2: CliTurnTracker keys turns by message id, takes the largest figure per id, and treats id-less events as separate turns", () => {
    const t = new CliTurnTracker();
    const ev = (id: string | undefined, input: number, out: number) => ({
      type: "assistant" as const,
      message: { role: "assistant" as const, content: [], ...(id ? { id } : {}), usage: { input_tokens: input, output_tokens: out } },
    });
    t.record(ev("a", 5, 1));
    t.record(ev("a", 5, 9)); // same call, later block: output grew
    t.record(ev(undefined, 7, 1));
    t.record(ev(undefined, 7, 1));
    expect(t.count).toBe(3);
    expect(t.firstTurnContextTokens).toBe(5);
    expect(t.perTurn().entries[0]?.outputTokens).toBe(9);
  });
});
