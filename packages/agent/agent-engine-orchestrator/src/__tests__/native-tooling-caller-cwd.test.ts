import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionStore, TaskStore } from "@adhd/agent-store-runtime";
import type { AgentDefinition, McpServerConfig } from "@adhd/agent-base-types";

import { StdioMcpClient } from "../clients/stdio-client.js";
import { taskTool } from "../tools/task.js";
import type { TaskDeps } from "../tools/task.js";
import type { AgentStore } from "../tools/agent-crud.js";
import { PolicyEngine } from "../engine/policy.js";
import { HookRegistry } from "../engine/hooks.js";
import { BackgroundQueue } from "../engine/queue.js";
import { DagEngine } from "../engine/dag-engine.js";
import { Orchestrator } from "../engine/orchestrator.js";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import type { ExecutionContext } from "../validation/index.js";
import { nowIso } from "../utils/timestamps.js";

/**
 * AC4 — the CALLER-SUPPLIED cwd threads from the `task` MCP input (or an
 * inherited parent cwd) into native-tooling resolution, and is carried on the
 * child ExecutionContext so a further sub-dispatch inherits it (ADR-0008 D4;
 * caller-cwd contract).
 *
 * The store is a faithful stand-in for the agent-mcp resolving wrapper: its
 * `read(name, cwd)` builds the fs root from the cwd it is HANDED. So the fs root
 * the child actually resolves PROVES which cwd `task.ts` threaded.
 *
 * REVERT-FAILING: dropping `input.cwd ?? callerContext?.cwd` from `task.ts`
 * (back to the bare `read(name)` / host `process.cwd()`) turns the /P, /Q and
 * inheritance assertions RED.
 */

vi.mock("openai", () => {
    class MockOpenAI {
        chat = {
            completions: {
                create: vi.fn(async () => ({
                    choices: [
                        {
                            message: { content: "done", tool_calls: undefined },
                            finish_reason: "stop",
                        },
                    ],
                    usage: undefined,
                })),
            },
        };
        constructor(_opts: unknown) {
            // no-op: real network client never constructed
        }
    }
    return { default: MockOpenAI };
});

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    agent_name TEXT NOT NULL,
    agent_version INTEGER NOT NULL,
    agent_data TEXT NOT NULL,
    status TEXT DEFAULT 'active' NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT,
    composed_prompt_id TEXT
);
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    tool_calls TEXT,
    tool_results TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT,
    parent_task_id TEXT,
    is_ephemeral INTEGER DEFAULT 0 NOT NULL,
    recursion_depth INTEGER DEFAULT 0 NOT NULL,
    status TEXT DEFAULT 'pending' NOT NULL,
    prompt TEXT NOT NULL,
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    cancelled_at TEXT,
    depends_on TEXT,
    on_upstream_failure TEXT,
    inputs TEXT,
    resume_token TEXT
);
CREATE TABLE IF NOT EXISTS task_events (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_usage (
    task_id TEXT PRIMARY KEY NOT NULL,
    root_task_id TEXT,
    agent_name TEXT NOT NULL,
    provider_type TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0 NOT NULL,
    output_tokens INTEGER DEFAULT 0 NOT NULL,
    tool_call_count INTEGER DEFAULT 0 NOT NULL,
    model_calls INTEGER DEFAULT 0 NOT NULL,
    latency_ms INTEGER DEFAULT 0 NOT NULL,
    is_complete INTEGER DEFAULT 0 NOT NULL,
    stop_reason TEXT,
    max_tokens INTEGER,
    cache_read_input_tokens INTEGER,
    cache_creation_input_tokens INTEGER,
    uncached_input_tokens INTEGER,
    reasoning_tokens INTEGER,
    peak_context_tokens INTEGER,
    peak_context_at INTEGER,
    compute_ms INTEGER,
    est_tool_result_tokens INTEGER,
    est_cost_usd REAL,
    created_at TEXT NOT NULL
);
`;

const declarative: AgentDefinition = {
    name: "cwd-agent",
    version: 1,
    provider: { type: "openai", model: "gpt-4o-mini" },
    systemPrompt: "test",
    mcpServers: {},
    permissions: {},
    nativeTooling: { fs: { roots: ["a", "b"] } },
    createdAt: nowIso(),
    updatedAt: nowIso(),
};

/**
 * The resolved fs root the store derives from whatever cwd it is handed.
 *
 * `undefined` is the host-fallback signal. The real host would anchor on
 * `process.cwd()` there; this stand-in must NOT, because `process.cwd()` is the
 * repo root and the resulting `npx -y @modelcontextprotocol/server-filesystem`
 * config is a REAL stdio server that `taskTool` would spawn (seconds, flaky
 * under load). The fallback contract under test is only "the resolver is handed
 * `undefined`", so the undefined branch resolves to NO servers: nothing spawns.
 */
function resolvedForCwd(cwd: string | undefined): AgentDefinition {
    if (cwd === undefined) {
        return { ...declarative, mcpServers: {} };
    }
    const anchor = cwd;
    const args = ["npx", "-y", "@modelcontextprotocol/server-filesystem", `${anchor}/a`, `${anchor}/b`];
    const fs: McpServerConfig = { transport: "stdio", command: "npx", args, cwd: anchor };
    return { ...declarative, mcpServers: { fs } };
}

function makeEngineConfig(): EngineConfig {
    return {
        server: { contextLimit: 0, defaultMaxTokens: 1024 },
        queue: { concurrency: 1 },
        sse: { baseUrl: "http://localhost:0" },
        plugins: { entries: [] },
        getProviderConfig: () => ({
            secret: "test-secret",
            baseURL: "http://localhost:0/v1",
            model: "gpt-4o-mini",
        }),
        subprocessEnv: () => ({}),
        resolveEnvName: (name: string) => name,
        isEnvNameAllowed: () => true,
    };
}

const silentLogger: EngineLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
};

interface Harness {
    deps: TaskDeps;
    readCwds: Array<string | undefined>;
    capturedContexts: ExecutionContext[];
}

function makeHarness(): Harness {
    const sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = drizzle(sqlite) as any;

    const taskStore = new TaskStore(db);
    const sessionStore = new SessionStore(db);

    // The host-resolving stand-in: record the cwd thread and resolve the fs root
    // from it. `readUnresolved` keeps the snapshot declarative (D4/D8).
    const readCwds: Array<string | undefined> = [];
    const agentStore: AgentStore = {
        create: () => declarative,
        read: (_name: string, cwd?: string) => {
            readCwds.push(cwd);
            return resolvedForCwd(cwd);
        },
        readUnresolved: () => declarative,
        update: () => declarative,
        delete: () => undefined,
        list: () => [declarative],
    };

    const policy = new PolicyEngine({ serverMaxDepth: 10, serverMaxToolLoops: 10 });
    const hooks = new HookRegistry();
    const queue = new BackgroundQueue(1, silentLogger);
    const dagEngine = new DagEngine(
        db,
        queue,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        taskStore as any,
        async () => undefined,
        silentLogger
    );

    const capturedContexts: ExecutionContext[] = [];
    hooks.register("task:start", (payload) => {
        capturedContexts.push(payload.executionContext as ExecutionContext);
    });

    const deps: TaskDeps = {
        agentStore,
        sessionStore,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        taskStore: taskStore as any,
        orchestrator: new Orchestrator(),
        queue,
        policy,
        hooks,
        selfUrl: undefined,
        inProcessDescriptors: [],
        inProcessHandler: async () => {
            throw new Error("no in-process tools in this test");
        },
        db,
        dagEngine,
        config: makeEngineConfig(),
        logger: silentLogger,
    };

    return { deps, readCwds, capturedContexts };
}

/** The fs allowed-dir args of the definition the child actually ran with. */
const fsArgsOf = (ctx: ExecutionContext): string[] => {
    const fs = ctx.agentDefinition.mcpServers["fs"] as Extract<McpServerConfig, { transport: "stdio" }>;
    return fs.args as string[];
};

describe("AC4 — caller-supplied cwd threads into native-tooling resolution (ADR-0008 D4)", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("task{cwd:'/P'} anchors /P — NOT the host process cwd — and is carried for sub-dispatch", async () => {
        const { deps, readCwds, capturedContexts } = makeHarness();

        await taskTool({ agent_name: "cwd-agent", prompt: "hi", cwd: "/P" }, deps);

        // The read was handed the caller cwd (not undefined ⇒ not host fallback).
        expect(readCwds).toEqual(["/P"]);
        expect(readCwds[0]).not.toBe(process.cwd());
        // The child resolved its roots against /P...
        expect(capturedContexts).toHaveLength(1);
        expect(fsArgsOf(capturedContexts[0])).toEqual([
            "npx",
            "-y",
            "@modelcontextprotocol/server-filesystem",
            "/P/a",
            "/P/b",
        ]);
        // ...and the cwd is carried on the ExecutionContext for a further dispatch.
        expect(capturedContexts[0].cwd).toBe("/P");
    });

    it("a parent sub-dispatch carries the PARENT cwd to the child (no cwd on the child call)", async () => {
        const { deps, readCwds, capturedContexts } = makeHarness();
        const parentContext = { cwd: "/Q" } as ExecutionContext;

        await taskTool({ agent_name: "cwd-agent", prompt: "hi" }, deps, parentContext);

        // Inherited from the parent — the child call supplied none of its own.
        expect(readCwds).toEqual(["/Q"]);
        expect(capturedContexts[0].cwd).toBe("/Q");
    });

    it("a caller cwd WINS over the inherited parent cwd", async () => {
        const { deps, readCwds } = makeHarness();
        const parentContext = { cwd: "/Q" } as ExecutionContext;

        await taskTool({ agent_name: "cwd-agent", prompt: "hi", cwd: "/P" }, deps, parentContext);

        expect(readCwds).toEqual(["/P"]);
    });

    it("no caller cwd and no parent ⇒ read receives undefined (host fallback, flagged upstream)", async () => {
        const { deps, readCwds, capturedContexts } = makeHarness();
        // 5dfb3e14 AC1: spy (pass-through) on the real stdio spawn seam.
        const connectSpy = vi.spyOn(StdioMcpClient.prototype, "connect");

        await taskTool({ agent_name: "cwd-agent", prompt: "hi" }, deps);

        // 5dfb3e14 AC1: no child process is spawned — the registry was
        // handed zero stdio servers and no stdio client ever connected.
        expect(capturedContexts).toHaveLength(1);
        expect(Object.values(capturedContexts[0].agentDefinition.mcpServers)).toEqual([]);
        expect(connectSpy).not.toHaveBeenCalled();

        // `undefined` is the signal the host turns into a flagged `process.cwd()`
        // fallback (ADR-0008 D4) — the resolver never receives a fabricated cwd.
        expect(readCwds).toEqual([undefined]);
    });
});
