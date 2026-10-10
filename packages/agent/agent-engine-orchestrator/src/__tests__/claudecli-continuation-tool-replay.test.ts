/**
 * 54499db1 -- claudecli session continuation must carry the earlier turns' tool calls and tool results.
 *
 *  AC1  a fact present only in a phase-1 tool result is visible to the phase-2 spawn on the same session.
 *  AC2  the replay shows prior tool use + result the way a resumed/anthropic session would (call, then result, then answer).
 *  AC3  the replayed tool output stays bounded by the tool-result cap (`agent.toolResult.maxChars`), so phase-2
 *       turn-1 context grows only by the capped history content.
 *
 * Real ClaudeCliProvider; only `child_process.spawn` is scripted. Phase 1 streams a tool_use + tool_result pair, phase 2
 * is a second `chat()` over the persisted (JSON round-tripped, as the session store does) phase-1 message.
 */
import { describe, expect, it, vi } from "vitest";
import { Readable } from "stream";

import type { EngineConfig, EngineLogger } from "../interfaces.js";
import type { Message } from "../validation/index.js";
import { DEFAULT_TOOL_RESULT_MAX_CHARS } from "../engine/tool-result-cap.js";

vi.mock("child_process", () => ({ spawn: vi.fn() }));

const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const cfg = (maxChars?: number): EngineConfig => ({
  server: { contextLimit: 0, defaultMaxTokens: 8192 },
  queue: { concurrency: 1 },
  sse: { baseUrl: "" },
  plugins: { entries: [] },
  getProviderConfig: () => ({}),
  subprocessEnv: () => ({}),
  resolveEnvName: (() => undefined) as unknown as EngineConfig["resolveEnvName"],
  ...(maxChars !== undefined ? { toolResult: { maxChars } } : {}),
}) as unknown as EngineConfig;

const line = (e: Record<string, unknown>): string => JSON.stringify(e) + "\n";

function phase1Stream(output: string): string {
  return [
    line({ type: "system", subtype: "init", model: "claude-haiku-4-5" }),
    line({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "mcp__tickets__get_rate", input: { ticket: "T-42" } }] } }),
    line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: output }] } }),
    line({ type: "assistant", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "The rate is noted." }] } }),
    line({ type: "result", subtype: "success", is_error: false, result: "The rate is noted." }),
  ].join("");
}
const plainStream = line({ type: "result", subtype: "success", is_error: false, result: "ok" });

/** Run `chat()` once against a scripted spawn; returns the response and the text written to the CLI's stdin. */
async function chatOnce(script: string, messages: Message[], maxChars?: number) {
  const { spawn } = await import("child_process");
  const writes: string[] = [];
  const stdout = new Readable({ read() {} });
  queueMicrotask(() => { stdout.push(script); stdout.push(null); });
  (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
    stdout,
    stdin: { write: (s: string) => { writes.push(s); return true; }, end: () => {} },
    stderr: new Readable({ read() {} }),
    on: () => {}, once: () => {}, kill: () => {},
    exitCode: 0, signalCode: null, killed: false,
  });
  const { ClaudeCliProvider } = await import("../providers/claudecli.js");
  const provider = new ClaudeCliProvider({ type: "claudecli", model: "claude-haiku-4-5" }, {}, undefined, cfg(maxChars), logger);
  const response = await provider.chat({ messages });
  const sent = writes.map((w) => JSON.parse(w) as { message: { content: string } });
  return { response, input: sent[0]!.message.content };
}

const msg = (role: Message["role"], content: string): Message =>
  ({ id: "00000000-0000-4000-8000-000000000001", sessionId: "00000000-0000-4000-8000-000000000002", role, content, createdAt: new Date().toISOString() });

/** What the session store does to a message between the two phases. */
const persisted = (m: Message): Message => JSON.parse(JSON.stringify(m)) as Message;

describe("54499db1: claudecli continuation replays phase-1 tool use", () => {
  it("54499db1 AC1/AC2: the phase-2 spawn input contains the phase-1 tool call, its result text, then the answer", async () => {
    const p1 = await chatOnce(phase1Stream("RATE=USD 187.50 per night"), [msg("user", "Look up the rate for T-42")]);
    expect(p1.response.message.content).toBe("The rate is noted.");

    const p2 = await chatOnce(plainStream, [
      msg("user", "Look up the rate for T-42"),
      persisted(p1.response.message),
      msg("user", "What rate did the tool return?"),
    ]);

    expect(p2.input).toContain("RATE=USD 187.50 per night");
    expect(p2.input).toContain("mcp__tickets__get_rate");
    expect(p2.input).toContain("T-42");
    const call = p2.input.indexOf("Assistant called tool mcp__tickets__get_rate");
    const result = p2.input.indexOf("Tool result (mcp__tickets__get_rate");
    const answer = p2.input.indexOf("Assistant: The rate is noted.");
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(result);
    expect(result).toBeLessThan(answer);
    expect(p2.input.endsWith("[Current message]\nWhat rate did the tool return?")).toBe(true);
  });

  it("54499db1 AC1: a text-only phase 1 replays exactly as before (no tool lines, first-turn size unchanged)", async () => {
    const p1 = await chatOnce(plainStream, [msg("user", "hi")]);
    expect(p1.response.message.toolResults).toBeUndefined();
    const p2 = await chatOnce(plainStream, [msg("user", "hi"), persisted(p1.response.message), msg("user", "again")]);
    expect(p2.input).toBe("[Conversation history]\nUser: hi\nAssistant: ok\n\n[Current message]\nagain");
  });

  it("54499db1 AC3: replayed tool output is bounded by the configured tool-result cap", async () => {
    const big = "X".repeat(DEFAULT_TOOL_RESULT_MAX_CHARS * 3);
    const p1 = await chatOnce(phase1Stream(big), [msg("user", "q")]);
    const p2 = await chatOnce(plainStream, [msg("user", "q"), persisted(p1.response.message), msg("user", "recall")]);
    expect(p2.input.length).toBeLessThan(DEFAULT_TOOL_RESULT_MAX_CHARS * 2);
    expect(p2.input).toContain("[tool result truncated");

    const small = await chatOnce(phase1Stream(big), [msg("user", "q")], 200);
    const p3 = await chatOnce(plainStream, [msg("user", "q"), persisted(small.response.message), msg("user", "recall")]);
    expect(p3.input.length).toBeLessThan(1200);
  });
});
