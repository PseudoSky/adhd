/**
 * tool-result-tokens.test.ts — backlog d89e20f4 (orchestrator tokenized the FULL
 * tool result before the cap), related 3ad735bb AC1.4. Unit tests for the bounded
 * estimator plus a REAL Orchestrator + real TaskStore drive (only the LLM provider
 * boundary is mocked) proving (a4235310 AC2: no wall-clock assertions) a 1,000,000-char single-character run never reaches
 * the tokenizer in full. Bounds are asserted deterministically (tokenizer argument
 * length), never by tight wall-clock.
 */
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { encode as realEncode } from "gpt-tokenizer";

import * as schema from "@adhd/agent-store-runtime";
import { TaskStore } from "@adhd/agent-store-runtime";
import type { AgentDefinition, ExecutionContext, Message } from "@adhd/agent-base-types";

import { Orchestrator } from "../engine/orchestrator.js";
import type { OrchestratorTaskStore, OrchestratorSessionStore } from "../engine/orchestrator.js";
import { HookRegistry } from "../engine/hooks.js";
import {
    estimateToolResultTokens,
    TOOL_RESULT_EXACT_ENCODE_MAX_CHARS,
    TOOL_RESULT_SAMPLE_CHARS,
} from "../engine/tool-result-tokens.js";
import type { PolicyEngine } from "../engine/policy.js";
import type { LLMProvider, ProviderChatResponse } from "../providers/types.js";
import type { McpClientRegistry } from "../clients/registry.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import { createMigratedSqlite } from "./fixtures/real-schema-db.js";

/** Every string handed to the tokenizer through the orchestrator's import. */
const encodeArgLengths: number[] = [];
vi.mock("gpt-tokenizer", async (importOriginal) => {
    const actual = await importOriginal<typeof import("gpt-tokenizer")>();
    return {
        ...actual,
        encode: (s: string, ...rest: unknown[]) => {
            encodeArgLengths.push(s.length);
            return (actual.encode as (s: string, ...r: unknown[]) => number[])(s, ...rest);
        },
    };
});

const SAMPLE_BOUND = 2 * TOOL_RESULT_SAMPLE_CHARS;

describe("d89e20f4 AC1 estimator bounds tokenizer input", () => {
    it("a 1,000,000-char single-char run encodes at most the sample bound in total per call, flagged estimated", () => {
        const seen: number[] = [];
        const spy = (s: string) => { seen.push(s.length); return realEncode(s); };
        const out = estimateToolResultTokens("m".repeat(1_000_000), spy);
        expect(out.estimated).toBe(true);
        expect(Math.max(...seen)).toBeLessThanOrEqual(TOOL_RESULT_SAMPLE_CHARS);
        expect(seen.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(SAMPLE_BOUND);
        expect(out.tokens).toBeGreaterThan(0);
    });

    it("NEGATIVE CONTROL: a naive encode-everything implementation trips the same bound assertion", () => {
        const seen: number[] = [];
        const naive = (t: string, enc: (s: string) => ArrayLike<number>) => enc(t).length;
        // Use a cheap fake encoder so the control itself does not stall.
        naive("m".repeat(1_000_000), (s) => { seen.push(s.length); return { length: s.length } as ArrayLike<number>; });
        expect(Math.max(...seen)).toBeGreaterThan(TOOL_RESULT_SAMPLE_CHARS);
    });

    it("scaled estimate is within 15% of the exact count for large ordinary text", () => {
        const text = Array.from({ length: 6000 }, (_, i) => `line ${i}: the quick brown fox ${i * 7} jumps`).join("\n");
        expect(text.length).toBeGreaterThan(TOOL_RESULT_EXACT_ENCODE_MAX_CHARS);
        const exact = realEncode(text).length;
        const est = estimateToolResultTokens(text);
        expect(est.estimated).toBe(true);
        expect(Math.abs(est.tokens - exact) / exact).toBeLessThan(0.15);
    });

    it("a4235310 AC1 dense middle (base64 blob) between normal head and tail is within 25% of the exact count (real tokenizer)", () => {
        let seed = 12345;
        const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        const b64 = Array.from({ length: 60_000 }, () => alphabet[Math.floor(rnd() * 64)]).join("");
        const prose = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog`).join("\n");
        const text = `${prose(300)}\n${b64}\n${prose(300)}`;
        expect(text.length).toBeGreaterThan(TOOL_RESULT_EXACT_ENCODE_MAX_CHARS);
        const exact = realEncode(text).length;
        const est = estimateToolResultTokens(text);
        expect(est.estimated).toBe(true);
        expect(Math.abs(est.tokens - exact) / exact).toBeLessThan(0.25);
    });

    it("a4235310 AC1 NEGATIVE CONTROL: a head+tail-only sample misses the same dense middle by more than 25%", () => {
        const dense = Array.from({ length: 60_000 }, (_, i) => String.fromCharCode(33 + ((i * 7919) % 90))).join("");
        const prose = "the quick brown fox jumps over the lazy dog\n".repeat(400);
        const text = `${prose}${dense}${prose}`;
        const exact = realEncode(text).length;
        const head = text.slice(0, TOOL_RESULT_SAMPLE_CHARS);
        const tail = text.slice(-TOOL_RESULT_SAMPLE_CHARS);
        const headTail = Math.ceil(((realEncode(head).length + realEncode(tail).length) * text.length) / (2 * TOOL_RESULT_SAMPLE_CHARS));
        expect(Math.abs(headTail - exact) / exact).toBeGreaterThan(0.25);
        expect(Math.abs(estimateToolResultTokens(text).tokens - exact) / exact).toBeLessThan(0.25);
    });

    it("a4235310 AC1 the stall bound holds for a dense middle: no tokenizer call exceeds one chunk, total within the sample bound", () => {
        const seen: number[] = [];
        estimateToolResultTokens("x".repeat(100_000) + "y".repeat(100_000), (s) => { seen.push(s.length); return realEncode(s); });
        expect(Math.max(...seen)).toBeLessThanOrEqual(TOOL_RESULT_SAMPLE_CHARS);
        expect(seen.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(SAMPLE_BOUND);
    });

    it("does not split a surrogate pair at a sample boundary", () => {
        const text = "😀".repeat(30_000);
        const seen: string[] = [];
        estimateToolResultTokens(text, (s) => { seen.push(s); return realEncode(s); });
        for (const s of seen) expect(s).toBe(Array.from(s).join(""));
        for (const s of seen) expect(s.charCodeAt(s.length - 1) >= 0xd800 && s.charCodeAt(s.length - 1) <= 0xdbff).toBe(false);
    });
});

describe("d89e20f4 AC2 normal-size results keep exact counts", () => {
    it("at the threshold the figure equals encode(text).length and is not flagged", () => {
        const text = "abc def ghi ".repeat(Math.floor(TOOL_RESULT_EXACT_ENCODE_MAX_CHARS / 12));
        expect(text.length).toBeLessThanOrEqual(TOOL_RESULT_EXACT_ENCODE_MAX_CHARS);
        expect(estimateToolResultTokens(text)).toEqual({ tokens: realEncode(text).length, estimated: false });
    });
    it("empty string is exact zero", () => {
        expect(estimateToolResultTokens("")).toEqual({ tokens: 0, estimated: false });
    });
});

function makeCtx(taskId: string): ExecutionContext {
    const def: AgentDefinition = {
        name: "enc-test-agent", version: 1, provider: { type: "anthropic", model: "claude_sonnet_4_6" },
        systemPrompt: "x", mcpServers: {}, permissions: {}, createdAt: nowIso(), updatedAt: nowIso(),
    };
    return { taskId, sessionId: generateId(), agentName: def.name, agentDefinition: def, recursionDepth: 0, toolCallCount: 0 };
}

async function runWithToolResult(toolResult: string) {
    const sqlite = createMigratedSqlite();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = drizzle(sqlite, { schema }) as any;
    const taskId = generateId();
    const ctx = makeCtx(taskId);
    const taskStore = new TaskStore(db);
    taskStore.create({ sessionId: ctx.sessionId, prompt: "p", id: taskId });
    let calls = 0;
    const provider: LLMProvider = {
        chat: async (): Promise<ProviderChatResponse> => {
            calls++;
            return calls === 1
                ? {
                    message: { id: generateId(), sessionId: ctx.sessionId, role: "assistant",
                        toolCalls: [{ id: generateId(), server: "test-server", tool: "echo", arguments: {} }], createdAt: nowIso() },
                    stopReason: "tool_calls",
                }
                : {
                    message: { id: generateId(), sessionId: ctx.sessionId, role: "assistant", content: "done", createdAt: nowIso() },
                    stopReason: "completed",
                };
        },
    };
    const registry = {
        listAllTools: async () => [{ name: "test-server__echo", description: "", inputSchema: { type: "object", properties: {} } }],
        getClient: async () => ({ callTool: async () => toolResult }),
        closeAll: async () => { /* no-op */ },
    } as unknown as McpClientRegistry;
    const user: Message = { id: generateId(), sessionId: ctx.sessionId, role: "user", content: "hello", createdAt: nowIso() };
    const sessionStore: OrchestratorSessionStore = { appendMessage: async () => { /* no-op */ }, close: () => { /* no-op */ } };
    encodeArgLengths.length = 0;
    await new Orchestrator().run({
        executionContext: ctx, messages: [user], registry, provider,
        policy: { check: () => { /* permit */ } } as unknown as PolicyEngine,
        taskStore: taskStore as unknown as OrchestratorTaskStore, sessionStore,
        signal: new AbortController().signal, taskId, hooks: new HookRegistry(),
    });
    const row = sqlite.prepare("SELECT payload FROM task_events WHERE task_id = ? AND type = 'TOOL_RESULT'").get(taskId) as { payload: string };
    return JSON.parse(row.payload) as {
        tool_call_est_result_tokens: number;
        tool_call_est_result_tokens_estimated?: boolean;
        truncated?: boolean;
        original_chars?: number;
    };
}

describe("d89e20f4 AC1 orchestrator drive: 1,000,000-char run never reaches the tokenizer in full", () => {
    it("TOOL_RESULT is flagged estimated and no tokenizer call exceeds the sample", async () => {
        const payload = await runWithToolResult("h".repeat(1_000_000));
        expect(Math.max(...encodeArgLengths)).toBeLessThanOrEqual(TOOL_RESULT_SAMPLE_CHARS);
        expect(payload.tool_call_est_result_tokens_estimated).toBe(true);
        expect(payload.tool_call_est_result_tokens).toBeGreaterThan(0);
        expect(payload.truncated).toBe(true);
        expect(payload.original_chars).toBe(1_000_000);
    });

    it("a normal-size result keeps the exact count and carries no estimate flag (3ad735bb AC1.4)", async () => {
        const text = Array.from({ length: 80 }, (_, i) => `tool output line ${i}: varied ${i * 7}`).join("\n");
        const payload = await runWithToolResult(text);
        expect(payload.tool_call_est_result_tokens).toBe(realEncode(text).length);
        expect(payload.tool_call_est_result_tokens_estimated).toBeUndefined();
    });
});
