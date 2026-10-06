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
 * Regression test for the ephemeral-task session-id bug: `runEphemeralTask`
 * (packages/agent/agent-engine-orchestrator/src/tools/task.ts) generated a real
 * `ephemeralSessionId` and used it for the in-memory ExecutionContext and every
 * message, but persisted `sessionId: null` to the `tasks` table instead of that
 * generated id. Verified live in production data: 11/18 tasks had
 * `session_id IS NULL`, correlating 100% with `is_ephemeral = 1`.
 *
 * This test drives the REAL orchestrator + REAL TaskStore + REAL (in-memory)
 * sqlite through the actual `agent_name` (ephemeral) branch of `taskTool` —
 * exactly the path the `agent` MCP tool takes. The only mocked boundary is the
 * external LLM provider SDK (`openai`), per repo policy (mock only the
 * external LLM/provider boundary, never the thing under test).
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

function makeTestAgentDefinition(): AgentDefinition {
    return {
        name: "ephemeral-test-agent",
        version: 1,
        provider: { type: "openai", model: "gpt-4o-mini" },
        systemPrompt: "You are a test agent.",
        mcpServers: {},
        permissions: {},
        createdAt: nowIso(),
        updatedAt: nowIso(),
    };
}

function makeStubAgentStore(agentDefinition: AgentDefinition): AgentStore {
    return {
        create: () => agentDefinition,
        read: (name: string) => {
            if (name !== agentDefinition.name) {
                throw new Error(`unexpected agent name in test stub: ${name}`);
            }
            return agentDefinition;
        },
        update: () => agentDefinition,
        delete: () => {
            /* no-op: not used on the ephemeral path */
        },
        list: () => [agentDefinition],
    };
}

function makeEngineConfig(): EngineConfig {
    return {
        server: { contextLimit: 0, defaultMaxTokens: 1024 },
        queue: { concurrency: 1 },
        sse: { baseUrl: "http://localhost:0" },
        plugins: { entries: [] },
        getProviderConfig: () => ({ secret: "test-secret", baseURL: "http://localhost:0/v1", model: "gpt-4o-mini" }),
        subprocessEnv: () => ({}),
        isEnvNameAllowed: () => true,
    };
}

const silentLogger: EngineLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
};

function makeDeps(): {
    deps: TaskDeps;
    taskStore: TaskStore;
    sessionStore: SessionStore;
    capturedSessionIds: string[];
} {
    const sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = drizzle(sqlite) as any;

    const taskStore = new TaskStore(db);
    const agentDefinition = makeTestAgentDefinition();
    const agentStore = makeStubAgentStore(agentDefinition);
    // REAL session store (ADR-0008 D6, sessioned-everything): the one-shot
    // `agent_name` path creates a real session row, so the store must be real
    // — the retired noop-session stub is gone.
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
            /* no-op: not exercised on the ephemeral path */
        },
        silentLogger
    );
    const config = makeEngineConfig();

    // Capture the exact sessionId the real orchestrator used for the execution
    // context, independent of what ends up persisted — proves the persisted
    // value (asserted below via a fresh DB read) matches the value actually
    // used to run the task, not just "is non-null".
    const capturedSessionIds: string[] = [];
    hooks.register("task:start", (payload) => {
        capturedSessionIds.push(payload.executionContext.sessionId);
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

    return { deps, taskStore, sessionStore, capturedSessionIds };
}

describe("runEphemeralTask — session id persistence (BUG: ephemeral tasks lost session_id)", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("persists the exact ephemeral sessionId used by the execution context, not null", async () => {
        const { deps, taskStore, sessionStore, capturedSessionIds } = makeDeps();

        const result = await taskTool(
            { agent_name: "ephemeral-test-agent", prompt: "hello from a real ephemeral task" },
            deps
        );

        // Sanity: the real orchestrator actually ran the (mocked-LLM-boundary) task
        // to completion — this is not a short-circuited/mocked orchestrator.
        expect(result.status).toBe("completed");
        expect(result.result).toBe("ephemeral task completed");

        // The real orchestrator emitted task:start with a real generated sessionId.
        expect(capturedSessionIds).toHaveLength(1);
        const [usedSessionId] = capturedSessionIds;
        expect(typeof usedSessionId).toBe("string");
        expect(usedSessionId.length).toBeGreaterThan(0);

        // Re-read the task from the REAL sqlite store (not the in-memory result) —
        // this is the exact assertion that fails against the pre-fix code, which
        // unconditionally persisted `sessionId: null` for every ephemeral task.
        const persistedTask = taskStore.read(result.task_id);

        expect(persistedTask.isEphemeral).toBe(true);
        expect(persistedTask.sessionId).toBeDefined();
        expect(persistedTask.sessionId).not.toBeNull();
        expect(persistedTask.sessionId).toBe(usedSessionId);

        // ADR-0008 D6 — sessioned-everything: the one-shot task's session is a
        // REAL persisted row (not the retired noop placeholder). Retention
        // `ephemeral` reclaims it on terminal, so it is closed (not absent).
        const reclaimed = sessionStore.read(usedSessionId);
        expect(reclaimed.agentName).toBe("ephemeral-test-agent");
        expect(reclaimed.status).toBe("closed");
    });
});
