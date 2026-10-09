/**
 * ae62e6b0 (BK3, plan 9ed453c1-b113-473d-8c35-fc6dc2541306) — prompt-cache breakpoint placement.
 *
 * Pure request-builder tests (`applyCacheBreakpoints`, `minCacheableTokens`) plus the REAL
 * `AnthropicProvider` + `@anthropic-ai/sdk` driven through the engine's `wire.fetch` seam (no
 * socket, no api.anthropic.com). The real-HTTP loopback + task_usage proof is
 * `bk3-cache-breakpoints.e2e.test.ts`.
 */
import { encode } from "gpt-tokenizer";
import { describe, expect, it } from "vitest";
import type { MessageParam, TextBlockParam, Tool } from "@anthropic-ai/sdk/resources/messages";

import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import {
  MIN_CACHEABLE_TOKENS,
  UNKNOWN_MODEL_MIN_CACHEABLE_TOKENS,
  applyCacheBreakpoints,
  minCacheableTokens,
} from "../providers/anthropic-cache.js";
import { anthropicSseBody, distinctFiller } from "./fixtures/anthropic-sse.js";

const HAIKU = "claude-haiku-4-5";
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

const tokensOf = (s: string): number => encode(s).length;
const tool = (name: string, descWords: number): Tool => ({
  name,
  description: distinctFiller(descWords, name),
  input_schema: { type: "object", properties: {} },
});

/** A prefix well above Haiku 4.5's 4096 minimum at every breakpoint: ~2.5k tools + ~2.5k system + ~2.5k user. */
function bigRequest() {
  const tools = [tool("alpha", 700), tool("beta", 700)];
  const system = distinctFiller(900, "sys");
  const messages: MessageParam[] = [{ role: "user", content: distinctFiller(900, "usr") }];
  return { tools, system, messages };
}

interface IWireBody {
  tools?: Array<Record<string, unknown>>;
  system?: unknown;
  messages?: unknown;
}

const countCacheControls = (v: unknown): number => (JSON.stringify(v).match(/"cache_control"/g) ?? []).length;

describe("ae62e6b0 AC3.1: minimum-prefix table", () => {
  it("ae62e6b0 AC3.1: documented minimums per model-id prefix", () => {
    expect(minCacheableTokens("claude-haiku-4-5")).toBe(4096);
    expect(minCacheableTokens("claude-haiku-4-5-20251001")).toBe(4096);
    expect(minCacheableTokens("claude-haiku-5-5")).toBe(512);
    expect(minCacheableTokens("claude-sonnet-4-6")).toBe(1024);
    expect(minCacheableTokens("claude-sonnet-5")).toBe(1024);
    expect(minCacheableTokens("claude-opus-4-5")).toBe(4096);
    expect(minCacheableTokens("claude-opus-4-6")).toBe(4096);
  });

  it("ae62e6b0 AC3.1: an unknown model assumes the conservative 4096", () => {
    expect(UNKNOWN_MODEL_MIN_CACHEABLE_TOKENS).toBe(4096);
    expect(minCacheableTokens("some-future-model")).toBe(4096);
    expect(minCacheableTokens("")).toBe(4096);
    expect(MIN_CACHEABLE_TOKENS.length).toBeGreaterThanOrEqual(6);
  });
});

describe("ae62e6b0 AC3.1: breakpoint positions at or above the minimum", () => {
  it("ae62e6b0 AC3.1: a >=6k-token prefix on claude-haiku-4-5 gets exactly the three breakpoints, in tools/system/messages", () => {
    const req = bigRequest();
    expect(tokensOf(JSON.stringify(req.tools)) + tokensOf(req.system) + tokensOf(req.messages[0].content as string)).toBeGreaterThan(6000);

    const out = applyCacheBreakpoints({ model: HAIKU, ...req });

    expect(out.placed).toEqual(["tools", "system", "messages"]);
    expect(countCacheControls(out)).toBe(3);
    // last tools entry only
    expect(out.tools?.[0]).not.toHaveProperty("cache_control");
    expect(out.tools?.[1]).toHaveProperty("cache_control", { type: "ephemeral" });
    // string system becomes one text block carrying the breakpoint
    expect(out.system).toEqual([{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]);
    // string user content becomes one text block carrying the breakpoint
    expect(out.messages[0].content).toEqual([
      { type: "text", text: req.messages[0].content, cache_control: { type: "ephemeral" } },
    ]);
  });

  it("ae62e6b0 AC3.1: never more than the 4 the API allows (<=3 emitted) even with many tools and messages", () => {
    const tools = Array.from({ length: 12 }, (_, i) => tool(`t${i}`, 200));
    const messages: MessageParam[] = Array.from({ length: 9 }, (_, i): MessageParam => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: distinctFiller(400, `m${i}`),
    }));
    const out = applyCacheBreakpoints({ model: HAIKU, tools, system: distinctFiller(300), messages });
    expect(countCacheControls(out)).toBeLessThanOrEqual(3);
    expect(countCacheControls(out.messages)).toBe(1); // only the FINAL entry
    expect(JSON.stringify(out.messages.slice(0, -1))).not.toContain("cache_control");
  });

  it("ae62e6b0 AC3.1: TTL is the 5-minute default: no ttl field anywhere", () => {
    const out = applyCacheBreakpoints({ model: HAIKU, ...bigRequest() });
    const json = JSON.stringify(out);
    expect(json).toContain('"cache_control":{"type":"ephemeral"}');
    expect(json).not.toContain('"ttl"');
  });

  it("ae62e6b0 AC3.1: the breakpoint MOVES: after a tool round-trip it sits on the new last block, not the old one", () => {
    const req = bigRequest();
    const turn2: MessageParam[] = [
      ...req.messages,
      { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "alpha", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: '"result"' }] },
    ];
    const out = applyCacheBreakpoints({ model: HAIKU, ...req, messages: turn2 });
    expect(out.placed).toContain("messages");
    expect(countCacheControls(out.messages)).toBe(1);
    const lastBlock = (out.messages[2].content as unknown as Array<Record<string, unknown>>)[0];
    expect(lastBlock).toHaveProperty("cache_control", { type: "ephemeral" });
    expect(JSON.stringify(out.messages[0])).not.toContain("cache_control");
    expect(JSON.stringify(out.messages[1])).not.toContain("cache_control");
  });

  it("ae62e6b0 AC3.1: inputs are never mutated", () => {
    const req = bigRequest();
    const snapshot = JSON.stringify(req);
    applyCacheBreakpoints({ model: HAIKU, ...req });
    expect(JSON.stringify(req)).toBe(snapshot);
  });
});

describe("ae62e6b0 AC3.1: per-breakpoint minimum-prefix guard", () => {
  it("ae62e6b0 AC3.1: nothing below the minimum: a small request has no cache_control at all", () => {
    const out = applyCacheBreakpoints({
      model: HAIKU,
      tools: [tool("a", 20)],
      system: "short system prompt",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.placed).toEqual([]);
    expect(countCacheControls(out)).toBe(0);
  });

  it("ae62e6b0 AC3.1: the 3.1k-token benchmark shape (prefix below 4096) gets no breakpoints on haiku-4-5", () => {
    const tools = [tool("shell", 500)];
    const system = distinctFiller(250, "bench");
    const total = tokensOf(JSON.stringify(tools)) + tokensOf(system);
    expect(total).toBeGreaterThan(2500);
    expect(total).toBeLessThan(4096);
    const out = applyCacheBreakpoints({ model: HAIKU, tools, system, messages: [{ role: "user", content: "task" }] });
    expect(out.placed).toEqual([]);
  });

  it("ae62e6b0 AC3.1: it is PER breakpoint: small tools stay unmarked while system and messages (cumulative >= min) are marked", () => {
    const tools = [tool("small", 100)]; // well under 4096 alone
    const system = distinctFiller(1500, "sys"); // tools+system now crosses the minimum
    const out = applyCacheBreakpoints({ model: HAIKU, tools, system, messages: [{ role: "user", content: distinctFiller(100) }] });
    expect(tokensOf(JSON.stringify(tools))).toBeLessThan(4096);
    expect(out.placed).toEqual(["system", "messages"]);
    expect(out.tools?.[0]).not.toHaveProperty("cache_control");
  });

  it("ae62e6b0 AC3.1: only the messages breakpoint when tools+system alone are under the minimum but the conversation crosses it", () => {
    const out = applyCacheBreakpoints({
      model: HAIKU,
      tools: [tool("a", 100)],
      system: "sys",
      messages: [{ role: "user", content: distinctFiller(1800) }],
    });
    expect(out.placed).toEqual(["messages"]);
  });

  it("ae62e6b0 AC3.1: the same ~2k-token prefix is skipped on haiku-4-5 and an UNKNOWN model, cached on haiku-5-5 (512) and sonnet-4-6 (1024)", () => {
    const req = { tools: undefined, system: distinctFiller(600, "s"), messages: [{ role: "user", content: "go" } as MessageParam] };
    expect(tokensOf(req.system)).toBeGreaterThan(1500);
    expect(tokensOf(req.system)).toBeLessThan(4096);
    expect(applyCacheBreakpoints({ model: HAIKU, ...req }).placed).toEqual([]);
    expect(applyCacheBreakpoints({ model: "claude-unknown-9", ...req }).placed).toEqual([]);
    expect(applyCacheBreakpoints({ model: "claude-haiku-5-5", ...req }).placed).toEqual(["system", "messages"]);
    expect(applyCacheBreakpoints({ model: "claude-sonnet-4-6", ...req }).placed).toEqual(["system", "messages"]);
  });
});

describe("ae62e6b0 AC3.1: blocks that never carry a breakpoint", () => {
  it("ae62e6b0 AC3.1: a trailing thinking block is skipped: the breakpoint lands on the last cacheable block before it", () => {
    const out = applyCacheBreakpoints({
      model: HAIKU,
      tools: undefined,
      system: distinctFiller(1300),
      messages: [
        { role: "user", content: distinctFiller(1300, "u") },
        {
          role: "assistant",
          content: [
            { type: "text", text: "answer" },
            { type: "thinking", thinking: "hmm", signature: "sig" },
          ],
        },
      ],
    });
    const content = out.messages[1].content as unknown as Array<Record<string, unknown>>;
    expect(content[0]).toHaveProperty("cache_control");
    expect(content[1]).not.toHaveProperty("cache_control");
    expect(JSON.stringify(out.messages)).toContain('"type":"thinking"');
  });

  it("ae62e6b0 AC3.1: a final entry that is only thinking / redacted_thinking / empty text gets no messages breakpoint", () => {
    const base = { model: HAIKU, tools: undefined, system: distinctFiller(2600) };
    for (const content of [
      [{ type: "thinking" as const, thinking: "t", signature: "s" }],
      [{ type: "redacted_thinking" as const, data: "d" }],
      [{ type: "text" as const, text: "" }],
    ]) {
      const out = applyCacheBreakpoints({ ...base, messages: [{ role: "assistant", content }] });
      expect(out.placed).not.toContain("messages");
      expect(JSON.stringify(out.messages)).not.toContain("cache_control");
    }
  });

  it("ae62e6b0 AC3.1: an empty-text trailing block is skipped for the preceding block", () => {
    const out = applyCacheBreakpoints({
      model: HAIKU,
      tools: undefined,
      system: distinctFiller(2600),
      messages: [{ role: "assistant", content: [{ type: "text", text: "real" }, { type: "text", text: "" }] }],
    });
    const content = out.messages[0].content as unknown as Array<Record<string, unknown>>;
    expect(content[0]).toHaveProperty("cache_control");
    expect(content[1]).not.toHaveProperty("cache_control");
  });
});

describe("ae62e6b0 AC3.1: OAuth identity system block stays first and unchanged", () => {
  const identityBlock: TextBlockParam = { type: "text", text: IDENTITY };

  it("ae62e6b0 AC3.1: [identity, prompt] -> identity is byte-identical and first; only the prompt block is marked", () => {
    const prompt = distinctFiller(2600);
    const out = applyCacheBreakpoints({
      model: HAIKU,
      tools: undefined,
      system: [identityBlock, { type: "text", text: prompt }],
      messages: [{ role: "user", content: "go" }],
      protectedLeadingSystemBlocks: 1,
    });
    const sys = out.system as TextBlockParam[];
    expect(sys[0]).toEqual({ type: "text", text: IDENTITY });
    expect(JSON.stringify(sys[0])).toBe(JSON.stringify(identityBlock));
    expect(sys[1]).toEqual({ type: "text", text: prompt, cache_control: { type: "ephemeral" } });
  });

  it("ae62e6b0 AC3.1: [identity] alone is never marked, even when the tools prefix is huge (the tools breakpoint covers it)", () => {
    const out = applyCacheBreakpoints({
      model: HAIKU,
      tools: [tool("big", 1600)],
      system: [identityBlock],
      messages: [{ role: "user", content: "go" }],
      protectedLeadingSystemBlocks: 1,
    });
    expect(out.placed).toContain("tools");
    expect(out.placed).not.toContain("system");
    expect(out.system).toEqual([{ type: "text", text: IDENTITY }]);
  });
});

describe("ae62e6b0 AC3.1: the real AnthropicProvider puts the breakpoints on the wire", () => {
  const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  function makeProvider(secret: string, capture: IWireBody[], options?: { promptCaching?: boolean }) {
    const fetchSeam: typeof fetch = async (_url, init) => {
      capture.push(JSON.parse(String(init?.body)) as IWireBody);
      return new Response(
        anthropicSseBody({ model: HAIKU, text: "ok", usage: { input_tokens: 10, output_tokens: 5 } }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    };
    const engineConfig = {
      server: { contextLimit: 0, defaultMaxTokens: 8192 },
      wire: { fetch: fetchSeam },
      getProviderConfig: () => ({ secret, model: HAIKU }),
    } as unknown as EngineConfig;
    return new AnthropicProvider({ type: "anthropic", model: HAIKU }, engineConfig, logger, options);
  }

  const chatRequest = (req: ReturnType<typeof bigRequest>) => ({
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.messages[0].content as string },
    ] as never,
    tools: req.tools.map(t => ({ name: t.name, description: t.description ?? "", inputSchema: t.input_schema })),
  });

  it("ae62e6b0 AC3.1: API-key credential: request body carries exactly the three breakpoints, no ttl", async () => {
    const bodies: IWireBody[] = [];
    const provider = makeProvider("sk-ant-api-test", bodies);
    await provider.chat(chatRequest(bigRequest()));
    expect(bodies).toHaveLength(1);
    const body = bodies[0];
    expect(countCacheControls(body)).toBe(3);
    const tools = body.tools as unknown as Array<Record<string, unknown>>;
    expect(tools[0]).not.toHaveProperty("cache_control");
    expect(tools[1]).toHaveProperty("cache_control", { type: "ephemeral" });
    expect(body.system).toEqual([{ type: "text", text: bigRequest().system, cache_control: { type: "ephemeral" } }]);
    expect(JSON.stringify(body)).not.toContain('"ttl"');
  });

  it("ae62e6b0 AC3.1: OAuth credential: identity block first and unchanged, breakpoint on the user system block", async () => {
    const bodies: IWireBody[] = [];
    const provider = makeProvider("sk-ant-oat-test", bodies);
    await provider.chat(chatRequest(bigRequest()));
    const system = bodies[0].system as unknown as Array<Record<string, unknown>>;
    expect(system).toHaveLength(2);
    expect(system[0]).toEqual({ type: "text", text: IDENTITY });
    expect(system[1]).toHaveProperty("cache_control", { type: "ephemeral" });
    expect(countCacheControls(bodies[0])).toBe(3);
  });

  it("ae62e6b0 AC3.1: a small request is byte-identical to the pre-BK3 body (no cache_control, system stays a string)", async () => {
    const bodies: IWireBody[] = [];
    const provider = makeProvider("sk-ant-api-test", bodies);
    await provider.chat({ messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }] as never });
    expect(countCacheControls(bodies[0])).toBe(0);
    expect(bodies[0].system).toBe("be brief");
    expect(bodies[0].messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("ae62e6b0 AC3.3: negative control: promptCaching:false sends no cache_control for the same big request", async () => {
    const bodies: IWireBody[] = [];
    const provider = makeProvider("sk-ant-api-test", bodies, { promptCaching: false });
    await provider.chat(chatRequest(bigRequest()));
    expect(countCacheControls(bodies[0])).toBe(0);
  });
});
