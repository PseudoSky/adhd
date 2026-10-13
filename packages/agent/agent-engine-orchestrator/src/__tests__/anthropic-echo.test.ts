/**
 * R9-hist S2a: `providers/anthropic-echo.ts`, the pure capture / replay / sanitize / degrade-match / persistence-partition
 * helpers behind Anthropic assistant-history fidelity.
 *
 * Offline and deterministic: no provider call, no network, no clock, no sleep. Block shapes come from the REAL
 * `@anthropic-ai/sdk` accumulating the S1 fixtures (including sanitized R8 C1 wire captures) through a `fetch` seam, and
 * history validity is judged by the S1 contract fake's documented-rule validator (`validateMessagesRequest`), so
 * "sanitize prevents a 400" is asserted against a rule engine instead of against the function's own output.
 *
 * Acceptance ids (spec-v2 / spec R9-DUR; each test title cites its id):
 *  - R9-hist AC1: `captureEcho` keeps the SDK's content blocks verbatim, deep-cloned, order preserved; a text/tool_use-only
 *    response yields no echo.
 *  - R9-hist AC2: `assistantBlocks` emits thinking (signature, empty display) unmodified and in order.
 *  - R9-hist AC3: an executed server_tool_use + result pair is replayed in place with `tool_use_id` intact.
 *  - R9-hist AC4 (S3a part): outside the pending-tail exception a dangling server_tool_use / orphan result is dropped,
 *    never a 400 (the pending-tail exception itself is S3b and is asserted ABSENT here).
 *  - R9-hist AC5: replayed `tool_use.name` goes through the provider's resolver; id and input unchanged.
 *  - R9-hist AC6: no echo / wrong provider / wrong model / disagreeing tool calls => `undefined` (legacy path).
 *  - R9-hist AC10 (pure part): `partitionEcho` / `stripServerBlocks` tiering and caps.
 *  - R9-hist AC17 (matcher part): `isEchoRejection` accepts echo-fault 400s and excludes context-length 400s, 429, 5xx, abort.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { describe, expect, it } from "vitest";

import type { IProviderEcho } from "@adhd/agent-base-types";

import {
  assistantBlocks,
  captureEcho,
  isEchoRejection,
  replayedEchoFamilies,
  type EchoBlockFamily,
  partitionEcho,
  sanitizeServerToolPairs,
  stripServerBlocks,
  type EchoCaps,
} from "../providers/anthropic-echo.js";
import { ProviderCallError, describeFailure } from "../providers/provider-failure.js";
import type { Message, ToolCall } from "../validation/index.js";
import {
  c1Reply,
  loadC1Wire,
  validateMessagesRequest,
  webFetchResultBlock,
  type IApiBlock,
} from "./fixtures/anthropic-contract-fake.js";
import { anthropicSseBody, parseSseBody, type ISseBlock } from "./fixtures/anthropic-sse.js";

const MODEL = "claude-haiku-5-5";
const USAGE = { input_tokens: 12, output_tokens: 7 };

/** What the real SDK accumulates from an SSE body (the same client code path `AnthropicProvider` uses). */
async function sdkContent(sse: string): Promise<unknown[]> {
  const client = new Anthropic({
    apiKey: "sk-ant-api-test",
    maxRetries: 0,
    fetch: (async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch,
  });
  const msg = await client.messages.stream({ model: MODEL, max_tokens: 1024, messages: [{ role: "user", content: "hi" }] }).finalMessage();
  return msg.content as unknown[];
}

const nameFor = (tc: ToolCall): string => `${tc.server}__${tc.tool}`;

function assistantMessage(over: Partial<Message> = {}): Message {
  return { id: "msg_a1", sessionId: "s1", role: "assistant", createdAt: "2026-01-01T00:00:00.000Z", ...over };
}

function call(id: string, server: string, tool: string, args: unknown = {}): ToolCall {
  return { id, server, tool, arguments: args };
}

const thinking = (sig: string, text = ""): IApiBlock => ({ type: "thinking", thinking: text, signature: sig });
const text = (t: string): IApiBlock => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: unknown = {}): IApiBlock => ({ type: "tool_use", id, name, input });
const serverUse = (id: string, url = "https://example.com/a"): IApiBlock => ({ type: "server_tool_use", id, name: "web_fetch", input: { url } });
const serverResult = (id: string, body = "page body", url = "https://example.com/a"): IApiBlock =>
  webFetchResultBlock(id, url, body) as unknown as IApiBlock;

function echoOf(blocks: IApiBlock[], model = MODEL): IProviderEcho {
  return { provider: "anthropic", model, blocks };
}

const types = (blocks: readonly unknown[]): string[] => blocks.map(b => (b as { type: string }).type);

// ─── captureEcho ─────────────────────────────────────────────────────────────

describe("R9-hist AC1: captureEcho", () => {
  it("R9-hist AC1: thinking + redacted_thinking + text + tool_use + server_tool_use + server result are captured verbatim, in order", async () => {
    const blocks: ISseBlock[] = [
      { type: "thinking", thinking: "", signature: "SYNTHETIC-SIGNATURE-0" },
      { type: "redacted_thinking", data: "SYNTHETIC-REDACTED-0" },
      { type: "text", text: "fetching" },
      { type: "tool_use", id: "toolu_1", name: "fs__read_text_file", input: { path: "a.js" }, caller: { type: "direct" } },
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_fetch", input: { url: "https://example.com" } },
      webFetchResultBlock("srvtoolu_1", "https://example.com", "Example Domain"),
      { type: "thinking", thinking: "shown", signature: "SYNTHETIC-SIGNATURE-1" },
      { type: "text", text: "done" },
    ];
    const content = await sdkContent(anthropicSseBody({ model: MODEL, usage: USAGE, blocks }));
    const echo = captureEcho(content, MODEL);

    expect(echo).toEqual({ provider: "anthropic", model: MODEL, blocks: content });
    expect(types(echo!.blocks)).toEqual([
      "thinking", "redacted_thinking", "text", "tool_use", "server_tool_use", "web_fetch_tool_result", "thinking", "text",
    ]);
  });

  it("R9-hist AC1: the sanitized R8 C1 capture seq 2 (deferred server_tool_use beside client tool_use) is captured whole", async () => {
    const content = await sdkContent(loadC1Wire("seq02DeferredServerToolUse"));
    const echo = captureEcho(content, MODEL)!;
    expect(echo.blocks).toEqual(content);
    expect(types(echo.blocks)).toContain("server_tool_use");
    expect(types(echo.blocks)).not.toContain("web_fetch_tool_result");
    expect(types(echo.blocks).filter(t => t === "tool_use").length).toBeGreaterThanOrEqual(2);
  });

  it("R9-hist AC1: the sanitized C1 captures seq 4 and 5 (executed pair with interleaved thinking) are captured whole", async () => {
    for (const name of ["seq04ExecutedPairWithThinking", "seq05ExecutedPairTwoClients"] as const) {
      const content = await sdkContent(loadC1Wire(name));
      const echo = captureEcho(content, MODEL)!;
      expect(echo.blocks, name).toEqual(content);
      expect(types(echo.blocks), name).toEqual(expect.arrayContaining(["thinking", "server_tool_use", "web_fetch_tool_result"]));
    }
  });

  it("R9-hist AC1: a text/tool_use-only response yields NO echo (request bytes stay what they are today)", async () => {
    const content = await sdkContent(loadC1Wire("seq03AfterDroppedTail"));
    expect(types(content)).not.toContain("thinking");
    expect(captureEcho(content, MODEL)).toBeUndefined();
    expect(captureEcho([text("hi"), toolUse("toolu_1", "a__b")], MODEL)).toBeUndefined();
    expect(captureEcho([], MODEL)).toBeUndefined();
  });

  it.each([
    ["thinking", [thinking("sig")]],
    ["redacted_thinking", [{ type: "redacted_thinking", data: "x" } as IApiBlock]],
    ["server_tool_use", [serverUse("srv_1")]],
    ["web_fetch_tool_result", [serverResult("srv_1")]],
    ["web_search_tool_result", [{ type: "web_search_tool_result", tool_use_id: "srv_2", content: [] } as IApiBlock]],
  ])("R9-hist AC1: a lone %s block makes the response worth echoing", (_name, blocks) => {
    expect(captureEcho(blocks, MODEL)?.blocks).toEqual(blocks);
  });

  it("R9-hist AC1: a client tool_result type is not a server result (never triggers an echo)", () => {
    expect(captureEcho([{ type: "tool_result", tool_use_id: "t", content: "x" } as IApiBlock], MODEL)).toBeUndefined();
  });

  it("R9-hist AC1: unknown future block types are preserved verbatim next to a relevant block", () => {
    const future: IApiBlock = { type: "future_block_v9", payload: { nested: [1, 2, { k: "v" }] }, citations: null };
    const echo = captureEcho([thinking("sig"), future, text("t")], MODEL)!;
    expect(echo.blocks[1]).toEqual(future);
    expect(types(echo.blocks)).toEqual(["thinking", "future_block_v9", "text"]);
  });

  it("R9-hist AC1: the capture is a deep clone to plain JSON, not a reference into SDK-owned objects", () => {
    const source = [thinking("sig"), toolUse("toolu_1", "a__b", { deep: { n: 1 } })];
    const echo = captureEcho(source, MODEL)!;
    (source[1] as unknown as { input: { deep: { n: number } } }).input.deep.n = 99;
    (source[0] as unknown as { signature: string }).signature = "mutated";
    expect((echo.blocks[1] as { input: { deep: { n: number } } }).input.deep.n).toBe(1);
    expect((echo.blocks[0] as { signature: string }).signature).toBe("sig");
    expect(JSON.parse(JSON.stringify(echo))).toEqual(echo);
  });

  it("R9-hist AC1: the model recorded is the configured model string passed in", () => {
    expect(captureEcho([thinking("s")], "my-configured-model")?.model).toBe("my-configured-model");
  });
});

// ─── assistantBlocks ─────────────────────────────────────────────────────────

describe("R9-hist AC2 AC3 AC5 AC6: assistantBlocks", () => {
  const blocks = [
    thinking("SIG-A"),
    text("looking"),
    serverUse("srv_1"),
    serverResult("srv_1"),
    thinking("SIG-B", "visible reasoning"),
    toolUse("toolu_1", "read_text_file", { path: "/a" }),
  ];
  const msg = assistantMessage({ content: "looking", toolCalls: [call("toolu_1", "fs", "read_text_file", { path: "/a" })] });

  it("R9-hist AC2: thinking blocks (type, signature, empty display) are emitted unmodified, in captured order", () => {
    const out = assistantBlocks(msg, echoOf(blocks), MODEL, nameFor)!;
    expect(out[0]).toEqual(blocks[0]);
    expect(out[4]).toEqual(blocks[4]);
    expect(types(out)).toEqual(["thinking", "text", "server_tool_use", "web_fetch_tool_result", "thinking", "tool_use"]);
  });

  it("R9-hist AC3: an executed pair is replayed in place with tool_use_id intact", () => {
    const out = assistantBlocks(msg, echoOf(blocks), MODEL, nameFor)!;
    expect(out[2]).toEqual(blocks[2]);
    expect(out[3]).toEqual(blocks[3]);
    expect((out[3] as unknown as { tool_use_id: string }).tool_use_id).toBe("srv_1");
  });

  it("R9-hist AC5: only tool_use.name is rewritten (through the provider resolver); id and input are unchanged", () => {
    const out = assistantBlocks(msg, echoOf(blocks), MODEL, nameFor)!;
    expect(out[5]).toEqual({ type: "tool_use", id: "toolu_1", name: "fs__read_text_file", input: { path: "/a" } });
    // every other block is deep-equal to the capture
    expect(out.filter((_, i) => i !== 5)).toEqual(blocks.filter((_, i) => i !== 5));
  });

  it("R9-hist AC5: a server tool name (web_fetch) is never passed through the resolver", () => {
    const seen: string[] = [];
    assistantBlocks(msg, echoOf(blocks), MODEL, tc => (seen.push(tc.id), nameFor(tc)));
    expect(seen).toEqual(["toolu_1"]);
  });

  it("R9-hist AC5: the replay is a copy, mutating it does not touch the stored echo", () => {
    const echo = echoOf(blocks);
    const out = assistantBlocks(msg, echo, MODEL, nameFor)!;
    (out[0] as unknown as { signature: string }).signature = "tampered";
    expect((echo.blocks[0] as { signature: string }).signature).toBe("SIG-A");
    expect((echo.blocks[5] as { name: string }).name).toBe("read_text_file");
  });

  it("R9-hist AC6: no echo => undefined (the caller keeps the legacy rebuild, byte-identical to today)", () => {
    expect(assistantBlocks(msg, undefined, MODEL, nameFor)).toBeUndefined();
  });

  it("R9-hist AC6: an echo of another model or another provider is not replayed", () => {
    expect(assistantBlocks(msg, echoOf(blocks, "claude-opus-4-8"), MODEL, nameFor)).toBeUndefined();
    const foreign = { ...echoOf(blocks), provider: "openai" } as unknown as IProviderEcho;
    expect(assistantBlocks(msg, foreign, MODEL, nameFor)).toBeUndefined();
  });

  it("R9-hist AC6: an empty echo is not replayed", () => {
    expect(assistantBlocks(msg, echoOf([]), MODEL, nameFor)).toBeUndefined();
  });

  it("R9-hist AC6: an echo whose client tool_use ids disagree with the message's tool calls falls back (never a mispaired history)", () => {
    const edited = assistantMessage({ toolCalls: [call("toolu_OTHER", "fs", "read_text_file")] });
    expect(assistantBlocks(edited, echoOf(blocks), MODEL, nameFor)).toBeUndefined();
    const fewer = assistantMessage({ toolCalls: [] });
    expect(assistantBlocks(fewer, echoOf(blocks), MODEL, nameFor)).toBeUndefined();
    const more = assistantMessage({ toolCalls: [call("toolu_1", "fs", "read_text_file"), call("toolu_2", "fs", "x")] });
    expect(assistantBlocks(more, echoOf(blocks), MODEL, nameFor)).toBeUndefined();
  });

  it("R9-hist AC6: a thinking-only turn with no tool calls replays whole", () => {
    const e = echoOf([thinking("S"), text("answer")]);
    expect(assistantBlocks(assistantMessage({ content: "answer" }), e, MODEL, nameFor)).toEqual(e.blocks);
  });

  it("R9-hist AC5: parallel tool calls are each renamed by id, in echoed order", () => {
    const e = echoOf([thinking("S"), toolUse("t1", "a"), toolUse("t2", "b"), toolUse("t3", "c")]);
    const m = assistantMessage({ toolCalls: [call("t1", "x", "a"), call("t2", "y", "b"), call("t3", "z", "c")] });
    const out = assistantBlocks(m, e, MODEL, nameFor)!;
    expect(out.slice(1).map(b => (b as unknown as { name: string }).name)).toEqual(["x__a", "y__b", "z__c"]);
  });
});

// ─── sanitizeServerToolPairs ─────────────────────────────────────────────────

describe("R9-hist AC4: sanitizeServerToolPairs", () => {
  const user = (t: string): MessageParam => ({ role: "user", content: t });
  const toolResultUser = (id: string): MessageParam => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] });
  const asst = (...blocks: IApiBlock[]): MessageParam => ({ role: "assistant", content: blocks as unknown as MessageParam["content"] });

  /** The contract fake's documented-rule verdict on a history. */
  function violations(messages: MessageParam[]): string[] {
    const v = validateMessagesRequest(
      { model: MODEL, max_tokens: 64, stream: true, messages },
      { emittedTurns: [], allowThinkingOmission: true },
    );
    // V4a/V4b judge thinking PROVENANCE against what the fake emitted; this suite hands in synthetic thinking and
    // checks PAIRING (V1-V3, V5) only.
    return v.violations.filter(x => x.rule !== "V4a" && x.rule !== "V4b").map(x => `${x.rule}: ${x.message}`);
  }

  it("R9-hist AC4: a complete pair is untouched and the same message objects are returned", () => {
    const history = [user("go"), asst(thinking("S"), serverUse("srv_1"), serverResult("srv_1"), text("done")), user("next")];
    const out = sanitizeServerToolPairs(history);
    expect(out).toEqual(history);
    expect(out[1]).toBe(history[1]);
    expect(violations(out)).toEqual([]);
  });

  it("R9-hist AC4: an orphan result (its server_tool_use windowed away) is dropped; the raw history is a V3 400, the sanitized one is not", () => {
    const history = [user("go"), asst(serverResult("srv_gone"), text("based on the page")), user("next")];
    expect(violations(history).join("\n")).toMatch(/V3/); // negative control: the unsanitized history is invalid
    const out = sanitizeServerToolPairs(history);
    expect(types((out[1] as { content: unknown[] }).content)).toEqual(["text"]);
    expect(violations(out)).toEqual([]);
  });

  it("R9-hist AC4: a dangling server_tool_use mid-history is dropped; the raw history is rejected, the sanitized one is not", () => {
    const history = [
      user("go"),
      asst(text("fetching"), serverUse("srv_1"), toolUse("toolu_1", "a__b")),
      toolResultUser("toolu_1"),
      asst(text("later")),
      user("next"),
    ];
    expect(violations(history).join("\n")).toMatch(/V2/); // negative control
    const out = sanitizeServerToolPairs(history);
    expect(types((out[1] as { content: unknown[] }).content)).toEqual(["text", "tool_use"]);
    expect(violations(out)).toEqual([]);
  });

  it("R9-hist AC4: the pending-tail shape is dropped by this sanitizer (S3a ships without the deferred exception: today's behaviour, never a 400)", () => {
    const history = [user("go"), asst(text("fetching"), serverUse("srv_1"), toolUse("toolu_1", "a__b")), toolResultUser("toolu_1")];
    const out = sanitizeServerToolPairs(history);
    expect(types((out[1] as { content: unknown[] }).content)).toEqual(["text", "tool_use"]);
    expect(violations(out)).toEqual([]);
  });

  it("R9-hist AC4: a result that arrives in the next assistant message still pairs with its use (kept, in order)", () => {
    const history = [
      user("go"),
      asst(text("fetching"), serverUse("srv_1"), toolUse("toolu_1", "a__b")),
      toolResultUser("toolu_1"),
      asst(serverResult("srv_1"), text("got it")),
    ];
    const out = sanitizeServerToolPairs(history);
    expect(out).toEqual(history);
    expect(violations(out)).toEqual([]);
  });

  it("R9-hist AC4: a result placed BEFORE its use is an orphan and the use (now result-less) goes with it", () => {
    const history = [user("go"), asst(serverResult("srv_1"), serverUse("srv_1"), text("x"))];
    const out = sanitizeServerToolPairs(history);
    expect(types((out[1] as { content: unknown[] }).content)).toEqual(["text"]);
  });

  it("R9-hist AC4: a duplicate result for one id is dropped (V3 duplicate), the first stays", () => {
    const history = [user("go"), asst(serverUse("srv_1"), serverResult("srv_1", "first"), serverResult("srv_1", "second"), text("x"))];
    expect(violations(history).join("\n")).toMatch(/duplicate/); // negative control
    const out = sanitizeServerToolPairs(history);
    const content = (out[1] as { content: Array<{ type: string; content?: { content?: { source?: { data?: string } } } }> }).content;
    expect(content.map(b => b.type)).toEqual(["server_tool_use", "web_fetch_tool_result", "text"]);
    expect(JSON.stringify(content[1])).toContain("first");
    expect(JSON.stringify(content[1])).not.toContain("second");
    expect(violations(out)).toEqual([]);
  });

  it("R9-hist AC4: windowing that keeps only the second half of a pair and the first half of another is repaired", () => {
    const history = [
      asst(serverResult("srv_old")), // windowed: use fell outside
      user("x"),
      asst(serverUse("srv_new"), text("tail")), // windowed: result fell outside (or never came)
    ];
    const out = sanitizeServerToolPairs(history.slice(1)); // a request must start with a user turn
    expect(violations(out)).toEqual([]);
    const all = sanitizeServerToolPairs(history);
    expect(all.some(m => JSON.stringify(m).includes("srv_old"))).toBe(false); // orphan and its (now empty) message are gone
    expect(all.some(m => JSON.stringify(m).includes("srv_new"))).toBe(false);
  });

  it("R9-hist AC4: thinking blocks and unknown blocks are never touched", () => {
    const future: IApiBlock = { type: "future_block_v9", x: 1 };
    const history = [user("go"), asst(thinking("SIG"), future, serverUse("srv_1"), text("t"))];
    const out = sanitizeServerToolPairs(history);
    expect((out[1] as { content: unknown[] }).content).toEqual([thinking("SIG"), future, text("t")]);
  });

  it("R9-hist AC4: an assistant message left empty is removed (the API rejects empty content); user turns and string content pass through", () => {
    const history = [user("a"), asst(serverUse("srv_1")), user("b"), { role: "assistant", content: "plain" } as MessageParam];
    const out = sanitizeServerToolPairs(history);
    expect(out.map(m => m.role)).toEqual(["user", "user", "assistant"]);
    expect(out[2]).toBe(history[3]);
  });

  it("R9-hist AC4: the input array and its messages are not mutated", () => {
    const history = [user("go"), asst(serverResult("srv_gone"), text("x"))];
    const before = JSON.stringify(history);
    sanitizeServerToolPairs(history);
    expect(JSON.stringify(history)).toBe(before);
  });

  it("R9-hist AC4: server blocks without an id cannot pair and are dropped; the client tool_result of a user turn is never mistaken for a server result", () => {
    const history = [
      user("go"),
      asst({ type: "server_tool_use", name: "web_fetch", input: {} } as IApiBlock, text("t")),
      toolResultUser("toolu_x"),
    ];
    const out = sanitizeServerToolPairs(history);
    expect(types((out[1] as { content: unknown[] }).content)).toEqual(["text"]);
    expect(out[2]).toBe(history[2]);
  });

  it("R9-hist AC4: web_search pairs (an unrelated *_tool_result type) are paired the same way", () => {
    const search = (id: string): IApiBlock => ({ type: "web_search_tool_result", tool_use_id: id, content: [] });
    const use = (id: string): IApiBlock => ({ type: "server_tool_use", id, name: "web_search", input: { query: "q" } });
    const ok = [user("go"), asst(use("srv_s"), search("srv_s"), text("t"))];
    expect(sanitizeServerToolPairs(ok)).toEqual(ok);
    const orphan = [user("go"), asst(search("srv_none"), text("t"))];
    expect(types((sanitizeServerToolPairs(orphan)[1] as { content: unknown[] }).content)).toEqual(["text"]);
  });
});

// ─── isEchoRejection ─────────────────────────────────────────────────────────

describe("R9-hist AC17: isEchoRejection", () => {
  const base = {
    v: 1 as const,
    scope: "request" as const,
    resumable: false,
    confidence: "certain" as const,
    providerType: "anthropic" as const,
    modelRef: MODEL,
    wireModel: MODEL,
    credentialKey: "k",
    credentialScope: "k",
    attempts: [],
    hops: [],
    classifierVersion: 1,
  };
  function failure(cls: "invalid_request" | "context_length" | "rate_limited" | "unavailable" | "overloaded" | "cancelled" | "auth", msg: string, status?: number): ProviderCallError {
    const f = {
      ...base,
      class: cls,
      retryable: cls === "rate_limited" || cls === "unavailable" || cls === "overloaded",
      message: msg,
      ...(status === undefined ? {} : { status }),
    } as unknown as ConstructorParameters<typeof ProviderCallError>[0];
    return new ProviderCallError(f, describeFailure(f));
  }

  it.each([
    "messages.3.content.0: Invalid `signature` in `thinking` block",
    "thinking blocks in the latest assistant message cannot be modified",
    "messages.1.content.2: `redacted_thinking` block could not be verified",
    "unexpected `tool_use_id` found in `web_fetch_tool_result` blocks: srvtoolu_x",
    "`server_tool_use` block without a corresponding result",
    "web_search_tool_result block missing its server_tool_use",
    "messages.2.content.1: Expected `thinking` or `redacted_thinking`, but found `text`. When `thinking` is enabled, a final `assistant` message must start with a thinking block",
  ])("R9-hist AC17: invalid_request naming an echoed block type is an echo rejection: %s", msg => {
    expect(isEchoRejection(failure("invalid_request", msg, 400))).toBe(true);
  });

  it.each([
    "prompt is too long: 213000 tokens > 200000 maximum",
    "input length and max_tokens exceed context limit: 188240 + 64000 > 200000",
    "Request exceeds the maximum context window for this model",
    "too many tokens in the thinking budget",
    "context_length_exceeded while replaying thinking blocks",
    "context length exceeded: web_fetch_tool_result is huge",
  ])("R9-hist AC17: a length rejection is NOT an echo rejection even if it names an echoed block: %s", msg => {
    expect(isEchoRejection(failure("invalid_request", msg, 400))).toBe(false);
  });

  it.each([
    "messages.4: tool_use ids were found without tool_result blocks immediately after",
    "messages.2.content.0.tool_result: unexpected `tool_use_id` found in `tool_result` blocks: toolu_x",
    "tools.0.web_search: max_uses must be a positive integer",
    "tools.1.web_fetch_20250910: invalid allowed_domains",
    "thinking.budget_tokens: Input should be greater than or equal to 1024",
    "messages.1.content.0.tool_result.content: redacted",
  ])("cafe9a17 AC2: a genuine history/config 400 that merely mentions a tool or thinking word is NOT an echo rejection: %s", msg => {
    expect(isEchoRejection(failure("invalid_request", msg, 400))).toBe(false);
  });

  it("cafe9a17 AC2: the matched family must have been replayed (a thinking-block 400 with no thinking on the wire is not echo-caused)", () => {
    const err = failure("invalid_request", "messages.3.content.0: Invalid `signature` in `thinking` block", 400);
    expect(isEchoRejection(err, new Set<EchoBlockFamily>(["thinking"]))).toBe(true);
    expect(isEchoRejection(err, new Set<EchoBlockFamily>())).toBe(false);
    expect(isEchoRejection(err, new Set<EchoBlockFamily>(["server"]))).toBe(false);
    const srv = failure("invalid_request", "unexpected tool_use_id found in `web_fetch_tool_result` blocks: srvtoolu_x", 400);
    expect(isEchoRejection(srv, new Set<EchoBlockFamily>(["server"]))).toBe(true);
    expect(isEchoRejection(srv, new Set<EchoBlockFamily>(["thinking"]))).toBe(false);
  });

  it("cafe9a17 AC2: replayedEchoFamilies reports exactly the echo families on the wire", () => {
    const asst = (...content: unknown[]) => ({ role: "assistant", content }) as never;
    expect([...replayedEchoFamilies([asst({ type: "text", text: "a" }, { type: "tool_use", id: "t", name: "n", input: {} })])]).toEqual([]);
    expect([...replayedEchoFamilies([asst({ type: "redacted_thinking", data: "x" })])]).toEqual(["thinking"]);
    expect([...replayedEchoFamilies([asst({ type: "server_tool_use", id: "s", name: "web_search", input: {} })])]).toEqual(["server"]);
    expect([...replayedEchoFamilies([{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] } as never])]).toEqual([]);
  });

  it("R9-hist AC17: an invalid_request that names no echoed block type is not an echo rejection", () => {
    expect(isEchoRejection(failure("invalid_request", "max_tokens: must be greater than or equal to 1", 400))).toBe(false);
    expect(isEchoRejection(failure("invalid_request", "model: field required", 400))).toBe(false);
  });

  it("R9-hist AC17: other classes (context_length, 429, 5xx/overloaded, auth, cancelled) never match even with a matching text", () => {
    const msg = "Invalid signature in thinking block";
    expect(isEchoRejection(failure("context_length", msg, 400))).toBe(false);
    expect(isEchoRejection(failure("rate_limited", msg, 429))).toBe(false);
    expect(isEchoRejection(failure("unavailable", msg, 503))).toBe(false);
    expect(isEchoRejection(failure("overloaded", msg, 529))).toBe(false);
    expect(isEchoRejection(failure("auth", msg, 401))).toBe(false);
    expect(isEchoRejection(failure("cancelled", msg))).toBe(false);
  });

  it("R9-hist AC17: a non-provider error (plain Error, AbortError, SDK-shaped object, nullish) is never an echo rejection", () => {
    const abort = new Error("Request was aborted: thinking");
    abort.name = "AbortError";
    expect(isEchoRejection(new Error("Invalid signature in thinking block"))).toBe(false);
    expect(isEchoRejection(abort)).toBe(false);
    expect(isEchoRejection({ status: 400, message: "Invalid signature in thinking block" })).toBe(false);
    expect(isEchoRejection(undefined)).toBe(false);
    expect(isEchoRejection(null)).toBe(false);
    expect(isEchoRejection("thinking")).toBe(false);
  });

  it("R9-hist AC17: the provider-class prefix in the error text (\"Provider failure [invalid_request ...]\") does not by itself match", () => {
    const e = failure("invalid_request", "bad request", 400);
    expect(e.message).toContain("invalid_request");
    expect(isEchoRejection(e)).toBe(false);
  });
});

// ─── stripServerBlocks / partitionEcho ───────────────────────────────────────

describe("R9-hist AC10: stripServerBlocks", () => {
  it("R9-hist AC10: removes every server_tool_use and *_tool_result (pairs whole), keeps tier T in order", () => {
    const e = echoOf([thinking("S"), text("a"), serverUse("srv_1"), serverResult("srv_1"), toolUse("t1", "x__y"), serverUse("srv_2"), serverResult("srv_2")]);
    const out = stripServerBlocks(e);
    expect(types(out.blocks)).toEqual(["thinking", "text", "tool_use"]);
    expect(out.provider).toBe("anthropic");
    expect(out.model).toBe(MODEL);
  });

  it("R9-hist AC10: pure: the input echo is not mutated, and an echo without tier S is returned as is", () => {
    const e = echoOf([thinking("S"), serverUse("srv_1"), serverResult("srv_1")]);
    const before = JSON.stringify(e);
    stripServerBlocks(e);
    expect(JSON.stringify(e)).toBe(before);
    const t = echoOf([thinking("S"), text("a")]);
    expect(stripServerBlocks(t)).toBe(t);
  });

  it("R9-hist AC10: the stripped history is valid by the sanitizer (no pair is split)", () => {
    const e = echoOf([thinking("S"), serverUse("srv_1"), serverResult("srv_1"), text("t")]);
    const stripped = stripServerBlocks(e);
    const m: MessageParam[] = [{ role: "user", content: "go" }, { role: "assistant", content: stripped.blocks as unknown as MessageParam["content"] }];
    expect(sanitizeServerToolPairs(m)).toEqual(m);
  });
});

describe("R9-hist AC10: partitionEcho", () => {
  const CAPS: EchoCaps = { maxMessageBytes: 131_072, maxSessionBytes: 4_194_304, serverResultTtlMs: 600_000 };
  const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));
  const big = (n: number): string => "x".repeat(n);
  const serverBytesOf = (blocks: readonly IApiBlock[]): number => blocks.filter(b => b.type !== "thinking" && b.type !== "text" && b.type !== "tool_use").reduce((s, b) => s + bytesOf(b), 0);

  it("R9-hist AC10: a small echo is stored exactly as captured, with exact byte accounting", () => {
    const blocks = [thinking("S"), text("t"), serverUse("srv_1"), serverResult("srv_1", "small"), toolUse("t1", "a__b")];
    const e = echoOf(blocks);
    const p = partitionEcho(e, CAPS, 0, true);
    expect(p.reason).toBeUndefined();
    expect(p.persist?.echo).toEqual(e);
    expect(p.persist?.bytes).toBe(bytesOf(blocks));
    expect(p.persist?.serverBytes).toBe(serverBytesOf(blocks));
    expect(p.persist!.serverBytes).toBeGreaterThan(0);
    expect(p.persist!.serverBytes).toBeLessThan(p.persist!.bytes);
  });

  it("R9-hist AC10: bytes is the UTF-8 byte length, not the character count", () => {
    const e = echoOf([thinking("S", "héllo wörld ✓ 漢字")]);
    const p = partitionEcho(e, CAPS, 0, true);
    expect(p.persist?.bytes).toBe(bytesOf(e.blocks));
    expect(p.persist!.bytes).toBeGreaterThan(JSON.stringify(e.blocks).length);
    expect(p.persist?.serverBytes).toBe(0);
  });

  it("R9-hist AC10: an over-maxMessageBytes server pair is dropped whole while thinking and the client tool_use persist", () => {
    const e = echoOf([thinking("S"), text("t"), serverUse("srv_1"), serverResult("srv_1", big(200_000)), toolUse("t1", "a__b")]);
    const p = partitionEcho(e, CAPS, 0, true);
    expect(p.reason).toBe("over_message_cap");
    expect(types(p.persist!.echo.blocks)).toEqual(["thinking", "text", "tool_use"]);
    expect(p.persist!.serverBytes).toBe(0);
    expect(p.persist!.bytes).toBeLessThanOrEqual(CAPS.maxMessageBytes);
    expect(p.persist!.bytes).toBe(bytesOf(p.persist!.echo.blocks));
  });

  it("R9-hist AC10: only as many pairs as needed are dropped, largest first, and never half a pair", () => {
    const e = echoOf([
      thinking("S"),
      serverUse("srv_small"), serverResult("srv_small", big(1_000)),
      serverUse("srv_huge"), serverResult("srv_huge", big(140_000)),
      serverUse("srv_mid"), serverResult("srv_mid", big(2_000)),
    ]);
    const p = partitionEcho(e, CAPS, 0, true);
    expect(p.reason).toBe("over_message_cap");
    const kept = p.persist!.echo.blocks;
    expect(kept.map(b => (b as { id?: string; tool_use_id?: string }).id ?? (b as { tool_use_id?: string }).tool_use_id)).toEqual([
      undefined, "srv_small", "srv_small", "srv_mid", "srv_mid",
    ]);
    // the survivor history is valid
    const m: MessageParam[] = [{ role: "user", content: "go" }, { role: "assistant", content: kept as unknown as MessageParam["content"] }];
    expect(sanitizeServerToolPairs(m)).toEqual(m);
  });

  it("R9-hist AC10: tier T alone over maxMessageBytes persists nothing for the message (legacy later), reason over_message_cap", () => {
    const e = echoOf([thinking("S", big(200_000)), serverUse("srv_1"), serverResult("srv_1", "x")]);
    const p = partitionEcho(e, CAPS, 0, true);
    expect(p).toEqual({ reason: "over_message_cap" });
  });

  it("R9-hist AC10: TTL 0 persists no tier S (reason server_dropped); thinking still persists", () => {
    const e = echoOf([thinking("S"), serverUse("srv_1"), serverResult("srv_1"), text("t")]);
    const p = partitionEcho(e, { ...CAPS, serverResultTtlMs: 0 }, 0, true);
    expect(p.reason).toBe("server_dropped");
    expect(types(p.persist!.echo.blocks)).toEqual(["thinking", "text"]);
    expect(p.persist!.serverBytes).toBe(0);
  });

  it("R9-hist AC15: a sanitize veto (persistServer=false) drops tier S exactly like TTL 0, tier T persists", () => {
    const e = echoOf([thinking("S"), serverUse("srv_1"), serverResult("srv_1"), text("t")]);
    const p = partitionEcho(e, CAPS, 0, false);
    expect(p.reason).toBe("server_dropped");
    expect(types(p.persist!.echo.blocks)).toEqual(["thinking", "text"]);
  });

  it("R9-hist AC10: a session at its tier S cap drops new tier S whole; thinking keeps persisting; no error", () => {
    const e = echoOf([thinking("S"), serverUse("srv_1"), serverResult("srv_1", big(5_000))]);
    const atCap = partitionEcho(e, CAPS, CAPS.maxSessionBytes, true);
    expect(atCap.reason).toBe("session_cap");
    expect(types(atCap.persist!.echo.blocks)).toEqual(["thinking"]);
    expect(atCap.persist!.serverBytes).toBe(0);
  });

  it("R9-hist AC10: the session cap is on sessionServerBytes + this message's tier S (boundary: equal fits, one byte more does not)", () => {
    const blocks = [thinking("S"), serverUse("srv_1"), serverResult("srv_1", big(3_000))];
    const e = echoOf(blocks);
    const serverBytes = serverBytesOf(blocks);
    const fits = partitionEcho(e, { ...CAPS, maxSessionBytes: 10_000 + serverBytes }, 10_000, true);
    expect(fits.reason).toBeUndefined();
    expect(fits.persist!.serverBytes).toBe(serverBytes);
    const over = partitionEcho(e, { ...CAPS, maxSessionBytes: 10_000 + serverBytes - 1 }, 10_000, true);
    expect(over.reason).toBe("session_cap");
    expect(over.persist!.serverBytes).toBe(0);
  });

  it("R9-hist AC10: thinking is never counted against the session cap", () => {
    const e = echoOf([thinking("S", big(50_000))]);
    const p = partitionEcho(e, { ...CAPS, maxSessionBytes: 0 }, 999_999_999, true);
    expect(p.reason).toBeUndefined();
    expect(p.persist?.echo).toEqual(e);
  });

  it("R9-hist AC10: a server-only echo that loses all its server blocks leaves nothing worth persisting", () => {
    const e = echoOf([serverUse("srv_1"), serverResult("srv_1", big(200_000)), text("t")]);
    const p = partitionEcho(e, CAPS, 0, true);
    expect(p.persist).toBeUndefined();
    expect(p.reason).toBe("over_message_cap");
  });

  it("R9-hist AC10: an unpaired server block is its own unit and is subject to the same caps", () => {
    const e = echoOf([thinking("S"), serverUse("srv_dangling")]);
    const kept = partitionEcho(e, CAPS, 0, true);
    expect(types(kept.persist!.echo.blocks)).toEqual(["thinking", "server_tool_use"]);
    const cut = partitionEcho(e, CAPS, CAPS.maxSessionBytes, true);
    expect(types(cut.persist!.echo.blocks)).toEqual(["thinking"]);
  });

  it("R9-hist AC10: pure: the captured (live-run) echo is never mutated by partitioning", () => {
    const e = echoOf([thinking("S"), serverUse("srv_1"), serverResult("srv_1", big(200_000))]);
    const before = JSON.stringify(e);
    partitionEcho(e, CAPS, 0, true);
    partitionEcho(e, { ...CAPS, serverResultTtlMs: 0 }, 0, true);
    expect(JSON.stringify(e)).toBe(before);
  });

  it("R9-hist AC10: deterministic: the same inputs give the same partition", () => {
    const e = echoOf([thinking("S"), serverUse("a"), serverResult("a", big(70_000)), serverUse("b"), serverResult("b", big(70_000))]);
    expect(partitionEcho(e, CAPS, 0, true)).toEqual(partitionEcho(e, CAPS, 0, true));
  });

  it("R9-hist AC10: a real C1 capture (seq 5: executed pair, two thinking blocks, two client calls) fits the default caps whole", async () => {
    const echo = captureEcho(await sdkContent(loadC1Wire("seq05ExecutedPairTwoClients")), MODEL)!;
    const p = partitionEcho(echo, CAPS, 0, true);
    expect(p.reason).toBeUndefined();
    expect(p.persist!.echo).toEqual(echo);
    expect(parseSseBody(loadC1Wire("seq05ExecutedPairTwoClients")).content.length).toBe(echo.blocks.length);
    expect(c1Reply("seq05ExecutedPairTwoClients").blocks?.length).toBe(echo.blocks.length);
  });
});
