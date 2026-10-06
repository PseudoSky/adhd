import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionStore, TaskStore } from "@adhd/agent-store-runtime";
import type { AgentDefinition } from "@adhd/agent-base-types";

import { taskTool } from "../tools/task.js";
import type { TaskDeps } from "../tools/task.js";
import type { AgentStore } from "../tools/agent-crud.js";
import { PolicyEngine } from "../engine/policy.js";
import { HookRegistry } from "../engine/hooks.js";
import { BackgroundQueue } from "../engine/queue.js";
import { DagEngine } from "../engine/dag-engine.js";
import { Orchestrator } from "../engine/orchestrator.js";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { nowIso } from "../utils/timestamps.js";

/**
 * FIX B1 (dispatch-2026-10-04-9c4e static-review bucket B) — the one-shot
 * (`agent_name`) path must snapshot the DECLARATIVE definition into the session
 * (`sessions.agent_data`), never the task-time RESOLVED one.
 *
 * The host injects an `agentStore` whose `read` resolves the native toolset
 * against the dispatching cwd (ADR-0008 D4). If `task.ts` persisted that resolved
 * definition, an fs/shell root fixed at `/P` would be frozen into the session and
 * would WIN over the `/Q` resolution on reuse (`withDefaultMcpServers` gives an
 * explicit `mcpServers` entry precedence) — defeating portability.
 *
 * This drives the REAL `taskTool` one-shot branch + REAL sqlite through the real
 * orchestrator (only the external LLM SDK is mocked, per repo policy) and asserts
 * the stored snapshot carries no resolved root while the RESOLVED definition is
 * still what actually runs. The negative control builds the same deps with a
 * store lacking `readUnresolved` — proving the fix is load-bearing.
 */

vi.mock("openai", () => {
    class MockOpenAI {
        chat = {
            completions: {
                create: vi.fn(async () => ({
                    choices: [
                        {
                            message: { content: "ephemeral task completed", tool_calls: undefined },
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
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS idx_task_usage_root_task_id ON task_usage (root_task_id);
`;

/** The DECLARATIVE definition a host stores (no resolved root; ADR-0008 D4/D8). */
function declarativeDefinition(): AgentDefinition {
    return {
        name: "snapshot-agent",
        version: 1,
        provider: { type: "openai", model: "gpt-4o-mini" },
        systemPrompt: "You are a test agent.",
        mcpServers: {},
        permissions: {},
        nativeTooling: { fs: true, shell: true },
        createdAt: nowIso(),
        updatedAt: nowIso(),
    };
}

/** The same definition as a resolving host's `read` returns it — rooted at `/P`. */
function resolvedDefinition(declarative: AgentDefinition): AgentDefinition {
    return {
        ...declarative,
        mcpServers: {
            fs: {
                transport: "stdio",
                command: "srt",
                args: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/P"],
                cwd: "/P",
            },
        },
    };
}

function makeStubAgentStore(
    resolved: AgentDefinition,
    declarative: AgentDefinition,
    withUnresolved: boolean
): AgentStore {
    const base: AgentStore = {
        create: () => resolved,
        read: (name: string) => {
            if (name !== resolved.name) {
                throw new Error(`unexpected agent name in test stub: ${name}`);
            }
            return resolved;
        },
        update: () => resolved,
        delete: () => {
            /* no-op: not used on the ephemeral path */
        },
        list: () => [resolved],
    };
    return withUnresolved ? { ...base, readUnresolved: () => declarative } : base;
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
    taskStore: TaskStore;
    sessionStore: SessionStore;
    capturedContexts: Array<{ agentDefinition: AgentDefinition }>;
}

function makeHarness(opts: { withUnresolved: boolean }): Harness {
    const sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = drizzle(sqlite) as any;

    const taskStore = new TaskStore(db);
    const declarative = declarativeDefinition();
    const resolved = resolvedDefinition(declarative);
    const agentStore = makeStubAgentStore(resolved, declarative, opts.withUnresolved);
    const sessionStore = new SessionStore(db);
    const policy = new PolicyEngine({ serverMaxDepth: 10, serverMaxToolLoops: 10 });
    const hooks = new HookRegistry();
    const queue = new BackgroundQueue(1, silentLogger);
    const dagEngine = new DagEngine(
        db,
        queue,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        taskStore as any,
        async () => {
            /* no-op */
        },
        silentLogger
    );
    const config = makeEngineConfig();

    const capturedContexts: Array<{ agentDefinition: AgentDefinition }> = [];
    hooks.register("task:start", (payload) => {
        capturedContexts.push({
            agentDefinition: payload.executionContext.agentDefinition as AgentDefinition,
        });
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
            throw new Error("no in-process tools registered in this test");
        },
        db,
        dagEngine,
        config,
        logger: silentLogger,
    };

    return { deps, taskStore, sessionStore, capturedContexts };
}

describe("runEphemeralTask — the session snapshot is DECLARATIVE (B1, ADR-0008 D4/D8)", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("persists the UNRESOLVED definition (no resolved root) while the RESOLVED one runs", async () => {
        const { deps, taskStore, sessionStore, capturedContexts } = makeHarness({
            withUnresolved: true,
        });

        const result = await taskTool(
            { agent_name: "snapshot-agent", prompt: "hello" },
            deps
        );
        expect(result.status).toBe("completed");

        // The RESOLVED definition (rooted at /P) is what actually executed — the
        // fix keeps the resolved read for provider + execution context.
        expect(capturedContexts).toHaveLength(1);
        expect(
            JSON.stringify(capturedContexts[0].agentDefinition.mcpServers)
        ).toContain("/P");

        // The session row carries the DECLARATIVE definition: no resolved root.
        const persisted = taskStore.read(result.task_id);
        const sid = persisted.sessionId;
        expect(sid).toBeDefined();

        const stored = sessionStore.getAgentDefinition(sid as string) as AgentDefinition;
        expect(JSON.stringify(stored)).not.toContain("/P");
        expect(stored.mcpServers).toEqual({});
        expect(stored.nativeTooling).toEqual({ fs: true, shell: true });
    });

    it("NEGATIVE CONTROL: without readUnresolved the snapshot IS the resolved definition (frozen /P)", async () => {
        const { deps, taskStore, sessionStore } = makeHarness({ withUnresolved: false });

        const result = await taskTool(
            { agent_name: "snapshot-agent", prompt: "hello" },
            deps
        );
        expect(result.status).toBe("completed");

        const sid = taskStore.read(result.task_id).sessionId as string;
        const stored = sessionStore.getAgentDefinition(sid) as AgentDefinition;
        // Reproduces the pre-fix bug: the resolved root is frozen into the session.
        expect(JSON.stringify(stored)).toContain("/P");
        expect(stored.mcpServers).toHaveProperty("fs");
    });
});
