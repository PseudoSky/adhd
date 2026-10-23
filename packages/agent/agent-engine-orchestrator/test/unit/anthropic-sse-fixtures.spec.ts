/**
 * R9-hist S1: the SSE fixture (`fixtures/anthropic-sse.ts`) and the sanitized R8 C1 wire captures (`fixtures/c1-wire/`).
 *
 * Offline: the REAL `@anthropic-ai/sdk` parses every body through a `fetch` seam; nothing reaches api.anthropic.com.
 *
 * Acceptance ids (spec-v2 / spec R9-DUR):
 *  - R9-hist AC1 (capture): the content blocks the SDK accumulates from a stream (thinking + signature, server_tool_use,
 *    web_fetch_tool_result, text, tool_use) are the blocks the fixture was given, in order, and the fixture's emitted
 *    SSE is event-for-event what the real capture looks like (checked by parsing both with the same SDK).
 *  - R9-pause AC1 (fixture side): `pause_turn` is a representable stop reason.
 *  - S1 hygiene: the committed captures carry no credential, no request/organisation id, no original Anthropic id and
 *    no real signature; the legacy `text` / `toolUse` params emit exactly the bytes the existing suites were written against.
 *
 * guards: the SSE fixture builder or a committed C1 wire capture drifts from what the real SDK accumulates (blocks lost or reordered, pause_turn not representable), or a capture carries a credential, request or organisation id, original Anthropic id or real signature.
 * tier: S
 * cites: R9-hist AC1, R9-pause AC1, S1 hygiene (cited in the header).
 */
import Anthropic from "@anthropic-ai/sdk";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { C1_WIRE, c1Reply, loadC1Wire, type C1WireName } from "../fixtures/anthropic-contract-fake.js";
import { anthropicSseBody, parseSseBody, type ISseBlock } from "../fixtures/anthropic-sse.js";

const MODEL = "claude-haiku-5-5";
const USAGE = { input_tokens: 12, output_tokens: 7 };

/** What the real SDK accumulates from `sse` (the same client code path `AnthropicProvider` uses). */
async function sdkMessage(sse: string): Promise<Anthropic.Message> {
  const client = new Anthropic({
    apiKey: "sk-ant-api-test",
    maxRetries: 0,
    fetch: (async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch,
  });
  return client.messages.stream({ model: MODEL, max_tokens: 1024, messages: [{ role: "user", content: "hi" }] }).finalMessage();
}

const BLOCKS: readonly ISseBlock[] = [
  { type: "thinking", thinking: "", signature: "SYNTHETIC-SIGNATURE-unit-0" },
  { type: "redacted_thinking", data: "SYNTHETIC-REDACTED-unit-0" },
  { type: "text", text: "I will fetch the page and read the code." },
  { type: "tool_use", id: "toolu_unit_1", name: "fs__read_text_file", input: { path: "src/a.js" }, caller: { type: "direct" } },
  { type: "server_tool_use", id: "srvtoolu_unit_1", name: "web_fetch", input: { url: "https://example.com" } },
  {
    type: "web_fetch_tool_result",
    tool_use_id: "srvtoolu_unit_1",
    content: { type: "web_fetch_result", url: "https://example.com", content: { type: "document", title: "Example Domain" } },
  },
  { type: "thinking", thinking: "reasoning shown", signature: "SYNTHETIC-SIGNATURE-unit-1" },
  { type: "text", text: "done" },
];

describe("R9-hist AC1: the fixture's blocks mode is what the real SDK accumulates", () => {
  it("R9-hist AC1: thinking (+signature), redacted_thinking, text, tool_use, server_tool_use and a server result round-trip in order", async () => {
    const msg = await sdkMessage(anthropicSseBody({ model: MODEL, usage: USAGE, blocks: BLOCKS }));
    expect(msg.content).toEqual(BLOCKS);
    expect(msg.stop_reason).toBe("tool_use");
    expect(msg.id).toBe("msg_loopback");
  });

  it("R9-hist AC1: parseSseBody agrees with the SDK on the same body (the fake's own parser is not a second opinion)", async () => {
    const sse = anthropicSseBody({ model: MODEL, usage: USAGE, blocks: BLOCKS, messageId: "msg_unit" });
    const parsed = parseSseBody(sse);
    const msg = await sdkMessage(sse);
    expect(parsed.content).toEqual(msg.content);
    expect(parsed.id).toBe("msg_unit");
    expect(parsed.stopReason).toBe(msg.stop_reason);
  });

  it("R9-hist AC1: stop reason is derived (tool_use iff a client tool_use is present) and overridable", async () => {
    const text: ISseBlock[] = [{ type: "text", text: "plain" }];
    expect((await sdkMessage(anthropicSseBody({ model: MODEL, usage: USAGE, blocks: text }))).stop_reason).toBe("end_turn");
    const serverOnly: ISseBlock[] = [{ type: "server_tool_use", id: "srvtoolu_u", name: "web_fetch", input: { url: "https://example.com" } }];
    expect((await sdkMessage(anthropicSseBody({ model: MODEL, usage: USAGE, blocks: serverOnly }))).stop_reason).toBe("end_turn");
  });

  it("R9-pause AC1: pause_turn is emitted as the stop reason, with the server_tool_use that paused the turn kept as the tail", async () => {
    const blocks: ISseBlock[] = [
      { type: "text", text: "searching" },
      { type: "server_tool_use", id: "srvtoolu_pause", name: "web_search", input: { query: "x" } },
    ];
    const msg = await sdkMessage(anthropicSseBody({ model: MODEL, usage: USAGE, blocks, stopReason: "pause_turn" }));
    expect(msg.stop_reason).toBe("pause_turn");
    expect(msg.content.at(-1)).toMatchObject({ type: "server_tool_use", id: "srvtoolu_pause" });
  });

  it("legacy `text` / `toolUse` params emit exactly the bytes the existing suites rely on", () => {
    const body = anthropicSseBody({
      model: MODEL,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
      text: "hi",
      toolUse: { id: "toolu_a", name: "echo", input: { x: 1 } },
    });
    expect(body).toBe(
      [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_loopback","type":"message","role":"assistant","model":"claude-haiku-5-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"cache_read_input_tokens":3,"output_tokens":1}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_a","name":"echo","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"x\\":1}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join("")
    );
  });
});

const EXPECTED_SHAPES: Record<C1WireName, { types: string[]; stop: string }> = {
  seq02DeferredServerToolUse: { types: ["thinking", "text", "tool_use", "tool_use", "server_tool_use"], stop: "tool_use" },
  seq03AfterDroppedTail: { types: ["tool_use", "tool_use"], stop: "tool_use" },
  seq04ExecutedPairWithThinking: {
    types: ["thinking", "text", "server_tool_use", "web_fetch_tool_result", "thinking", "text", "tool_use"],
    stop: "tool_use",
  },
  seq05ExecutedPairTwoClients: {
    types: ["thinking", "server_tool_use", "web_fetch_tool_result", "thinking", "tool_use", "tool_use"],
    stop: "tool_use",
  },
};

describe("R9-hist AC1: sanitized R8 C1 wire captures (fixtures/c1-wire)", () => {
  const names = Object.keys(C1_WIRE) as C1WireName[];

  it.each(names)("R9-hist AC1: %s parses through the real SDK into the captured block sequence", async name => {
    const msg = await sdkMessage(loadC1Wire(name));
    expect(msg.content.map(b => b.type)).toEqual(EXPECTED_SHAPES[name].types);
    expect(msg.stop_reason).toBe(EXPECTED_SHAPES[name].stop);
    expect(msg.model).toBe(MODEL);
    // The fake's parser (used to turn a capture into a scripted reply) reads the same blocks the SDK does.
    expect(c1Reply(name).blocks).toEqual(msg.content);
  });

  it.each(names)("R9-hist AC1: %s re-emitted through the fixture's own SSE writer is read back identically by the SDK", async name => {
    const original = await sdkMessage(loadC1Wire(name));
    const reply = c1Reply(name);
    const reEmitted = await sdkMessage(
      anthropicSseBody({ model: MODEL, usage: USAGE, blocks: reply.blocks, ...(reply.stopReason ? { stopReason: reply.stopReason } : {}) })
    );
    expect(reEmitted.content).toEqual(original.content);
    expect(reEmitted.stop_reason).toBe(original.stop_reason);
  });

  it("R9-hist AC1: the captures carry the shapes the spec's evidence table cites (empty-display thinking with a signature; a deferred server_tool_use beside client tool_use; an executed pair)", async () => {
    const deferred = (await sdkMessage(loadC1Wire("seq02DeferredServerToolUse"))).content;
    const thinking = deferred[0] as Anthropic.ThinkingBlock;
    expect(thinking.type).toBe("thinking");
    expect(thinking.thinking).toBe("");
    expect(thinking.signature.length).toBeGreaterThan(100);
    const su = deferred.find(b => b.type === "server_tool_use") as Anthropic.ServerToolUseBlock;
    expect(su.name).toBe("web_fetch");
    expect(deferred.some(b => b.type === "web_fetch_tool_result")).toBe(false);

    const executed = (await sdkMessage(loadC1Wire("seq04ExecutedPairWithThinking"))).content;
    const result = executed.find(b => b.type === "web_fetch_tool_result") as unknown as { tool_use_id: string; content: { url: string } };
    const use = executed.find(b => b.type === "server_tool_use") as Anthropic.ServerToolUseBlock;
    expect(result.tool_use_id).toBe(use.id);
    expect(result.content.url).toBe("https://example.com");
  });

  it("S1 hygiene: every committed capture is listed in C1_WIRE (no stray file), and none carries a credential, request/org id, original Anthropic id or real signature", () => {
    const dir = fileURLToPath(new URL("../../test/fixtures/c1-wire/", import.meta.url));
    expect(readdirSync(dir).sort()).toEqual(Object.values(C1_WIRE).sort());
    for (const file of Object.values(C1_WIRE)) {
      const text = readFileSync(`${dir}${file}`, "utf8");
      expect(text, file).not.toMatch(/sk-ant|Bearer |x-api-key|authorization/i);
      expect(text, file).not.toMatch(/request-id|organization|cf-ray|set-cookie|anthropic-/i);
      expect(text, file).not.toMatch(/\/Users\/|@[a-z0-9-]+\.[a-z]{2,}/i);
      // Original ids are `msg_01...`, `toolu_01...`, `srvtoolu_01...`; the committed ones are `*_c1_seq0N_<letter>`.
      expect(text, file).not.toMatch(/(?:msg|toolu|srvtoolu)_01/);
      for (const id of text.match(/(?:msg|toolu|srvtoolu)_[A-Za-z0-9_]+/g) ?? []) expect(id, file).toMatch(/^(?:msg|toolu|srvtoolu)_c1_seq0\d_[a-z]$/);
      // Real signatures begin `CAQS`/`EqQB...` and are opaque base64; the committed ones are marked and same-length synthetic.
      for (const sig of text.match(/"signature":"([^"]+)"/g) ?? []) expect(sig, file).toMatch(/^"signature":"SYNTHETIC-SIGNATURE-c1-seq0\d-b\d-/);
      expect(text, file).not.toMatch(/"retrieved_at":"(?!2026-01-01T00:00:00\.000000\+00:00")/);
    }
  });
});
