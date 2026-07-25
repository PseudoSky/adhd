import { describe, expect, it, vi } from "vitest";
import { Readable } from "stream";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import type { ProviderChatRequest } from "../providers/types.js";

/**
 * Proves the fix for the root cause of agent-mcp's `claudecli`-provider tasks
 * recording zero tokens in `usage_query` (backlog `agent-mcp-001`): the terminal
 * `result` event on a `claude -p --output-format stream-json` run already carries
 * a fully-aggregated `usage` object (verified live against the real CLI,
 * 2026-07-25), but `ClaudeStreamResultEvent` never declared the field, so
 * `JSON.parse(...) as ClaudeStreamEvent` silently dropped it.
 *
 * Fixture lines below are the real shape captured from that live run — not
 * invented. `child_process.spawn` is mocked (this package must never actually
 * spawn a nested `claude` process from a test) to emit them verbatim.
 */

vi.mock("child_process", () => ({
    spawn: vi.fn(),
}));

const STREAM_LINES = [
    JSON.stringify({
        type: "assistant",
        message: {
            model: "claude-haiku-4-5-20251001",
            id: "msg_test123",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "OK" }],
            usage: { input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 19897, cache_read_input_tokens: 21699 },
        },
    }),
    JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "OK",
        stop_reason: "end_turn",
        total_cost_usd: 0.0429589,
        usage: {
            input_tokens: 10,
            output_tokens: 197,
            cache_creation_input_tokens: 19897,
            cache_read_input_tokens: 21699,
        },
    }),
];

function makeFakeProc() {
    const stdout = new Readable({ read() {} });
    const writes: string[] = [];
    const stdin = {
        write: (s: string) => { writes.push(s); return true; },
        end: () => {},
    };
    const proc = {
        stdout,
        stdin,
        stderr: new Readable({ read() {} }),
        on: (_event: string, _cb: (...args: unknown[]) => void) => {},
        kill: () => {},
        exitCode: 0 as number | null,
        killed: false,
    };
    // Feed the fixture lines asynchronously (mirrors real stream-json's line-by-line arrival)
    queueMicrotask(() => {
        for (const line of STREAM_LINES) stdout.push(line + "\n");
        stdout.push(null);
    });
    return { proc, writes };
}

const engineConfig: EngineConfig = {
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    queue: { concurrency: 1 },
    sse: { baseUrl: "" },
    plugins: { entries: [] },
    getProviderConfig: () => ({}),
    subprocessEnv: () => ({}),
    resolveEnvName: (() => undefined) as unknown as EngineConfig["resolveEnvName"],
} as unknown as EngineConfig;

const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const request: ProviderChatRequest = {
    messages: [{ role: "user", content: "Say OK" } as ProviderChatRequest["messages"][number]],
};

describe("ClaudeCliProvider — usage capture from the real result event", () => {
    it("populates usage/rawUsage from the terminal result event's usage field", async () => {
        const { spawn } = await import("child_process");
        const { proc } = makeFakeProc();
        (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(proc);

        const { ClaudeCliProvider } = await import("../providers/claudecli.js");
        const provider = new ClaudeCliProvider(
            { type: "claudecli", model: "claude-haiku-4-5" },
            {},
            undefined,
            engineConfig,
            logger
        );

        const response = await provider.chat(request);

        // This is the actual regression check: before the fix, both were `undefined`
        // because ClaudeStreamResultEvent never declared `usage` at all.
        expect(response.rawUsage).toEqual({
            input_tokens: 10,
            output_tokens: 197,
            cache_creation_input_tokens: 19897,
            cache_read_input_tokens: 21699,
        });
        expect(response.usage).toBeDefined();
        // Same reconstruction anthropic.ts already uses: total input = uncached + cache_read + cache_creation.
        expect(response.usage!.inputTokens).toBe(10 + 19897 + 21699);
        expect(response.usage!.outputTokens).toBe(197);
        expect(response.usage!.cacheReadTokens).toBe(21699);
        expect(response.usage!.cacheCreationTokens).toBe(19897);
        expect(response.usage!.uncachedInputTokens).toBe(10);
        expect(response.message.content).toBe("OK");
    });

    it("degrades gracefully (no crash) when the result event has no usage field", async () => {
        const { spawn } = await import("child_process");
        const stdout = new Readable({ read() {} });
        const stdin = { write: () => true, end: () => {} };
        const proc = {
            stdout, stdin, stderr: new Readable({ read() {} }),
            on: () => {}, kill: () => {}, exitCode: 0, killed: false,
        };
        queueMicrotask(() => {
            stdout.push(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK" }) + "\n");
            stdout.push(null);
        });
        (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(proc);

        const { ClaudeCliProvider } = await import("../providers/claudecli.js");
        const provider = new ClaudeCliProvider(
            { type: "claudecli", model: "claude-haiku-4-5" },
            {},
            undefined,
            engineConfig,
            logger
        );

        const response = await provider.chat(request);
        expect(response.usage).toBeUndefined();
        expect(response.rawUsage).toBeUndefined();
        expect(response.message.content).toBe("OK");
    });
});
