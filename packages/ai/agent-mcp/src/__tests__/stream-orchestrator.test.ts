/**
 * stream-orchestrator.test.ts
 *
 * Verifies that the Orchestrator emits the correct TaskStreamEvents via the
 * in-memory EventBus: tool_call, tool_result, status_change, and done (including
 * on the cancellation path).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Orchestrator } from "../engine/orchestrator.js";
import { subscribeToTask, type TaskStreamEvent } from "../streaming/event-bus.js";
import { nowIso } from "../utils/timestamps.js";
import { generateId } from "../utils/ids.js";
import type { LLMProvider, ProviderChatResponse } from "../providers/types.js";
import type { ExecutionContext, Message } from "../validation/index.js";
import type { McpClientRegistry } from "../clients/registry.js";
import type { PolicyEngine } from "../engine/policy.js";
import type { TaskStore } from "../store/task-store.js";
import type { SessionStore } from "../store/session-store.js";

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

const policy = {
    check: () => { /* no-op: test stub — policy always permits */ },
} as unknown as PolicyEngine;

const taskStore = {
    updateStatus: () => { /* no-op: test stub */ },
    appendEvent: () => { /* no-op: test stub */ },
    unregisterCancellation: () => { /* no-op: test stub */ },
} as unknown as TaskStore;

const sessionStore = {
    appendMessage: async () => { /* no-op: test stub */ },
} as unknown as SessionStore;

const noopRegistry = {
    listAllTools: async () => [],
    closeAll: async () => { /* no-op: test stub */ },
} as unknown as McpClientRegistry;

function makeCtx(taskId: string): ExecutionContext {
    return {
        taskId,
        sessionId: generateId(),
        agentName: "stream-test-agent",
        agentDefinition: {
            name: "stream-test-agent",
            version: 1,
            provider: { type: "openai", model: "gpt-4o-mini", timeoutMs: 5000 },
            systemPrompt: "You are helpful.",
            mcpServers: {},
            permissions: {},
            createdAt: nowIso(),
            updatedAt: nowIso(),
        },
        recursionDepth: 0,
        toolCallCount: 0,
    };
}

function makeUserMessage(sessionId: string): Message {
    return {
        id: generateId(),
        sessionId,
        role: "user",
        content: "hello",
        createdAt: nowIso(),
    };
}

/** Provider that resolves immediately with a completed response. */
function completedProvider(reply = "done"): LLMProvider {
    return {
        chat: async () => ({
            message: {
                id: generateId(),
                sessionId: generateId(),
                role: "assistant",
                content: reply,
                createdAt: nowIso(),
            },
            stopReason: "completed" as const,
        }),
    };
}

/** Provider that blocks until the signal fires. */
function hangingProvider(): LLMProvider {
    return {
        chat: ({ signal }) =>
            new Promise<ProviderChatResponse>((_, reject) => {
                if (signal?.aborted) { reject(signal.reason); return; }
                signal?.addEventListener("abort", () => reject(signal!.reason));
            }),
    };
}

/** Provider that returns one round of tool calls, then completes. */
function toolCallProvider(toolCallIds: string[], sessionId: string): LLMProvider {
    let callCount = 0;
    return {
        chat: async () => {
            callCount++;
            if (callCount === 1) {
                return {
                    message: {
                        id: generateId(),
                        sessionId,
                        role: "assistant",
                        content: null,
                        toolCalls: toolCallIds.map(id => ({
                            id,
                            server: "test-server",
                            tool: "test-tool",
                            arguments: { input: "x" },
                        })),
                        createdAt: nowIso(),
                    },
                    stopReason: "tool_calls" as const,
                };
            }
            return {
                message: {
                    id: generateId(),
                    sessionId,
                    role: "assistant",
                    content: "all done",
                    createdAt: nowIso(),
                },
                stopReason: "completed" as const,
            };
        },
    };
}

function makeToolRegistry(): McpClientRegistry {
    return {
        listAllTools: async () => [
            { name: "test-server__test-tool", description: "", inputSchema: { type: "object", properties: {} } },
        ],
        getClient: async () => ({
            callTool: async () => "tool-result-value",
        }),
        closeAll: async () => { /* no-op: test stub */ },
    } as unknown as McpClientRegistry;
}

// ---------------------------------------------------------------------------
// Helper: collect events for a taskId
// ---------------------------------------------------------------------------

function collectEvents(taskId: string): { events: TaskStreamEvent[]; unsubscribe: () => void } {
    const events: TaskStreamEvent[] = [];
    const unsubscribe = subscribeToTask(taskId, e => events.push(e));
    return { events, unsubscribe };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("stream-orchestrator — SSE event emission", () => {
    describe("status_change events", () => {
        it("emits status_change(running) at task start", async () => {
            const taskId = generateId();
            const ctx = makeCtx(taskId);
            const { events, unsubscribe } = collectEvents(taskId);

            try {
                const orch = new Orchestrator();
                await orch.run({
                    executionContext: ctx,
                    messages: [makeUserMessage(ctx.sessionId)],
                    registry: noopRegistry,
                    provider: completedProvider(),
                    policy,
                    taskStore,
                    sessionStore,
                    signal: new AbortController().signal,
                    taskId,
                });
            } finally {
                unsubscribe();
            }

            const statusChanges = events.filter(e => e.type === "status_change");
            expect(statusChanges.some(e => e.type === "status_change" && e.status === "running")).toBe(true);
        });

        it("emits status_change(completed) on successful completion", async () => {
            const taskId = generateId();
            const ctx = makeCtx(taskId);
            const { events, unsubscribe } = collectEvents(taskId);

            try {
                const orch = new Orchestrator();
                await orch.run({
                    executionContext: ctx,
                    messages: [makeUserMessage(ctx.sessionId)],
                    registry: noopRegistry,
                    provider: completedProvider("result"),
                    policy,
                    taskStore,
                    sessionStore,
                    signal: new AbortController().signal,
                    taskId,
                });
            } finally {
                unsubscribe();
            }

            const statusChanges = events.filter(e => e.type === "status_change");
            expect(statusChanges.some(e => e.type === "status_change" && e.status === "completed")).toBe(true);
        });
    });

    describe("done event", () => {
        it("emits done with result on successful completion", async () => {
            const taskId = generateId();
            const ctx = makeCtx(taskId);
            const { events, unsubscribe } = collectEvents(taskId);

            try {
                const orch = new Orchestrator();
                await orch.run({
                    executionContext: ctx,
                    messages: [makeUserMessage(ctx.sessionId)],
                    registry: noopRegistry,
                    provider: completedProvider("my result"),
                    policy,
                    taskStore,
                    sessionStore,
                    signal: new AbortController().signal,
                    taskId,
                });
            } finally {
                unsubscribe();
            }

            const doneEvents = events.filter(e => e.type === "done");
            expect(doneEvents).toHaveLength(1);
            const done = doneEvents[0];
            expect(done?.type).toBe("done");
            if (done?.type === "done") {
                expect(done.result).toBe("my result");
                expect(done.error).toBeNull();
            }
        });

        it("emits done on the cancellation path (SSE clients must not hang)", async () => {
            const taskId = generateId();
            const ctx = makeCtx(taskId);
            const { events, unsubscribe } = collectEvents(taskId);
            const controller = new AbortController();

            const orch = new Orchestrator();
            const runPromise = orch.run({
                executionContext: ctx,
                messages: [makeUserMessage(ctx.sessionId)],
                registry: noopRegistry,
                provider: hangingProvider(),
                policy,
                taskStore,
                sessionStore,
                signal: controller.signal,
                taskId,
            });

            // Cancel after a brief delay
            setTimeout(() => controller.abort(), 20);

            // Orchestrator throws on cancellation — swallow it
            await runPromise.catch(() => { /* swallow expected cancellation throw */ });
            unsubscribe();

            const doneEvents = events.filter(e => e.type === "done");
            expect(doneEvents).toHaveLength(1);
            const done = doneEvents[0];
            expect(done?.type).toBe("done");
            if (done?.type === "done") {
                expect(done.result).toBeNull();
                expect(done.error).toBeTruthy(); // cancellation error message
            }
        });

        it("emits done with error on provider failure path", async () => {
            const taskId = generateId();
            const ctx = makeCtx(taskId);
            const { events, unsubscribe } = collectEvents(taskId);

            const failingProvider: LLMProvider = {
                chat: async () => { throw new Error("boom"); },
            };

            const orch = new Orchestrator();
            await orch.run({
                executionContext: ctx,
                messages: [makeUserMessage(ctx.sessionId)],
                registry: noopRegistry,
                provider: failingProvider,
                policy,
                taskStore,
                sessionStore,
                signal: new AbortController().signal,
                taskId,
            }).catch(() => { /* swallow expected throw */ });

            unsubscribe();

            const doneEvents = events.filter(e => e.type === "done");
            expect(doneEvents).toHaveLength(1);
            const done = doneEvents[0];
            if (done?.type === "done") {
                expect(done.error).toContain("boom");
                expect(done.result).toBeNull();
            }
        });
    });

    describe("tool_call and tool_result events", () => {
        it("emits tool_call before dispatch and tool_result after each tool", async () => {
            const taskId = generateId();
            const toolCallId1 = generateId();
            const toolCallId2 = generateId();
            const ctx = makeCtx(taskId);
            const { events, unsubscribe } = collectEvents(taskId);

            const orch = new Orchestrator();
            await orch.run({
                executionContext: ctx,
                messages: [makeUserMessage(ctx.sessionId)],
                registry: makeToolRegistry(),
                provider: toolCallProvider([toolCallId1, toolCallId2], ctx.sessionId),
                policy,
                taskStore,
                sessionStore,
                signal: new AbortController().signal,
                taskId,
            });
            unsubscribe();

            const toolCallEvents = events.filter(e => e.type === "tool_call");
            const toolResultEvents = events.filter(e => e.type === "tool_result");

            // Both tool calls should emit events
            expect(toolCallEvents).toHaveLength(2);
            expect(toolResultEvents).toHaveLength(2);

            // Verify toolCallIds appear in tool_call events
            const emittedCallIds = toolCallEvents.map(e => e.type === "tool_call" ? e.toolCallId : null);
            expect(emittedCallIds).toContain(toolCallId1);
            expect(emittedCallIds).toContain(toolCallId2);

            // Verify toolCallIds appear in tool_result events
            const resultCallIds = toolResultEvents.map(e => e.type === "tool_result" ? e.toolCallId : null);
            expect(resultCallIds).toContain(toolCallId1);
            expect(resultCallIds).toContain(toolCallId2);
        });

        it("tool_call event contains qualified tool name and input", async () => {
            const taskId = generateId();
            const toolCallId = generateId();
            const ctx = makeCtx(taskId);
            const { events, unsubscribe } = collectEvents(taskId);

            const orch = new Orchestrator();
            await orch.run({
                executionContext: ctx,
                messages: [makeUserMessage(ctx.sessionId)],
                registry: makeToolRegistry(),
                provider: toolCallProvider([toolCallId], ctx.sessionId),
                policy,
                taskStore,
                sessionStore,
                signal: new AbortController().signal,
                taskId,
            });
            unsubscribe();

            const toolCallEvent = events.find(e => e.type === "tool_call");
            expect(toolCallEvent).toBeDefined();
            if (toolCallEvent?.type === "tool_call") {
                expect(toolCallEvent.toolName).toBe("test-server__test-tool");
                expect(toolCallEvent.toolCallId).toBe(toolCallId);
                expect(toolCallEvent.input).toEqual({ input: "x" });
            }
        });
    });

    describe("event ordering", () => {
        it("emits status_change(running) before done", async () => {
            const taskId = generateId();
            const ctx = makeCtx(taskId);
            const { events, unsubscribe } = collectEvents(taskId);

            const orch = new Orchestrator();
            await orch.run({
                executionContext: ctx,
                messages: [makeUserMessage(ctx.sessionId)],
                registry: noopRegistry,
                provider: completedProvider(),
                policy,
                taskStore,
                sessionStore,
                signal: new AbortController().signal,
                taskId,
            });
            unsubscribe();

            const types = events.map(e => e.type);
            const runningIdx = types.indexOf("status_change");
            const doneIdx = types.lastIndexOf("done");
            expect(runningIdx).toBeGreaterThanOrEqual(0);
            expect(doneIdx).toBeGreaterThan(runningIdx);
        });

        it("token events are NOT emitted (deferred to 0.5.0)", async () => {
            const taskId = generateId();
            const ctx = makeCtx(taskId);
            const { events, unsubscribe } = collectEvents(taskId);

            const orch = new Orchestrator();
            await orch.run({
                executionContext: ctx,
                messages: [makeUserMessage(ctx.sessionId)],
                registry: noopRegistry,
                provider: completedProvider(),
                policy,
                taskStore,
                sessionStore,
                signal: new AbortController().signal,
                taskId,
            });
            unsubscribe();

            const tokenEvents = events.filter(e => e.type === "token");
            expect(tokenEvents).toHaveLength(0);
        });
    });
});
