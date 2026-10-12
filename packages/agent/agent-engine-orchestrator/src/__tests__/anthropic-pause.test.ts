/**
 * R9-pause S2b: the `pause_turn` continuation loop (`providers/anthropic-pause.ts`), driven through the REAL
 * `@anthropic-ai/sdk` streaming client against the offline contract fake (S1). No network, no provider call, no
 * clock, no sleep: the fake ignores the abort signal, so aborts are fired from inside the script (deterministic).
 *
 * Acceptance ids (spec-v2 section 2 "pause_turn (A5)" and AC18, split so each clause has its own id):
 *   R9-pause AC1   a `pause_turn` then `end_turn` returns the turn once: blocks concatenated, usage summed
 *   R9-pause AC2   five consecutive pauses fail loudly (never `completed`, never partial content); 4 then end completes
 *   R9-pause AC3   the continuation replays the paused content as-is, with the same tools; the contract fake accepts it
 *   R9-pause AC4   every continuation is a counted model call (`modelCalls` = reportedModelCalls)
 *   R9-pause AC5   `beforeContinuation(n)` runs before every continuation request, never before the first, and a
 *                  rejection (budget trip) stops the loop with no further request
 *   R9-pause AC6   abort during the 3rd continuation sends no 4th request
 *   R9-pause AC7   a progress signal per continuation
 *   R9-pause AC8   spend is never lost: cap, abort, rejected hook and failed continuation carry the calls already made
 *   R9-pause AC9   retry placement: the cap/abort/hook errors are not provider faults (not retried); a transient
 *                  failure of ONE continuation retried per call does not restart the turn
 *
 * Scope notes (what the fake cannot express, found while writing this): (1) its V2 rule rejects an UNRESOLVED
 * `server_tool_use` as the final (assistant) message of a request, so the scripts pause on resolved pairs plus text;
 * a real pause that ends in a dangling `server_tool_use` is a shape only the gated live test (S7) can show the API
 * accepts. (2) its V4 matches a merged trailing assistant message to ONE emitted turn, so thinking blocks from TWO
 * different paused responses in the same tail read as "dropped in part" (V4a): scripts put thinking in the first
 * paused response only. Neither is a defect of the loop; fixtures are not edited here.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam, Message, MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages";
import { describe, expect, it } from "vitest";

import {
  MAX_PAUSE_TURNS,
  PAUSE_TURN_CAPPED,
  PAUSE_TURN_EMPTY,
  PauseTurnCapError,
  isPauseTurnCapError,
  runWithPauseTurn,
  sumPauseUsage,
  type IPauseCall,
  type IPauseLoopOptions,
} from "../providers/anthropic-pause.js";
import { readPartialUsage } from "../providers/partial-usage.js";
import type { ProviderTokenUsage } from "../providers/partial-usage.js";
import { TripRegistry, callWithRetry, classifySdkError, type RetryRuntime } from "../providers/provider-failure.js";
import { ToolError } from "../validation/errors.js";
import { makeContractFake, type FakeScript, type FakeStep, type IContractFake, type IContractFakeOptions } from "./fixtures/anthropic-contract-fake.js";
import type { ISseBlock } from "./fixtures/anthropic-sse.js";

const MODEL = "claude-haiku-5-5";
const TOOLS: Tool[] = [{ name: "echo__echo", description: "echo", input_schema: { type: "object", properties: {} } }];
const BASE: MessageParam[] = [{ role: "user", content: "go" }];

// -- scripts ------------------------------------------------------------------------------------------------------
const usage = (i: number) => ({ input_tokens: 100 * (i + 1), output_tokens: 10 + i, cache_read_input_tokens: 1000 });
/** A paused reply: reasoning (optional) + a resolved server pair + text, stop_reason pause_turn. */
const pause = (i: number, opts: { thinking?: boolean } = {}): FakeStep => ({
  blocks: [
    ...(opts.thinking ? ([{ type: "thinking", thinking: "", signature: `sig-${i}` }] as ISseBlock[]) : []),
    { type: "server_tool_use", id: `srv_${i}`, name: "web_fetch", input: { url: `https://example.com/${i}` } },
    { type: "text", text: `part-${i}` },
  ],
  stopReason: "pause_turn",
  usage: usage(i),
});
const end = (i: number, text = "final"): FakeStep => ({ blocks: [{ type: "text", text }], stopReason: "end_turn", usage: usage(i) });
const pauses = (n: number, opts?: { thinking?: boolean }): FakeStep[] => Array.from({ length: n }, (_, i) => pause(i, opts));

/** The provider's per-response usage normalisation, reduced to what these tests need (the real one lives in anthropic.ts). */
const usageOf = (m: Message): ProviderTokenUsage => {
  const cacheRead = m.usage.cache_read_input_tokens ?? 0;
  const uncached = m.usage.input_tokens;
  return {
    inputTokens: uncached + cacheRead,
    outputTokens: m.usage.output_tokens,
    uncachedInputTokens: uncached,
    cacheReadTokens: cacheRead,
    stopReason: String(m.stop_reason),
  };
};

interface IRig {
  fake: IContractFake;
  client: Anthropic;
  /** Every call the loop asked for, in order. */
  calls: IPauseCall[];
  /** Mirrors what S3a's `send` does: original messages, plus the paused blocks as the last assistant message. */
  send: (call: IPauseCall) => Promise<Message>;
  run: (extra?: Partial<IPauseLoopOptions<Message>>) => ReturnType<typeof runWithPauseTurn<Message>>;
}

function rig(script: FakeScript, options?: IContractFakeOptions): IRig {
  const fake = makeContractFake(script, options);
  const client = new Anthropic({ apiKey: "sk-ant-api-test", maxRetries: 0, fetch: fake.fetch });
  const calls: IPauseCall[] = [];
  const send = (call: IPauseCall): Promise<Message> => {
    calls.push(call);
    const messages: MessageParam[] =
      call.n === 0 ? BASE : [...BASE, { role: "assistant", content: call.pausedBlocks as ContentBlockParam[] }];
    return client.messages.stream({ model: MODEL, max_tokens: 256, tools: TOOLS, messages }).finalMessage();
  };
  return { fake, client, calls, send, run: extra => runWithPauseTurn({ send, usageOf, ...extra }) };
}

const textOf = (blocks: readonly unknown[]): string[] =>
  (blocks as Array<{ type: string; text?: string }>).filter(b => b.type === "text").map(b => b.text ?? "");

const noFaults = (r: IRig): void => {
  expect(r.fake.faults).toEqual([]);
  expect(r.fake.rejections()).toEqual([]);
};

describe("R9-pause AC1: pause_turn then end_turn completes the turn once", () => {
  it("returns every block exactly once, in order, from one logical turn; usage is summed", async () => {
    const r = rig([pause(0), end(1, "the answer")]);
    const res = await r.run();

    expect(res.last.stop_reason).toBe("end_turn");
    expect(res.responses).toHaveLength(2);
    expect(textOf(res.blocks)).toEqual(["part-0", "the answer"]);
    expect(res.blocks.map(b => (b as { type: string }).type)).toEqual([
      "server_tool_use", "web_fetch_tool_result", "text", "text",
    ]);
    // usage(0) + usage(1): uncached 100 + 200, cache_read 1000 + 1000, output 10 + 11
    expect(res.usage).toMatchObject({ inputTokens: 100 + 1000 + 200 + 1000, outputTokens: 21, uncachedInputTokens: 300, cacheReadTokens: 2000 });
    expect(res.usage?.stopReason).toBe("end_turn");
    expect(r.fake.requests).toHaveLength(2);
    noFaults(r);
  });

  it("a turn that never pauses is one call with no continuation and no hook invocation", async () => {
    const hooks: number[] = [];
    const r = rig([end(0)]);
    const res = await r.run({ beforeContinuation: async n => void hooks.push(n) });
    expect(res.continuations).toBe(0);
    expect(res.modelCalls).toBe(1);
    expect(hooks).toEqual([]);
    expect(r.calls).toEqual([{ n: 0, pausedBlocks: [] }]);
    noFaults(r);
  });

  it("stop reasons other than pause_turn end the loop (max_tokens, tool_use, refusal): the caller maps them", async () => {
    for (const stopReason of ["max_tokens", "refusal"] as const) {
      const r = rig([{ blocks: [{ type: "text", text: "cut" }], stopReason, usage: usage(0) }]);
      const res = await r.run();
      expect(res.last.stop_reason).toBe(stopReason);
      expect(res.modelCalls).toBe(1);
    }
    const tool = rig([{ blocks: [{ type: "tool_use", id: "tu_1", name: "echo__echo", input: {} }], usage: usage(0) }]);
    expect((await tool.run()).last.stop_reason).toBe("tool_use");
  });
});

describe("R9-pause AC2: the cap fails loudly", () => {
  it("5 consecutive pauses throw PauseTurnCapError after exactly 5 requests (no 6th), never a result", async () => {
    const r = rig([...pauses(5), end(5, "never reached")]);
    const err = await r.run().then(
      () => undefined,
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(PauseTurnCapError);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe("PROVIDER_ERROR");
    expect((err as Error).message).toBe("provider paused the turn 5 times without finishing");
    expect((err as ToolError).data).toEqual({ kind: PAUSE_TURN_CAPPED, pauses: 5, continuations: 4 });
    expect(isPauseTurnCapError(err)).toBe(true);
    expect(r.fake.requests).toHaveLength(MAX_PAUSE_TURNS);
    expect(r.calls.map(c => c.n)).toEqual([0, 1, 2, 3, 4]);
    // the unreached final reply was never consumed
    expect(r.fake.emittedTurns).toHaveLength(5);
    noFaults(r);
  });

  it("boundary: 4 pauses then end_turn completes with 4 continuations; the 5th pause is the first failure", async () => {
    const ok = rig([...pauses(4), end(4)]);
    const res = await ok.run();
    expect(res.continuations).toBe(4);
    expect(res.modelCalls).toBe(5);
    expect(ok.fake.requests).toHaveLength(5);
    noFaults(ok);

    const capped = rig([...pauses(5), end(5)]);
    await expect(capped.run()).rejects.toBeInstanceOf(PauseTurnCapError);
    expect(capped.fake.requests).toHaveLength(5);
  });

  it("maxPauses is honoured and validated", async () => {
    const r = rig([...pauses(2), end(2)]);
    await expect(r.run({ maxPauses: 2 })).rejects.toMatchObject({ data: { kind: PAUSE_TURN_CAPPED, pauses: 2, continuations: 1 } });
    expect(r.fake.requests).toHaveLength(2);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(runWithPauseTurn({ send: async () => ({ content: [], stop_reason: "end_turn" }), maxPauses: bad })).rejects.toBeInstanceOf(RangeError);
    }
  });

  it("a paused response with no content at all fails loudly (nothing to continue from), distinct from the cap", async () => {
    const send = async (): Promise<{ content: unknown[]; stop_reason: string }> => ({ content: [], stop_reason: "pause_turn" });
    const err = await runWithPauseTurn({ send }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).data).toMatchObject({ kind: PAUSE_TURN_EMPTY });
    expect(isPauseTurnCapError(err)).toBe(false);
  });
});

describe("R9-pause AC3: the continuation replays the paused content as-is", () => {
  it("each continuation body is the original messages plus ONE trailing assistant message holding every paused block, same tools", async () => {
    const r = rig([pause(0), pause(1), end(2)]);
    const res = await r.run();
    const bodies = r.fake.bodies();

    expect(bodies).toHaveLength(3);
    for (const b of bodies) expect(b.tools).toEqual(TOOLS);
    expect(bodies[0]!.messages).toEqual(BASE);
    // continuation 1 = first response's content; continuation 2 = first + second, concatenated in one assistant message
    const first = res.responses[0]!.content;
    const second = res.responses[1]!.content;
    expect(bodies[1]!.messages).toHaveLength(2);
    expect(bodies[1]!.messages[1]).toEqual({ role: "assistant", content: JSON.parse(JSON.stringify(first)) });
    expect(bodies[2]!.messages).toHaveLength(2);
    expect(bodies[2]!.messages[1]).toEqual({ role: "assistant", content: JSON.parse(JSON.stringify([...first, ...second])) });
    noFaults(r);
  });

  it("thinking in the paused response survives every later continuation untouched (V4a accepts it)", async () => {
    // Scope note: the fake matches a merged assistant tail to ONE emitted turn, so it can express thinking in the first
    // paused response only (thinking in two paused responses reads as "dropped in part"); see the header.
    const r = rig([pause(0, { thinking: true }), pause(1), end(2)]);
    const res = await r.run();
    expect(res.blocks.map(b => (b as { type: string }).type).filter(t => t === "thinking")).toHaveLength(1);
    for (const body of r.fake.bodies().slice(1)) {
      const tail = body.messages[body.messages.length - 1]!;
      expect((tail.content as Array<{ type: string; signature?: string }>)[0]).toMatchObject({ type: "thinking", signature: "sig-0" });
    }
    noFaults(r);
  });

  it("negative control: a continuation that drops the paused thinking is a 400 the fake reports (the check has teeth)", async () => {
    const r = rig([pause(0, { thinking: true }), end(1)]);
    const stripping = (call: IPauseCall): Promise<Message> =>
      r.send({ ...call, pausedBlocks: call.pausedBlocks.filter(b => (b as { type: string }).type !== "thinking") });
    await expect(runWithPauseTurn({ send: stripping })).rejects.toMatchObject({ status: 400 });
    expect(r.fake.rejections().map(v => v.rule)).toContain("V4b");
  });
});

describe("R9-pause AC4: every continuation is a counted model call", () => {
  it.each([0, 1, 2, 4])("%i pauses => modelCalls = pauses + 1, continuations = pauses, one request each", async pausesBefore => {
    const r = rig([...pauses(pausesBefore), end(pausesBefore)]);
    const res = await r.run();
    expect(res.continuations).toBe(pausesBefore);
    expect(res.modelCalls).toBe(pausesBefore + 1);
    expect(res.modelCalls).toBe(r.fake.requests.length);
    expect(res.responses).toHaveLength(res.modelCalls);
    noFaults(r);
  });

  it("summed usage equals the per-call usages added together, not just the last call's", async () => {
    const r = rig([pause(0), pause(1), end(2)]);
    const res = await r.run();
    const each = res.responses.map(usageOf);
    expect(res.usage?.inputTokens).toBe(each.reduce((s, u) => s + u.inputTokens, 0));
    expect(res.usage?.outputTokens).toBe(each.reduce((s, u) => s + u.outputTokens, 0));
    expect(res.usage).toEqual(sumPauseUsage(res.responses, usageOf));
    expect(res.usage!.inputTokens).toBeGreaterThan(each[2]!.inputTokens);
  });
});

describe("R9-pause AC5: beforeContinuation vets every continuation before it is sent", () => {
  it("is awaited with n = 1, 2, 3 and runs while the request count still excludes that continuation", async () => {
    const seen: Array<{ n: number; requestsSoFar: number }> = [];
    const r = rig([pause(0), pause(1), pause(2), end(3)]);
    await r.run({
      beforeContinuation: async n => {
        await Promise.resolve();
        seen.push({ n, requestsSoFar: r.fake.requests.length });
      },
    });
    expect(seen).toEqual([
      { n: 1, requestsSoFar: 1 },
      { n: 2, requestsSoFar: 2 },
      { n: 3, requestsSoFar: 3 },
    ]);
  });

  it("a budget trip on the 3rd continuation stops the loop: the rejection propagates and only 3 requests were sent", async () => {
    const budget = new Error("budget cap reached: pre:model_request denied");
    const r = rig([pause(0), pause(1), pause(2), end(3)]);
    const err = await r
      .run({
        beforeContinuation: async n => {
          if (n === 3) throw budget;
        },
      })
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(err).toBe(budget);
    expect(r.fake.requests).toHaveLength(3);
    expect(r.calls.map(c => c.n)).toEqual([0, 1, 2]);
  });
});

describe("R9-pause AC6: abort is honoured between continuations", () => {
  it("aborting during the 3rd continuation sends no 4th request", async () => {
    const ac = new AbortController();
    const hooked: number[] = [];
    // the fake ignores the signal, so the abort is fired while the 3rd continuation (request index 3) is being served;
    // that response still arrives as another pause. Only the loop's own between-continuation check can stop request 5.
    const script = (ctx: { index: number }): FakeStep => {
      if (ctx.index === 3) ac.abort();
      return pause(ctx.index);
    };
    const r = rig(script as unknown as FakeScript);
    const err = await r
      .run({ signal: ac.signal, beforeContinuation: async n => void hooked.push(n) })
      .then(
        () => undefined,
        (e: unknown) => e
      );

    expect((err as Error).name).toBe("AbortError");
    expect(r.fake.requests).toHaveLength(4); // the original + continuations 1, 2, 3; never a 4th continuation
    expect(hooked).toEqual([1, 2, 3]); // not even vetted for a 4th
    expect(r.calls.map(c => c.n)).toEqual([0, 1, 2, 3]);
  });

  it("a signal aborted before the first continuation stops after the original call", async () => {
    const ac = new AbortController();
    const r = rig((ctx: { index: number }) => {
      ac.abort();
      return pause(ctx.index);
    });
    await expect(r.run({ signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(r.fake.requests).toHaveLength(1);
  });

  it("an abort that lands on the response that ENDS the turn does not discard the finished turn", async () => {
    const ac = new AbortController();
    const r = rig((ctx: { index: number }) => {
      if (ctx.index === 1) ac.abort();
      return ctx.index === 0 ? pause(0) : end(1);
    });
    const res = await r.run({ signal: ac.signal });
    expect(res.last.stop_reason).toBe("end_turn");
    expect(r.fake.requests).toHaveLength(2);
  });
});

describe("R9-pause AC7: a progress signal per continuation", () => {
  it("onContinuation fires once per continuation with its number and the pauses seen so far", async () => {
    const info: Array<{ n: number; pauses: number }> = [];
    const r = rig([pause(0), pause(1), end(2)]);
    await r.run({ onContinuation: i => info.push(i) });
    expect(info).toEqual([
      { n: 1, pauses: 1 },
      { n: 2, pauses: 2 },
    ]);
  });

  it("at the cap the hook ran for each of the 4 continuations (the engine emitted 4 progress events) and none for a 5th", async () => {
    const hooked: number[] = [];
    const r = rig(pauses(6));
    await expect(r.run({ beforeContinuation: async n => void hooked.push(n) })).rejects.toBeInstanceOf(PauseTurnCapError);
    expect(hooked).toEqual([1, 2, 3, 4]);
  });
});

describe("R9-pause AC8: spend is never lost on a failed loop", () => {
  const expectSpent = (err: unknown, calls: number, lowerBound: boolean): void => {
    const partial = readPartialUsage(err);
    expect(partial?.reportedModelCalls).toBe(calls);
    expect(partial?.usage?.outputTokens).toBe(Array.from({ length: calls }, (_, i) => 10 + i).reduce((a, b) => a + b, 0));
    expect(partial?.usage?.inputTokens).toBe(Array.from({ length: calls }, (_, i) => 100 * (i + 1) + 1000).reduce((a, b) => a + b, 0));
    expect(partial?.usage?.usageLowerBound === true).toBe(lowerBound);
    expect(partial?.responseModel).toBeTruthy();
  };

  it("the cap error carries all 5 calls' usage", async () => {
    const r = rig(pauses(5));
    const err = await r.run().catch((e: unknown) => e);
    expectSpent(err, 5, false);
  });

  it("a rejected beforeContinuation carries the calls made before it", async () => {
    const r = rig(pauses(4));
    const err = await r.run({ beforeContinuation: async n => { if (n === 3) throw new Error("denied"); } }).catch((e: unknown) => e);
    expectSpent(err, 3, false);
  });

  it("an abort between continuations carries the calls made before it", async () => {
    const ac = new AbortController();
    const r = rig((ctx: { index: number }) => {
      if (ctx.index === 3) ac.abort();
      return pause(ctx.index);
    });
    const err = await r.run({ signal: ac.signal }).catch((e: unknown) => e);
    expectSpent(err, 4, false);
  });

  it("a continuation request that fails mid-flight carries the earlier calls, flagged as a lower bound (its own spend is unknown)", async () => {
    const r = rig([pause(0), pause(1), { error: { status: 529, type: "overloaded_error", message: "overloaded" } }, end(3)]);
    const err = await r.run().catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(529);
    expectSpent(err, 2, true);
  });

  it("no usageOf, no marker; a failure on the very first call has nothing to carry", async () => {
    const r = rig(pauses(5));
    const bare = await runWithPauseTurn({ send: r.send }).catch((e: unknown) => e);
    expect(bare).toBeInstanceOf(PauseTurnCapError);
    expect(readPartialUsage(bare)).toBeUndefined();

    const first = rig([{ error: { status: 400, type: "invalid_request_error", message: "bad" } }]);
    expect(readPartialUsage(await first.run().catch((e: unknown) => e))).toBeUndefined();
  });
});

describe("R9-pause AC9: retry placement", () => {
  const ctx = { providerType: "anthropic" as const, modelRef: MODEL, wireModel: MODEL, credentialKey: "k", credentialScope: "k" };
  const runtime = (): RetryRuntime => ({ clock: { now: () => 0, sleep: async () => undefined }, rng: () => 0, registry: new TripRegistry() });
  const policy = { retries: 2, minTimeout: 1, maxTimeout: 1, factor: 1, windowMs: 60_000 };
  const target = { providerType: "anthropic" as const, credentialScope: "k", wireModel: MODEL };

  it("wrapping the WHOLE loop in callWithRetry is wrong: the cap error is classified `unknown`, not retried, and rewrapped as a ProviderCallError (identity and message lost)", async () => {
    const classified = classifySdkError(new PauseTurnCapError(5, 4), ctx, false);
    expect(classified).toMatchObject({ class: "unknown", retryable: false });

    let attempts = 0;
    const r = rig(pauses(5));
    const err = await callWithRetry(
      async () => {
        attempts++;
        return r.run();
      },
      { runtime: runtime(), policy, target, classify: e => classifySdkError(e, ctx, false) }
    ).catch((e: unknown) => e);
    expect(attempts).toBe(1);
    expect(r.fake.requests).toHaveLength(5);
    expect(err).not.toBeInstanceOf(PauseTurnCapError);
    expect((err as Error).message).not.toBe("provider paused the turn 5 times without finishing");
    // the guard still finds the cap through the cause chain, so a caller that did wrap can recover it
    expect(isPauseTurnCapError(err)).toBe(true);
  });

  it("per-call retry: a 529 on continuation 2 retries that one call; the turn is not restarted and nothing is re-sent earlier", async () => {
    const r = rig([pause(0), pause(1), { error: { status: 529, type: "overloaded_error", message: "overloaded" } }, end(2, "done")]);
    const retried = (call: IPauseCall): Promise<Message> =>
      callWithRetry(() => r.send(call), { runtime: runtime(), policy, target, classify: e => classifySdkError(e, ctx, false) });
    const res = await runWithPauseTurn({ send: retried, usageOf });

    expect(res.last.stop_reason).toBe("end_turn");
    expect(textOf(res.blocks)).toEqual(["part-0", "part-1", "done"]);
    // original, c1, c2 (529), c2 again = 4 wire requests; the 529 is the only rejected one and is injected, not a violation
    expect(r.fake.requests.map(q => q.status)).toEqual([200, 200, 529, 200]);
    expect(res.continuations).toBe(2);
    expect(r.fake.rejections()).toEqual([]);
    expect(r.fake.faults).toEqual([]);
  });
});
