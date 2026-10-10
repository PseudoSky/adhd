/**
 * 9ed453c1 / de6bee5d FLT — fault and rate-limit parity for the `claudecli` provider.
 *
 * Unit lane (ADR-0009): the child is a scripted fake injected through the `wire.spawn` seam; nothing
 * is spawned. The stream shapes come from the claude 2.1.296 binary's own result / rate_limit_event
 * schema (`rate_limit_info.status` allowed|allowed_warning|rejected, `resetsAt` epoch seconds,
 * result `api_error_status`) and recorded `allowed`/`allowed_warning` events. A `rejected` event and
 * an `is_error` limit result were never captured live (no traffic was sent to trigger one), so those
 * fixtures are SYNTHETIC and say so. Real-process proofs: `flt-claudecli-faults.e2e.test.ts`.
 *
 *  FLT-AC1  a rate-limit / usage-window result -> PROVIDER_RATE_LIMITED with reset time, retryable per
 *           class, never PROVIDER_AUTH_ERROR / empty-result; transient 429/529 retried, windows not.
 *  FLT-AC3  non-zero exit surfaces exit code + stderr; exit 0 with nothing is still the auth hint.
 *  FLT-AC4  a window trip on one task fails a sibling on the same credential with zero spawns.
 *  FLT-AC5  abort kills the child and is never retried.
 */
import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

import { ClaudeCliProvider } from "../providers/claudecli.js";
import { ProviderCallError, TripRegistry, classifyCliFault, parseCliRateLimitEvent } from "../providers/provider-failure.js";
import type { RetryRuntime } from "../providers/provider-failure.js";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import type { ProviderChatRequest } from "../providers/types.js";
import { ToolError } from "../validation/errors.js";
import { FakeClock } from "./fixtures/fake-clock.js";

const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const line = (o: unknown): string => JSON.stringify(o) + "\n";
const OK_RESULT = line({ type: "result", subtype: "success", is_error: false, result: "OK" });

interface IScript {
  lines?: string[];
  stderr?: string;
  exitCode?: number | null;
  /** Never ends stdout (a hung turn); only `kill` ends it. */
  hang?: boolean;
}

function fakeProc(s: IScript) {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const proc = {
    stdout,
    stderr,
    stdin: { write: () => true, end: () => {} },
    pid: undefined as number | undefined,
    exitCode: s.hang ? (null as number | null) : (s.exitCode ?? 0),
    signalCode: null as NodeJS.Signals | null,
    killed: false,
    on: (_e: string, _cb: unknown) => proc,
    once: (_e: string, _cb: unknown) => proc,
    kill: vi.fn((sig?: NodeJS.Signals) => {
      proc.killed = true;
      proc.signalCode = sig ?? "SIGTERM";
      stdout.push(null);
      return true;
    }),
  };
  queueMicrotask(() => {
    if (s.stderr) stderr.push(s.stderr);
    stderr.push(null);
    for (const l of s.lines ?? []) stdout.push(l);
    if (!s.hang) stdout.push(null);
  });
  return proc;
}

function rig(scripts: IScript[], opts: { registry?: TripRegistry; clock?: FakeClock; rng?: () => number } = {}) {
  const clock = opts.clock ?? new FakeClock();
  const runtime: RetryRuntime = { clock, rng: opts.rng ?? (() => 0), registry: opts.registry ?? new TripRegistry() };
  const procs: Array<ReturnType<typeof fakeProc>> = [];
  const spawn = vi.fn(() => {
    const p = fakeProc(scripts[Math.min(procs.length, scripts.length - 1)]!);
    procs.push(p);
    return p;
  });
  const engineConfig = {
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    queue: { concurrency: 1 },
    sse: { baseUrl: "" },
    plugins: { entries: [] },
    getProviderConfig: () => ({}),
    subprocessEnv: () => ({ PATH: "/nowhere/bin" }),
    resolveEnvName: (() => undefined) as unknown as EngineConfig["resolveEnvName"],
    wire: { spawn },
  } as unknown as EngineConfig;
  const provider = new ClaudeCliProvider(
    { type: "claudecli", model: "claude-haiku-4-5" },
    {},
    undefined,
    engineConfig,
    logger,
    undefined,
    { retryRuntime: runtime }
  );
  return { provider, spawn, procs, clock, runtime };
}

const request = (signal?: AbortSignal): ProviderChatRequest => ({
  messages: [{ role: "user", content: "Say OK" } as ProviderChatRequest["messages"][number]],
  ...(signal ? { signal } : {}),
});

const rejectedEvent = (resetsAtSec: number) =>
  line({
    type: "rate_limit_event",
    // SYNTHETIC: shape per the claude 2.1.296 schema; a live `rejected` was never captured.
    rate_limit_info: { status: "rejected", resetsAt: resetsAtSec, rateLimitType: "five_hour", overageStatus: "rejected" },
  });

describe("de6bee5d FLT-AC1: usage-window and rate-limit results", () => {
  it("FLT-AC1: a rejected five_hour window + is_error result -> PROVIDER_RATE_LIMITED with the reset time, not retryable, not AUTH", async () => {
    const r = rig([{ lines: [rejectedEvent(1_800_003_600), line({ type: "result", subtype: "success", is_error: true, result: "5-hour limit reached ∙ resets 3pm" })] }]);
    const settled = await r.clock.settle(r.provider.chat(request()));
    expect(settled.status).toBe("rejected");
    const e = (settled as PromiseRejectedResult).reason as ProviderCallError;
    expect(e).toBeInstanceOf(ProviderCallError);
    expect(e.code).toBe("PROVIDER_RATE_LIMITED");
    expect(e.code).not.toBe("PROVIDER_AUTH_ERROR");
    expect(e.data.class).toBe("rate_limited");
    expect(e.data.scope).toBe("credential");
    expect(e.data.retryable).toBe(false);
    expect(e.data.resumable).toBe(true);
    expect(e.resetAt).toBe(new Date(1_800_003_600_000).toISOString());
    expect(e.message).toContain(new Date(1_800_003_600_000).toISOString());
    expect(r.spawn).toHaveBeenCalledTimes(1); // zero retries for a window
    expect(r.clock.sleeps).toEqual([]);
  });

  it("FLT-AC1: a window stated only in anchored result text (no event) is also a non-retryable rate limit", async () => {
    const r = rig([{ lines: [line({ type: "result", subtype: "success", is_error: true, result: "You've hit your weekly limit · resets Mon 9am" })] }]);
    const settled = await r.clock.settle(r.provider.chat(request()));
    const e = (settled as PromiseRejectedResult).reason as ProviderCallError;
    expect(e.code).toBe("PROVIDER_RATE_LIMITED");
    expect(e.data.retryable).toBe(false);
    expect(r.spawn).toHaveBeenCalledTimes(1);
  });

  it("FLT-AC1: a transient 429 result (api_error_status) is rate_limited AND retryable, retried once with backoff", async () => {
    const r = rig([
      { lines: [line({ type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "API Error: 429 rate_limit_error" })] },
      { lines: [OK_RESULT] },
    ]);
    const settled = await r.clock.settle(r.provider.chat(request()));
    expect(settled.status).toBe("fulfilled");
    expect(r.spawn).toHaveBeenCalledTimes(2);
    expect(r.clock.sleeps).toHaveLength(1);
  });

  it("FLT-AC1: a 529 overloaded result is PROVIDER_OVERLOADED, retryable, bounded at 3 spawns", async () => {
    const r = rig([{ lines: [line({ type: "result", subtype: "success", is_error: true, api_error_status: 529, result: "Overloaded" })] }]);
    const settled = await r.clock.settle(r.provider.chat(request()));
    const e = (settled as PromiseRejectedResult).reason as ProviderCallError;
    expect(e.code).toBe("PROVIDER_OVERLOADED");
    expect(e.data.retryable).toBe(true);
    expect(r.spawn).toHaveBeenCalledTimes(3);
  });

  it("FLT-AC1: a transient failure AFTER a tool ran is not retried (a re-spawn would repeat side effects)", async () => {
    const toolTurn = line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } });
    const r = rig([{ lines: [toolTurn, line({ type: "result", subtype: "success", is_error: true, api_error_status: 529, result: "Overloaded" })] }, { lines: [OK_RESULT] }]);
    const settled = await r.clock.settle(r.provider.chat(request()));
    expect(settled.status).toBe("rejected");
    expect(r.spawn).toHaveBeenCalledTimes(1);
  });

  it("FLT-AC1 / FLT-4: an allowed_warning window event is surfaced on the response, not swallowed", async () => {
    const warn = line({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning", resetsAt: 1_800_003_600, rateLimitType: "seven_day", utilization: 0.5 },
    });
    const r = rig([{ lines: [warn, OK_RESULT] }]);
    const res = await r.provider.chat(request());
    expect(res.limitWarnings).toEqual([
      { kind: "usage_window", status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.5, resetsAt: new Date(1_800_003_600_000).toISOString() },
    ]);
  });

  it("FLT-AC1: a plain `allowed` event produces no warning", async () => {
    const r = rig([{ lines: [line({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }), OK_RESULT] }]);
    expect((await r.provider.chat(request())).limitWarnings).toBeUndefined();
  });
});

describe("de6bee5d FLT-AC3: process faults surface binary / exit / stderr, never AUTH", () => {
  it("FLT-AC3: non-zero exit with no result reports the exit code and the stderr tail as PROVIDER_ERROR", async () => {
    const r = rig([{ lines: [], exitCode: 3, stderr: "boom: config unreadable\n" }]);
    const settled = await r.clock.settle(r.provider.chat(request()));
    const e = (settled as PromiseRejectedResult).reason as ToolError;
    expect(e.code).toBe("PROVIDER_ERROR");
    expect(e.message).toContain("exited with code 3");
    expect(e.message).toContain("boom: config unreadable");
    expect(e.code).not.toBe("PROVIDER_AUTH_ERROR");
  });

  it("FLT-AC3: stderr secrets are scrubbed from the surfaced tail", async () => {
    const r = rig([{ lines: [], exitCode: 1, stderr: `auth ${"sk-ant-" + "api03-ABCDEFGHIJKLMNOPQRSTUV"} failed` }]);
    const settled = await r.clock.settle(r.provider.chat(request()));
    expect(((settled as PromiseRejectedResult).reason as Error).message).not.toContain("ABCDEFGHIJKLMNOPQRSTUV");
  });

  it("FLT-AC3: exit 0 with no result and no other evidence keeps the PROVIDER_AUTH_ERROR sign-in hint", async () => {
    const r = rig([{ lines: [], exitCode: 0 }]);
    const settled = await r.clock.settle(r.provider.chat(request()));
    expect(((settled as PromiseRejectedResult).reason as ToolError).code).toBe("PROVIDER_AUTH_ERROR");
  });
});

describe("de6bee5d FLT-AC4: the limiter is shared across tasks on one credential", () => {
  it("FLT-AC4: after a window trip a sibling task fails fast with the same reset and ZERO spawns", async () => {
    const shared = { registry: new TripRegistry(), clock: new FakeClock() };
    const a = rig([{ lines: [rejectedEvent(1_800_003_600), line({ type: "result", is_error: true, result: "limit" })] }], shared);
    const b = rig([{ lines: [OK_RESULT] }], shared);
    await shared.clock.settle(a.provider.chat(request()));
    const settled = await shared.clock.settle(b.provider.chat(request()));
    expect(b.spawn).not.toHaveBeenCalled();
    const e = (settled as PromiseRejectedResult).reason as ProviderCallError;
    expect(e.code).toBe("PROVIDER_RATE_LIMITED");
    expect(e.data.source).toBe("trip");
    expect(e.resetAt).toBe(new Date(1_800_003_600_000).toISOString());
  });

  it("FLT-AC4: a transient 429 on A pauses B until it lifts, then B proceeds", async () => {
    const shared = { registry: new TripRegistry(), clock: new FakeClock() };
    const a = rig([{ lines: [line({ type: "result", is_error: true, api_error_status: 429, result: "API Error: 429" })] }, { lines: [OK_RESULT] }], { ...shared, rng: () => 0.5 });
    const b = rig([{ lines: [OK_RESULT] }], shared);
    const pa = a.provider.chat(request());
    await shared.clock.untilSleeping(1);
    const pb = b.provider.chat(request());
    await shared.clock.untilSleeping(2);
    expect(b.spawn).not.toHaveBeenCalled();
    await shared.clock.settle(Promise.all([pa, pb]));
    expect(b.spawn).toHaveBeenCalledTimes(1);
  });
});

describe("de6bee5d FLT-AC5: abort", () => {
  it("FLT-AC5: aborting a hung turn terminates the child, rejects as an abort, and never retries", async () => {
    const r = rig([{ lines: [], hang: true }, { lines: [OK_RESULT] }]);
    const ac = new AbortController();
    const caught = r.provider.chat(request(ac.signal)).catch((e: unknown) => e);
    await r.clock.flush();
    ac.abort();
    const e = (await caught) as Error;
    expect(e.message).toContain("request aborted");
    expect(r.procs[0]!.kill).toHaveBeenCalled();
    await r.clock.flush();
    expect(r.spawn).toHaveBeenCalledTimes(1);
    expect(r.clock.sleeps).toEqual([]);
  });
});

describe("de6bee5d FLT-AC1: pure classification", () => {
  const ctx = { providerType: "claudecli" as const, modelRef: "m", wireModel: "m", credentialKey: "k", credentialScope: "k" };
  it("parseCliRateLimitEvent rejects malformed events and keeps resetsAt in epoch seconds", () => {
    expect(parseCliRateLimitEvent({ type: "rate_limit_event" })).toBeUndefined();
    expect(parseCliRateLimitEvent({ rate_limit_info: { status: "bogus" } })).toBeUndefined();
    expect(parseCliRateLimitEvent({ rate_limit_info: { status: "rejected", resetsAt: 5 } })).toEqual({ status: "rejected", resetsAt: 5 });
  });
  it("no evidence -> undefined (the caller keeps its empty-result error)", () => {
    expect(classifyCliFault({ toolUseEmitted: false, exitCode: 0 }, ctx, 0)).toBeUndefined();
  });
  it("free text that merely mentions a limit is NOT promoted to a window", () => {
    const hit = classifyCliFault({ toolUseEmitted: false, errorResult: { text: "the tool said: you've hit your limit of retries" } }, ctx, 0);
    expect(hit?.failure.class).not.toBe("rate_limited");
  });
});
