/**
 * afa37093 (plan 9ed453c1) review corrections -- AC1 (a failed or usage-less run is not recorded as free) and
 * AC3 (a run that spent resources is never recorded as $0 / exact when it is not).
 *
 *  M1  retried attempts: every attempt that billed is counted -- summed onto the failure, folded into the success.
 *  M2  usage rebuilt from stream-json assistant snapshots is a LOWER BOUND, and usage_query says so.
 *  M3  a success with no result.usage is rebuilt from the stream, else UNMEASURED -- never a silent zero row.
 *  L8  attachPartialUsage can never replace the original error.
 *  L6  failed runs record stop_reason `error`.
 *
 * Unit lane: only child_process.spawn is replaced (ADR-0009); the retry loop, engine, UsagePlugin and usage_query are real.
 */
import { describe, expect, it, vi } from "vitest";

import { attachPartialUsage, mergePartialUsage, mergeProviderUsage, readPartialUsage, MAX_PER_TURN_USAGE } from "../providers/partial-usage.js";
import type { ProviderTokenUsage } from "../providers/partial-usage.js";
import { usageQueryByGrain } from "../tools/usage.js";
import { SPAWN_ENOENT, SPAWN_SILENT, fixture, parseStream, replayStream, serializeStream, type IReplayResult, type StreamEvent } from "./fixtures/claudecli-replay-harness.js";

vi.mock("child_process", () => ({ spawn: vi.fn() }));

const MODEL = "claude-haiku-4-5";
const init: StreamEvent = { type: "system", subtype: "init", model: MODEL };
const turn = (id: string, u: { in: number; read: number; write: number; out: number }): StreamEvent => ({
  type: "assistant",
  message: { id, content: [{ type: "text", text: "x" }], usage: { input_tokens: u.in, cache_read_input_tokens: u.read, cache_creation_input_tokens: u.write, output_tokens: u.out } },
});
interface IAttemptUsage { in: number; read: number; write: number; write1h: number; out: number }
const rawUsage = (u: IAttemptUsage): Record<string, unknown> => ({
  input_tokens: u.in, cache_read_input_tokens: u.read, cache_creation_input_tokens: u.write, output_tokens: u.out,
  cache_creation: { ephemeral_1h_input_tokens: u.write1h },
});
/** An attempt the CLI billed, then failed with an API error `status` (529 = transient/retried, 400 = final). */
const billedFailure = (status: number, u: IAttemptUsage, cost: number, numTurns: number): string =>
  serializeStream([init, turn(`m-${status}-${u.in}`, { in: u.in, read: u.read, write: u.write, out: 1 }), {
    type: "result", subtype: "error_during_execution", is_error: true, result: `API Error: ${status} failure`, api_error_status: status,
    usage: rawUsage(u), total_cost_usd: cost, num_turns: numTurns,
  }]);
const billedSuccess = (u: IAttemptUsage, cost: number, numTurns: number): string =>
  serializeStream([init, turn("m-ok", { in: u.in, read: u.read, write: u.write, out: 1 }), {
    type: "result", subtype: "success", is_error: false, result: "OK", stop_reason: "end_turn",
    usage: rawUsage(u), total_cost_usd: cost, num_turns: numTurns,
  }]);

const A1: IAttemptUsage = { in: 100, read: 200, write: 1000, write1h: 400, out: 50 };
const A2: IAttemptUsage = { in: 10, read: 30, write: 20, write1h: 20, out: 5 };
const ctx = (u: IAttemptUsage): number => u.in + u.read + u.write;

interface ITaskUsage {
  input_tokens: number; output_tokens: number; model_calls: number; est_cost_usd: number | null; cost_status: string | null;
  cli_reported_cost_usd: number | null; cache_creation_input_tokens: number | null; cache_read_input_tokens: number | null;
  cache_creation_1h_tokens: number | null; stop_reason: string | null;
}
const row = (r: IReplayResult): ITaskUsage => r.sqlite.prepare("SELECT * FROM task_usage WHERE task_id = ?").get(r.taskId) as ITaskUsage;
const taskRow = (r: IReplayResult) => usageQueryByGrain(r.db, { include_incomplete: false, limit: 5, grain: "task" }).rows[0];
const turnRows = (r: IReplayResult) => usageQueryByGrain(r.db, { include_incomplete: false, limit: 50, grain: "turn" }).rows;

describe("afa37093 AC3 / M1: every billed attempt of a retried request is counted", () => {
  it("afa37093 AC3: attempt 1 bills then fails transiently, attempt 2 succeeds -> the response usage carries BOTH attempts (tokens by type, cache tiers, CLI cost, model calls)", async () => {
    const r = await replayStream([billedFailure(529, A1, 0.01, 2), billedSuccess(A2, 0.002, 1)]);
    expect(r.error).toBeUndefined();
    expect(r.spawnCount()).toBe(2);
    const u = row(r);
    expect(u.input_tokens).toBe(ctx(A1) + ctx(A2));
    expect(u.output_tokens).toBe(A1.out + A2.out);
    expect(u.cache_read_input_tokens).toBe(A1.read + A2.read);
    expect(u.cache_creation_input_tokens).toBe(A1.write + A2.write);
    expect(u.cache_creation_1h_tokens).toBe(A1.write1h + A2.write1h);
    expect(u.cli_reported_cost_usd).toBeCloseTo(0.012, 9);
    expect(u.model_calls).toBe(3);
    expect(u.cost_status).toBe("priced");
    expect(u.est_cost_usd).toBeGreaterThan(0);
    expect(taskRow(r)?.usage_lower_bound).toBe(false); // both attempts were measured: exact
    r.close();
  });

  it("afa37093 AC3: attempt 1 bills (transient), attempt 2 fails for good -> the failed task records the SUM of both attempts, not just the last", async () => {
    const r = await replayStream([billedFailure(529, A1, 0.01, 2), billedFailure(400, A2, 0.002, 1)]);
    expect(r.taskStatus()).toBe("failed");
    expect(r.spawnCount()).toBe(2);
    const u = row(r);
    expect(u.input_tokens).toBe(ctx(A1) + ctx(A2));
    expect(u.output_tokens).toBe(A1.out + A2.out);
    expect(u.cache_creation_1h_tokens).toBe(A1.write1h + A2.write1h);
    expect(u.cli_reported_cost_usd).toBeCloseTo(0.012, 9);
    expect(u.model_calls).toBe(3);
    expect(u.stop_reason).toBe("error"); // L6
    r.close();
  });

  it("afa37093 AC3: attempt 2 never starts (spawn ENOENT) -> the failure carries attempt 1's spend exactly once; no stale or doubled partial", async () => {
    const r = await replayStream([billedFailure(529, A1, 0.01, 2), SPAWN_ENOENT]);
    expect(r.taskStatus()).toBe("failed");
    expect(r.spawnCount()).toBe(2);
    const u = row(r);
    expect(u.input_tokens).toBe(ctx(A1));
    expect(u.output_tokens).toBe(A1.out);
    expect(u.cli_reported_cost_usd).toBeCloseTo(0.01, 9);
    expect(u.model_calls).toBe(2);
    r.close();
  });

  it("afa37093 AC3: a never-started FIRST spawn spent nothing: it carries no partial and records no usage row", async () => {
    const r = await replayStream([SPAWN_ENOENT]);
    expect(r.taskStatus()).toBe("failed");
    expect(readPartialUsage(r.error)).toBeUndefined();
    expect(r.sqlite.prepare("SELECT count(*) AS n FROM task_usage WHERE task_id = ?").get(r.taskId)).toEqual({ n: 0 });
    r.close();
  });

  it("afa37093 AC3: attempt 1 bills, attempt 2 dies reporting nothing -> attempt 1's spend is kept and the sum is flagged a lower bound", async () => {
    const r = await replayStream([billedFailure(529, A1, 0.01, 2), SPAWN_SILENT]);
    expect(r.taskStatus()).toBe("failed");
    const u = row(r);
    expect(u.input_tokens).toBe(ctx(A1));
    expect(u.cli_reported_cost_usd).toBeCloseTo(0.01, 9);
    expect(taskRow(r)?.usage_lower_bound).toBe(true);
    r.close();
  });

  it("afa37093 AC3: attempt 1 died silent (transient classification impossible) is not retried; the lone marker row stays unmeasured", async () => {
    const r = await replayStream([SPAWN_SILENT]);
    expect(row(r)).toMatchObject({ cost_status: "unmeasured", est_cost_usd: null });
    r.close();
  });
});

describe("afa37093 AC3 / M2: stream-rebuilt usage is queryable as a lower bound", () => {
  const B1 = fixture("claudecli-b1-multiturn.stream.jsonl");
  const failB1 = (keepUsage: boolean): string =>
    serializeStream(parseStream(B1).map((e) => {
      if (e.type !== "result") return e;
      const failed: Record<string, unknown> = { ...e, is_error: true, subtype: "error_during_execution", result: "API Error: 400 bad request", api_error_status: 400 };
      if (!keepUsage) { delete failed["usage"]; delete failed["total_cost_usd"]; delete failed["modelUsage"]; }
      return failed as StreamEvent;
    }));

  it("afa37093 AC3: a failed run rebuilt from assistant snapshots is usage_lower_bound at task, turn and session grain; output tokens are the snapshot sum (14 vs the CLI's 998)", async () => {
    const r = await replayStream(failB1(false));
    expect(row(r).output_tokens).toBe(14);
    expect(taskRow(r)?.usage_lower_bound).toBe(true);
    expect(turnRows(r)[0]?.usage_lower_bound).toBe(true);
    expect(r.modelResponseEvents()[0]).toMatchObject({ usageLowerBound: true });
    const session = usageQueryByGrain(r.db, { include_incomplete: false, limit: 5, grain: "session" });
    expect(session.rows[0]?.usage_lower_bound).toBe(true);
    r.close();
  });

  it("afa37093 AC3: a failed run whose CLI error result carried usage is EXACT (not flagged), and so is a normal success", async () => {
    const failed = await replayStream(failB1(true));
    expect(row(failed).output_tokens).toBe(998);
    expect(taskRow(failed)?.usage_lower_bound).toBe(false);
    expect(turnRows(failed)[0]?.usage_lower_bound).toBe(false);
    failed.close();
    const ok = await replayStream(B1);
    expect(taskRow(ok)?.usage_lower_bound).toBe(false);
    ok.close();
  });
});

describe("afa37093 AC1/AC3 / M3: a success with no result.usage never looks free", () => {
  const successWithoutUsage = (withTurns: boolean): string =>
    serializeStream([
      init,
      ...(withTurns ? [turn("a", { in: 10, read: 0, write: 5_000, out: 3 }), turn("b", { in: 8, read: 5_000, write: 400, out: 2 })] : []),
      { type: "result", subtype: "success", is_error: false, result: "OK", stop_reason: "end_turn" },
    ]);

  it("afa37093 AC1: the usage is rebuilt from the stream turns (input/cache exact) and flagged a lower bound", async () => {
    const r = await replayStream(successWithoutUsage(true));
    expect(r.error).toBeUndefined();
    expect(r.taskStatus()).toBe("completed");
    const u = row(r);
    expect(u.input_tokens).toBe(10 + 5_000 + 8 + 5_000 + 400);
    expect(u.cost_status).toBe("priced");
    expect(u.est_cost_usd).toBeGreaterThan(0);
    expect(taskRow(r)?.usage_lower_bound).toBe(true);
    r.close();
  });

  it("afa37093 AC3: with nothing to rebuild from the row is unmeasured (cost NULL, never $0), visible in usage_query", async () => {
    const r = await replayStream(successWithoutUsage(false));
    expect(r.taskStatus()).toBe("completed");
    expect(row(r)).toMatchObject({ input_tokens: 0, output_tokens: 0, cost_status: "unmeasured", est_cost_usd: null });
    const t = usageQueryByGrain(r.db, { include_incomplete: false, limit: 5, grain: "task" });
    expect(t.rows[0]).toMatchObject({ cost_status: "unmeasured", est_cost_usd: null, task_status: "completed" });
    expect(t.summary.unpriced_tasks).toBe(1);
    r.close();
  });
});

describe("afa37093 AC3 / L8: attaching the spend marker can never replace the original error", () => {
  it("afa37093 AC3: frozen, sealed and non-extensible errors come back unchanged (no TypeError); an extensible one carries the marker", () => {
    for (const lock of [Object.freeze, Object.seal, Object.preventExtensions] as const) {
      const err = lock(new Error("original"));
      let returned: unknown;
      expect(() => { returned = attachPartialUsage(err, { reportedModelCalls: 1 }); }).not.toThrow();
      expect(returned).toBe(err);
      expect(readPartialUsage(err)).toBeUndefined();
    }
    const plain = new Error("plain");
    expect(readPartialUsage(attachPartialUsage(plain, { reportedModelCalls: 1 }))).toEqual({ reportedModelCalls: 1 });
    expect(attachPartialUsage("a string", { reportedModelCalls: 1 })).toBe("a string");
  });

  it("afa37093 AC3: an error holding a NON-configurable slot under the marker key does not throw either", () => {
    const err = new Error("locked slot");
    attachPartialUsage(err, { reportedModelCalls: 1 });
    const key = Object.getOwnPropertySymbols(err)[0] as symbol;
    Object.defineProperty(err, key, { value: { reportedModelCalls: 1 }, configurable: false, enumerable: false });
    expect(() => attachPartialUsage(err, { reportedModelCalls: 9 })).not.toThrow();
    expect(readPartialUsage(err)).toEqual({ reportedModelCalls: 1 });
  });
});

describe("afa37093 AC3: merging usages (unit)", () => {
  const u = (o: Partial<ProviderTokenUsage> & { inputTokens: number; outputTokens: number }): ProviderTokenUsage => o;
  it("afa37093 AC3: tokens, cache tiers, CLI cost and per-model entries add; peak is the max; unmeasured sides yield a lower bound", () => {
    const a = u({ inputTokens: 10, outputTokens: 1, uncachedInputTokens: 4, cacheReadTokens: 3, cacheCreationTokens: 3, cacheCreation1hTokens: 2, cliReportedCostUsd: 0.5, peakContextTokens: 7,
      modelBreakdown: [{ model: "m", uncachedInputTokens: 4, cacheReadTokens: 3, cacheCreationTokens: 3, cacheCreation1hTokens: 2, outputTokens: 1, reportedCostUsd: 0.5 }] });
    const b = u({ inputTokens: 20, outputTokens: 2, uncachedInputTokens: 8, cacheReadTokens: 6, cacheCreationTokens: 6, cacheCreation1hTokens: 0, peakContextTokens: 20,
      modelBreakdown: [{ model: "m", uncachedInputTokens: 8, cacheReadTokens: 6, cacheCreationTokens: 6, cacheCreation1hTokens: 0, outputTokens: 2 }] });
    expect(mergeProviderUsage(a, b)).toMatchObject({
      inputTokens: 30, outputTokens: 3, uncachedInputTokens: 12, cacheReadTokens: 9, cacheCreationTokens: 9, cacheCreation1hTokens: 2, cliReportedCostUsd: 0.5, peakContextTokens: 20,
      modelBreakdown: [{ model: "m", uncachedInputTokens: 12, cacheReadTokens: 9, cacheCreationTokens: 9, cacheCreation1hTokens: 2, outputTokens: 3, reportedCostUsd: 0.5 }],
    });
    const unmeasured = u({ inputTokens: 0, outputTokens: 0, unmeasured: true });
    expect(mergeProviderUsage(a, unmeasured)).toMatchObject({ inputTokens: 10, usageLowerBound: true });
    expect(mergeProviderUsage(unmeasured, b)).toMatchObject({ inputTokens: 20, usageLowerBound: true });
    expect(mergeProviderUsage(unmeasured, unmeasured).unmeasured).toBe(true);
    expect(mergePartialUsage(undefined, { reportedModelCalls: 2 })).toEqual({ reportedModelCalls: 2 });
    expect(mergePartialUsage({ usage: a, reportedModelCalls: 1 }, {}).usage?.usageLowerBound).toBe(true);
  });

  it("afa37093 AC3: a breakdown covering only one side is dropped (it would misprice the rest); per-turn lists concatenate under the cap", () => {
    const turnU = { uncachedInputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 1, contextTokens: 1 };
    const a = u({ inputTokens: 1, outputTokens: 1, firstTurnContextTokens: 1, perTurnUsage: Array.from({ length: 40 }, () => turnU),
      modelBreakdown: [{ model: "m", uncachedInputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0, outputTokens: 1 }] });
    const b = u({ inputTokens: 1, outputTokens: 1, firstTurnContextTokens: 1, perTurnUsage: Array.from({ length: 40 }, () => turnU) });
    const m = mergeProviderUsage(a, b);
    expect(m.modelBreakdown).toBeUndefined();
    expect(m.perTurnUsage).toHaveLength(MAX_PER_TURN_USAGE);
    expect(m.perTurnUsageTruncated).toBe(true);
    expect(mergeProviderUsage(a, u({ inputTokens: 1, outputTokens: 1 })).perTurnUsage).toBeUndefined();
  });
});
