/**
 * 9ed453c1 / de6bee5d FLT — fault and rate-limit parity for the `anthropic` provider
 * (SPEC docs/plan/provider-failure PF-2.AC1/AC2 + the attempt-bound subset of PF-4).
 *
 * The REAL `AnthropicProvider` + `@anthropic-ai/sdk` are driven through the engine's `wire.fetch` seam
 * (no socket, no subprocess; ADR-0009 unit lane) with a FAKE CLOCK: every backoff is a latch the test
 * releases, so nothing sleeps and no timing is asserted from the wall.
 *
 *  FLT-AC2  429 + Retry-After then 200 -> retried ONCE after exactly the stated delay; attempts <= 3;
 *           a quota (billing-class / far-future reset) 429 is NEVER retried and fails fast with its reset.
 *  FLT-AC4  process-local shared limiter: the first 429 pauses a second task on the same credential.
 *  FLT-AC5  abort -> no retry after abort; an abort during backoff rejects immediately.
 *
 * NEGATIVE CONTROLS are recorded in the commit message (mutant runs on tmp copies, tracked files untouched).
 */
import { describe, expect, it } from "vitest";

import { AnthropicProvider } from "../providers/anthropic.js";
import { ProviderCallError, TripRegistry, type RetryRuntime } from "../providers/provider-failure.js";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { anthropicSseBody } from "./fixtures/anthropic-sse.js";
import { FakeClock } from "./fixtures/fake-clock.js";

const MODEL = "claude-haiku-4-5";
const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const ok = (): Response =>
  new Response(anthropicSseBody({ model: MODEL, text: "done", usage: { input_tokens: 10, output_tokens: 5 } }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
const err = (status: number, type: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ type: "error", error: { type, message: `${type} message`, ...extra } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

interface IRig {
  calls: number;
  clock: FakeClock;
  runtime: RetryRuntime;
  provider: AnthropicProvider;
}

/** `script` yields the Nth response; past its end the last entry repeats. */
function rig(script: Array<() => Response>, shared?: { clock: FakeClock; registry: TripRegistry }): IRig {
  const clock = shared?.clock ?? new FakeClock();
  const runtime: RetryRuntime = { clock, rng: () => 0, registry: shared?.registry ?? new TripRegistry() };
  const r = { calls: 0 } as IRig;
  const fetchSeam: typeof fetch = async () => {
    const make = script[Math.min(r.calls, script.length - 1)]!;
    r.calls++;
    return make();
  };
  const engineConfig = {
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    wire: { fetch: fetchSeam },
    getProviderConfig: () => ({ secret: "sk-ant-api-test", model: MODEL }),
  } as unknown as EngineConfig;
  r.clock = clock;
  r.runtime = runtime;
  r.provider = new AnthropicProvider({ type: "anthropic", model: MODEL }, engineConfig, logger, {
    promptCaching: false,
    retryRuntime: runtime,
  });
  return r;
}

const req = (signal?: AbortSignal) => ({
  messages: [{ role: "user", content: "hi" }] as never,
  ...(signal ? { signal } : {}),
});

describe("de6bee5d FLT-AC2: anthropic 429/529 retry", () => {
  it("FLT-AC2: 429 + Retry-After:2 then 200 is retried exactly once, after exactly the stated delay", async () => {
    const r = rig([() => err(429, "rate_limit_error", { "retry-after": "2" }), ok]);
    const p = r.provider.chat(req());
    await r.clock.untilSleeping(1);
    expect(r.calls).toBe(1);
    expect(r.clock.sleeps).toEqual([2000]);
    await r.clock.advance(1999);
    expect(r.calls).toBe(1); // not one ms early
    await r.clock.advance(1);
    const res = await p;
    expect(r.calls).toBe(2);
    expect(res.message.content).toBe("done");
  });

  it("FLT-AC2: Retry-After is honoured on a 529 overloaded too", async () => {
    const r = rig([() => err(529, "overloaded_error", { "retry-after": "3" }), ok]);
    const p = r.provider.chat(req());
    await r.clock.untilSleeping(1);
    expect(r.clock.sleeps).toEqual([3000]);
    await r.clock.advance(3000);
    await p;
    expect(r.calls).toBe(2);
  });

  it("FLT-AC2: a permanently overloaded provider stops at 3 attempts (SDK maxRetries is 0), PROVIDER_OVERLOADED", async () => {
    const r = rig([() => err(529, "overloaded_error")]);
    const settled = await r.clock.settle(r.provider.chat(req()));
    expect(r.calls).toBe(3);
    expect(settled.status).toBe("rejected");
    const e = (settled as PromiseRejectedResult).reason as ProviderCallError;
    expect(e).toBeInstanceOf(ProviderCallError);
    expect(e.code).toBe("PROVIDER_OVERLOADED");
    expect(e.data.class).toBe("overloaded");
    expect(e.data.retryable).toBe(true);
  });

  it("FLT-AC2: a spend-limit (billing) 429 is NEVER retried and sleeps zero times", async () => {
    const r = rig([() => err(429, "rate_limit_error", {}, { details: { error_code: "enforced_spend_limit_reached" } })]);
    const settled = await r.clock.settle(r.provider.chat(req()));
    expect(r.calls).toBe(1);
    expect(r.clock.sleeps).toEqual([]);
    const e = (settled as PromiseRejectedResult).reason as ProviderCallError;
    expect(e.code).toBe("PROVIDER_BILLING");
    expect(e.data.class).toBe("billing");
    expect(e.data.retryable).toBe(false);
    expect(e.data.resumable).toBe(true);
  });

  it("FLT-AC2: a 429 whose reset is an hour away (usage window) fails fast with the reset time, no retry", async () => {
    const r = rig([() => err(429, "rate_limit_error", { "retry-after": "3600" })]);
    const start = r.clock.now();
    const settled = await r.clock.settle(r.provider.chat(req()));
    expect(r.calls).toBe(1);
    expect(r.clock.sleeps).toEqual([]);
    const e = (settled as PromiseRejectedResult).reason as ProviderCallError;
    expect(e.code).toBe("PROVIDER_RATE_LIMITED");
    expect(e.data.class).toBe("rate_limited");
    expect(e.resetAt).toBe(new Date(start + 3_600_000).toISOString());
    expect(e.message).toContain(new Date(start + 3_600_000).toISOString());
  });

  it("FLT-AC2: 401 is never retried and keeps the PROVIDER_AUTH_ERROR operator hint", async () => {
    const r = rig([() => err(401, "authentication_error")]);
    const settled = await r.clock.settle(r.provider.chat(req()));
    expect(r.calls).toBe(1);
    const e = (settled as PromiseRejectedResult).reason as ProviderCallError;
    expect(e.code).toBe("PROVIDER_AUTH_ERROR");
    expect(e.message).toContain("ADHD_AGENT_ANTHROPIC_SECRET");
  });
});

describe("de6bee5d FLT-AC4: one process-local limiter per credential", () => {
  it("FLT-AC4: task A's 429 pauses task B (same credential) until the stated delay; B spends no request while paused", async () => {
    const shared = { clock: new FakeClock(), registry: new TripRegistry() };
    const a = rig([() => err(429, "rate_limit_error", { "retry-after": "5" }), ok], shared);
    // B uses its own provider instance + fetch counter but the SAME credential and registry.
    const b = rig([ok], shared);

    const pa = a.provider.chat(req());
    await shared.clock.untilSleeping(1); // A hit its 429 and is backing off
    const pb = b.provider.chat(req()); // B starts while the credential is paused
    await shared.clock.untilSleeping(2); // B parked on the shared pause, not on the network
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(0);

    await shared.clock.advance(4999);
    expect(a.calls + b.calls).toBe(1); // nobody went early
    await shared.clock.advance(1);
    await Promise.all([pa, pb]);
    expect(a.calls).toBe(2);
    expect(b.calls).toBe(1);
  });

  it("FLT-AC4: a quota trip makes a sibling task fail fast with ZERO requests", async () => {
    const shared = { clock: new FakeClock(), registry: new TripRegistry() };
    const a = rig([() => err(429, "rate_limit_error", {}, { details: { error_code: "enforced_spend_limit_reached" } })], shared);
    const b = rig([ok], shared);
    await shared.clock.settle(a.provider.chat(req()));
    const settled = await shared.clock.settle(b.provider.chat(req()));
    expect(b.calls).toBe(0);
    const e = (settled as PromiseRejectedResult).reason as ProviderCallError;
    expect(e.code).toBe("PROVIDER_BILLING");
    expect(e.data.source).toBe("trip");
  });
});

describe("de6bee5d FLT-AC5: abort is never retried", () => {
  it("FLT-AC5: abort during backoff rejects immediately and makes no further request", async () => {
    const r = rig([() => err(429, "rate_limit_error", { "retry-after": "5" }), ok]);
    const ac = new AbortController();
    const p = r.provider.chat(req(ac.signal));
    const caught = p.catch((e: unknown) => e);
    await r.clock.untilSleeping(1);
    ac.abort();
    const e = (await caught) as Error;
    expect(e.name).toBe("AbortError");
    await r.clock.advance(10_000);
    expect(r.calls).toBe(1);
  });

  it("FLT-AC5: a call whose signal is already aborted makes zero requests", async () => {
    const r = rig([ok]);
    const ac = new AbortController();
    ac.abort();
    await expect(r.provider.chat(req(ac.signal))).rejects.toThrow();
    expect(r.calls).toBe(0);
  });
});
