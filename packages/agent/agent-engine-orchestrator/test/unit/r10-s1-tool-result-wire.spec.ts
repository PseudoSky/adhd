/**
 * R10 S1 (P5 tool-result wire fidelity, P7 `thinking` option).
 *
 * Before: every adapter sent `JSON.stringify(toolResult.result)`. For an MCP tool the stored result is the content
 * array `[{type:'text', text}]`, so the model read a JSON document with the file text escaped inside it, and a result
 * over the size cap was an escaped-JSON fragment (backlog ae9d4022; R9 C1 wire capture: 182 of 251 tool_result
 * blocks). These tests drive the REAL `AnthropicProvider` / `OpenAIProvider` and the REAL SDKs through the engine's
 * `wire.fetch` seam (the Anthropic one against the documented-rule contract fake, V1-V5), so they see the bytes a
 * server would. No socket, no provider call.
 *
 * Acceptance ids (each test title carries `R10 S1 AC<n>`):
 *   AC1  anthropic wire: a text-only MCP result with CR LF, quotes and backslashes is on the wire exactly once-encoded
 *   AC2  a mixed text + image result becomes an array of Anthropic blocks (unsupported blocks keep their JSON, nothing dropped)
 *   AC3  error results keep is_error
 *   AC4  openai / deepseek wire: a plain string, never a content-part array and never the JSON of the array
 *   AC5  the size cap slices the extracted text (notice present, no escape fragments), and escaping alone never trips it
 *   AC6  P7: `thinking` unset => body byte-identical to before; set => exactly that field on the wire
 *   AC7  echo replay and cache-breakpoint token estimation work with the new tool_result shape
 *   AC8  `ToolDefinition.annotations` never reaches the wire
 *
 * guards: an MCP tool result reaches an Anthropic or OpenAI-compatible wire as escaped JSON of its content array (or an over-cap result as an escaped-JSON fragment, or with is_error, non-text blocks, the thinking option or tool annotations mishandled) instead of the extracted text the model should read.
 * tier: S
 * cites: ae9d4022; R10 S1 AC1-AC8 (every test title carries its AC).
 */
import { describe, expect, it } from "vitest";

import { capToolResult, DEFAULT_TOOL_RESULT_MAX_CHARS, mcpContentText } from "../../src/engine/tool-result-cap.js";
import type { EngineConfig, EngineLogger } from "../../src/interfaces.js";
import { estimatePrefixTokens } from "../../src/providers/anthropic-cache.js";
import { toToolResultContent } from "../../src/providers/anthropic-tool-result.js";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import { OpenAIProvider } from "../../src/providers/openai.js";
import type { ProviderChatRequest } from "../../src/providers/types.js";
import { providerConfigSchema } from "../../src/validation/agent.js";
import { makeContractFake, type FakeStep, type IContractFake } from "../fixtures/anthropic-contract-fake.js";
import type { ISseBlock } from "../fixtures/anthropic-sse.js";

const MODEL = "claude-haiku-5-5";
const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** A file body with CR LF line ends, quotes, a backslash and a tab: everything JSON escaping would rewrite. */
const CRLF_FILE = 'export const a = "x";\r\n// path C:\\tmp\\f.js\r\n\tconst b = \'y\';\r\n';
const textBlock = (text: string) => ({ type: "text", text });
const mcp = (...texts: string[]) => texts.map(textBlock);

const tool = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
  ...extra,
});
const toolCall = { id: "toolu_1", server: "fs", tool: "read_text_file", arguments: { path: "a.js" } };
const history = (result: unknown, isError = false) =>
  [
    { id: "m1", role: "user", content: "read it" },
    { id: "m2", role: "assistant", content: "", toolCalls: [toolCall] },
    { id: "m3", role: "tool", toolResults: [{ toolCallId: "toolu_1", result, isError }] },
  ] as never;

// -- anthropic rig -------------------------------------------------------------------------------------------
const okStep = (): FakeStep => ({ blocks: [{ type: "text", text: "ok" }] as ISseBlock[] });

function anthropicRig(script: readonly FakeStep[] = [okStep()], providerConfig: Record<string, unknown> = {}) {
  const fake: IContractFake = makeContractFake(script);
  const config = {
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    wire: { fetch: fake.fetch },
    getProviderConfig: () => ({ secret: "sk-ant-api-test", model: MODEL }),
  } as unknown as EngineConfig;
  const provider = new AnthropicProvider({ type: "anthropic", model: MODEL, ...providerConfig } as never, config, logger);
  return { fake, provider };
}
const noFaults = (fake: IContractFake): void => {
  expect(fake.faults).toEqual([]);
  expect(fake.rejections()).toEqual([]);
};
const resultBlock = (fake: IContractFake, i = 0) => {
  const msgs = fake.requests[i]!.body!.messages;
  const last = msgs[msgs.length - 1]!.content as Array<Record<string, unknown>>;
  return last[0]!;
};

describe("R10 S1 AC1: anthropic wire carries the text once-encoded", () => {
  it("R10 S1 AC1: a text-only MCP result is the raw text (CR LF, quotes, backslash, tab intact), V1-V5 pass", async () => {
    const { fake, provider } = anthropicRig();
    await provider.chat({ messages: history(mcp(CRLF_FILE)), tools: [tool("fs__read_text_file")] });
    noFaults(fake);
    const block = resultBlock(fake);
    expect(block["type"]).toBe("tool_result");
    expect(block["tool_use_id"]).toBe("toolu_1");
    expect(typeof block["content"]).toBe("string");
    expect(block["content"]).toBe(CRLF_FILE);
    expect(block["content"]).toContain("\r\n");
    expect(block["content"]).not.toMatch(/^\[\{"type"/);
  });

  it("R10 S1 AC1: the raw request body encodes the content exactly once (a real CR LF is `\\r\\n` once, never `\\\\r\\\\n`)", async () => {
    const { fake, provider } = anthropicRig();
    await provider.chat({ messages: history(mcp(CRLF_FILE)), tools: [tool("fs__read_text_file")] });
    const raw = fake.requests[0]!.rawBody;
    expect(raw).toContain(JSON.stringify(CRLF_FILE));
    expect(raw).not.toContain("\\\\r\\\\n");
    expect(raw).not.toContain('\\"type\\":\\"text\\"');
  });

  it("R10 S1 AC1: several text blocks are joined with a newline, empty ones dropped; a lone block is verbatim", async () => {
    expect(toToolResultContent(mcp("a", "", "b"))).toBe("a\nb");
    expect(toToolResultContent(mcp("only"))).toBe("only");
    expect(toToolResultContent(mcp(""))).toBe("");
    expect(mcpContentText(mcp("a", "b"))).toBe("a\nb");
  });

  it("R10 S1 AC1: the engine's own non-MCP results keep a deterministic encoding (string verbatim, object JSON once)", async () => {
    expect(toToolResultContent("plain\r\ntext")).toBe("plain\r\ntext");
    expect(toToolResultContent({ rows: [1, "x"] })).toBe('{"rows":[1,"x"]}');
    expect(toToolResultContent(42)).toBe("42");
    expect(toToolResultContent([1, 2])).toBe("[1,2]");
    // An array of objects that merely have a `type` key is not an MCP content array: left as JSON, never reinterpreted.
    expect(toToolResultContent([{ type: "file", path: "a" }])).toBe('[{"type":"file","path":"a"}]');
    expect(toToolResultContent([{ type: "text" }])).toBe('[{"type":"text"}]');
    expect(toToolResultContent([])).toBe("[]");
    expect(toToolResultContent(undefined)).toBeUndefined();
    const { fake, provider } = anthropicRig();
    await provider.chat({ messages: history({ rows: ['q"uote'] }), tools: [tool("fs__read_text_file")] });
    noFaults(fake);
    expect(resultBlock(fake)["content"]).toBe('{"rows":["q\\"uote"]}');
  });

  it("R10 S1 AC1: a result with no JSON form leaves `content` off the wire, as before", async () => {
    const { fake, provider } = anthropicRig();
    await provider.chat({ messages: history(undefined), tools: [tool("fs__read_text_file")] });
    noFaults(fake);
    expect(Object.keys(resultBlock(fake))).not.toContain("content");
  });
});

describe("R10 S1 AC2: non-text MCP blocks", () => {
  const PNG = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };

  it("R10 S1 AC2: text + image becomes [text block, base64 image block] on the wire", async () => {
    const { fake, provider } = anthropicRig();
    await provider.chat({ messages: history([textBlock("chart:"), PNG]), tools: [tool("fs__read_text_file")] });
    noFaults(fake);
    expect(resultBlock(fake)["content"]).toEqual([
      { type: "text", text: "chart:" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
    ]);
  });

  it("R10 S1 AC2: audio, resource, resource_link and an unsupported image type keep their JSON as a text block; empty text is dropped", () => {
    const audio = { type: "audio", data: "AAAA", mimeType: "audio/wav" };
    const link = { type: "resource_link", uri: "file:///a", name: "a" };
    const bmp = { type: "image", data: "Qk0=", mimeType: "image/bmp" };
    const out = toToolResultContent([textBlock(""), audio, link, bmp, textBlock("t")]);
    expect(out).toEqual([
      { type: "text", text: JSON.stringify(audio) },
      { type: "text", text: JSON.stringify(link) },
      { type: "text", text: JSON.stringify(bmp) },
      { type: "text", text: "t" },
    ]);
  });
});

describe("R10 S1 AC3: errors", () => {
  it("R10 S1 AC3: is_error true and false are preserved next to the new content shape", async () => {
    for (const isError of [true, false]) {
      const { fake, provider } = anthropicRig();
      await provider.chat({ messages: history(mcp("boom"), isError), tools: [tool("fs__read_text_file")] });
      noFaults(fake);
      const block = resultBlock(fake);
      expect(block["is_error"]).toBe(isError);
      expect(block["content"]).toBe("boom");
    }
  });
});

// -- openai / deepseek rig ----------------------------------------------------------------------------------
interface IOpenAIBody {
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
  tools?: unknown[];
}
let lastOpenAIRaw = "";
async function openaiBody(
  messages: ProviderChatRequest["messages"],
  tools?: ProviderChatRequest["tools"],
  providerConfig: Record<string, unknown> = {}
): Promise<IOpenAIBody> {
  const bodies: IOpenAIBody[] = [];
  const fetchSeam: typeof fetch = async (_u, init) => {
    lastOpenAIRaw = String(init?.body);
    bodies.push(JSON.parse(String(init?.body)) as IOpenAIBody);
    return new Response(
      JSON.stringify({
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "m",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  const config = {
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    wire: { fetch: fetchSeam },
    getProviderConfig: () => ({ secret: "sk-test", model: "deepseek-flash", baseURL: "http://localhost:1/v1" }),
  } as unknown as EngineConfig;
  await new OpenAIProvider({ type: "openai", model: "deepseek-flash", ...providerConfig } as never, config).chat({ messages, ...(tools ? { tools } : {}) });
  expect(bodies).toHaveLength(1);
  return bodies[0]!;
}
const toolMessage = (b: IOpenAIBody) => b.messages.find(m => m.role === "tool")!;

describe("R10 S1 AC4: openai / deepseek get a plain string", () => {
  it("R10 S1 AC4: an MCP text array is its joined text as a STRING (DeepSeek rejects a content-part array)", async () => {
    const body = await openaiBody(history(mcp(CRLF_FILE, "second")));
    const msg = toolMessage(body);
    expect(msg.tool_call_id).toBe("toolu_1");
    expect(typeof msg.content).toBe("string");
    expect(msg.content).toBe(`${CRLF_FILE}\nsecond`);
    expect(String(msg.content)).not.toContain('[{"type":"text"');
  });

  it("R10 S1 AC4: a string result is sent verbatim (not as the JSON of a string)", async () => {
    const msg = toolMessage(await openaiBody(history("hello \"world\"")));
    expect(msg.content).toBe('hello "world"');
  });

  it("R10 S1 AC4: an engine object result is its JSON once", async () => {
    const obj = toolMessage(await openaiBody(history({ n: 1 })));
    expect(obj.content).toBe('{"n":1}');
  });

  it("R10 S1 AC4: a result with no JSON form is the empty string, never a missing content", async () => {
    const msg = toolMessage(await openaiBody(history(undefined)));
    expect(msg.content).toBe("");
  });
});

describe("R10 S1 AC1/AC2/AC3/AC5 on the OpenAI-compatible adapter (openai.ts, also serving DeepSeek)", () => {
  const PNG = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };

  it("R10 S1 AC1 (openai): CR LF, quotes, backslash and tab reach the wire once-encoded as a plain string", async () => {
    const body = await openaiBody(history(mcp(CRLF_FILE)));
    const msg = toolMessage(body);
    expect(typeof msg.content).toBe("string");
    expect(msg.content).toBe(CRLF_FILE);
    expect(lastOpenAIRaw).toContain(JSON.stringify(CRLF_FILE));
    expect(lastOpenAIRaw).not.toContain("\\\\r\\\\n");
    expect(lastOpenAIRaw).not.toContain('\\"type\\":\\"text\\"');
  });

  it("R10 S1 AC2 (openai): text + image is ONE string: the text raw, the image block as its JSON on its own line; the array is never JSON-encoded into a string", async () => {
    const msg = toolMessage(await openaiBody(history([textBlock("chart:"), PNG, textBlock("done")])));
    expect(typeof msg.content).toBe("string");
    expect(msg.content).toBe(`chart:\n${JSON.stringify(PNG)}\ndone`);
    expect(String(msg.content)).not.toContain('[{"type":"text"');
    expect(String(msg.content)).not.toMatch(/^\[/);
    // only non-text blocks: each is its own JSON line, still not wrapped in an array
    const onlyImage = toolMessage(await openaiBody(history([PNG])));
    expect(onlyImage.content).toBe(JSON.stringify(PNG));
  });

  it("R10 S1 AC3 (openai): an error result sends its text; the OpenAI tool message has no is_error field, so none is invented", async () => {
    const msg = toolMessage(await openaiBody(history(mcp("boom"), true)));
    expect(msg.content).toBe("boom");
    expect(Object.keys(msg).sort()).toEqual(["content", "role", "tool_call_id"]);
  });

  it("R10 S1 AC5 (openai): an over-cap read reaches the wire as the unescaped head/tail fragment with the notice", async () => {
    const big = Array.from({ length: 400 }, (_, i) => `export const v${i} = "value ${i}"; // path C:\\x\\${i}\r\n`).join("");
    const capped = capToolResult(mcp(big), false, DEFAULT_TOOL_RESULT_MAX_CHARS).result;
    const content = String(toolMessage(await openaiBody(history(capped))).content);
    expect(content.startsWith(big.slice(0, 4500))).toBe(true);
    expect(content).toContain(`[tool result truncated: showing first 4500 and last 1500 of ${big.length} chars;`);
    expect(content).not.toContain("\\r");
    expect(content).not.toContain('\\"');
  });
});

describe("R10 S1 AC6 (openai): thinking is Anthropic-only", () => {
  it("R10 S1 AC6 (openai): a `thinking` key on an openai provider config never reaches the request body", async () => {
    const body = await openaiBody([{ role: "user", content: "hi" }] as never, undefined, { thinking: { type: "adaptive" } });
    expect(Object.keys(body)).not.toContain("thinking");
    expect(lastOpenAIRaw).not.toContain("thinking");
  });

  it("R10 S1 AC6 (openai): the S0 schema REJECTS `thinking` on an openai provider (strict), and accepts it on anthropic", () => {
    expect(providerConfigSchema.safeParse({ type: "openai", model: "m", thinking: { type: "adaptive" } }).success).toBe(false);
    expect(providerConfigSchema.safeParse({ type: "anthropic", model: MODEL, thinking: { type: "adaptive" } }).success).toBe(true);
  });
});

describe("R10 S1 AC5: the cap works on the text the model reads", () => {
  const line = (i: number) => `export const v${i} = "value ${i}"; // path C:\\x\\${i}\r\n`;
  const BIG = Array.from({ length: 400 }, (_, i) => line(i)).join("");

  it("R10 S1 AC5: a >6000-char CRLF file is cut as real text: unescaped head and tail, a notice that counts real characters", () => {
    expect(BIG.length).toBeGreaterThan(DEFAULT_TOOL_RESULT_MAX_CHARS);
    const out = capToolResult(mcp(BIG), false, DEFAULT_TOOL_RESULT_MAX_CHARS);
    expect(out.truncated).toBe(true);
    expect(out.originalChars).toBe(BIG.length);
    const s = out.result as string;
    expect(typeof s).toBe("string");
    expect(s.startsWith(BIG.slice(0, 4500))).toBe(true);
    expect(s.endsWith(BIG.slice(BIG.length - 1500))).toBe(true);
    expect(s).toContain(`[tool result truncated: showing first 4500 and last 1500 of ${BIG.length} chars;`);
    expect(s).toContain("\r\n");
    // The only backslashes are the ones in the file's own `C:\x\N` paths; escaping would double them or add `\n`/`\r`/`\"`.
    expect(s).not.toContain("\\n");
    expect(s).not.toContain("\\r");
    expect(s).not.toContain('\\"');
    expect(s).not.toContain("\\\\");
    expect(s).not.toMatch(/^\[\{"type"/);
  });

  it("R10 S1 AC5: through the provider the over-cap result reaches the wire as that unescaped fragment", async () => {
    const capped = capToolResult(mcp(BIG), false, DEFAULT_TOOL_RESULT_MAX_CHARS).result;
    const { fake, provider } = anthropicRig();
    await provider.chat({ messages: history(capped), tools: [tool("fs__read_text_file")] });
    noFaults(fake);
    const content = resultBlock(fake)["content"] as string;
    expect(content.startsWith(BIG.slice(0, 4500))).toBe(true);
    expect(content).toContain("[tool result truncated:");
    expect(content).not.toContain("\\r");
  });

  it("R10 S1 AC5: escaping alone never trips the cap: 5500 quote characters (11000 chars as JSON) are under a 6000 cap and pass through untouched", () => {
    const quotes = mcp('"'.repeat(5500));
    expect(JSON.stringify(quotes).length).toBeGreaterThan(DEFAULT_TOOL_RESULT_MAX_CHARS);
    const out = capToolResult(quotes, false, DEFAULT_TOOL_RESULT_MAX_CHARS);
    expect(out.truncated).toBe(false);
    expect(out.result).toBe(quotes);
    expect(out.originalChars).toBe(5500);
  });

  it("R10 S1 AC5: a result holding a non-text block, and an engine object, are still capped as their JSON (unchanged)", () => {
    const mixed = [textBlock("t".repeat(8000)), { type: "image", data: "AAAA", mimeType: "image/png" }];
    const out = capToolResult(mixed, false, 6000);
    expect(out.truncated).toBe(true);
    expect(out.originalChars).toBe(JSON.stringify(mixed).length);
  });
});

describe("R10 S1 AC6: P7 thinking option", () => {
  const ask = { messages: [{ role: "user", content: "hi" }] as never };
  const PRE_P7_BODY = '{"model":"claude-haiku-5-5","max_tokens":128000,"messages":[{"role":"user","content":"hi"}],"stream":true}';

  it("R10 S1 AC6: unset => the request body is byte-identical to the pre-change body (golden) and has no `thinking` key", async () => {
    const { fake, provider } = anthropicRig([okStep()], {});
    await provider.chat(ask);
    expect(fake.requests[0]!.rawBody).toBe(PRE_P7_BODY);
    expect(Object.keys(fake.requests[0]!.body!)).not.toContain("thinking");
  });

  it.each([
    ["adaptive", { type: "adaptive" }],
    ["adaptive + summarized", { type: "adaptive", display: "summarized" }],
    ["adaptive + omitted", { type: "adaptive", display: "omitted" }],
    ["disabled", { type: "disabled" }],
  ])("R10 S1 AC6: %s reaches the wire as exactly that `thinking` object and nothing else changes", async (_n, thinking) => {
    const { fake, provider } = anthropicRig([okStep()], { thinking });
    await provider.chat(ask);
    noFaults(fake);
    const body = fake.requests[0]!.body!;
    expect(body["thinking"]).toEqual(thinking);
    const { thinking: _t, ...rest } = body;
    expect(JSON.stringify(rest)).toBe(PRE_P7_BODY);
  });

  it("R10 S1 AC6: thinking and effort ride together without disturbing each other", async () => {
    const { fake, provider } = anthropicRig([okStep()], { thinking: { type: "adaptive", display: "summarized" }, effort: "high" });
    await provider.chat(ask);
    const body = fake.requests[0]!.body!;
    expect(body["thinking"]).toEqual({ type: "adaptive", display: "summarized" });
    expect(body["output_config"]).toEqual({ effort: "high" });
  });
});

describe("R10 S1 AC7: echo replay and cache accounting with the new shape", () => {
  it("R10 S1 AC7: an echoed thinking + tool_use turn is replayed and its MCP result follows as a raw-text tool_result; V1-V5 pass", async () => {
    const turn1: FakeStep = {
      blocks: [
        { type: "thinking", thinking: "", signature: "sig-1" },
        { type: "tool_use", id: "toolu_1", name: "fs__read_text_file", input: { path: "a.js" } },
      ] as ISseBlock[],
      stopReason: "tool_use",
    };
    const { fake, provider } = anthropicRig([turn1, okStep()]);
    const t1 = await provider.chat({ messages: [{ id: "u1", role: "user", content: "read it" }] as never, tools: [tool("fs__read_text_file")] });
    expect(t1.echo).toBeDefined();
    const t2 = await provider.chat({
      messages: [{ id: "u1", role: "user", content: "read it" }, t1.message, { id: "t1", role: "tool", toolResults: [{ toolCallId: "toolu_1", result: mcp(CRLF_FILE), isError: false }] }] as never,
      echoes: new Map([[t1.message.id, t1.echo!]]),
      tools: [tool("fs__read_text_file")],
    });
    noFaults(fake);
    expect(t2.echoReplay?.messages).toBe(1);
    const msgs = fake.requests[1]!.body!.messages;
    expect((msgs[1]!.content as Array<{ type: string }>).map(b => b.type)).toEqual(["thinking", "tool_use"]);
    expect(resultBlock(fake, 1)["content"]).toBe(CRLF_FILE);
  });

  it("R10 S1 AC7: the cache estimator counts a block-array tool_result by its text, not its JSON framing and escapes", () => {
    const text = '"quoted" \\ path\r\n'.repeat(400);
    const est = (content: unknown) =>
      estimatePrefixTokens({
        tools: undefined,
        system: undefined,
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content }] }] as never,
      }).total;
    const asString = est(text);
    expect(est([{ type: "text", text }])).toBe(asString);
    // negative control for the test itself: the JSON form of the same array is far larger.
    expect(est(JSON.stringify([{ type: "text", text }]))).toBeGreaterThan(asString);
  });
});

describe("R10 S1 AC8: annotations never reach the wire", () => {
  const annotated = tool("fs__read_text_file", { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } });

  it("R10 S1 AC8: anthropic `tools` carries name/description/input_schema only", async () => {
    const { fake, provider } = anthropicRig();
    await provider.chat({ messages: [{ role: "user", content: "hi" }] as never, tools: [annotated] as never });
    noFaults(fake);
    const raw = fake.requests[0]!.rawBody;
    expect(raw).not.toContain("annotations");
    expect(raw).not.toContain("readOnlyHint");
    expect(fake.requests[0]!.body!.tools).toEqual([{ name: "fs__read_text_file", description: "fs__read_text_file", input_schema: { type: "object", properties: {} } }]);
  });

  it("R10 S1 AC8: openai `tools` carries the function declaration only", async () => {
    const body = await openaiBody([{ role: "user", content: "hi" }] as never, [annotated] as never);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("annotations");
    expect(raw).not.toContain("readOnlyHint");
  });
});
