import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import type { ProviderChatRequest } from "../providers/types.js";
import { AGENT_MCP_SERVER_NAME, CONCURRENCY_HINT_TOOLS, concurrencyHintAnnotations } from "../providers/claudecli.js";

/**
 * 424b6362 AC4 — the claudecli bridge advertises `{readOnlyHint:true}` for EXACTLY the bare tool names
 * `task`, `tasks_batch`, `agent` (a CLI concurrency hint, see the CONCURRENCY_HINT_TOOLS comment) and
 * nothing for any other tool. No subprocess, no bound port (`spawn` and `startToolBridge` are mocked);
 * the bound-port / real-CLI proofs are in claudecli-concurrency-hint.e2e.test.ts.
 */

vi.mock("child_process", () => ({ spawn: vi.fn() }));
const startToolBridge = vi.fn();
vi.mock("../providers/claudecli-tool-bridge.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../providers/claudecli-tool-bridge.js")>()),
    startToolBridge: (...a: unknown[]) => startToolBridge(...a),
}));

const scratchRoot = mkdtempSync(join(tmpdir(), "424b6362-hint-"));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const engine = {
    wire: { tempDir: scratchRoot },
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    queue: { concurrency: 1 }, sse: { baseUrl: "" }, plugins: { entries: [] },
    getProviderConfig: () => ({}), subprocessEnv: () => ({}),
    resolveEnvName: (() => undefined) as unknown as EngineConfig["resolveEnvName"],
} as unknown as EngineConfig;

const EXPECTED = ["agent", "task", "tasks_batch"];
const OTHERS = [
    "task_status", "tasks", "agents", "agent_create", "task_cancel", "tasks_batch_status", "bump", "echo",
    "Task", "AGENT", "task ", "", "x__task", "agent-mcp__agent",
];

/** The pinned policy check; the negative control below proves it has teeth. */
function assertPolicy(hinted: ReadonlySet<string>, hook: (tool: string, server: string) => Record<string, unknown> | undefined): void {
    expect([...hinted].sort()).toEqual(EXPECTED);
    for (const t of EXPECTED) expect(hook(t, AGENT_MCP_SERVER_NAME)).toEqual({ readOnlyHint: true });
    for (const t of OTHERS) expect(hook(t, AGENT_MCP_SERVER_NAME)).toBeUndefined();
    // 95ee2a24 AC1: the same bare names on any other server are never hinted.
    for (const t of EXPECTED) for (const server of ["s", "latch", "agent-mcp-evil", "AGENT-MCP", ""]) expect(hook(t, server)).toBeUndefined();
}

beforeEach(() => startToolBridge.mockReset());

describe("424b6362 AC4 + 95ee2a24 AC1: claudecli concurrency-hint policy", () => {
    it("424b6362 AC4 / 95ee2a24 AC1: readOnlyHint for exactly task / tasks_batch / agent on agent-mcp only, undefined for every other tool or server", () => {
        assertPolicy(CONCURRENCY_HINT_TOOLS, concurrencyHintAnnotations);
    });

    it("424b6362 AC4 negative control: a fourth hinted tool turns the policy check red", () => {
        const widened = new Set([...CONCURRENCY_HINT_TOOLS, "echo"]);
        const hook = (t: string) => (widened.has(t) ? { readOnlyHint: true } : undefined); // ignores the server: the 95ee2a24 AC1 half goes red
        expect(() => assertPolicy(widened, hook)).toThrow();
    });

    it("424b6362 AC4: ClaudeCliProvider hands the bridge a toolAnnotations hook that implements the policy", async () => {
        const { spawn } = await import("child_process");
        const stdout = new Readable({ read() {} });
        const proc = {
            stdout, stderr: new Readable({ read() {} }), pid: undefined, on: () => {}, kill: () => {},
            stdin: { write: () => true, end: () => {} }, exitCode: 0 as number | null, killed: false,
        };
        (spawn as unknown as ReturnType<typeof vi.fn>).mockReset();
        (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
            queueMicrotask(() => {
                stdout.push(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK", num_turns: 1 }) + "\n");
                stdout.push(null);
            });
            return proc;
        });
        startToolBridge.mockResolvedValue({ baseUrl: "http://127.0.0.1:1", token: "t", serverNames: ["s"], calls: () => 0, close: async () => {} });
        const { ClaudeCliProvider } = await import("../providers/claudecli.js");
        const provider = new ClaudeCliProvider({ type: "claudecli", model: "claude-haiku-4-5" } as never, {} as never, undefined, engine, logger);
        const tools = [AGENT_MCP_SERVER_NAME, "s"].flatMap((srv) => ["task", "tasks_batch", "agent", "bump", "task_status"].map((n) => ({
            name: `${srv}__${n}`, description: "d", inputSchema: { type: "object" },
        }))) as NonNullable<ProviderChatRequest["tools"]>;
        await provider.chat({
            messages: [{ role: "user", content: "go" }] as unknown as ProviderChatRequest["messages"],
            tools,
            executeTool: async () => ({ result: "", isError: false }),
        });
        expect(startToolBridge).toHaveBeenCalledTimes(1);
        const opts = startToolBridge.mock.calls[0]![0] as { toolAnnotations?: (t: string, d: unknown) => unknown };
        expect(opts.toolAnnotations).toBeTypeOf("function");
        const hook = opts.toolAnnotations as unknown as (t: string, d: unknown, server: string) => unknown;
        for (const t of EXPECTED) expect(hook(t, {}, AGENT_MCP_SERVER_NAME)).toEqual({ readOnlyHint: true });
        for (const t of ["bump", "task_status"]) expect(hook(t, {}, AGENT_MCP_SERVER_NAME)).toBeUndefined();
        // 95ee2a24 AC1: a foreign server's task / agent / tasks_batch gets no hint through the provider's hook.
        for (const t of EXPECTED) expect(hook(t, {}, "s")).toBeUndefined();
    });
});
