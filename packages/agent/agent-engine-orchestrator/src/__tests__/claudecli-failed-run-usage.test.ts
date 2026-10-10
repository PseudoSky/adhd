/**
 * afa37093 (plan 9ed453c1) -- failed claudecli runs record the usage and cost they spent.
 *
 * This file is the unit lane (spawn replaced by crafted transcripts). The same ACs are driven against a REAL
 * child process (fake claude fixtures) for the timeout / cancel / fatal-after-return paths in
 * claudecli-failed-run-usage.e2e.test.ts (ADR-0009).
 *
 *  AC1  an is_error CLI result records a usage row carrying the tokens and the cli_reported cost the CLI emitted.
 *  AC3  a run that reported nothing is recorded as a zero row marked unmeasured (cost UNKNOWN, never $0).
 *  AC4  usage_query returns these rows with the failed task status.
 */
import { describe, expect, it, vi } from "vitest";

import { attachPartialUsage, readPartialUsage } from "../providers/partial-usage.js";
import { usageQueryByGrain } from "../tools/usage.js";
import { Readable } from "node:stream";
import type { EngineConfig } from "../interfaces.js";
import { TripRegistry } from "../providers/provider-failure.js";
import type { ProviderChatRequest } from "../providers/types.js";
import { FakeClock } from "./fixtures/fake-clock.js";
import { fixture, parseStream, replayStream, serializeStream, silentLogger } from "./fixtures/claudecli-replay-harness.js";

vi.mock("child_process", () => ({ spawn: vi.fn() }));

const B1 = fixture("claudecli-b1-multiturn.stream.jsonl");

/** B1 with its final `result` turned into an API error (status 400: not transient, so exactly one spawn). */
function failingB1(opts: { keepUsage: boolean }): string {
  return serializeStream(parseStream(B1).map((e) => {
    if (e.type !== "result") return e;
    const failed: Record<string, unknown> = { ...e, is_error: true, subtype: "error_during_execution", result: "API Error: 400 bad request", api_error_status: 400 };
    if (!opts.keepUsage) {
      delete failed["usage"];
      delete failed["total_cost_usd"];
      delete failed["modelUsage"];
    }
    return failed as typeof e;
  }));
}

interface ITaskUsage {
  input_tokens: number; output_tokens: number; model_calls: number; est_cost_usd: number | null;
  cost_status: string | null; cli_reported_cost_usd: number | null; is_complete: number; cache_creation_1h_tokens: number | null;
}
const usageRow = (sqlite: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } }, taskId: string): ITaskUsage | undefined =>
  sqlite.prepare("SELECT * FROM task_usage WHERE task_id = ?").get(taskId) as ITaskUsage | undefined;

describe("afa37093: usage of failed claudecli runs", () => {
  it("afa37093 AC1: an is_error result records the CLI's tokens and total_cost_usd, priced, on a failed task", async () => {
    const r = await replayStream(failingB1({ keepUsage: true }));
    expect(r.error).toBeDefined();
    expect(r.taskStatus()).toBe("failed");
    const row = usageRow(r.sqlite, r.taskId);
    expect(row).toBeDefined();
    expect(row?.input_tokens).toBe(36_589); // the same cache-inclusive figure a successful B1 records
    expect(row?.output_tokens).toBe(998);
    expect(row?.cli_reported_cost_usd).toBeCloseTo(0.0260546, 6);
    expect(row?.cost_status).toBe("priced");
    expect(row?.est_cost_usd).toBeCloseTo(0.0260546, 6); // the estimate matches the CLI's own figure
    expect(row?.is_complete).toBe(1); // the terminal handler completed the row, so default usage_query shows it
    r.close();
  });

  it("afa37093 AC4: usage_query (task and turn grain, default filters) returns the failed run's row with task_status failed", async () => {
    const r = await replayStream(failingB1({ keepUsage: true }));
    const task = usageQueryByGrain(r.db, { include_incomplete: false, limit: 50, grain: "task" });
    expect(task.rows).toHaveLength(1);
    expect(task.rows[0]).toMatchObject({ task_status: "failed", input_tokens: 36_589, cli_reported_cost_usd: expect.closeTo(0.0260546, 6) });
    const turn = usageQueryByGrain(r.db, { include_incomplete: false, limit: 50, grain: "turn" });
    expect(turn.rows).toHaveLength(1);
    expect(turn.rows[0]).toMatchObject({ task_status: "failed", input_tokens: 36_589 });
    expect(turn.rows[0]?.est_cost_usd).toBeCloseTo(0.0260546, 6);
    expect(turn.summary.est_cost_usd).toBeCloseTo(0.0260546, 6);
    r.close();
  });

  it("afa37093 AC1: an is_error result WITHOUT usage still records the spend the stream showed (sum of the per-turn usage)", async () => {
    const r = await replayStream(failingB1({ keepUsage: false }));
    expect(r.taskStatus()).toBe("failed");
    const row = usageRow(r.sqlite, r.taskId);
    // Σ over the five distinct model calls of uncached + cache_read + cache_creation
    const expected = [[10, 0, 5_637], [8, 5_637, 513], [8, 6_150, 762], [8, 6_912, 1_795], [8, 8_707, 434]].flat().reduce((a, b) => a + b, 0);
    expect(row?.input_tokens).toBe(expected);
    expect(row?.cost_status).toBe("priced");
    expect(row?.cli_reported_cost_usd).toBeNull(); // the CLI reported none; never invented
    expect(row?.est_cost_usd).toBeGreaterThan(0);
    r.close();
  });

  it("afa37093 AC3: an is_error run that emitted no usage at all is a zero row marked unmeasured -- cost NULL, never $0 -- visible as failed", async () => {
    const noUsage = serializeStream(parseStream(failingB1({ keepUsage: false })).filter((e) => e.type !== "assistant"));
    const r = await replayStream(noUsage);
    expect(r.taskStatus()).toBe("failed");
    const row = usageRow(r.sqlite, r.taskId);
    expect(row).toMatchObject({ input_tokens: 0, output_tokens: 0, model_calls: 0, cost_status: "unmeasured", est_cost_usd: null, is_complete: 1 });
    const task = usageQueryByGrain(r.db, { include_incomplete: false, limit: 5, grain: "task" });
    expect(task.rows[0]).toMatchObject({ task_status: "failed", cost_status: "unmeasured", est_cost_usd: null });
    expect(task.summary.est_cost_usd).toBeNull();
    expect(task.summary.unpriced_tasks).toBe(1);
    const turn = usageQueryByGrain(r.db, { include_incomplete: false, limit: 5, grain: "turn" });
    expect(turn.rows[0]).toMatchObject({ cost_status: "unmeasured", est_cost_usd: null, task_status: "failed" });
    r.close();
  });

  it("afa37093 AC1: a failed run's MODEL_RESPONSE event is marked failed so turn consumers can tell it from a completed turn", async () => {
    const r = await replayStream(failingB1({ keepUsage: true }));
    const [payload] = r.modelResponseEvents();
    expect(payload).toMatchObject({ failed: true, failure: "provider_error", stopReason: "error", hasContent: false });
    r.close();
  });

  it("afa37093 AC3: a CLI that started but died with no output carries an (empty) partial-usage marker; a spawn that never started carries none", async () => {
    const { spawn } = await import("child_process");
    const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;
    const { ClaudeCliProvider } = await import("../providers/claudecli.js");
    const retryRuntime = { clock: new FakeClock(), rng: () => 0, registry: new TripRegistry() };
    const config = {
      server: { contextLimit: 0, defaultMaxTokens: 8192 }, queue: { concurrency: 1 }, sse: { baseUrl: "" }, plugins: { entries: [] },
      getProviderConfig: () => ({}), subprocessEnv: () => ({ PATH: "/nowhere/bin" }), resolveEnvName: () => undefined,
    } as unknown as EngineConfig;
    const request = { messages: [{ role: "user", content: "hi" } as ProviderChatRequest["messages"][number]] };
    const run = async (kind: "spawn-error" | "died"): Promise<unknown> => {
      const stdout = new Readable({ read() {} });
      spawnMock.mockReset();
      spawnMock.mockReturnValue({
        stdout, stdin: { write: () => true, end: () => {} }, stderr: new Readable({ read() {} }),
        on: (event: string, cb: (e: Error) => void) => {
          if (event === "error" && kind === "spawn-error") queueMicrotask(() => { cb(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" })); stdout.push(null); });
        },
        once: () => {}, kill: vi.fn(), exitCode: kind === "died" ? 1 : 0, signalCode: null, killed: false,
      });
      if (kind === "died") queueMicrotask(() => stdout.push(null));
      const provider = new ClaudeCliProvider({ type: "claudecli", model: "claude-haiku-4-5" }, {}, undefined, config, silentLogger, undefined, { retryRuntime });
      return provider.chat(request).catch((e: unknown) => e);
    };
    expect(readPartialUsage(await run("spawn-error"))).toBeUndefined();
    expect(readPartialUsage(await run("died"))).toEqual({});
  });

  it("afa37093: partial usage rides on the error and survives callWithRetry's re-wrapping as a cause", () => {
    const e = new Error("inner");
    expect(readPartialUsage(e)).toBeUndefined();
    attachPartialUsage(e, { reportedModelCalls: 2 });
    expect(readPartialUsage(new Error("outer", { cause: e }))).toEqual({ reportedModelCalls: 2 });
  });
});
