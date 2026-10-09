import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "stream";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import type { ProviderChatRequest } from "../providers/types.js";

/**
 * Ticket 98f9da19 — claudecli worker isolation (commits b1f0efa1, aad8f3e4).
 *
 * Every test drives the real `ClaudeCliProvider.chat()` loop; only
 * `child_process.spawn` is mocked (no subprocess is ever started), and the
 * "claude" side is a synthetic stream-json fixture. Assertions read what the
 * provider actually passed to `spawn` (argv/env) or wrote to the child's stdin.
 *
 * Each assertion fails if the corresponding behaviour in
 * `providers/claudecli.ts` is reverted (negative controls were run when this
 * file was authored).
 */

vi.mock("child_process", () => ({
    spawn: vi.fn(),
}));

const RESULT_LINE = JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: "OK", num_turns: 1,
});

function assistantLine(blocks: Array<{ id: string; name: string; input?: unknown }>): string {
    return JSON.stringify({
        type: "assistant",
        message: {
            role: "assistant",
            content: blocks.map((b) => ({ type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} })),
        },
    });
}

function makeFakeProc(lines: string[] = [RESULT_LINE]) {
    const stdout = new Readable({ read() {} });
    const writes: string[] = [];
    const proc = {
        stdout,
        stdin: { write: (s: string) => { writes.push(s); return true; }, end: () => {} },
        stderr: new Readable({ read() {} }),
        pid: undefined,
        on: () => {},
        kill: () => {},
        exitCode: 0 as number | null,
        killed: false,
    };
    queueMicrotask(() => {
        for (const l of lines) stdout.push(l + "\n");
        stdout.push(null);
    });
    return { proc, writes };
}

// claudecli requires the host-injected namespaced temp root (no os.tmpdir() fallback; c536ce29 S8B).
const scratchRoot = mkdtempSync(join(tmpdir(), "98f9da19-claudecli-"));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

function makeEngineConfig(subprocessEnv: Record<string, string> = {}): EngineConfig {
    return {
        wire: { tempDir: scratchRoot },
        server: { contextLimit: 0, defaultMaxTokens: 8192 },
        queue: { concurrency: 1 },
        sse: { baseUrl: "" },
        plugins: { entries: [] },
        getProviderConfig: () => ({}),
        subprocessEnv: () => subprocessEnv,
        resolveEnvName: (() => undefined) as unknown as EngineConfig["resolveEnvName"],
    } as unknown as EngineConfig;
}

const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const baseRequest: ProviderChatRequest = {
    messages: [{ role: "user", content: "Say OK" } as ProviderChatRequest["messages"][number]],
};

interface RunOpts {
    providerConfig?: Record<string, unknown>;
    compiledTools?: string[];
    subprocessEnv?: Record<string, string>;
    lines?: string[];
    request?: ProviderChatRequest;
}

async function run(opts: RunOpts = {}) {
    const { spawn } = await import("child_process");
    const { proc, writes } = makeFakeProc(opts.lines);
    const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;
    spawnMock.mockReset();
    spawnMock.mockReturnValue(proc);
    const { ClaudeCliProvider } = await import("../providers/claudecli.js");
    const provider = new ClaudeCliProvider(
        { type: "claudecli", model: "claude-haiku-4-5", ...(opts.providerConfig ?? {}) } as never,
        {},
        opts.compiledTools,
        makeEngineConfig(opts.subprocessEnv),
        logger,
    );
    await provider.chat(opts.request ?? baseRequest);
    const [, args, spawnOpts] = spawnMock.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    return { args, env: spawnOpts.env, writes };
}

const TRANSCRIPT_ENV = "ADHD_AGENT_CLAUDECLI_KEEP_SESSION_TRANSCRIPT";
const ENV_KEYS = ["CLAUDE_CODE_DISABLE_CLAUDE_MDS", "CLAUDE_CODE_DISABLE_AUTO_MEMORY", TRANSCRIPT_ENV, "CLAUDE_CODE_BUILTIN_TOOLS"];

let saved: Record<string, string | undefined>;
beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
    for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
});

describe("98f9da19 AC1 — strict, empty MCP config when no servers are declared", () => {
    it("98f9da19 AC1: argv has --strict-mcp-config and --mcp-config with the inline empty config", async () => {
        const { args } = await run();
        expect(args).toContain("--strict-mcp-config");
        const i = args.indexOf("--mcp-config");
        expect(i).toBeGreaterThanOrEqual(0);
        expect(args[i + 1]).toBe('{"mcpServers":{}}');
        expect(JSON.parse(args[i + 1]!)).toEqual({ mcpServers: {} });
    });
});

describe("98f9da19 AC2 — --tools allowlist", () => {
    it("98f9da19 AC2: --tools carries the effective allowed set comma-joined; no denylist / builtin-tools env", async () => {
        const { args, env } = await run({ compiledTools: ["Read", "Grep"] });
        const i = args.indexOf("--tools");
        expect(i).toBeGreaterThanOrEqual(0);
        expect(args[i + 1]).toBe("Read,Grep");
        expect(args).not.toContain("--disallowedTools");
        expect(env["CLAUDE_CODE_BUILTIN_TOOLS"]).toBeUndefined();
    });

    it("98f9da19 AC2: falls back to allowedBuiltinTools when no compiled tools", async () => {
        const { args } = await run({ providerConfig: { allowedBuiltinTools: ["Bash"] } });
        expect(args[args.indexOf("--tools") + 1]).toBe("Bash");
    });

    it("98f9da19 AC2: --tools \"\" (empty string) when nothing is allowed", async () => {
        const { args } = await run();
        const i = args.indexOf("--tools");
        expect(i).toBeGreaterThanOrEqual(0);
        expect(args[i + 1]).toBe("");
        expect(args).not.toContain("--disallowedTools");
    });

    it("98f9da19 AC2: --tools is not passed in systemPromptIsAgentSpec mode", async () => {
        const request: ProviderChatRequest = {
            messages: [
                { role: "system", content: "---\nname: spec-agent\ndescription: d\ntools: Read\n---\nBody" } as never,
                { role: "user", content: "go" } as never,
            ],
        };
        const { args } = await run({
            providerConfig: { systemPromptIsAgentSpec: true },
            compiledTools: ["Read"],
            request,
        });
        expect(args).toContain("--agent");
        expect(args).not.toContain("--tools");
        expect(args).not.toContain("--disallowedTools");
    });
});

describe("98f9da19 AC3 — session transcript persistence", () => {
    it("98f9da19 AC3: --no-session-persistence is the default", async () => {
        const { args } = await run();
        expect(args).toContain("--no-session-persistence");
    });

    it("98f9da19 AC3: keepSessionTranscript:true removes it", async () => {
        const { args } = await run({ providerConfig: { keepSessionTranscript: true } });
        expect(args).not.toContain("--no-session-persistence");
    });

    it("98f9da19 AC3: explicit keepSessionTranscript:false wins over env=1", async () => {
        process.env[TRANSCRIPT_ENV] = "1";
        const { args } = await run({ providerConfig: { keepSessionTranscript: false } });
        expect(args).toContain("--no-session-persistence");
    });

    it("98f9da19 AC3: ADHD_AGENT_CLAUDECLI_KEEP_SESSION_TRANSCRIPT=1 removes it", async () => {
        process.env[TRANSCRIPT_ENV] = "1";
        const { args } = await run();
        expect(args).not.toContain("--no-session-persistence");
    });

    it("98f9da19 AC3: other env values keep the default", async () => {
        process.env[TRANSCRIPT_ENV] = "0";
        const { args } = await run();
        expect(args).toContain("--no-session-persistence");
    });
});

describe("98f9da19 AC4 — only agent-declared mcp__ tool_use is answered by the loop", () => {
    const tools = [
        { name: "files__read_doc", description: "d", inputSchema: { type: "object" } },
        { name: "my-srv__do-it", description: "d", inputSchema: { type: "object" } },
    ] as unknown as ProviderChatRequest["tools"];

    async function drive(blocks: Array<{ id: string; name: string }>) {
        const executeTool = vi.fn(async () => ({ result: "tool-out", isError: false }));
        const { writes } = await run({
            lines: [assistantLine(blocks), RESULT_LINE],
            request: { ...baseRequest, tools, executeTool },
        });
        // writes[0] is the initial user prompt; the rest are synthetic tool_results.
        const toolResults = writes.slice(1).map((w) => JSON.parse(w));
        return { executeTool, toolResults };
    }

    it("98f9da19 AC4: declared mcp__ tool gets exactly one synthetic tool_result via executeTool", async () => {
        const { executeTool, toolResults } = await drive([{ id: "tu_1", name: "mcp__files__read_doc" }]);
        expect(executeTool).toHaveBeenCalledTimes(1);
        expect(executeTool).toHaveBeenCalledWith("files", "read_doc", {});
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].message.content[0]).toMatchObject({
            type: "tool_result", tool_use_id: "tu_1", is_error: false,
        });
    });

    it("98f9da19 AC4: declared tool matches after name normalisation (hyphens -> underscores)", async () => {
        const { executeTool, toolResults } = await drive([{ id: "tu_n", name: "mcp__my_srv__do_it" }]);
        expect(executeTool).toHaveBeenCalledTimes(1);
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].message.content[0].tool_use_id).toBe("tu_n");
    });

    it("98f9da19 AC4: built-in (Bash) and undeclared MCP tools produce no synthetic tool_result", async () => {
        const { executeTool, toolResults } = await drive([
            { id: "tu_bash", name: "Bash" },
            { id: "tu_other", name: "mcp__stranger__nuke" },
        ]);
        expect(executeTool).not.toHaveBeenCalled();
        expect(toolResults).toEqual([]);
    });

    it("98f9da19 AC4: mixed turn answers only the declared tool", async () => {
        const { executeTool, toolResults } = await drive([
            { id: "tu_bash", name: "Bash" },
            { id: "tu_ok", name: "mcp__files__read_doc" },
            { id: "tu_x", name: "mcp__stranger__nuke" },
        ]);
        expect(executeTool).toHaveBeenCalledTimes(1);
        expect(toolResults.map((r) => r.message.content[0].tool_use_id)).toEqual(["tu_ok"]);
    });

    it("98f9da19 AC4: isLoopExecutedToolUse unit contract", async () => {
        const { isLoopExecutedToolUse } = await import("../providers/claudecli.js");
        expect(isLoopExecutedToolUse("Bash", ["Bash"])).toBe(false);
        expect(isLoopExecutedToolUse("mcp__a__b", [])).toBe(false);
        expect(isLoopExecutedToolUse("mcp__a__b")).toBe(false);
        expect(isLoopExecutedToolUse("mcp__a__b", ["a__b"])).toBe(true);
        expect(isLoopExecutedToolUse("mcp__a_b__c_d", ["a-b__c-d"])).toBe(true);
    });
});

describe("98f9da19 AC5 — lean CLAUDE.md / auto-memory env", () => {
    it("98f9da19 AC5: both disable vars default to 1", async () => {
        const { env } = await run();
        expect(env["CLAUDE_CODE_DISABLE_CLAUDE_MDS"]).toBe("1");
        expect(env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"]).toBe("1");
    });

    it("98f9da19 AC5: explicit process.env value wins", async () => {
        process.env["CLAUDE_CODE_DISABLE_CLAUDE_MDS"] = "0";
        process.env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "0";
        const { env } = await run();
        expect(env["CLAUDE_CODE_DISABLE_CLAUDE_MDS"]).toBe("0");
        expect(env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"]).toBe("0");
    });

    it("98f9da19 AC5: explicit host subprocessEnv value wins", async () => {
        const { env } = await run({
            subprocessEnv: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "0", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" },
        });
        expect(env["CLAUDE_CODE_DISABLE_CLAUDE_MDS"]).toBe("0");
        expect(env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"]).toBe("0");
    });
});
