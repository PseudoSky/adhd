import { mkdtempSync, readFileSync, rmSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import type { ProviderChatRequest } from "../providers/types.js";

/**
 * 9ed453c1 BRIDGE — pure/unit twins of the claudecli bridge proofs (no subprocess, no bound port;
 * `child_process.spawn` and `startToolBridge` are mocked). The bound-port / real-process proofs are
 * in claudecli-tool-bridge.e2e.test.ts.
 */

vi.mock("child_process", () => ({ spawn: vi.fn() }));
const startToolBridge = vi.fn();
vi.mock("../providers/claudecli-tool-bridge.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../providers/claudecli-tool-bridge.js")>()),
    startToolBridge: (...a: unknown[]) => startToolBridge(...a),
}));

const scratchRoot = mkdtempSync(join(tmpdir(), "9ed453c1-bridge-cfg-"));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const engine = {
    wire: { tempDir: scratchRoot },
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    queue: { concurrency: 1 }, sse: { baseUrl: "" }, plugins: { entries: [] },
    getProviderConfig: () => ({}), subprocessEnv: () => ({}),
    resolveEnvName: (() => undefined) as unknown as EngineConfig["resolveEnvName"],
} as unknown as EngineConfig;

const RESULT = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK", num_turns: 1 });

async function spawnedArgs(request: ProviderChatRequest, readConfigDuring = false) {
    const { spawn } = await import("child_process");
    const stdout = new Readable({ read() {} });
    const proc = {
        stdout, stderr: new Readable({ read() {} }), pid: undefined, on: () => {}, kill: () => {},
        stdin: { write: () => true, end: () => {} }, exitCode: 0 as number | null, killed: false,
    };
    let configSeen: { path: string; body: string; mode: number } | undefined;
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReset();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation((_c: string, args: string[]) => {
        const p = args[args.indexOf("--mcp-config") + 1]!;
        if (readConfigDuring && !p.startsWith("{")) {
            configSeen = { path: p, body: readFileSync(p, "utf8"), mode: statSync(p).mode & 0o777 };
        }
        queueMicrotask(() => { stdout.push(RESULT + "\n"); stdout.push(null); });
        return proc;
    });
    const { ClaudeCliProvider } = await import("../providers/claudecli.js");
    const provider = new ClaudeCliProvider({ type: "claudecli", model: "claude-haiku-4-5" } as never, {
        // A real server entry that MUST NOT reach claude any more.
        counter: { transport: "stdio", command: "node", args: ["srv.mjs"], env: { SECRET: "s3cr3t" } },
    } as never, undefined, engine, logger);
    const res = await provider.chat(request);
    const calls = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    return { res, args: calls.length ? (calls[0]![1] as string[]) : undefined, configSeen };
}

const tools = [
    { name: "counter__bump", description: "d", inputSchema: { type: "object" } },
    { name: "other__x", description: "d", inputSchema: { type: "object" } },
] as NonNullable<ProviderChatRequest["tools"]>;
const msgs = [{ role: "user", content: "go" }] as unknown as ProviderChatRequest["messages"];

beforeEach(() => startToolBridge.mockReset());

describe("9ed453c1 BRIDGE AC-9 — config hygiene", () => {
    it("9ed453c1 BRIDGE AC-9: --mcp-config is a 0600 file with only bridge http entries (no stdio command, no server env)", async () => {
        const close = vi.fn(async () => {});
        startToolBridge.mockResolvedValue({ baseUrl: "http://127.0.0.1:4242", token: "tok123", serverNames: ["counter", "other"], calls: () => 0, close });
        const { args, configSeen } = await spawnedArgs({ messages: msgs, tools, executeTool: async () => ({ result: "", isError: false }) }, true);
        expect(args).toContain("--strict-mcp-config");
        expect(configSeen).toBeDefined();
        expect(configSeen!.mode).toBe(0o600);
        const cfg = JSON.parse(configSeen!.body) as { mcpServers: Record<string, Record<string, unknown>> };
        expect(cfg).toEqual({
            mcpServers: {
                counter: { type: "http", url: "http://127.0.0.1:4242/mcp/counter", headers: { Authorization: "Bearer tok123" } },
                other: { type: "http", url: "http://127.0.0.1:4242/mcp/other", headers: { Authorization: "Bearer tok123" } },
            },
        });
        expect(configSeen!.body).not.toContain("s3cr3t");
        expect(configSeen!.body).not.toContain("srv.mjs");
        expect(close).toHaveBeenCalledTimes(1);
        // temp file is removed after the turn (best-effort unlink is async)
        await vi.waitFor(() => expect(readdirSync(scratchRoot).filter((f) => f.endsWith(".json"))).toEqual([]));
    });

    it("9ed453c1 BRIDGE AC-9: no advertised tools => inline empty config, no bridge started", async () => {
        const { args } = await spawnedArgs({ messages: msgs });
        expect(args![args!.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
        expect(startToolBridge).not.toHaveBeenCalled();
    });

    it("9ed453c1 BRIDGE AC-9: buildBridgeMcpConfig url-encodes server names and emits one entry per server", async () => {
        const { buildBridgeMcpConfig } = await import("../providers/claudecli-tool-bridge.js");
        const cfg = buildBridgeMcpConfig({ baseUrl: "http://127.0.0.1:9", token: "t", serverNames: ["a b", "c-d"] });
        expect(Object.keys(cfg.mcpServers)).toEqual(["a b", "c-d"]);
        expect(cfg.mcpServers["a b"]!.url).toBe("http://127.0.0.1:9/mcp/a%20b");
    });
});

describe("9ed453c1 BRIDGE AC-6 — grouping", () => {
    it("9ed453c1 BRIDGE AC-6: groupToolsByServer splits server__tool and keeps original tool names", async () => {
        const { groupToolsByServer } = await import("../providers/claudecli-tool-bridge.js");
        const g = groupToolsByServer([
            { name: "my-srv__do-it", description: "d", inputSchema: {} },
            { name: "my-srv__other", description: "d", inputSchema: {} },
            { name: "b__t", description: "d", inputSchema: {} },
        ]);
        expect([...g.keys()]).toEqual(["my-srv", "b"]);
        expect([...g.get("my-srv")!.keys()]).toEqual(["do-it", "other"]);
    });
});

describe("9ed453c1 BRIDGE AC-10 — fail loud", () => {
    it("9ed453c1 BRIDGE AC-10: tools advertised without executeTool => PROVIDER_ERROR, nothing spawned, no bridge", async () => {
        const { spawn } = await import("child_process");
        (spawn as unknown as ReturnType<typeof vi.fn>).mockReset();
        const { ClaudeCliProvider } = await import("../providers/claudecli.js");
        const provider = new ClaudeCliProvider({ type: "claudecli", model: "m" } as never, {}, undefined, engine, logger);
        await expect(provider.chat({ messages: msgs, tools })).rejects.toThrow(/^PROVIDER_ERROR: .*executeTool/);
        expect(spawn).not.toHaveBeenCalled();
        expect(startToolBridge).not.toHaveBeenCalled();
    });
});

describe("9ed453c1 BRIDGE AC-8 — bridge closed in finally", () => {
    it("9ed453c1 BRIDGE AC-8: the bridge is closed even when the turn fails", async () => {
        const close = vi.fn(async () => {});
        startToolBridge.mockResolvedValue({ baseUrl: "http://127.0.0.1:1", token: "t", serverNames: ["counter"], calls: () => 0, close });
        const { spawn } = await import("child_process");
        (spawn as unknown as ReturnType<typeof vi.fn>).mockReset();
        (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error("spawn exploded"); });
        const { ClaudeCliProvider } = await import("../providers/claudecli.js");
        const provider = new ClaudeCliProvider({ type: "claudecli", model: "m" } as never, {}, undefined, engine, logger);
        await expect(
            provider.chat({ messages: msgs, tools, executeTool: async () => ({ result: "", isError: false }) })
        ).rejects.toThrow(/spawn exploded/);
        expect(close).toHaveBeenCalledTimes(1);
    });
});

describe("9ed453c1 BRIDGE — engine builtin pseudo-tools are not bridged", () => {
    it("9ed453c1 BRIDGE AC-6: builtin__request_human_input alone => no bridge, no fail-loud, inline empty config", async () => {
        const builtinOnly = [
            { name: "builtin__request_human_input", description: "d", inputSchema: { type: "object" } },
        ] as NonNullable<ProviderChatRequest["tools"]>;
        const { args } = await spawnedArgs({ messages: msgs, tools: builtinOnly });
        expect(startToolBridge).not.toHaveBeenCalled();
        expect(args![args!.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    });

    it("9ed453c1 BRIDGE AC-6: bridgeableTools keeps MCP-server tools and drops builtin__*", async () => {
        const { bridgeableTools } = await import("../providers/claudecli-tool-bridge.js");
        expect(bridgeableTools([...tools, { name: "builtin__request_human_input", description: "d", inputSchema: {} }]).map((t) => t.name))
            .toEqual(["counter__bump", "other__x"]);
    });
});
