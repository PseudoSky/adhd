/**
 * ea8f6f92-d0db-426e-bf9d-bd7ba2fdd5ca AC3 (D6) + review B2-M2: no deadlock when a bridged `task` call
 * spawns a child, proven through the REAL `taskTool` -> `Orchestrator.run` child path.
 *
 * The parent is a real `Orchestrator.run` at `toolCallConcurrency: 1` whose provider stands in for the
 * `claude` CLI and fires one bridged `agent__task` call. That call is served by the REAL `taskTool`
 * (real stores, real `McpClientRegistry`, real child `Orchestrator.run`); only the external boundary is
 * stubbed (the child's OpenAI SDK). The child's model issues a real tool call, so the child NEEDS a
 * slot while its parent still holds the only one. A limiter shared across the task tree (process- or
 * config-wide) would park the child behind its own parent forever.
 *
 * Negative control (verified, review B2-M2): making `createToolLimiter` return one module-level
 * limiter makes this test time out (red); the per-task limiter is green.
 */
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it, vi } from "vitest";

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
import type { OrchestratorSessionStore, OrchestratorTaskStore } from "../engine/orchestrator.js";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import type { LLMProvider, ProviderChatRequest, ProviderChatResponse, ToolDefinition } from "../providers/types.js";
import type { McpClientRegistry } from "../clients/registry.js";
import type { ExecutionContext, Message } from "../validation/index.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import { createMigratedSqlite } from "./fixtures/real-schema-db.js";

/** Scripted child model: turn 1 calls the child's `leaf` tool, turn 2 finishes. */
const openaiCalls: number[] = [];
vi.mock("openai", () => {
    class MockOpenAI {
        chat = {
            completions: {
                create: vi.fn(async () => {
                    openaiCalls.push(openaiCalls.length);
                    if (openaiCalls.length === 1) {
                        return {
                            choices: [{
                                message: {
                                    content: null,
                                    tool_calls: [{ id: "call_leaf", type: "function", function: { name: "agent-mcp__leaf", arguments: "{}" } }],
                                },
                                finish_reason: "tool_calls",
                            }],
                            usage: undefined,
                        };
                    }
                    return { choices: [{ message: { content: "child done", tool_calls: undefined }, finish_reason: "stop" }], usage: undefined };
                }),
            },
        };
    }
    return { default: MockOpenAI };
});

const silentLogger: EngineLogger = { info() {}, warn() {}, error() {}, debug() {} } as EngineLogger;

const childDef: AgentDefinition = {
    name: "child-agent",
    version: 1,
    provider: { type: "openai", model: "gpt-4o-mini" },
    systemPrompt: "child",
    // `agent-mcp` is the self-referential server: served by the in-process handler below.
    mcpServers: { "agent-mcp": { transport: "http", url: "http://localhost:0/mcp" } },
    permissions: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
} as AgentDefinition;

function engineConfig(): EngineConfig {
    return {
        server: { contextLimit: 0, defaultMaxTokens: 1024 },
        queue: { concurrency: 1 },
        sse: { baseUrl: "http://localhost:0" },
        plugins: { entries: [] },
        toolCallConcurrency: 1,
        getProviderConfig: () => ({ secret: "test-secret", baseURL: "http://localhost:0/v1", model: "gpt-4o-mini" }),
        subprocessEnv: () => ({}),
        resolveEnvName: (name: string) => name,
        isEnvNameAllowed: () => true,
    } as EngineConfig;
}

describe("ea8f6f92 AC3 (review B2-M2): bridged task -> real child task under toolCallConcurrency=1", () => {
    it("ea8f6f92 AC3: the child's own tool call gets a slot while its parent holds the only one", async () => {
        const sqlite = createMigratedSqlite();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = drizzle(sqlite) as any;
        const taskStore = new TaskStore(db);
        const sessionStore = new SessionStore(db);
        const agentStore: AgentStore = {
            create: () => childDef, read: () => childDef, readUnresolved: () => childDef,
            update: () => childDef, delete: () => undefined, list: () => [childDef],
        };
        const queue = new BackgroundQueue(1, silentLogger);
        const leafCalls: string[] = [];
        const deps: TaskDeps = {
            agentStore,
            sessionStore,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            taskStore: taskStore as any,
            orchestrator: new Orchestrator(),
            queue,
            policy: new PolicyEngine({ serverMaxDepth: 10, serverMaxToolLoops: 10 }),
            hooks: new HookRegistry(),
            selfUrl: undefined,
            inProcessDescriptors: [{ name: "leaf", description: "leaf", inputSchema: { type: "object", properties: {} } }],
            inProcessHandler: async (toolName) => {
                leafCalls.push(toolName);
                return { content: [{ type: "text", text: "leaf-ok" }] };
            },
            db,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            dagEngine: new DagEngine(db, queue, taskStore as any, async () => undefined, silentLogger),
            config: engineConfig(),
            logger: silentLogger,
        };

        // Parent: a real Orchestrator.run at limit 1; its bridged `agent__task` call runs the REAL taskTool.
        const parentCtx: ExecutionContext = {
            taskId: generateId(), sessionId: generateId(), agentName: "parent-agent",
            agentDefinition: { ...childDef, name: "parent-agent", provider: { type: "claudecli", model: "sonnet" } } as AgentDefinition,
            recursionDepth: 0, toolCallCount: 0,
        };
        const taskDescriptor: ToolDefinition = { name: "agent__task", description: "task", inputSchema: { type: "object", properties: {} } };
        let taskToolOutput: unknown;
        const registry = {
            listAllTools: async () => [taskDescriptor],
            closeAll: async () => {},
            getClient: async () => ({
                callTool: async (_tool: string, _args: unknown) => {
                    taskToolOutput = await taskTool({ agent_name: "child-agent", prompt: "go" }, deps, parentCtx);
                    return [{ type: "text", text: "task returned" }];
                },
            }),
        } as unknown as McpClientRegistry;
        const provider = {
            chat: async (req: ProviderChatRequest): Promise<ProviderChatResponse> => {
                await req.executeTool!("agent", "task", {});
                return {
                    message: { id: generateId(), sessionId: generateId(), role: "assistant", content: "parent done", createdAt: nowIso() },
                    stopReason: "completed",
                } as ProviderChatResponse;
            },
        } as unknown as LLMProvider;
        const parentTaskStore: OrchestratorTaskStore = { updateStatus: () => {}, appendEvent: () => {}, unregisterCancellation: () => {} };
        const parentSessions: OrchestratorSessionStore = { appendMessage: async () => {}, close: () => {} };
        const user: Message = { id: generateId(), sessionId: parentCtx.sessionId, role: "user", content: "go", createdAt: nowIso() };

        const parent = new Orchestrator().run({
            executionContext: parentCtx, messages: [user], registry, provider,
            policy: new PolicyEngine({ serverMaxDepth: 10, serverMaxToolLoops: 10 }),
            taskStore: parentTaskStore, sessionStore: parentSessions,
            signal: new AbortController().signal, taskId: parentCtx.taskId, logger: silentLogger,
            config: engineConfig(),
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, rej) => {
            timer = setTimeout(() => rej(new Error("deadlock: bridged task + real child did not complete")), 15_000);
        });
        try {
            expect((await Promise.race([parent, deadline])).result).toBe("parent done");
        } finally {
            clearTimeout(timer);
        }
        expect(leafCalls).toEqual(["leaf"]); // the child really executed a tool through ITS limiter
        expect(JSON.stringify(taskToolOutput)).toContain("child done");
    }, 30_000);
});
