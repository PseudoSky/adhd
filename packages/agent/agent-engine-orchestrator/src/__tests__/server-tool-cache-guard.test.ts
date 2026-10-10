/**
 * ebfe7421 (D2) — the Anthropic cache guard must count the real weight of server tools.
 *
 * Measured on claude-haiku-4-5 (agent-mcp `task`, same agent with and without the web tools):
 * tools-only real input 6,122 tokens vs a gpt-tokenizer estimate of 2,402; the web_search +
 * web_fetch pair alone adds >= 2,190 real tokens (turn-1 input 6,441-6,464 vs 4,205-4,251) while
 * their `{type,name}` stubs estimate at ~60. Before the fix no breakpoint was placed (2,402 < 4096).
 */
import { encode } from "gpt-tokenizer";
import { describe, expect, it } from "vitest";
import type { MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages";

import {
  SERVER_TOOL_TOKEN_WEIGHTS,
  applyCacheBreakpoints,
  serverToolTokens,
} from "../providers/anthropic-cache.js";
import { ANTHROPIC_NATIVE_WEB_TOOLS } from "../providers/server-side-tools.js";
import { distinctFiller } from "./fixtures/anthropic-sse.js";

const HAIKU = "claude-haiku-4-5";
const MIN = 4096;
const SERVER_TOOLS = ANTHROPIC_NATIVE_WEB_TOOLS.map(t => ({ ...t })) as unknown as Tool[];
const tokensOf = (v: unknown): number => encode(JSON.stringify(v)).length;
const custom = (name: string, words: number): Tool => ({
  name,
  description: distinctFiller(words, name),
  input_schema: { type: "object", properties: {} },
});
const user = (text: string): MessageParam[] => [{ role: "user", content: text }];
const marks = (v: unknown): number => (JSON.stringify(v).match(/"cache_control"/g) ?? []).length;

/** Custom tools sized so the NAIVE estimate of tools+server stubs is ~2.4k, like the measured 2,402. */
function measuredShapedTools(): Tool[] {
  return [custom("shell", 295), custom("task", 295), ...SERVER_TOOLS];
}

describe("ebfe7421 D2-AC1: server tools are counted at their real weight", () => {
  it("ebfe7421 D2-AC1: fixture reproduces the measured shape (naive 2.4k < 4096 <= naive + measured server delta)", () => {
    const tools = measuredShapedTools();
    const naive = tokensOf(tools);
    expect(naive).toBeGreaterThan(2200);
    expect(naive).toBeLessThan(2600);
    expect(naive).toBeLessThan(MIN);
    // the server-tool delta alone (measured >= 2,190) lifts the prefix over the minimum
    expect(naive + serverToolTokens(tools)).toBeGreaterThanOrEqual(MIN);
  });

  it("ebfe7421 D2-AC1: weights are the measured pair (>= 2,190 combined, never above the measured floor)", () => {
    const pair = serverToolTokens(SERVER_TOOLS);
    expect(pair).toBe(2180);
    expect(pair).toBeLessThanOrEqual(2190);
    expect(SERVER_TOOL_TOKEN_WEIGHTS.map(([p]) => p)).toEqual(["web_search_", "web_fetch_"]);
  });

  it("ebfe7421 D2-AC1: a real >=4096 prefix with server tools gets breakpoints though the naive estimate is below the minimum", () => {
    const tools = measuredShapedTools();
    expect(tokensOf(tools)).toBeLessThan(MIN);
    const out = applyCacheBreakpoints({
      model: HAIKU,
      tools,
      system: "You are a concise assistant. Follow instructions exactly.",
      messages: user("Reply with exactly: PONG"),
    });
    expect(out.placed).toEqual(["tools", "system", "messages"]);
    const last = out.tools![out.tools!.length - 1] as unknown as Record<string, unknown>;
    expect(last["cache_control"]).toEqual({ type: "ephemeral" });
    expect(last["type"]).toBe("web_fetch_20250910");
  });

  it("ebfe7421 D2-AC1: a genuinely small prefix with server tools (real < minimum) still gets no breakpoints", () => {
    const tools = [custom("shell", 40), ...SERVER_TOOLS];
    const out = applyCacheBreakpoints({
      model: HAIKU,
      tools,
      system: "short",
      messages: user("hi"),
    });
    // naive ~0.3k + 2,180 server weight is far below 4096
    expect(tokensOf(tools) + serverToolTokens(tools)).toBeLessThan(MIN);
    expect(out.placed).toEqual([]);
    expect(marks(out)).toBe(0);
  });

  it("ebfe7421 D2-AC1: an unknown server-tool type contributes 0 (lower bound, never a premium on an uncacheable prefix)", () => {
    const tools = [{ type: "future_tool_20300101", name: "future" } as unknown as Tool];
    expect(serverToolTokens(tools)).toBe(0);
    expect(serverToolTokens(undefined)).toBe(0);
  });

  it("ebfe7421 D2-AC1: unknown model with server tools keeps the conservative 4096 minimum", () => {
    const out = applyCacheBreakpoints({
      model: "claude-mystery-9",
      tools: [custom("shell", 40), ...SERVER_TOOLS],
      system: "short",
      messages: user("hi"),
    });
    expect(out.placed).toEqual([]);
  });
});

describe("ebfe7421 D2-AC2: prefixes without server tools are unchanged", () => {
  it("ebfe7421 D2-AC2: serverToolTokens is 0 for custom-only tools, so the estimate is byte-identical to the old one", () => {
    const tools = [custom("a", 300), custom("b", 300)];
    expect(serverToolTokens(tools)).toBe(0);
  });

  it("ebfe7421 D2-AC2: a custom-only 2.4k prefix still places nothing and returns the inputs by identity", () => {
    const tools = [custom("a", 330), custom("b", 330)];
    const messages = user("hi");
    const out = applyCacheBreakpoints({ model: HAIKU, tools, system: "s", messages });
    expect(out.placed).toEqual([]);
    expect(out.tools).toBe(tools);
    expect(out.messages).toBe(messages);
  });

  it("ebfe7421 D2-AC2: a custom-only prefix over the minimum places the same three breakpoints", () => {
    const out = applyCacheBreakpoints({
      model: HAIKU,
      tools: [custom("a", 700), custom("b", 700)],
      system: distinctFiller(900, "sys"),
      messages: user(distinctFiller(900, "usr")),
    });
    expect(out.placed).toEqual(["tools", "system", "messages"]);
  });
});
