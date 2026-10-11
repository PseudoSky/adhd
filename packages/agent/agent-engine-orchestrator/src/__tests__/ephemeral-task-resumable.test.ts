import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionStore, TaskStore } from "@adhd/agent-store-runtime";
import type { AgentDefinition } from "@adhd/agent-base-types";

import { taskTool } from "../tools/task.js";
import { createProvider } from "../providers/factory.js";
import type { TaskDeps } from "../tools/task.js";
import type { AgentStore } from "../tools/agent-crud.js";
import { PolicyEngine } from "../engine/policy.js";
import { HookRegistry } from "../engine/hooks.js";
import { BackgroundQueue } from "../engine/queue.js";
import { DagEngine } from "../engine/dag-engine.js";
import { Orchestrator } from "../engine/orchestrator.js";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { nowIso } from "../utils/timestamps.js";
import { createMigratedSqlite } from "./fixtures/real-schema-db.js";

/**
 * ad988fda AC6 / 95ee2a24 AC4: a one-shot (ephemeral `agent_name`) dispatch must not retain a claudecli session
 * transcript, so the ephemeral task path tells the provider factory `sessionResumable:false`; a session-bound task
 * (which can get a second task and resume) must not. Drives the REAL taskTool + orchestrator + stores; the only
 * mocks are the LLM SDK boundary and a pass-through spy on `createProvider` that records the options it receives.
 */

vi.mock("../providers/factory.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../providers/factory.js")>();
    return { ...actual, createProvider: vi.fn(actual.createProvider) };
});

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
    const sqlite = createMigratedSqlite();
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

describe("ad988fda AC6 / 95ee2a24 AC4: sessionResumable follows the dispatch retention class", () => {
    beforeEach(() => {
        vi.mocked(createProvider).mockClear();
    });

    const lastOptions = () => {
        const calls = vi.mocked(createProvider).mock.calls;
        expect(calls).toHaveLength(1);
        return calls[0][4];
    };

    it("ad988fda AC6: an ephemeral (agent_name) task builds its provider with sessionResumable:false", async () => {
        const { deps } = makeDeps();
        const result = await taskTool({ agent_name: "ephemeral-test-agent", prompt: "one shot" }, deps);
        expect(result.status).toBe("completed");
        expect(lastOptions()?.sessionResumable).toBe(false);
    });

    it("ad988fda AC6: a session-bound task does not opt out (sessionResumable is not false)", async () => {
        const { deps, sessionStore } = makeDeps();
        const session = sessionStore.create({
            agentName: "ephemeral-test-agent",
            agentDefinition: makeTestAgentDefinition(),
        });
        const result = await taskTool({ session_id: session.id, prompt: "in a session", background: false }, deps);
        expect(result.status).toBe("completed");
        expect(lastOptions()?.sessionResumable).not.toBe(false);
    });
});
