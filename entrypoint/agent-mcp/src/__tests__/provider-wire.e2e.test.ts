/**
 * c536ce29 P1 (provider / MCP-client egress through EngineConfig.wire) - e2e lane. ONE scaffold:
 * real channels over a temp dir, a loopback-only `globalThis.fetch` guard (any non-loopback host
 * fails the suite loudly), the PRODUCTION wiring (`toEngineConfig()` + the process-wide wire seams).
 *
 *   TRC-AC5   the real ClaudeCliProvider spawning a real child (the fake-claude stand-in) writes
 *             spawn.start / stdin / stdout / exit / close; env VALUES never reach the log
 *   TRC-AC6   the engine's real stdio MCP client against a real MCP server child writes
 *             mcp.send / mcp.recv
 *   TRC-AC9   a spawn failure (ENOENT) is logged as spawn.error and rethrown by the provider
 *   P1-AC-A   a failing model call in the real `task` tool path, through createServer + the real
 *             orchestrator + the loaded default tracing plugin (only the provider boundary is a
 *             loopback server), emits provider:failed and closes agent.model_call as an error
 *
 * No env gate: nothing here calls a paid third-party service.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createProvider, StdioMcpClient, type EngineLogger } from "@adhd/agent-engine-orchestrator";
import type { AgentCreateInput } from "@adhd/agent-engine-orchestrator";

import { defaultPluginEntries, toEngineConfig } from "../config.js";
import { loadDefaultPlugins } from "../plugins/load-defaults.js";
import { createServer } from "../server.js";
import { createWireSeams } from "../wire/seams.js";
import { buildHarness, type Harness } from "./integration/harness.js";
import {
    installChannels,
    makeGuardFetch,
    REAL_FETCH,
    startLoopback,
    type IChannelFixture,
    type Rec,
} from "./provider-wire-utils.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, "../../../../packages/agent/agent-engine-orchestrator/src/__tests__/fixtures");
const FAKE_CLAUDE = path.join(FIXTURES, "fake-claude.mjs");
const ECHO_SERVER = path.join(FIXTURES, "verify-echo-server.mjs");
const TMP_ROOT = path.resolve(here, "../../../../tmp/agent-mcp");

const SECRET_ENV = "ADHD_AGENT_P1E2E_SECRET"; // env var NAME, not a credential  pragma: allowlist secret
const ENV_CANARY = ["p1e2e", "ENVVALUEcanary0123456789"].join("-");
const log: EngineLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const messages = [{ id: "m1", sessionId: "s1", role: "user" as const, content: "ping", createdAt: new Date().toISOString() }];
const silentLogger = log;

const leaks: string[] = [];
let ch: IChannelFixture | undefined;
const saved: Record<string, string | undefined> = {};
const setEnv = (k: string, v: string | undefined): void => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
};

beforeAll(() => {
    globalThis.fetch = makeGuardFetch(leaks);
});
afterAll(() => {
    globalThis.fetch = REAL_FETCH;
});
beforeEach(() => {
    setEnv(SECRET_ENV, ["sk-", "p1e2e", "OPENAIcanary0123456789"].join(""));
    setEnv("ADHD_AGENT_P1E2E_TOKEN", ENV_CANARY); // a credential-named var => registered with the redactor
    ch = installChannels();
});
afterEach(async () => {
    await ch?.dispose();
    ch = undefined;
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
        delete saved[k];
    }
    expect(leaks, "a request left loopback").toEqual([]);
});

const events = (recs: Rec[], ...names: string[]): Rec[] => recs.filter((r) => names.includes(r.event));
const prodConfig = () => ({ ...toEngineConfig(), wire: createWireSeams() });

describe("c536ce29 P1 provider wire (e2e)", () => {
    it("c536ce29 TRC-AC5: the claudecli provider's real child is traced start-to-close; env values never reach disk", async () => {
        // An executable copy in a scratch dir: the tracked fixture is not +x and must stay untouched.
        fs.mkdirSync(TMP_ROOT, { recursive: true });
        const scratch = fs.mkdtempSync(path.join(TMP_ROOT, "p1-claude-"));
        const exe = path.join(scratch, "fake-claude.mjs");
        fs.copyFileSync(FAKE_CLAUDE, exe);
        fs.chmodSync(exe, 0o755);
        const provider = createProvider(
            { providerType: "claudecli", modelRef: "claude-haiku-4-5" },
            // fake-claude reads the --mcp-config FILE the provider writes, so give it one stdio entry
            // (it launches the entry like Claude Code would; `node -e 0` exits at once).
            { probe: { transport: "stdio", command: process.execPath, args: ["-e", "0"] } },
            prodConfig(),
            log,
            { claudecli: { claudePath: exe } }
        );
        let out;
        try {
            out = await provider.chat({ messages });
        } finally {
            fs.rmSync(scratch, { recursive: true, force: true });
        }
        expect(out.message.content).toBe("OK");

        // exit/close land after chat() resolves: wait (bounded, event-yielding) for the close record.
        const deadline = Date.now() + 10_000;
        let recs = await ch!.records();
        while (!recs.some((r) => r.event === "spawn.close") && Date.now() < deadline) {
            await new Promise<void>((r) => setImmediate(r));
            recs = await ch!.records();
        }
        const start = events(recs, "spawn.start")[0]!;
        expect(start.command).toBe(exe);
        expect(Object.keys(start), "spawn.start keys").toEqual(expect.arrayContaining(["command", "args", "pid"]));
        expect(JSON.stringify(start), "env var NAMES are listed").toContain("ADHD_AGENT_P1E2E_TOKEN");
        const kinds = new Set(recs.map((r) => r.event));
        for (const k of ["spawn.start", "spawn.stdin", "spawn.stdout", "spawn.exit", "spawn.close"]) expect(kinds.has(k), k).toBe(true);
        expect(events(recs, "spawn.exit")[0]!.code).toBe(0);
        const stdout = events(recs, "spawn.stdout").map((r) => String(r.body)).join("");
        expect(stdout).toContain('"type":"result"');
        expect(events(recs, "spawn.stdin")[0]!.body).toBeTruthy();
        expect(await ch!.rawText()).not.toContain(ENV_CANARY);
    }, 30_000);

    it("c536ce29 TRC-AC9: a spawn failure is logged as spawn.error and the provider rejects", async () => {
        const provider = createProvider(
            { providerType: "claudecli", modelRef: "claude-haiku-4-5" },
            {},
            prodConfig(),
            log,
            { claudecli: { claudePath: path.join(here, "no-such-claude-binary-p1") } }
        );
        await expect(provider.chat({ messages })).rejects.toBeDefined();
        const errs = events(await ch!.records(), "spawn.error");
        expect(errs).toHaveLength(1);
        expect(errs[0]!.error_code).toBe("ENOENT");
    }, 30_000);

    it("c536ce29 TRC-AC6: the engine's stdio MCP client against a real server child writes mcp.send/mcp.recv", async () => {
        const client = new StdioMcpClient(
            "p1-stdio",
            { transport: "stdio", command: process.execPath, args: [ECHO_SERVER] } as never,
            prodConfig(),
            log
        );
        try {
            await client.connect();
            expect((await client.listTools()).map((t) => t.name)).toContain("echo");
            expect(await client.callTool("echo", { text: "hello-stdio-p1" })).toEqual([{ type: "text", text: "hello-stdio-p1" }]);
        } finally {
            await client.close();
        }
        const mcp = events(await ch!.records(), "mcp.send", "mcp.recv");
        expect(mcp.filter((r) => r.event === "mcp.send").map((r) => r.method)).toEqual(
            expect.arrayContaining(["initialize", "tools/list", "tools/call"])
        );
        expect(mcp.some((r) => r.event === "mcp.recv" && String(r.body).includes("hello-stdio-p1"))).toBe(true);
        expect(mcp.every((r) => r.server === "p1-stdio" && r.transport === "stdio")).toBe(true);
    }, 30_000);
});

describe("c536ce29 P1-AC-A: provider:failed is live in the production task path", () => {
    let root: string;
    let harness: Harness;
    let mcp: Client;

    beforeAll(async () => {
        fs.mkdirSync(TMP_ROOT, { recursive: true });
        root = fs.mkdtempSync(path.join(TMP_ROOT, "p1-ac-a-"));
        harness = await buildHarness();
        await loadDefaultPlugins(harness.hooks, harness.db, silentLogger, {
            configPath: path.join(root, "no-such-config.json"),
            defaultEntries: defaultPluginEntries({} as NodeJS.ProcessEnv, {
                service: "agent-mcp-p1",
                logSink: "file",
                logDir: path.join(root, "sink"),
                captureArgs: false,
            }),
        });
        const server = createServer({
            agentStore: harness.agentStore,
            sessionStore: harness.sessionStore,
            taskStore: harness.taskStore,
            queue: harness.queue,
            policy: harness.policy,
            orchestrator: harness.orchestrator,
            hooks: harness.hooks,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            db: harness.db as any,
            dagEngine: harness.dagEngine,
        });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await server.connect(st);
        mcp = new Client({ name: "p1-ac-a", version: "0.0.1" }, { capabilities: {} });
        await mcp.connect(ct);
    }, 60_000);
    afterAll(async () => {
        await mcp?.close().catch(() => undefined);
        await harness?.teardown();
        fs.rmSync(root, { recursive: true, force: true });
    });

    const sinkRecords = (): Rec[] => {
        const dir = path.join(root, "sink");
        if (!fs.existsSync(dir)) return [];
        const out: Rec[] = [];
        const walk = (d: string): void => {
            for (const n of fs.readdirSync(d)) {
                const f = path.join(d, n);
                if (fs.statSync(f).isDirectory()) walk(f);
                else if (n.endsWith(".jsonl")) {
                    for (const line of fs.readFileSync(f, "utf8").split("\n")) if (line.trim()) out.push(JSON.parse(line) as Rec);
                }
            }
        };
        walk(dir);
        return out;
    };

    it("c536ce29 P1-AC-A: a 400 from the model emits provider:failed and closes agent.model_call as an error", async () => {
        const failures: Array<{ taskId?: string; failureClass?: string; status?: number }> = [];
        harness.hooks.register("provider:failed", (p) => {
            failures.push({ taskId: p.executionContext?.taskId, failureClass: p.failure.class, status: p.failure.status });
        });
        const upstream = await startLoopback((_q, res) => {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "bad request p1-ac-a", type: "invalid_request_error" } }));
        });
        try {
            const name = `p1-agent-${crypto.randomUUID()}`;
            harness.agentStore.create({
                name,
                provider: { type: "openai", model: "p1-model", baseURL: `${upstream.origin}/v1`, env: { secret: SECRET_ENV } },
                systemPrompt: "x",
                mcpServers: {},
                permissions: {},
                // No adopted fs/shell servers: they are npx/uvx third-party children and not under test.
                nativeTooling: { fs: false, shell: false, hitl: false },
            } as unknown as AgentCreateInput);
            const sessionId = harness.sessionStore.create({ agentName: name, agentDefinition: harness.agentStore.read(name) }).id;
            const res = (await mcp.callTool({ name: "task", arguments: { session_id: sessionId, prompt: "go", background: false } })) as {
                isError?: boolean;
                content?: Array<{ text?: string }>;
            };
            expect(res.isError === true || /fail|error/i.test(res.content?.[0]?.text ?? "")).toBe(true);
            expect(upstream.seen).toHaveLength(1); // the real provider reached the loopback boundary once (no retry on 400)

            expect(failures).toHaveLength(1);
            expect(failures[0]!.status).toBe(400);
            const taskId = failures[0]!.taskId!;
            const deadline = Date.now() + 10_000;
            let recs = sinkRecords();
            const closedAsError = (r: Rec[]): boolean =>
                r.some((x) => x.event.startsWith("agent.model_call") && x["agent.task_id"] === taskId && x["agent.outcome"] === "error");
            while (!closedAsError(recs) && Date.now() < deadline) {
                await new Promise<void>((r) => setImmediate(r));
                recs = sinkRecords();
            }
            expect(closedAsError(recs), `model_call error record (have ${[...new Set(recs.map((r) => r.event))].join(", ")})`).toBe(true);
            // The raw wire shows the same 400 the provider saw.
            const wire = events(await ch!.records(), "http.response");
            expect(wire.map((r) => r.status)).toEqual([400]);
        } finally {
            await upstream.close();
        }
    }, 60_000);
});
