/**
 * R9-hist S1: tests of the contract fake itself (`fixtures/anthropic-contract-fake.ts`), so that later segments
 * (S2b, S3a, S6) can trust a 200 from it and a 400 means the provider sent an invalid history.
 *
 * Every validator has a POSITIVE control (a valid history is accepted) and a NEGATIVE control (a history that
 * violates exactly that rule is rejected with HTTP 400 `invalid_request_error` and the rule id recorded). Requests are
 * hand-built wire bodies, deliberately NOT produced by `AnthropicProvider`: these tests must keep their meaning when the
 * provider is fixed (S3a); the provider-through-the-fake proofs live in S3a / S6.
 *
 * Acceptance ids (spec R9-DUR AC12 "documented-rule fake", AC4 deferred shape, AC8/AC17 injected errors):
 *   R9-hist AC12 V1 | V2 | V3 | V4a | V4b | V5, R9-hist AC4, R9-hist AC8 (error injection), R9-pause AC1 (stop reason).
 * Offline: no socket, no clock, no provider call.
 *
 * guards: the offline Anthropic contract fake accepts a history that violates a documented rule (V1-V5) or rejects a valid one, so every provider proof that trusts its 200 or its 400 passes or fails for the wrong reason.
 * tier: S
 * cites: R9-hist AC12 (V1, V2, V3, V4a, V4b, V5), R9-hist AC4, R9-hist AC8, R9-pause AC1 (cited in the header).
 */
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import {
  c1Reply,
  makeContractFake,
  toApiBlocks,
  normalizeMessages,
  visibleHistory,
  webFetchResultBlock,
  type ContractRule,
  type FakeScript,
  type IApiBlock,
  type IApiMessage,
  type IContractFake,
  type IContractFakeOptions,
} from "./fixtures/anthropic-contract-fake.js";
import type { ISseBlock } from "./fixtures/anthropic-sse.js";

const MODEL = "claude-haiku-5-5";
const URL_ = "https://api.anthropic.com/v1/messages";

// -- block + body builders --------------------------------------------------------------------------------------
const thinking = (signature: string): IApiBlock => ({ type: "thinking", thinking: "", signature });
const text = (t: string): IApiBlock => ({ type: "text", text: t });
const toolUse = (id: string, name = "fs__read_text_file", input: Record<string, unknown> = { path: "a" }): IApiBlock => ({ type: "tool_use", id, name, input });
const serverUse = (id: string, url = "https://example.com"): IApiBlock => ({ type: "server_tool_use", id, name: "web_fetch", input: { url } });
const serverResult = (id: string, url = "https://example.com", page = "PAGE"): IApiBlock => ({ ...webFetchResultBlock(id, url, page) });
const toolResult = (id: string, content = "ok"): IApiBlock => ({ type: "tool_result", tool_use_id: id, content });
const user = (...content: Array<string | IApiBlock>): IApiMessage => ({
  role: "user",
  content: content.length === 1 && typeof content[0] === "string" ? content[0] : content.map(c => (typeof c === "string" ? text(c) : c)),
});
const assistant = (...content: IApiBlock[]): IApiMessage => ({ role: "assistant", content });
const body = (...messages: IApiMessage[]): Record<string, unknown> => ({ model: MODEL, max_tokens: 1024, stream: true, messages });

async function post(fake: IContractFake, payload: unknown): Promise<{ status: number; sse: string; error?: { type: string; message: string } }> {
  const res = await fake.fetch(URL_, { method: "POST", body: typeof payload === "string" ? payload : JSON.stringify(payload) });
  const raw = await res.text();
  if (res.status === 200) return { status: 200, sse: raw };
  return { status: res.status, sse: "", error: (JSON.parse(raw) as { error: { type: string; message: string } }).error };
}

/** A fake whose every accepted request is answered by a plain text reply. */
const textFake = (options?: IContractFakeOptions, n = 8): IContractFake =>
  makeContractFake(Array.from({ length: n }, () => ({ blocks: [{ type: "text", text: "ok" }] as ISseBlock[] })), options);

async function expectRejected(fake: IContractFake, payload: unknown, rule: ContractRule): Promise<void> {
  const before = fake.requests.length;
  const res = await post(fake, payload);
  expect(res.status).toBe(400);
  expect(res.error?.type).toBe("invalid_request_error");
  const violations = fake.requests[before]!.violations;
  expect(violations.map(v => v.rule)).toContain(rule);
  // The API reports the first violation; one broken history can break several rules (an orphaned result also leaves a use unresolved).
  expect(res.error?.message.startsWith(`${violations[0]!.rule}:`)).toBe(true);
  expect(fake.faults).toEqual([]);
}

async function expectAccepted(fake: IContractFake, payload: unknown): Promise<string> {
  const before = fake.requests.length;
  const res = await post(fake, payload);
  expect(res.error).toBeUndefined();
  expect(res.status).toBe(200);
  expect(fake.requests[before]!.violations).toEqual([]);
  return res.sse;
}

// ---------------------------------------------------------------------------------------------------------------
describe("R9-hist AC12 V1: every client tool_use has a tool_result in the next user turn", () => {
  it("R9-hist AC12 V1 positive: tool_use answered by tool_result", async () => {
    await expectAccepted(textFake(), body(user("go"), assistant(toolUse("t1")), user(toolResult("t1"))));
  });

  it("R9-hist AC12 V1 positive: the provider's one-user-message-per-result shape is merged like the real API does (parallel calls)", async () => {
    await expectAccepted(
      textFake(),
      body(user("go"), assistant(toolUse("t1"), toolUse("t2")), user(toolResult("t1")), user(toolResult("t2")))
    );
  });

  it("R9-hist AC12 V1 negative: tool_use followed by a plain user turn (no tool_result) is rejected", async () => {
    await expectRejected(textFake(), body(user("go"), assistant(toolUse("t1")), user("what happened?")), "V1");
  });

  it("R9-hist AC12 V1 negative: tool_use as the last message (nothing answers it) is rejected", async () => {
    await expectRejected(textFake(), body(user("go"), assistant(toolUse("t1"))), "V1");
  });

  it("R9-hist AC12 V1 negative: two parallel tool_use blocks but only one tool_result is rejected", async () => {
    await expectRejected(textFake(), body(user("go"), assistant(toolUse("t1"), toolUse("t2")), user(toolResult("t1"))), "V1");
  });
});

describe("R9-hist AC12 V2 / R9-hist AC4: server_tool_use pairing and the deferred tail", () => {
  it("R9-hist AC12 V2 positive: an executed pair (use + result in the same assistant message) is accepted", async () => {
    await expectAccepted(textFake(), body(user("go"), assistant(serverUse("s1"), serverResult("s1"), text("read it"))));
  });

  it("R9-hist AC4 positive: a dangling server_tool_use as the pending tail of the LAST assistant message + tool_result-only user turn is accepted, and the response OPENS with the matching result", async () => {
    const fake = makeContractFake([{ blocks: [{ type: "text", text: "continuing" }] }]);
    const sse = await expectAccepted(fake, body(user("go"), assistant(text("fetching"), serverUse("s1", "https://example.com/p"), toolUse("t1")), user(toolResult("t1"))));
    const first = fake.emittedTurns[0]!.blocks[0]!;
    expect(first).toMatchObject({ type: "web_fetch_tool_result", tool_use_id: "s1" });
    expect(sse.indexOf("web_fetch_tool_result")).toBeLessThan(sse.indexOf("continuing"));
    expect(sse).toContain("FIXTURE-PAGE-BODY(https://example.com/p)");
  });

  it("R9-hist AC4 positive: once delivered, BOTH halves are accepted in history (use in assistant N, result opening assistant N+1, tool_result between)", async () => {
    const fake = textFake();
    await expectAccepted(
      fake,
      body(
        user("go"),
        assistant(serverUse("s1"), toolUse("t1")),
        user(toolResult("t1")),
        assistant(serverResult("s1"), text("page read"), toolUse("t2")),
        user(toolResult("t2"))
      )
    );
  });

  it("R9-hist AC12 V2 negative: a dangling server_tool_use mid-history (a later assistant message exists) is rejected", async () => {
    await expectRejected(
      textFake(),
      body(user("go"), assistant(serverUse("s1"), toolUse("t1")), user(toolResult("t1")), assistant(text("moved on"), toolUse("t2")), user(toolResult("t2"))),
      "V2"
    );
  });

  it("R9-hist AC12 V2 negative: a dangling server_tool_use followed by a user turn that is not tool_result-only is rejected", async () => {
    await expectRejected(textFake(), body(user("go"), assistant(serverUse("s1"), toolUse("t1")), user(toolResult("t1"), "and also this")), "V2");
    await expectRejected(textFake(), body(user("go"), assistant(serverUse("s1")), user("hello?")), "V2");
  });

  it("R9-hist AC12 V2 negative: a dangling server_tool_use as the last message (nothing follows it) is rejected", async () => {
    await expectRejected(textFake(), body(user("go"), assistant(serverUse("s1"))), "V2");
  });

  it("R9-hist AC12 V2 negative: a result two assistant turns later than its server_tool_use does not resolve it", async () => {
    await expectRejected(
      textFake(),
      body(
        user("go"),
        assistant(serverUse("s1"), toolUse("t1")),
        user(toolResult("t1")),
        assistant(text("no result here"), toolUse("t2")),
        user(toolResult("t2")),
        assistant(serverResult("s1"), text("late"))
      ),
      "V2"
    );
  });

  it("R9-hist AC4: the fake executes a deferred fetch only when the tail is sent back; a provider that drops the tail leaves it pending forever", async () => {
    const fake = makeContractFake([
      { blocks: [text("a"), toolUse("t1"), serverUse("s1")] as ISseBlock[] },
      { blocks: [text("b")] as ISseBlock[] },
    ]);
    await expectAccepted(fake, body(user("go")));
    expect(fake.deferred).toEqual([{ id: "s1", name: "web_fetch", input: { url: "https://example.com" }, emittedAtRequest: 0 }]);
    // Sanitized replay (tail dropped, like arm C): accepted by the API, but the fetch never runs.
    await expectAccepted(fake, body(user("go"), assistant(text("a"), toolUse("t1")), user(toolResult("t1"))));
    expect(fake.deferred[0]!.deliveredAtRequest).toBeUndefined();
    expect(fake.emittedTurns[1]!.blocks.map(b => b.type)).toEqual(["text"]);
  });
});

describe("R9-hist AC12 V3: unknown or duplicate tool_use_id", () => {
  it("R9-hist AC12 V3 negative: client tool_result for an id no tool_use declared", async () => {
    await expectRejected(textFake(), body(user("go"), assistant(toolUse("t1")), user(toolResult("t1"), toolResult("ghost"))), "V3");
  });

  it("R9-hist AC12 V3 negative: tool_result with no assistant tool_use before it at all", async () => {
    await expectRejected(textFake(), body(user("go"), assistant(text("hi")), user(toolResult("t1"))), "V3");
  });

  it("R9-hist AC12 V3 negative: duplicate client tool_result for one id", async () => {
    await expectRejected(textFake(), body(user("go"), assistant(toolUse("t1")), user(toolResult("t1"), toolResult("t1"))), "V3");
  });

  it("R9-hist AC12 V3 negative: duplicate tool_use id (within a turn, and across turns)", async () => {
    await expectRejected(textFake(), body(user("go"), assistant(toolUse("t1"), toolUse("t1")), user(toolResult("t1"))), "V3");
    await expectRejected(
      textFake(),
      body(user("go"), assistant(toolUse("t1")), user(toolResult("t1")), assistant(toolUse("t1")), user(toolResult("t1"))),
      "V3"
    );
  });

  it("R9-hist AC12 V3 negative: duplicate server_tool_use id", async () => {
    await expectRejected(textFake(), body(user("go"), assistant(serverUse("s1"), serverResult("s1"), serverUse("s1"), serverResult("s1"), text("x"))), "V3");
  });

  it("R9-hist AC12 V3 negative: server result with no server_tool_use (orphan result)", async () => {
    await expectRejected(textFake(), body(user("go"), assistant(serverResult("s9"), text("x"))), "V3");
  });

  it("R9-hist AC12 V3 negative: server result BEFORE its server_tool_use in the same message", async () => {
    await expectRejected(textFake(), body(user("go"), assistant(serverResult("s1"), serverUse("s1"), text("x"))), "V3");
  });

  it("R9-hist AC12 V3 negative: duplicate server result for one server_tool_use", async () => {
    await expectRejected(textFake(), body(user("go"), assistant(serverUse("s1"), serverResult("s1"), serverResult("s1"), text("x"))), "V3");
  });

  it("R9-hist AC12 V3 negative: server result whose id belongs to a CLIENT tool_use", async () => {
    await expectRejected(textFake(), body(user("go"), assistant(toolUse("t1"), serverResult("t1")), user(toolResult("t1"))), "V3");
  });
});

describe("R9-hist AC12 V4: thinking blocks are passed back unmodified", () => {
  /** Request 1 returns thinking(s) + a client tool_use; returns the fake and the assistant blocks as emitted. */
  async function firstTurn(options?: IContractFakeOptions, signatures: string[] = ["sig-A"]) {
    const emitted: ISseBlock[] = [
      ...signatures.map(s => ({ type: "thinking" as const, thinking: "", signature: s })),
      { type: "text", text: "plan" },
      { type: "tool_use", id: "t1", name: "fs__read_text_file", input: { path: "a" } },
    ];
    const fake = makeContractFake([{ blocks: emitted }, ...Array.from({ length: 6 }, () => ({ blocks: [{ type: "text", text: "ok" } as ISseBlock] }))], options);
    await expectAccepted(fake, body(user("go")));
    return { fake, emitted: toApiBlocks(emitted) };
  }

  it("R9-hist AC12 V4a/V4b positive: the emitted turn replayed byte-for-byte is accepted", async () => {
    const { fake, emitted } = await firstTurn(undefined, ["sig-A", "sig-B"]);
    await expectAccepted(fake, body(user("go"), assistant(...emitted), user(toolResult("t1"))));
  });

  it("R9-hist AC12 V4a negative: a mutated signature is rejected", async () => {
    const { fake } = await firstTurn();
    await expectRejected(fake, body(user("go"), assistant(thinking("sig-A-tampered"), text("plan"), toolUse("t1")), user(toolResult("t1"))), "V4a");
  });

  it("R9-hist AC12 V4a negative: modified thinking text is rejected", async () => {
    const { fake } = await firstTurn();
    await expectRejected(
      fake,
      body(user("go"), assistant({ type: "thinking", thinking: "edited", signature: "sig-A" }, text("plan"), toolUse("t1")), user(toolResult("t1"))),
      "V4a"
    );
  });

  it("R9-hist AC12 V4a negative: reordered thinking blocks are rejected", async () => {
    const { fake } = await firstTurn(undefined, ["sig-A", "sig-B"]);
    await expectRejected(fake, body(user("go"), assistant(thinking("sig-B"), thinking("sig-A"), text("plan"), toolUse("t1")), user(toolResult("t1"))), "V4a");
  });

  it("R9-hist AC12 V4a negative: only part of a turn's thinking blocks is rejected (partial echo)", async () => {
    const { fake } = await firstTurn(undefined, ["sig-A", "sig-B"]);
    await expectRejected(fake, body(user("go"), assistant(thinking("sig-A"), text("plan"), toolUse("t1")), user(toolResult("t1"))), "V4a");
  });

  it("R9-hist AC12 V4a negative: a thinking block the model never returned (foreign signature) on an unrelated turn is rejected", async () => {
    const { fake } = await firstTurn();
    await expectRejected(fake, body(user("x"), assistant(thinking("never-emitted"), text("hi")), user("again")), "V4a");
  });

  it("R9-hist AC12 V4b negative: an emitted turn replayed WITHOUT its thinking is rejected (the arm-C defect shape)", async () => {
    const { fake } = await firstTurn();
    await expectRejected(fake, body(user("go"), assistant(text("plan"), toolUse("t1")), user(toolResult("t1"))), "V4b");
  });

  it("R9-hist AC12 V4b negative: a text-only turn that had thinking, replayed without it, is rejected (identified by its text)", async () => {
    const fake = makeContractFake([{ blocks: [{ type: "thinking", thinking: "", signature: "sig-T" }, { type: "text", text: "final answer" }] }, { blocks: [{ type: "text", text: "ok" }] }]);
    await expectAccepted(fake, body(user("q")));
    await expectRejected(fake, body(user("q"), assistant(text("final answer")), user("next")), "V4b");
  });

  it("R9-hist AC12 V4b control: allowThinkingOmission models an intentional degrade (V4b off) but V4a stays on", async () => {
    const { fake } = await firstTurn({ allowThinkingOmission: true });
    await expectAccepted(fake, body(user("go"), assistant(text("plan"), toolUse("t1")), user(toolResult("t1"))));
    await expectRejected(fake, body(user("go"), assistant(thinking("sig-A-tampered"), text("plan"), toolUse("t1")), user(toolResult("t1"))), "V4a");
  });

  it("R9-hist AC12 V4b control: allowThinkingOmission may be a per-request function: strict before a degrade, lenient after it", async () => {
    const { fake } = await firstTurn({ allowThinkingOmission: ({ index }) => index >= 2 });
    const stripped = body(user("go"), assistant(text("plan"), toolUse("t1")), user(toolResult("t1")));
    await expectRejected(fake, stripped, "V4b"); // request 1: still strict
    await expectAccepted(fake, stripped); // request 2: omission now allowed
  });

  it("R9-hist AC12 V4b control: a compacted-away turn imposes nothing (only turns present in the request are checked)", async () => {
    const { fake } = await firstTurn();
    await expectAccepted(fake, body(user("summary of earlier work"), assistant(text("understood")), user("continue")));
  });

  it("R9-hist AC12 V4 positive: redacted_thinking is held to the same rule", async () => {
    const redacted: ISseBlock = { type: "redacted_thinking", data: "REDACTED-1" };
    const fake = makeContractFake([{ blocks: [redacted, { type: "text", text: "x" }] }, { blocks: [{ type: "text", text: "ok" }] }, { blocks: [{ type: "text", text: "ok" }] }]);
    await expectAccepted(fake, body(user("q")));
    await expectAccepted(fake, body(user("q"), assistant(...toApiBlocks([redacted]), text("x")), user("n")));
    await expectRejected(fake, body(user("q"), assistant({ type: "redacted_thinking", data: "REDACTED-2" }, text("x")), user("n")), "V4a");
  });

  it("R9-hist AC4 + V4: a deferred-pair response that OPENS with the result block still has its thinking checked", async () => {
    const fake = makeContractFake([
      { blocks: [thinking("sig-1") as ISseBlock, toolUse("t1") as ISseBlock, serverUse("s1") as ISseBlock] },
      { blocks: [thinking("sig-2") as ISseBlock, text("read the page") as ISseBlock, toolUse("t2") as ISseBlock] },
      { blocks: [text("ok") as ISseBlock] },
    ]);
    await expectAccepted(fake, body(user("go")));
    await expectAccepted(fake, body(user("go"), assistant(thinking("sig-1"), toolUse("t1"), serverUse("s1")), user(toolResult("t1"))));
    expect(fake.emittedTurns[1]!.blocks.map(b => b.type)).toEqual(["web_fetch_tool_result", "thinking", "text", "tool_use"]);
    const turn2 = toApiBlocks(fake.emittedTurns[1]!.blocks);
    // Faithful history: turn 1 whole (incl. dangling use), turn 2 incl. its leading result.
    await expectAccepted(
      fake,
      body(user("go"), assistant(thinking("sig-1"), toolUse("t1"), serverUse("s1")), user(toolResult("t1")), assistant(...turn2), user(toolResult("t2")))
    );
    // Dropping turn 2's thinking is caught even though the turn begins with a server result.
    await expectRejected(
      fake,
      body(
        user("go"),
        assistant(thinking("sig-1"), toolUse("t1"), serverUse("s1")),
        user(toolResult("t1")),
        assistant(...turn2.filter(b => b.type !== "thinking")),
        user(toolResult("t2"))
      ),
      "V4b"
    );
  });
});

describe("R9-hist AC12 V5: requests are recorded; malformed requests are rejected", () => {
  it("R9-hist AC12 V5: every body is recorded in order as the exact bytes sent, accepted or rejected", async () => {
    const fake = textFake();
    const good = JSON.stringify(body(user("one")));
    const bad = JSON.stringify(body(user("two"), assistant(toolUse("t1")), user("no result")));
    await post(fake, good);
    await post(fake, bad);
    await post(fake, good);
    expect(fake.requests.map(r => r.index)).toEqual([0, 1, 2]);
    expect(fake.requests.map(r => r.rawBody)).toEqual([good, bad, good]);
    expect(fake.requests.map(r => r.status)).toEqual([200, 400, 200]);
    expect(fake.bodies()).toHaveLength(3);
    expect(fake.rejections()).toEqual([expect.objectContaining({ rule: "V1", requestIndex: 1 })]);
  });

  it("R9-hist AC12 V5 negative: a body that is not JSON is rejected and still recorded", async () => {
    const fake = textFake();
    const res = await post(fake, "{not json");
    expect(res.status).toBe(400);
    expect(fake.requests[0]).toMatchObject({ rawBody: "{not json", violations: [{ rule: "V5" }] });
    expect(fake.requests[0]!.body).toBeUndefined();
  });

  it.each([["null", "null"], ["an array", "[]"], ["a number", "5"]])("R9-hist AC12 V5 negative: a JSON body that is %s, not an object, is rejected", async (_n, raw) => {
    await expectRejected(textFake(), raw, "V5");
  });

  it.each([
    ["no messages", { model: MODEL, max_tokens: 10, stream: true }],
    ["empty messages", { model: MODEL, max_tokens: 10, stream: true, messages: [] }],
    ["first message is assistant", body(assistant(text("hi")), user("x"))],
    ["unknown role", { model: MODEL, max_tokens: 10, stream: true, messages: [{ role: "system", content: "x" }] }],
    ["no model", { max_tokens: 10, stream: true, messages: [user("x")] }],
    ["no max_tokens", { model: MODEL, stream: true, messages: [user("x")] }],
    ["content neither string nor array", { model: MODEL, max_tokens: 10, stream: true, messages: [{ role: "user", content: 5 }] }],
  ])("R9-hist AC12 V5 negative: malformed request (%s) is rejected", async (_name, payload) => {
    await expectRejected(textFake(), payload, "V5");
  });

  it("a non-streaming request or a foreign endpoint is a recorded FAULT of the fake (loud), not a silent pass", async () => {
    const fake = textFake();
    expect((await post(fake, { ...body(user("x")), stream: false })).status).toBe(501);
    expect((await fake.fetch("https://api.anthropic.com/v1/messages/count_tokens", { method: "POST", body: "{}" })).status).toBe(404);
    expect(fake.faults).toHaveLength(2);
  });
});

describe("R9-hist AC8: scripting (steps, functions, injected errors, stop reasons)", () => {
  const sdk = (fake: IContractFake) => new Anthropic({ apiKey: "sk-ant-api-test", maxRetries: 0, fetch: fake.fetch });
  const req = { model: MODEL, max_tokens: 64, messages: [{ role: "user" as const, content: "hi" }] };

  it("injected 400 invalid_request_error carries the caller's text through the real SDK (AC17 shapes: 'thinking signature', 'prompt is too long')", async () => {
    const fake = makeContractFake([
      { error: { status: 400, type: "invalid_request_error", message: "messages.1.content.0: Invalid `signature` in `thinking` block" } },
      { error: { status: 400, type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } },
    ]);
    await expect(sdk(fake).messages.stream(req).finalMessage()).rejects.toMatchObject({ status: 400, message: expect.stringContaining("thinking") });
    await expect(sdk(fake).messages.stream(req).finalMessage()).rejects.toMatchObject({ status: 400, message: expect.stringContaining("prompt is too long") });
  });

  it("injected 429 (with retry-after) and 529 surface with their status", async () => {
    const fake = makeContractFake([
      { error: { status: 429, type: "rate_limit_error", message: "slow down", headers: { "retry-after": "2" } } },
      { error: { status: 529, type: "overloaded_error", message: "Overloaded" } },
    ]);
    await expect(sdk(fake).messages.stream(req).finalMessage()).rejects.toMatchObject({ status: 429 });
    await expect(sdk(fake).messages.stream(req).finalMessage()).rejects.toMatchObject({ status: 529 });
  });

  it("a rejected request does not consume a script step; the index in function scripts counts every request", async () => {
    const seen: number[] = [];
    const script: FakeScript = ctx => {
      seen.push(ctx.index);
      return { blocks: [{ type: "text", text: `reply-${ctx.index}` }] };
    };
    const fake = makeContractFake(script);
    await post(fake, body(user("a")));
    await post(fake, body(user("a"), assistant(toolUse("t1")), user("bad")));
    await post(fake, body(user("a")));
    expect(seen).toEqual([0, 2]);
    const steps = makeContractFake([{ blocks: [{ type: "text", text: "only" }] }]);
    await post(steps, body(user("a"), assistant(toolUse("t1")), user("bad")));
    expect((await post(steps, body(user("a")))).status).toBe(200);
  });

  it("an exhausted script answers 500 and records a fault the test must assert on", async () => {
    const fake = makeContractFake([{ blocks: [{ type: "text", text: "one" }] }]);
    await post(fake, body(user("a")));
    expect((await post(fake, body(user("a")))).status).toBe(500);
    expect(fake.faults).toEqual([expect.stringContaining("script exhausted")]);
  });

  it("pause_turn, usage and model overrides reach the SDK message (R9-pause AC1)", async () => {
    const fake = makeContractFake([
      { blocks: [{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } }, { type: "web_search_tool_result", tool_use_id: "s1", content: [] }], stopReason: "pause_turn", usage: { input_tokens: 99, output_tokens: 42 }, model: "claude-test-x" },
    ]);
    const msg = await sdk(fake).messages.stream(req).finalMessage();
    expect(msg.stop_reason).toBe("pause_turn");
    expect(msg.model).toBe("claude-test-x");
    expect(msg.usage).toMatchObject({ input_tokens: 99, output_tokens: 42 });
    expect(msg.id).toBe("msg_fake_000");
  });

  it("a server_tool_use with no result is executed INLINE when the step has no client tool_use", async () => {
    const fake = makeContractFake([{ blocks: [{ type: "server_tool_use", id: "s1", name: "web_fetch", input: { url: "https://example.com/x" } }, { type: "text", text: "done" }] }]);
    const msg = await sdk(fake).messages.stream(req).finalMessage();
    expect(msg.content.map(b => b.type)).toEqual(["server_tool_use", "web_fetch_tool_result", "text"]);
    expect(msg.stop_reason).toBe("end_turn");
    expect(fake.deferred).toEqual([]);
  });

  it("a scripted model sees the visible history: it re-issues web_fetch exactly when the page is not in context (the arm-C loop)", async () => {
    const URL1 = "https://example.com/spec";
    const model: FakeScript = ctx =>
      ctx.history.isUrlInContext(URL1)
        ? { blocks: [{ type: "text", text: "have it" }] }
        : { blocks: [{ type: "tool_use", id: `t${ctx.index}`, name: "fs__read_text_file", input: {} }, { type: "server_tool_use", id: `s${ctx.index}`, name: "web_fetch", input: { url: URL1 } }] };

    // A history that LOST the fetched page (dropped tail, arm C): the scripted model fetches again, every round.
    const lossy = makeContractFake(model, { allowThinkingOmission: true });
    await expectAccepted(lossy, body(user("go")));
    await expectAccepted(lossy, body(user("go"), assistant(toolUse("t0")), user(toolResult("t0"))));
    await expectAccepted(lossy, body(user("go"), assistant(toolUse("t0")), user(toolResult("t0")), assistant(toolUse("t1")), user(toolResult("t1"))));
    expect(lossy.deferred.map(d => d.id)).toEqual(["s0", "s1", "s2"]);

    // A faithful history: the first turn is replayed whole with its dangling use, the fake executes the fetch, the
    // scripted model sees the page (it is in the history it is about to answer) and stops fetching.
    const faithful = makeContractFake(model);
    await expectAccepted(faithful, body(user("go")));
    await expectAccepted(faithful, body(user("go"), assistant(toolUse("t0"), serverUse("s0", URL1)), user(toolResult("t0"))));
    expect(faithful.emittedTurns[1]!.blocks.map(b => b.type)).toEqual(["web_fetch_tool_result", "text"]);
    await expectAccepted(
      faithful,
      body(user("go"), assistant(toolUse("t0"), serverUse("s0", URL1)), user(toolResult("t0")), assistant(...(toApiBlocks(faithful.emittedTurns[1]!.blocks))), user("thanks"))
    );
    expect(faithful.emittedTurns[2]!.blocks.map(b => b.type)).toEqual(["text"]);
    expect(faithful.deferred.map(d => d.id)).toEqual(["s0"]);
  });
});

describe("R9-hist AC12 helpers: visibleHistory + normalizeMessages", () => {
  it("merges consecutive same-role messages and expands string content", () => {
    const merged = normalizeMessages([user("a"), user("b"), assistant(text("c")), assistant(text("d"))]);
    expect(merged.map(m => m.role)).toEqual(["user", "assistant"]);
    expect(merged[0]!.blocks).toEqual([text("a"), text("b")]);
  });

  it("reports server uses (resolved or not), results and fetched URLs", () => {
    const h = visibleHistory(
      normalizeMessages([
        user("go"),
        assistant(serverUse("s1", "https://a.test"), serverResult("s1", "https://a.test", "A-PAGE"), serverUse("s2", "https://b.test"), toolUse("t1")),
        user(toolResult("t1")),
      ])
    );
    expect(h.serverToolUses().map(u => [u.id, u.resolved])).toEqual([["s1", true], ["s2", false]]);
    expect(h.fetchedUrls()).toEqual(["https://a.test"]);
    expect(h.isUrlInContext("https://a.test")).toBe(true);
    expect(h.isUrlInContext("https://b.test")).toBe(false);
    expect(h.contains("A-PAGE")).toBe(true);
    expect(h.contains("B-PAGE")).toBe(false);
  });
});

describe("R9-hist AC4 / AC12: the fake driven by the sanitized R8 C1 captures", () => {
  it("R9-hist AC4: C1 seq02 scripted as turn 1 -> faithful replay (thinking + dangling server_tool_use) is accepted and the deferred page is delivered first; the arm-C replay (thinking and tail dropped) is the V4b defect", async () => {
    const seq02 = c1Reply("seq02DeferredServerToolUse");
    const turn1 = toApiBlocks(seq02.blocks);
    const clientIds = turn1.filter(b => b.type === "tool_use").map(b => String(b["id"]));
    const serverId = String(turn1.find(b => b.type === "server_tool_use")!["id"]);
    const results = clientIds.map(id => toolResult(id));

    // Faithful: exactly what the model returned.
    const good = makeContractFake([seq02, c1Reply("seq05ExecutedPairTwoClients")]);
    await expectAccepted(good, body(user("task")));
    await expectAccepted(good, body(user("task"), assistant(...turn1), user(...results)));
    expect(good.deferred[0]).toMatchObject({ id: serverId, deliveredAtRequest: 1 });
    expect(good.emittedTurns[1]!.blocks[0]).toMatchObject({ type: "web_fetch_tool_result", tool_use_id: serverId });

    // Arm C's shape: text + tool_use only (what the legacy provider rebuilt). The API accepted it silently in R8; the
    // fake flags the dropped thinking as V4b, and in a no-thinking world the dropped tail would simply never run.
    const armC = makeContractFake([seq02, c1Reply("seq03AfterDroppedTail")]);
    await expectAccepted(armC, body(user("task")));
    const legacyHistory = body(user("task"), assistant(...turn1.filter(b => b.type === "text" || b.type === "tool_use")), user(...results));
    await expectRejected(armC, legacyHistory, "V4b");

    const lenient = makeContractFake([seq02, c1Reply("seq03AfterDroppedTail")], { allowThinkingOmission: true });
    await expectAccepted(lenient, body(user("task")));
    await expectAccepted(lenient, legacyHistory);
    expect(lenient.deferred[0]!.deliveredAtRequest).toBeUndefined();
  });

  it("R9-hist AC12 V4a: C1 seq04 (two thinking blocks around an executed pair) replayed whole is accepted; swapping the two thinking blocks is rejected", async () => {
    const seq04 = c1Reply("seq04ExecutedPairWithThinking");
    const blocks = toApiBlocks(seq04.blocks);
    const toolId = String(blocks.find(b => b.type === "tool_use")!["id"]);
    const fake = makeContractFake([seq04, { blocks: [{ type: "text", text: "ok" }] }]);
    await expectAccepted(fake, body(user("task")));
    const swapped = [...blocks];
    [swapped[0], swapped[4]] = [blocks[4]!, blocks[0]!];
    await expectRejected(fake, body(user("task"), assistant(...swapped), user(toolResult(toolId))), "V4a");
    await expectAccepted(fake, body(user("task"), assistant(...blocks), user(toolResult(toolId))));
  });
});
