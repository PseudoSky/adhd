/**
 * R9-hist S3a: `AnthropicProvider` wiring of the pure echo (`anthropic-echo.ts`) and pause (`anthropic-pause.ts`)
 * modules. The REAL provider + the REAL `@anthropic-ai/sdk` stream parser run against the offline contract fake
 * (`fixtures/anthropic-contract-fake.ts`) through the engine's `wire.fetch` seam. No network, no provider call, no
 * sleep: every backoff is a latch on a `FakeClock`, aborts are fired from inside the script.
 *
 * Acceptance ids (each test title carries `R9-hist S3a AC<n>`):
 *   AC1 replay    thinking, text, client tool_use (tier T) and server_tool_use + server results (tier S) go back on the wire
 *                 in captured order, tool_use names re-qualified to the advertised `server__tool`; the pairing sanitiser runs
 *   AC2 legacy    no echo (absent, empty map, other model, unknown id) => the request bytes are the ones the provider sent
 *                 BEFORE this change (goldens recorded from the unmodified provider at HEAD 184ce795)
 *   AC3 capture   `response.echo` holds every block incl. thinking and server blocks; `echoReplay` matches what was replayed
 *   AC4 pause     N pauses then end_turn => one merged message, summed usage, `reportedModelCalls`, per-continuation hook,
 *                 abort sends nothing more, the 5th pause fails unwrapped, a 529 retries only its own call
 *   AC5 dangling  a paused turn holding a client tool_use fails loudly (PROVIDER_ERROR) before any continuation
 *   AC6 degrade   a narrow echo rejection of call 0 => exactly ONE legacy retry + `echoDegraded`; a context-length 400, a
 *                 non-echo 400, a continuation rejection and a second failure never degrade (again)
 *   AC7 privacy   no signature / page text / encrypted_content in logs, errors or `echoDegraded`
 *
 * What these tests cannot show (scope, not defects): the mapping of a context-length error to the engine's
 * `CONTEXT_WINDOW_EXCEEDED` lives in `orchestrator.ts` (S5a); here the provider is shown to surface the SAME error the
 * no-echo path surfaces, after exactly one request. Whether the live API accepts the replayed shapes is the gated live
 * test's job (S7); the fake encodes the documented rules only.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { AnthropicProvider, redactApiMessage } from "../providers/anthropic.js";
import { PauseTurnCapError, isPauseTurnCapError } from "../providers/anthropic-pause.js";
import { readPartialUsage } from "../providers/partial-usage.js";
import { ProviderCallError, TripRegistry, type RetryRuntime } from "../providers/provider-failure.js";
import type { IProviderEcho, ProviderChatRequest, ProviderChatResponse } from "../providers/types.js";
import { ToolError } from "../validation/errors.js";
import {
  c1Reply,
  makeContractFake,
  type FakeScript,
  type FakeStep,
  type IContractFake,
  type IContractFakeOptions,
  type IMessagesRequestBody,
} from "./fixtures/anthropic-contract-fake.js";
import type { ISseBlock } from "./fixtures/anthropic-sse.js";
import { distinctFiller } from "./fixtures/anthropic-sse.js";
import { FakeClock } from "./fixtures/fake-clock.js";

const MODEL = "claude-haiku-5-5";

// -- rig ----------------------------------------------------------------------------------------------------------
interface IRig {
  fake: IContractFake;
  provider: AnthropicProvider;
  clock: FakeClock;
  /** Everything the provider logged, JSON-serialised (one entry per call). */
  logs: string[];
}

function makeRig(script: FakeScript, opts: { fake?: IContractFakeOptions; promptCaching?: boolean } = {}): IRig {
  const fake = makeContractFake(script, opts.fake);
  const logs: string[] = [];
  const log = (...args: unknown[]): void => {
    logs.push(JSON.stringify(args));
  };
  const logger = { info: log, warn: log, error: log, debug: log } as unknown as EngineLogger;
  const clock = new FakeClock();
  const retryRuntime: RetryRuntime = { clock, rng: () => 0, registry: new TripRegistry() };
  const config = {
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    wire: { fetch: fake.fetch },
    getProviderConfig: () => ({ secret: "sk-ant-api-test", model: MODEL }),
  } as unknown as EngineConfig;
  const provider = new AnthropicProvider({ type: "anthropic", model: MODEL } as never, config, logger, {
    promptCaching: opts.promptCaching ?? true,
    retryRuntime,
  });
  return { fake, provider, clock, logs };
}

const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object", properties: {} } });
const TOOLS = [tool("shell__shell_execute")];
const SERVER_TOOLS = [{ type: "web_fetch_20250910", name: "web_fetch" }] as never;

const textStep = (text = "ok"): FakeStep => ({ blocks: [{ type: "text", text }] as ISseBlock[] });
const errorStep = (status: number, type: string, message: string, headers?: Record<string, string>): FakeStep => ({
  error: { status, type, message, ...(headers ? { headers } : {}) },
});

const userMsg = { id: "u1", role: "user", content: "go" };
const toolResultMsg = (id: string) => ({ role: "tool", toolResults: [{ toolCallId: id, result: "ok", isError: false }] });
/** user -> the assistant turn the provider returned -> its tool results. */
function followUp(res: ProviderChatResponse, ...resultIds: string[]) {
  return [userMsg, res.message, ...resultIds.map(toolResultMsg)] as never;
}
const echoesOf = (...pairs: Array<[ProviderChatResponse, ProviderChatResponse["echo"]?]>): ReadonlyMap<string, IProviderEcho> =>
  new Map(pairs.flatMap(([res, echo]) => (echo ?? res.echo ? [[res.message.id, (echo ?? res.echo) as IProviderEcho] as const] : [])));

const SEQ04_TOOL_ID = "toolu_c1_seq04_a";
const lastBody = (r: IRig): IMessagesRequestBody => r.fake.requests[r.fake.requests.length - 1]!.body!;
const blockTypes = (content: unknown): string[] => (Array.isArray(content) ? content.map(b => (b as { type: string }).type) : []);
const wireAssistant = (body: IMessagesRequestBody, i = 1) => body.messages[i]!.content as Array<Record<string, unknown>>;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** A first turn that captures thinking + an executed server pair + a client tool_use (the real C1 seq04 shape). */
async function seq04Turn(r: IRig): Promise<ProviderChatResponse> {
  return r.provider.chat({ messages: [userMsg] as never, tools: TOOLS, serverSideTools: SERVER_TOOLS });
}

const noFaults = (r: IRig): void => {
  expect(r.fake.faults).toEqual([]);
  expect(r.fake.rejections()).toEqual([]);
};

// =================================================================================================================
describe("R9-hist S3a AC2: no echo => the request bytes are unchanged (goldens recorded from the provider before this change)", () => {
  const toolCalls = [
    { id: "toolu_1", server: "shell", tool: "shell_execute", arguments: { command: "ls" } },
    { id: "toolu_2", server: "plain", tool: "plain", arguments: {} },
  ];
  const toolHistory = [
    { id: "m1", role: "user", content: "run it" },
    { id: "m2", role: "assistant", content: "running", toolCalls },
    { id: "m3", role: "tool", toolResults: [{ toolCallId: "toolu_1", result: "a", isError: false }] },
    { id: "m4", role: "tool", toolResults: [{ toolCallId: "toolu_2", result: "b", isError: false }] },
  ];
  const g2Tools = [tool("shell__shell_execute"), tool("plain")];
  const g2Server = [
    { type: "web_search_20250305", name: "web_search" },
    { type: "web_fetch_20250910", name: "web_fetch" },
  ] as never;

  const G1_BODY =
    '{"model":"claude-haiku-5-5","system":"be brief","max_tokens":128000,"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"hello"},{"role":"user","content":"again"}],"stream":true}';
  const G2_UNCACHED_BODY =
    '{"model":"claude-haiku-5-5","max_tokens":128000,"messages":[{"role":"user","content":"run it"},{"role":"assistant","content":[{"type":"text","text":"running"},{"type":"tool_use","id":"toolu_1","name":"shell__shell_execute","input":{"command":"ls"}},{"type":"tool_use","id":"toolu_2","name":"plain","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"a","is_error":false}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_2","content":"b","is_error":false}]}],"tools":[{"name":"shell__shell_execute","description":"shell__shell_execute","input_schema":{"type":"object","properties":{}}},{"name":"plain","description":"plain","input_schema":{"type":"object","properties":{}}},{"type":"web_search_20250305","name":"web_search"},{"type":"web_fetch_20250910","name":"web_fetch"}],"stream":true}';
  // R10 S1 AC7 (deliberate re-baseline): P5 stops double-encoding tool results, so a stored result "a" now reaches the wire
  // as content "a" (it was content "\"a\"": the JSON of a string, inside a JSON body). That is the ONLY byte change in
  // these goldens. The pre-P5 SHAs are kept as PRE_P5_*: each test re-encodes the new body's tool_result content back to the
  // old shape and requires the OLD sha, which proves no other byte of the request moved.
  const G2_CACHED_SHA = "1bf3ea511b4d96d7bb08228b39ad5d4c667a5efa430732f270f31e368f98f543";
  const G5_CACHED_SHA = "4bd35ff76f1f69078d9bbd51b71f3112da9f304b08e7397948600fbdfc3939e8";
  const G5_UNCACHED_SHA = "6c4c00f20b7a3e721e7f5d661ba08ea514b513489fb89093a3be8773625ab16e";
  const PRE_P5_G2_CACHED_SHA = "e36b236ceb06426f24151ed8411ea9eb72e609a6c06550026471e4bf6ddc1ef5";
  const PRE_P5_G5_CACHED_SHA = "575fcd200347eace36126d54254faa02610cc3b30265690cef63130ee8536d60";
  const PRE_P5_G5_UNCACHED_SHA = "0d34d9aed58748a3227c00f5942539e3091e7a781d132569e5c58989a2f4ca30";
  const reDoubleEncode = (body: string): string => body.replace(/"content":"([ab])"/g, (_m, c: string) => `"content":"\\"${c}\\""`);

  const g1Messages = [
    { id: "a", role: "system", content: "be brief" },
    { id: "b", role: "user", content: "hi" },
    { id: "c", role: "assistant", content: "hello" },
    { id: "d", role: "user", content: "again" },
  ];
  const g5Messages = [
    { id: "a", role: "system", content: distinctFiller(6000, "s") },
    ...toolHistory,
    { id: "z", role: "user", content: distinctFiller(3000, "u") },
  ];

  async function rawBody(messages: unknown[], extra: Partial<ProviderChatRequest>, caching: boolean): Promise<string> {
    const r = makeRig([textStep()], { promptCaching: caching });
    await r.provider.chat({ messages: messages as never, ...extra });
    expect(r.fake.faults).toEqual([]);
    return r.fake.requests[0]!.rawBody;
  }

  it("R9-hist S3a AC2: text-only history, string content and system prompt are byte-identical", async () => {
    expect(await rawBody(g1Messages, {}, true)).toBe(G1_BODY);
    expect(await rawBody(g1Messages, {}, false)).toBe(G1_BODY);
  });

  it("R9-hist S3a AC2: a multi tool-call history with server tools is byte-identical, cache breakpoints on and off", async () => {
    const extra = { tools: g2Tools, serverSideTools: g2Server };
    expect(await rawBody(toolHistory, extra, false)).toBe(G2_UNCACHED_BODY);
    const cached = await rawBody(toolHistory, extra, true);
    expect(sha(cached)).toBe(G2_CACHED_SHA);
    expect(sha(reDoubleEncode(cached))).toBe(PRE_P5_G2_CACHED_SHA);
  });

  it("R9-hist S3a AC2: a large history that triggers the system + messages cache breakpoints is byte-identical", async () => {
    const extra = { tools: g2Tools };
    const cached = await rawBody(g5Messages, extra, true);
    const uncached = await rawBody(g5Messages, extra, false);
    expect(sha(cached)).toBe(G5_CACHED_SHA);
    expect(sha(uncached)).toBe(G5_UNCACHED_SHA);
    expect(sha(reDoubleEncode(cached))).toBe(PRE_P5_G5_CACHED_SHA);
    expect(sha(reDoubleEncode(uncached))).toBe(PRE_P5_G5_UNCACHED_SHA);
  });

  const unusable: Array<[string, ReadonlyMap<string, IProviderEcho>]> = [
    ["an empty echo map", new Map()],
    ["an echo keyed to an id that is not in the history", new Map([["not-in-history", { provider: "anthropic", model: MODEL, blocks: [{ type: "thinking", thinking: "", signature: "S" }] }]])],
    [
      "an echo captured under another model",
      new Map([["m2", { provider: "anthropic", model: "claude-opus-4-8", blocks: [{ type: "thinking", thinking: "", signature: "S" }, { type: "text", text: "running" }, ...toolCalls.map(tc => ({ type: "tool_use", id: tc.id, name: "x", input: {} }))] }]]),
    ],
    [
      "an echo from another provider",
      new Map([["m2", { provider: "openai", model: MODEL, blocks: [{ type: "text", text: "x" }] } as unknown as IProviderEcho]]),
    ],
    [
      "an echo whose tool_use ids disagree with the message's tool calls",
      new Map([["m2", { provider: "anthropic", model: MODEL, blocks: [{ type: "thinking", thinking: "", signature: "S" }, { type: "tool_use", id: "toolu_OTHER", name: "x", input: {} }] }]]),
    ],
  ];
  it.each(unusable)("R9-hist S3a AC2: %s => request bytes identical to the no-echo request", async (_name, echoes) => {
    const extra = { tools: g2Tools, serverSideTools: g2Server };
    const r = makeRig([textStep()], { promptCaching: false });
    const res = await r.provider.chat({ messages: toolHistory as never, ...extra, echoes });
    expect(r.fake.requests[0]!.rawBody).toBe(G2_UNCACHED_BODY);
    expect(res.echoReplay).toBeUndefined();
    expect(res.echoDegraded).toBeUndefined();
  });

  it("R9-hist S3a AC2/AC3: a text + tool_use response captures NO echo and reports no reportedModelCalls", async () => {
    const r = makeRig([{ blocks: [{ type: "text", text: "hi" }, { type: "tool_use", id: "toolu_x", name: "shell__shell_execute", input: {} }] as ISseBlock[], stopReason: "tool_use" }]);
    const res = await r.provider.chat({ messages: [userMsg] as never, tools: TOOLS });
    expect(res.echo).toBeUndefined();
    expect(res.echoReplay).toBeUndefined();
    expect(res.reportedModelCalls).toBeUndefined();
    expect(res.stopReason).toBe("tool_calls");
    expect(Object.keys(res).sort()).toEqual(["message", "rawUsage", "responseModel", "stopReason", "ttfbMs", "usage"].filter(k => k in res).sort());
  });
});

// =================================================================================================================
describe("R9-hist S3a AC3: capture", () => {
  it("R9-hist S3a AC3: response.echo holds every block the model emitted, in order, including thinking and the executed server pair", async () => {
    const r = makeRig([c1Reply("seq04ExecutedPairWithThinking")]);
    const res = await seq04Turn(r);
    expect(res.echo).toBeDefined();
    expect(res.echo!.provider).toBe("anthropic");
    expect(res.echo!.model).toBe(MODEL);
    expect(res.echo!.blocks.map(b => b["type"])).toEqual([
      "thinking",
      "text",
      "server_tool_use",
      "web_fetch_tool_result",
      "thinking",
      "text",
      "tool_use",
    ]);
    // Verbatim: signatures and the fetched page are the emitted ones, not rebuilt.
    const emitted = r.fake.emittedTurns[0]!.blocks as unknown as Array<Record<string, unknown>>;
    expect(res.echo!.blocks.filter(b => b["type"] === "thinking")).toEqual(emitted.filter(b => b["type"] === "thinking"));
    expect(res.echo!.blocks.find(b => b["type"] === "web_fetch_tool_result")).toEqual(emitted.find(b => b["type"] === "web_fetch_tool_result"));
    // The Message itself stays what it always was: text + resolved tool call, no thinking, no server block.
    expect(JSON.stringify(res.message)).not.toContain("signature");
    expect(res.message.toolCalls).toEqual([{ id: SEQ04_TOOL_ID, server: "shell", tool: "shell_execute", arguments: expect.any(Object) }]);
    noFaults(r);
  });

  it("R9-hist S3a AC3: echoReplay counts the replayed messages and bytes (two echoed turns in one history)", async () => {
    const r = makeRig([c1Reply("seq04ExecutedPairWithThinking"), c1Reply("seq05ExecutedPairTwoClients"), textStep("done")]);
    const t1 = await seq04Turn(r);
    const t2 = await r.provider.chat({
      messages: followUp(t1, SEQ04_TOOL_ID),
      echoes: echoesOf([t1]),
      tools: TOOLS,
      serverSideTools: SERVER_TOOLS,
    });
    expect(t1.echoReplay).toBeUndefined();
    expect(t2.echoReplay).toEqual({ messages: 1, bytes: Buffer.byteLength(JSON.stringify(wireAssistant(lastBody(r)))) });

    const history = [userMsg, t1.message, toolResultMsg(SEQ04_TOOL_ID), t2.message, toolResultMsg("toolu_c1_seq05_a"), toolResultMsg("toolu_c1_seq05_b")];
    const t3 = await r.provider.chat({ messages: history as never, echoes: echoesOf([t1], [t2]), tools: TOOLS, serverSideTools: SERVER_TOOLS });
    const body = lastBody(r);
    const replayedBytes = [1, 3].reduce((n, i) => n + Buffer.byteLength(JSON.stringify(body.messages[i]!.content)), 0);
    expect(t3.echoReplay).toEqual({ messages: 2, bytes: replayedBytes });
    expect(t3.echo).toBeUndefined(); // a text-only final turn needs no echo
    noFaults(r);
  });
});

// =================================================================================================================
describe("R9-hist S3a AC1: replay", () => {
  it("R9-hist S3a AC1: thinking, text, server pair and client tool_use go back in the captured order; the fake accepts the thinking unmodified", async () => {
    const r = makeRig([c1Reply("seq04ExecutedPairWithThinking"), textStep("next")]);
    const t1 = await seq04Turn(r);
    await r.provider.chat({ messages: followUp(t1, SEQ04_TOOL_ID), echoes: echoesOf([t1]), tools: TOOLS, serverSideTools: SERVER_TOOLS });
    noFaults(r); // V4a: the thinking blocks went back byte-identical; V2/V3: the pair resolved
    const body = lastBody(r);
    expect(blockTypes(body.messages[1]!.content)).toEqual([
      "thinking",
      "text",
      "server_tool_use",
      "web_fetch_tool_result",
      "thinking",
      "text",
      "tool_use",
    ]);
    const sent = wireAssistant(body);
    const emitted = r.fake.emittedTurns[0]!.blocks as unknown as Array<Record<string, unknown>>;
    expect(sent.filter(b => b["type"] === "thinking")).toEqual(emitted.filter(b => b["type"] === "thinking"));
    expect(sent.find(b => b["type"] === "web_fetch_tool_result")).toEqual(emitted.find(b => b["type"] === "web_fetch_tool_result"));
    // Tools and system are the ones the request always carried.
    expect(body.tools).toEqual([
      { name: "shell__shell_execute", description: "shell__shell_execute", input_schema: { type: "object", properties: {} } },
      { type: "web_fetch_20250910", name: "web_fetch", cache_control: { type: "ephemeral" } },
    ].map(t => (body.tools as unknown[]).find(x => (x as { name: string }).name === t.name) ?? t));
  });

  it("R9-hist S3a AC1: the replayed tool_use name is the advertised server__tool even though the model emitted the bare name", async () => {
    const r = makeRig([c1Reply("seq04ExecutedPairWithThinking"), textStep("next")]);
    const t1 = await seq04Turn(r);
    // The captured echo carries what the model emitted: the BARE name.
    expect(t1.echo!.blocks.find(b => b["type"] === "tool_use")!["name"]).toBe("shell_execute");
    await r.provider.chat({ messages: followUp(t1, SEQ04_TOOL_ID), echoes: echoesOf([t1]), tools: TOOLS, serverSideTools: SERVER_TOOLS });
    const sent = wireAssistant(lastBody(r));
    expect(sent.filter(b => b["type"] === "tool_use").map(b => b["name"])).toEqual(["shell__shell_execute"]);
    expect((lastBody(r).tools as Array<{ name: string }>).map(t => t.name)).toContain("shell__shell_execute");
    expect(JSON.stringify(lastBody(r).messages)).not.toMatch(/"name":"shell_execute"/);
    // ids and inputs stay as emitted
    const emittedUse = (r.fake.emittedTurns[0]!.blocks as unknown as Array<Record<string, unknown>>).find(b => b["type"] === "tool_use")!;
    expect(sent.find(b => b["type"] === "tool_use")).toMatchObject({ id: emittedUse["id"], input: emittedUse["input"] });
  });

  it("R9-hist S3a AC1: without the echo the same follow-up loses the thinking and the contract fake says so (the defect this change fixes)", async () => {
    const r = makeRig([c1Reply("seq04ExecutedPairWithThinking"), textStep("next")]);
    const t1 = await seq04Turn(r);
    await expect(
      r.provider.chat({ messages: followUp(t1, SEQ04_TOOL_ID), tools: TOOLS, serverSideTools: SERVER_TOOLS })
    ).rejects.toBeInstanceOf(ProviderCallError);
    expect(r.fake.rejections().map(v => v.rule)).toContain("V4b");
  });

  it("R9-hist S3a AC1: pairing is sanitised: an orphan server result and a dangling server_tool_use in an echo never reach the wire", async () => {
    const r = makeRig([textStep("fine")]);
    const assistant = {
      id: "a1",
      role: "assistant",
      content: "x",
      toolCalls: [{ id: "toolu_s", server: "shell", tool: "shell_execute", arguments: {} }],
    };
    const echo: IProviderEcho = {
      provider: "anthropic",
      model: MODEL,
      blocks: [
        { type: "web_fetch_tool_result", tool_use_id: "srv_gone", content: { type: "web_fetch_tool_result_error", error_code: "unavailable" } },
        { type: "text", text: "x" },
        { type: "server_tool_use", id: "srv_dangling", name: "web_fetch", input: { url: "https://example.com" } },
        { type: "tool_use", id: "toolu_s", name: "shell_execute", input: {} },
      ],
    };
    const res = await r.provider.chat({
      messages: [userMsg, assistant, toolResultMsg("toolu_s")] as never,
      echoes: new Map([["a1", echo]]),
      tools: TOOLS,
    });
    expect(res.message.content).toBe("fine");
    noFaults(r); // V3 (orphan) and V2 (dangling) would 400 without the sanitiser
    expect(blockTypes(wireAssistant(lastBody(r)))).toEqual(["text", "tool_use"]);
  });

  it("R9-hist S3a AC1: an empty text block in an echo is not replayed (the API rejects empty text); other blocks are untouched", async () => {
    const r = makeRig([textStep("fine")]);
    const assistant = { id: "a1", role: "assistant", content: undefined, toolCalls: [{ id: "toolu_s", server: "shell", tool: "shell_execute", arguments: {} }] };
    const echo: IProviderEcho = {
      provider: "anthropic",
      model: MODEL,
      blocks: [
        { type: "text", text: "" },
        { type: "tool_use", id: "toolu_s", name: "shell_execute", input: {} },
      ],
    };
    await r.provider.chat({ messages: [userMsg, assistant, toolResultMsg("toolu_s")] as never, echoes: new Map([["a1", echo]]), tools: TOOLS });
    expect(blockTypes(wireAssistant(lastBody(r)))).toEqual(["tool_use"]);
  });

  it("R9-hist S3a AC1: cache_control is never placed on a thinking block or on an assistant message of a replayed history (large history)", async () => {
    const r = makeRig([c1Reply("seq04ExecutedPairWithThinking"), textStep("next")]);
    const t1 = await r.provider.chat({
      messages: [{ ...userMsg, content: distinctFiller(9000, "p") }] as never,
      tools: TOOLS,
      serverSideTools: SERVER_TOOLS,
    });
    await r.provider.chat({
      messages: [{ ...userMsg, content: distinctFiller(9000, "p") }, t1.message, toolResultMsg(SEQ04_TOOL_ID)] as never,
      echoes: echoesOf([t1]),
      tools: TOOLS,
      serverSideTools: SERVER_TOOLS,
    });
    const body = lastBody(r);
    expect(JSON.stringify(body.messages)).toContain("cache_control"); // the breakpoint IS placed ...
    for (const m of body.messages.filter(m => m.role === "assistant")) {
      expect(JSON.stringify(m)).not.toContain("cache_control"); // ... on the final user entry only
    }
  });
});

// =================================================================================================================
describe("R9-hist S3a AC4: pause_turn", () => {
  const usage = (i: number) => ({ input_tokens: 100 * (i + 1), output_tokens: 10 + i, cache_read_input_tokens: 1000 });
  const pause = (i: number, withThinking = false): FakeStep => ({
    blocks: [
      ...(withThinking ? ([{ type: "thinking", thinking: "", signature: `sig-${i}` }] as ISseBlock[]) : []),
      { type: "server_tool_use", id: `srv_${i}`, name: "web_fetch", input: { url: `https://example.com/${i}` } },
      { type: "text", text: `part-${i}` },
    ],
    stopReason: "pause_turn",
    usage: usage(i),
  });
  const end = (i: number): FakeStep => ({ blocks: [{ type: "text", text: "final" }], stopReason: "end_turn", usage: usage(i) });
  const ask = (r: IRig, extra: Partial<ProviderChatRequest> = {}) =>
    r.provider.chat({ messages: [userMsg] as never, tools: TOOLS, serverSideTools: SERVER_TOOLS, ...extra });

  it("R9-hist S3a AC4: two pauses then end_turn return ONE merged message, 3 model calls, summed usage and a complete echo", async () => {
    const r = makeRig([pause(0, true), pause(1), end(2)]);
    const seen: number[] = [];
    const res = await ask(r, { beforeContinuation: async n => void seen.push(n) });
    expect(r.fake.requests).toHaveLength(3);
    expect(seen).toEqual([1, 2]);
    expect(res.message.content).toBe("part-0\npart-1\nfinal");
    expect(res.stopReason).toBe("completed");
    expect(res.reportedModelCalls).toBe(3);
    expect(res.usage).toMatchObject({
      uncachedInputTokens: 100 + 200 + 300,
      cacheReadTokens: 3000,
      inputTokens: 600 + 3000,
      outputTokens: 10 + 11 + 12,
    });
    expect(res.usage!.stopReason).toBe("stop"); // the call that ended the turn
    expect(res.echo!.blocks.map(b => b["type"])).toEqual([
      "thinking",
      "server_tool_use",
      "web_fetch_tool_result",
      "text",
      "server_tool_use",
      "web_fetch_tool_result",
      "text",
      "text",
    ]);
    noFaults(r);
  });

  it("R9-hist S3a AC4: the continuation replays the paused content as the last assistant message with the same tools, unmarked", async () => {
    const r = makeRig([pause(0, true), end(1)]);
    await ask(r, { messages: [{ ...userMsg, content: distinctFiller(9000, "c") }] as never });
    const [first, second] = [r.fake.requests[0]!.body!, r.fake.requests[1]!.body!];
    expect(second.tools).toEqual(first.tools);
    expect(second.system).toEqual(first.system);
    expect(second.messages).toHaveLength(first.messages.length + 1);
    const tail = second.messages[second.messages.length - 1]!;
    expect(tail.role).toBe("assistant");
    expect(blockTypes(tail.content)).toEqual(["thinking", "server_tool_use", "web_fetch_tool_result", "text"]);
    expect(JSON.stringify(tail)).not.toContain("cache_control");
    expect(second.messages.slice(0, -1)).toEqual(first.messages); // same prefix, same breakpoint
    expect(JSON.stringify(first.messages)).toContain("cache_control");
  });

  it("R9-hist S3a AC4: a single-call turn reports no reportedModelCalls (unchanged accounting)", async () => {
    const r = makeRig([end(0)]);
    const res = await ask(r);
    expect(res.reportedModelCalls).toBeUndefined();
    expect(res.usage).toMatchObject({ uncachedInputTokens: 100, cacheReadTokens: 1000, inputTokens: 1100, stopReason: "stop" });
  });

  it("R9-hist S3a AC4: an abort raised between calls (inside the continuation hook) sends no further request", async () => {
    const controller = new AbortController();
    const r = makeRig([pause(0), pause(1), end(2)]);
    const err = await ask(r, {
      signal: controller.signal,
      beforeContinuation: async n => {
        if (n === 2) controller.abort(); // after the loop's own signal check, before the 3rd request
      },
    }).catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
    expect(r.fake.requests).toHaveLength(2); // never a 3rd
    expect(readPartialUsage(err)?.reportedModelCalls).toBe(2);
  });

  it("R9-hist S3a AC4: an abort fired while the 2nd call is in flight rejects and sends no 3rd request", async () => {
    const controller = new AbortController();
    const r = makeRig(ctx => {
      if (ctx.index === 1) controller.abort();
      return ctx.index === 0 ? pause(0) : pause(1);
    });
    await expect(ask(r, { signal: controller.signal })).rejects.toBeInstanceOf(Error);
    expect(r.fake.requests).toHaveLength(2);
  });

  it("R9-hist S3a AC4: a rejecting beforeContinuation (budget trip) stops the loop with no further request and carries the spend", async () => {
    const r = makeRig([pause(0), pause(1), end(2)]);
    const trip = new ToolError("BUDGET_EXCEEDED" as never, "budget");
    const err = await ask(r, {
      beforeContinuation: async n => {
        if (n === 2) throw trip;
      },
    }).catch((e: unknown) => e);
    expect(err).toBe(trip);
    expect(r.fake.requests).toHaveLength(2);
    expect(readPartialUsage(err)?.reportedModelCalls).toBe(2);
  });

  it("R9-hist S3a AC4: five consecutive pauses reject with the cap error itself (not wrapped), after exactly 5 requests", async () => {
    const r = makeRig(Array.from({ length: 6 }, (_, i) => pause(i)));
    const err = await ask(r).catch((e: unknown) => e);
    expect(isPauseTurnCapError(err)).toBe(true);
    expect(err).toBeInstanceOf(PauseTurnCapError);
    expect(err).not.toBeInstanceOf(ProviderCallError);
    expect((err as Error).message).toBe("provider paused the turn 5 times without finishing");
    expect((err as ToolError).code).toBe("PROVIDER_ERROR");
    expect(r.fake.requests).toHaveLength(5);
    expect(readPartialUsage(err)?.reportedModelCalls).toBe(5);
    expect(r.clock.sleeps).toEqual([]); // the cap is not a provider fault: nothing retried
  });

  it("R9-hist S3a AC4: a 529 on continuation 2 retries ONLY that call (no restart of the turn)", async () => {
    const r = makeRig([pause(0), pause(1), errorStep(529, "overloaded_error", "Overloaded"), end(2)]);
    const settled = await r.clock.settle(ask(r));
    expect(settled.status).toBe("fulfilled");
    const res = (settled as PromiseFulfilledResult<ProviderChatResponse>).value;
    expect(r.fake.requests.map(q => q.status)).toEqual([200, 200, 529, 200]);
    expect(r.fake.requests[3]!.rawBody).toBe(r.fake.requests[2]!.rawBody); // the same continuation, again
    expect(r.fake.requests[2]!.body!.messages).toHaveLength(r.fake.requests[0]!.body!.messages.length + 1);
    expect(r.clock.sleeps).toHaveLength(1);
    expect(res.reportedModelCalls).toBe(3); // the failed request is not a model call
    expect(res.message.content).toBe("part-0\npart-1\nfinal");
  });
});

// =================================================================================================================
describe("R9-hist S3a AC5: a paused turn holding a client tool_use fails loudly", () => {
  const pausedWithClientTool: FakeStep = {
    blocks: [
      { type: "text", text: "looking" },
      { type: "tool_use", id: "toolu_pending", name: "shell__shell_execute", input: { command: "SECRET-ARGUMENT" } },
    ] as ISseBlock[],
    stopReason: "pause_turn",
    usage: { input_tokens: 50, output_tokens: 5 },
  };

  it("R9-hist S3a AC5: PROVIDER_ERROR naming the pending call id, one request only, no continuation hook, spend carried, no tool input in the message", async () => {
    const r = makeRig([pausedWithClientTool, textStep()]);
    let hook = 0;
    const err = await r.provider
      .chat({ messages: [userMsg] as never, tools: TOOLS, beforeContinuation: async () => void hook++ })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe("PROVIDER_ERROR");
    expect((err as Error).message).toContain("toolu_pending");
    expect((err as Error).message).not.toContain("SECRET-ARGUMENT");
    expect(r.fake.requests).toHaveLength(1);
    expect(hook).toBe(0);
    expect(readPartialUsage(err)?.reportedModelCalls).toBe(1);
  });
});

// =================================================================================================================
describe("R9-hist S3a AC6: degrade once to the legacy history", () => {
  const SIG_REJECTION = "messages.1.content.0: Invalid `signature` in `thinking` block";

  /** Request body -> the first thinking signature it carries (what a chatty API might quote back). */
  const signatureIn = (body: IMessagesRequestBody): string => {
    const m = /"signature":"([^"]+)"/.exec(JSON.stringify(body.messages));
    return m?.[1] ?? "";
  };

  /** seq04 first, then `second` for the echoed follow-up, then plain text replies. */
  const degradeRig = (second: (ctx: { body: IMessagesRequestBody }) => FakeStep, tail: FakeStep[] = [textStep("legacy ok")]) =>
    makeRig(
      ctx => {
        if (ctx.index === 0) return c1Reply("seq04ExecutedPairWithThinking");
        if (ctx.index === 1) return second(ctx);
        return tail[ctx.index - 2] ?? textStep("legacy ok");
      },
      { fake: { allowThinkingOmission: ({ index }) => index >= 2 } }
    );

  const echoedFollowUp = async (r: IRig) => {
    const t1 = await seq04Turn(r);
    const call = () => r.provider.chat({ messages: followUp(t1, SEQ04_TOOL_ID), echoes: echoesOf([t1]), tools: TOOLS, serverSideTools: SERVER_TOOLS });
    return { t1, call };
  };

  it("R9-hist S3a AC6: a signature-style 400 => exactly 2 requests, the second without any echo block, echoDegraded set", async () => {
    const r = degradeRig(() => errorStep(400, "invalid_request_error", SIG_REJECTION));
    const { call } = await echoedFollowUp(r);
    const res = await call();
    expect(r.fake.requests).toHaveLength(3); // turn 1 + rejected echoed request + ONE legacy retry
    expect(r.fake.requests.map(q => q.status)).toEqual([200, 400, 200]);
    const [echoed, legacy] = [r.fake.requests[1]!.body!, r.fake.requests[2]!.body!];
    expect(blockTypes(echoed.messages[1]!.content)).toContain("thinking");
    const legacyTypes = JSON.stringify(legacy.messages);
    for (const gone of ["thinking", "server_tool_use", "web_fetch_tool_result"]) expect(legacyTypes).not.toContain(`"type":"${gone}"`);
    expect(blockTypes(legacy.messages[1]!.content)).toEqual(["text", "tool_use"]);
    expect(wireAssistant(legacy).find(b => b["type"] === "tool_use")!["name"]).toBe("shell__shell_execute");
    expect(res.message.content).toBe("legacy ok");
    expect(res.echoDegraded).toEqual({ apiMessage: expect.stringContaining("signature"), echoedMessages: 1 });
    expect(res.echoReplay).toBeUndefined(); // nothing was replayed in the request that succeeded
    expect(r.fake.faults).toEqual([]);
  });

  it("R9-hist S3a AC6: a context-length 400 with echo present => no legacy retry, the same error the no-echo path surfaces", async () => {
    const tooLong = "prompt is too long: 250000 tokens > 200000 maximum";
    const withEcho = degradeRig(() => errorStep(400, "invalid_request_error", tooLong));
    const { call } = await echoedFollowUp(withEcho);
    const err = await call().catch((e: unknown) => e);
    expect(withEcho.fake.requests).toHaveLength(2); // turn 1 + the one rejected request: NO second legacy request

    const plain = makeRig([errorStep(400, "invalid_request_error", tooLong)]);
    const ref = await plain.provider.chat({ messages: [userMsg] as never, tools: TOOLS }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderCallError);
    expect((err as ProviderCallError).data.class).toBe((ref as ProviderCallError).data.class);
    expect((err as Error).message).toBe((ref as Error).message);
    expect((err as Error).message).toContain("prompt is too long"); // the engine's CONTEXT_WINDOW_EXCEEDED mapping keys on this text
    expect(withEcho.logs.join("")).not.toContain("without echoed blocks");
  });

  it("R9-hist S3a AC6: a 400 that does not name an echoed block type is not an echo rejection (no retry)", async () => {
    const r = degradeRig(() => errorStep(400, "invalid_request_error", "max_tokens: must be greater than or equal to 1"));
    const { call } = await echoedFollowUp(r);
    await expect(call()).rejects.toBeInstanceOf(ProviderCallError);
    expect(r.fake.requests).toHaveLength(2);
  });

  it.each([
    "messages.2.content.0.tool_result: unexpected `tool_use_id` found in `tool_result` blocks: toolu_x",
    "messages.1: tool_use ids were found without tool_result blocks immediately after",
  ])(
    "cafe9a17 AC2: a genuine client tool_result history 400 with echoes present => no legacy retry, the error surfaces, no echoDegraded (so the engine never deletes the echoes): %s",
    async msg => {
      const r = degradeRig(() => errorStep(400, "invalid_request_error", msg));
      const { call } = await echoedFollowUp(r);
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderCallError);
      expect((err as Error).message).toContain("tool_");
      expect(r.fake.requests.map(q => q.status)).toEqual([200, 400]); // turn 1 + the rejected request: NO legacy retry
      expect(r.logs.join("")).not.toContain("without echoed blocks");
    }
  );

  it("R9-hist S3a AC6: a second rejection after the degrade surfaces, and there is no third request", async () => {
    const r = degradeRig(
      () => errorStep(400, "invalid_request_error", SIG_REJECTION),
      [errorStep(400, "invalid_request_error", "messages.2.content.0.tool_result: unexpected tool_use_id found in tool_result blocks")]
    );
    const { call } = await echoedFollowUp(r);
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderCallError);
    expect((err as Error).message).toContain("unexpected tool_use_id");
    expect(r.fake.requests).toHaveLength(3); // never degrades twice
  });

  it("R9-hist S3a AC6: a rejection of a CONTINUATION is not a history fault: no degrade, the error surfaces", async () => {
    const r = makeRig(ctx => {
      if (ctx.index === 0) return c1Reply("seq04ExecutedPairWithThinking");
      if (ctx.index === 1) return { blocks: [{ type: "text", text: "paused" }], stopReason: "pause_turn" } as FakeStep;
      return errorStep(400, "invalid_request_error", SIG_REJECTION);
    });
    const { call } = await echoedFollowUp(r);
    await expect(call()).rejects.toBeInstanceOf(ProviderCallError);
    expect(r.fake.requests).toHaveLength(3); // turn 1, echoed call 0 (paused), the rejected continuation: no legacy request
  });

  it("R9-hist S3a AC6: a request that carried no echo is never degraded, even for a signature-style 400", async () => {
    const r = makeRig([errorStep(400, "invalid_request_error", SIG_REJECTION)]);
    await expect(r.provider.chat({ messages: [userMsg] as never, tools: TOOLS })).rejects.toBeInstanceOf(ProviderCallError);
    expect(r.fake.requests).toHaveLength(1);
  });

  it("R9-hist S3a AC6: 429 (retried by the fault policy, not degraded) and abort take today's path", async () => {
    const r = degradeRig(() => errorStep(429, "rate_limit_error", "slow down", { "retry-after": "1" }));
    const { call } = await echoedFollowUp(r);
    const settled = await r.clock.settle(call());
    expect(settled.status).toBe("fulfilled");
    expect(r.fake.requests.map(q => q.status)).toEqual([200, 429, 200]);
    // the retry of the 429 re-sent the ECHOED request (it is not the degrade)
    expect(r.fake.requests[2]!.rawBody).toBe(r.fake.requests[1]!.rawBody);
    expect((settled as PromiseFulfilledResult<ProviderChatResponse>).value.echoDegraded).toBeUndefined();
  });

  it("R9-hist S3a AC6: redactApiMessage cuts opaque runs and bounds the length", () => {
    expect(redactApiMessage("bad signature " + "A".repeat(200) + " in block")).toBe("bad signature [redacted] in block");
    expect(redactApiMessage("x ".repeat(1000))).toHaveLength(500);
    expect(redactApiMessage(SIG_REJECTION)).toBe(SIG_REJECTION);
  });

  describe("R9-hist S3a AC7: privacy", () => {
    const secretsOf = (echo: IProviderEcho): string[] => [
      // The fixture signatures are thousands of characters; a 60-character run is enough to prove a leak.
      ...echo.blocks.flatMap(b => (typeof b["signature"] === "string" ? [b["signature"].slice(0, 60)] : [])),
      "FIXTURE-PAGE-BODY",
      "encrypted_content",
      "retrieved_at",
    ];

    it("R9-hist S3a AC7: an API error that QUOTES the signature never reaches the logs or echoDegraded", async () => {
      const r = degradeRig(({ body }) => errorStep(400, "invalid_request_error", `${SIG_REJECTION}: ${signatureIn(body).slice(0, 60)} is not valid`));
      const { t1, call } = await echoedFollowUp(r);
      const secrets = secretsOf(t1.echo!);
      expect(secrets[0]!.length).toBe(60);
      const res = await call();
      expect(r.fake.requests[1]!.rawBody).toContain(secrets[0]!); // control: the signature WAS on the rejected wire
      const surfaces = [r.logs.join("\n"), JSON.stringify(res.echoDegraded)];
      for (const s of secrets) for (const surface of surfaces) expect(surface, s).not.toContain(s);
      expect(r.logs.join("\n")).toContain("without echoed blocks"); // control: the WARN did fire
    });

    it("R9-hist S3a AC7: the cap error, the pending-tool error and a surfaced second failure carry no block content", async () => {
      const cap = makeRig(Array.from({ length: 6 }, (_, i) => ({
        blocks: [
          ...(i === 0 ? [{ type: "thinking", thinking: "", signature: "SIGNATURE-SENTINEL-0123456789abcdef0123456789" }] : []),
          { type: "server_tool_use", id: `srv_${i}`, name: "web_fetch", input: { url: "https://example.com/p" } },
          { type: "text", text: "paused" },
        ] as ISseBlock[],
        stopReason: "pause_turn" as const,
      })));
      const capErr = await cap.provider.chat({ messages: [userMsg] as never, tools: TOOLS }).catch((e: unknown) => e);
      expect(isPauseTurnCapError(capErr)).toBe(true);
      const surfaced = JSON.stringify([(capErr as Error).message, (capErr as ToolError).data, cap.logs]);
      for (const s of ["SIGNATURE-SENTINEL", "FIXTURE-PAGE-BODY", "encrypted_content"]) expect(surfaced, s).not.toContain(s);

      const second = degradeRig(
        () => errorStep(400, "invalid_request_error", SIG_REJECTION),
        [errorStep(400, "invalid_request_error", "messages.2.content.0.tool_result: unexpected tool_use_id found in tool_result blocks")]
      );
      const { t1, call } = await echoedFollowUp(second);
      const err = await call().catch((e: unknown) => e);
      const out = JSON.stringify([(err as Error).message, (err as ProviderCallError).data, second.logs]);
      for (const s of secretsOf(t1.echo!)) expect(out, s).not.toContain(s);
    });
  });
});
