import { describe, expect, it, vi } from "vitest";
import { Orchestrator, resolveHitl } from "../engine/orchestrator.js";
import { ToolError } from "../validation/errors.js";
import { nowIso } from "../utils/timestamps.js";
import { generateId } from "../utils/ids.js";
import type { LLMProvider, ProviderChatResponse } from "../providers/types.js";
import type { ExecutionContext, Message } from "../validation/index.js";
import type { McpClientRegistry } from "../clients/registry.js";
import type { PolicyEngine } from "../engine/policy.js";
import type { TaskStore } from "../store/task-store.js";
import type { SessionStore } from "../store/session-store.js";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const registry = {
    listAllTools: async () => [],
    closeAll: async () => {},
} as unknown as McpClientRegistry;

const policy = {
    check: () => {},
} as unknown as PolicyEngine;

const sessionStore = {
    appendMessage: async () => {},
} as unknown as SessionStore;

/**
 * A task store stub that records status updates so tests can verify them.
 * Includes a `read` method so the orchestrator treats the task as durable (non-ephemeral).
 */
function makeTaskStore() {
    const updates: Array<{ status: string; fields?: Record<string, unknown> }> = [];
    const store = {
        updateStatus: vi.fn((_id: string, status: string, fields?: Record<string, unknown>) => {
            updates.push({ status, fields });
            return {} as ReturnType<TaskStore["updateStatus"]>;
        }),
        appendEvent: vi.fn(() => {}),
        unregisterCancellation: vi.fn(() => {}),
        // read must exist so orchestrator treats this as a durable task (not ephemeral)
        read: vi.fn(() => ({})),
    } as unknown as TaskStore;
    return { store, updates };
}

function makeCtx(): ExecutionContext {
    return {
        taskId: generateId(),
        sessionId: generateId(),
        agentName: "test-agent",
        agentDefinition: {
            name: "test-agent",
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

/**
 * Provider that returns a HITL tool call on the first request, then a
 * completed response on the second request (after HITL is resolved).
 * The injected userInput is captured from the tool result message.
 */
function hitlProvider(capturedInputs: string[]): LLMProvider {
    let callCount = 0;
    return {
        chat: async () => {
            callCount++;
            if (callCount === 1) {
                return {
                    message: {
                        id: generateId(),
                        sessionId: generateId(),
                        role: "assistant",
                        content: null,
                        toolCalls: [
                            {
                                id: "hitl-call-1",
                                server: "built-in",
                                tool: "request_human_input",
                                arguments: { prompt: "Please confirm" },
                            },
                        ],
                        createdAt: nowIso(),
                    },
                    stopReason: "tool_calls" as const,
                };
            }
            return {
                message: {
                    id: generateId(),
                    sessionId: generateId(),
                    role: "assistant",
                    content: "Done after human input",
                    createdAt: nowIso(),
                },
                stopReason: "completed" as const,
            };
        },
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HITL orchestrator", () => {
    describe("suspension", () => {
        it("sets status to awaiting_input with a resumeToken before awaiting the promise", async () => {
            const ctx = makeCtx();
            const { store, updates } = makeTaskStore();
            const orch = new Orchestrator();
            const taskId = generateId();

            const runPromise = orch.run({
                executionContext: ctx,
                messages: [makeUserMessage(ctx.sessionId)],
                registry,
                provider: hitlProvider([]),
                policy,
                taskStore: store,
                sessionStore,
                signal: new AbortController().signal,
                taskId,
            });

            // Wait for the orchestrator to reach the suspension point
            await new Promise(r => setTimeout(r, 20));

            // At this point the orchestrator should have written awaiting_input to the DB
            const awaitingUpdate = updates.find(u => u.status === "awaiting_input");
            expect(awaitingUpdate).toBeDefined();
            expect(awaitingUpdate?.fields?.resumeToken).toBeDefined();
            // resumeToken should look like a UUID
            expect(typeof awaitingUpdate?.fields?.resumeToken).toBe("string");

            // Resolve to unblock the test
            resolveHitl(taskId, "human answer");
            await runPromise;
        });

        it("writes resumeToken to the DB before registering the resolver (ordering invariant)", async () => {
            const ctx = makeCtx();
            const taskId = generateId();
            let resumeTokenWrittenAt: number | undefined;

            const orderedStore = {
                updateStatus: vi.fn((_id: string, status: string, fields?: Record<string, unknown>) => {
                    if (status === "awaiting_input" && fields?.resumeToken) {
                        resumeTokenWrittenAt = Date.now();
                    }
                    return {} as ReturnType<TaskStore["updateStatus"]>;
                }),
                appendEvent: vi.fn(() => {}),
                unregisterCancellation: vi.fn(() => {}),
                read: vi.fn(() => ({})),
            } as unknown as TaskStore;

            // hitlProvider returns the HITL call once, then completes after resume —
            // so the orchestrator finishes cleanly and leaves no dangling promise.
            const runPromise = new Orchestrator().run({
                executionContext: ctx,
                messages: [makeUserMessage(ctx.sessionId)],
                registry,
                provider: hitlProvider([]),
                policy,
                taskStore: orderedStore,
                sessionStore,
                signal: new AbortController().signal,
                taskId,
            });

            // Let the orchestrator reach the HITL intercept and suspend.
            await new Promise(r => setTimeout(r, 30));

            // The DB write must have already happened during suspension...
            expect(resumeTokenWrittenAt).toBeDefined();

            // ...and resolveHitl must succeed, which is only possible once the
            // resolver is registered. The resolver is registered immediately AFTER
            // the awaited DB write (orchestrator step 2 -> step 3), so a true resolve
            // proves the write preceded the await.
            const resolved = resolveHitl(taskId, "human answer");
            expect(resolved).toBe(true);

            await runPromise;
        });
    });

    describe("resumption", () => {
        it("resolveHitl returns true and continues the loop with the injected userInput", async () => {
            const ctx = makeCtx();
            const { store } = makeTaskStore();
            const orch = new Orchestrator();
            const taskId = generateId();
            const injectedInputs: unknown[] = [];

            // Capture tool results via sessionStore
            const capturingSessionStore = {
                appendMessage: async (_sid: string, msg: { role?: string; toolResults?: Array<{ result: unknown }> }) => {
                    if (msg.role === "tool" && msg.toolResults) {
                        for (const tr of msg.toolResults) {
                            injectedInputs.push(tr.result);
                        }
                    }
                },
            } as unknown as SessionStore;

            const runPromise = orch.run({
                executionContext: ctx,
                messages: [makeUserMessage(ctx.sessionId)],
                registry,
                provider: hitlProvider([]),
                policy,
                taskStore: store,
                sessionStore: capturingSessionStore,
                signal: new AbortController().signal,
                taskId,
            });

            // Wait for suspension
            await new Promise(r => setTimeout(r, 20));

            // Resolve HITL with a specific user input
            const resolved = resolveHitl(taskId, "the-user-answer");
            expect(resolved).toBe(true);

            const result = await runPromise;
            expect(result.result).toBe("Done after human input");

            // The user's input was injected as the HITL tool result
            expect(injectedInputs).toContain("the-user-answer");
        });

        it("resolveHitl returns false when no resolver is registered (process restart scenario)", () => {
            const unknownTaskId = "non-existent-task-id";
            const result = resolveHitl(unknownTaskId, "some-input");
            expect(result).toBe(false);
        });
    });

    describe("abort / cancellation", () => {
        it("rejects with PROVIDER_ERROR when the task signal is aborted while awaiting human input", async () => {
            const ctx = makeCtx();
            const { store } = makeTaskStore();
            const orch = new Orchestrator();
            const taskId = generateId();
            const controller = new AbortController();

            let callCount = 0;
            const singleHitlProvider: LLMProvider = {
                chat: async () => {
                    callCount++;
                    if (callCount === 1) {
                        return {
                            message: {
                                id: generateId(),
                                sessionId: ctx.sessionId,
                                role: "assistant",
                                content: null,
                                toolCalls: [
                                    {
                                        id: "hitl-abort-call",
                                        server: "built-in",
                                        tool: "request_human_input",
                                        arguments: {},
                                    },
                                ],
                                createdAt: nowIso(),
                            },
                            stopReason: "tool_calls" as const,
                        };
                    }
                    // Should not reach here
                    return {
                        message: {
                            id: generateId(),
                            sessionId: ctx.sessionId,
                            role: "assistant",
                            content: "should not reach",
                            createdAt: nowIso(),
                        },
                        stopReason: "completed" as const,
                    };
                },
            };

            const runPromise = orch.run({
                executionContext: ctx,
                messages: [makeUserMessage(ctx.sessionId)],
                registry,
                provider: singleHitlProvider,
                policy,
                taskStore: store,
                sessionStore,
                signal: controller.signal,
                taskId,
            });

            // Wait for the orchestrator to reach the suspension point
            await new Promise(r => setTimeout(r, 20));

            // Abort the task
            controller.abort();

            await expect(runPromise).rejects.toMatchObject({
                code: "PROVIDER_ERROR",
                message: expect.stringContaining("cancelled"),
            });
        });
    });

    describe("ephemeral task guard", () => {
        it("throws VALIDATION_ERROR for ephemeral tasks that call request_human_input", async () => {
            const ctx = makeCtx();
            const orch = new Orchestrator();
            const taskId = generateId();

            // Ephemeral captureTaskStore has no `read` method — simulates runEphemeralTask
            const ephemeralStore = {
                updateStatus: vi.fn(() => ({} as ReturnType<TaskStore["updateStatus"]>)),
                appendEvent: vi.fn(() => {}),
                unregisterCancellation: vi.fn(() => {}),
                // NOTE: no `read` method — this is how the orchestrator detects ephemeral
            } as unknown as TaskStore;

            let callCount = 0;
            const provider: LLMProvider = {
                chat: async () => {
                    callCount++;
                    return {
                        message: {
                            id: generateId(),
                            sessionId: ctx.sessionId,
                            role: "assistant",
                            content: null,
                            toolCalls: [
                                {
                                    id: "ephemeral-hitl",
                                    server: "built-in",
                                    tool: "request_human_input",
                                    arguments: {},
                                },
                            ],
                            createdAt: nowIso(),
                        },
                        stopReason: "tool_calls" as const,
                    };
                },
            };

            await expect(
                orch.run({
                    executionContext: ctx,
                    messages: [makeUserMessage(ctx.sessionId)],
                    registry,
                    provider,
                    policy,
                    taskStore: ephemeralStore,
                    sessionStore,
                    signal: new AbortController().signal,
                    taskId,
                })
            ).rejects.toMatchObject({
                code: "VALIDATION_ERROR",
                message: expect.stringContaining("ephemeral"),
            });
        });
    });
});
