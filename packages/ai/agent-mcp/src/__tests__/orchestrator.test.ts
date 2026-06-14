import { describe, expect, it } from "vitest";
import { Orchestrator } from "../engine/orchestrator.js";
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
// Minimal stubs — only the methods the orchestrator actually calls
// ---------------------------------------------------------------------------

const registry = {
    listAllTools: async () => [],
    closeAll: async () => {},
} as unknown as McpClientRegistry;

const policy = {
    check: () => {},
} as unknown as PolicyEngine;

const taskStore = {
    updateStatus: () => {},
    appendEvent: () => {},
    unregisterCancellation: () => {},
} as unknown as TaskStore;

const sessionStore = {
    appendMessage: () => {},
} as unknown as SessionStore;

function makeCtx(providerOverrides: Partial<ExecutionContext["agentDefinition"]["provider"]> = {}): ExecutionContext {
    return {
        taskId: generateId(),
        sessionId: generateId(),
        agentName: "test-agent",
        agentDefinition: {
            name: "test-agent",
            version: 1,
            provider: { type: "openai", model: "gpt-4o-mini", ...providerOverrides },
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
function completedProvider(reply: string): LLMProvider {
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

/** Provider that blocks until the signal fires, then rejects with the signal's reason. */
function hangingProvider(): LLMProvider {
    return {
        chat: ({ signal }) =>
            new Promise<ProviderChatResponse>((_, reject) => {
                if (signal?.aborted) {
                    reject(signal.reason);
                    return;
                }
                signal?.addEventListener("abort", () => reject(signal!.reason));
            }),
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Orchestrator", () => {
    describe("happy path", () => {
        it("returns the provider's reply when stopReason is 'completed'", async () => {
            const ctx = makeCtx();
            const orch = new Orchestrator();
            const result = await orch.run({
                executionContext: ctx,
                messages: [makeUserMessage(ctx.sessionId)],
                registry,
                provider: completedProvider("Hello there!"),
                policy,
                taskStore,
                sessionStore,
                signal: new AbortController().signal,
                taskId: generateId(),
            });
            expect(result.result).toBe("Hello there!");
        });
    });

    describe("provider timeout", () => {
        it("throws PROVIDER_TIMEOUT with timeout message when timeoutMs elapses", async () => {
            const timeoutMs = 50;
            const ctx = makeCtx({ timeoutMs });
            const orch = new Orchestrator();

            await expect(
                orch.run({
                    executionContext: ctx,
                    messages: [makeUserMessage(ctx.sessionId)],
                    registry,
                    provider: hangingProvider(),
                    policy,
                    taskStore,
                    sessionStore,
                    signal: new AbortController().signal,
                    taskId: generateId(),
                })
            ).rejects.toMatchObject({
                code: "PROVIDER_TIMEOUT",
                message: expect.stringContaining(`timed out after ${timeoutMs}ms`),
            });
        });

        it("error message includes advice to increase timeoutMs", async () => {
            const ctx = makeCtx({ timeoutMs: 50 });
            const orch = new Orchestrator();

            await expect(
                orch.run({
                    executionContext: ctx,
                    messages: [makeUserMessage(ctx.sessionId)],
                    registry,
                    provider: hangingProvider(),
                    policy,
                    taskStore,
                    sessionStore,
                    signal: new AbortController().signal,
                    taskId: generateId(),
                })
            ).rejects.toMatchObject({
                message: expect.stringContaining("timeoutMs"),
            });
        });

        it("detects timeout when SDK wraps abort as generic Error (APIUserAbortError pattern)", async () => {
            const timeoutMs = 50;
            const ctx = makeCtx({ timeoutMs });
            // Simulate the OpenAI SDK's APIUserAbortError: name stays "Error", message is "Request was aborted."
            const sdkStyleProvider: LLMProvider = {
                chat: ({ signal }) =>
                    new Promise<ProviderChatResponse>((_, reject) => {
                        signal?.addEventListener("abort", () => {
                            const err = new Error("Request was aborted.");
                            // intentionally do NOT set err.name — matches SDK behaviour
                            reject(err);
                        });
                    }),
            };
            const orch = new Orchestrator();

            await expect(
                orch.run({
                    executionContext: ctx,
                    messages: [makeUserMessage(ctx.sessionId)],
                    registry,
                    provider: sdkStyleProvider,
                    policy,
                    taskStore,
                    sessionStore,
                    signal: new AbortController().signal,
                    taskId: generateId(),
                })
            ).rejects.toMatchObject({
                code: "PROVIDER_TIMEOUT",
                message: expect.stringContaining(`timed out after ${timeoutMs}ms`),
            });
        });

        it("uses the default 60000ms value in the message when timeoutMs is not set", async () => {
            const ctx = makeCtx(); // no timeoutMs
            const orch = new Orchestrator();

            // Override AbortSignal.timeout to fire immediately so the test doesn't actually wait 60s
            const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
            AbortSignal.timeout = (ms: number) => (ms === 60_000 ? originalTimeout(50) : originalTimeout(ms));

            try {
                await expect(
                    orch.run({
                        executionContext: ctx,
                        messages: [makeUserMessage(ctx.sessionId)],
                        registry,
                        provider: hangingProvider(),
                        policy,
                        taskStore,
                        sessionStore,
                        signal: new AbortController().signal,
                        taskId: generateId(),
                    })
                ).rejects.toMatchObject({
                    code: "PROVIDER_TIMEOUT",
                    message: expect.stringContaining("60000ms"),
                });
            } finally {
                AbortSignal.timeout = originalTimeout;
            }
        });
    });

    describe("task cancellation", () => {
        it("throws PROVIDER_ERROR with cancellation message when task signal is aborted", async () => {
            const ctx = makeCtx({ timeoutMs: 5000 });
            const controller = new AbortController();
            const orch = new Orchestrator();

            const runPromise = orch.run({
                executionContext: ctx,
                messages: [makeUserMessage(ctx.sessionId)],
                registry,
                provider: hangingProvider(),
                policy,
                taskStore,
                sessionStore,
                signal: controller.signal,
                taskId: generateId(),
            });

            // Abort the task signal shortly after starting
            setTimeout(() => controller.abort(), 20);

            await expect(runPromise).rejects.toMatchObject({
                code: "PROVIDER_ERROR",
                message: expect.stringContaining("cancelled"),
            });
        });
    });

    describe("generic provider error", () => {
        it("throws PROVIDER_ERROR wrapping the original message", async () => {
            const ctx = makeCtx({ timeoutMs: 5000 });
            const provider: LLMProvider = {
                chat: async () => {
                    throw new Error("upstream API exploded");
                },
            };
            const orch = new Orchestrator();

            await expect(
                orch.run({
                    executionContext: ctx,
                    messages: [makeUserMessage(ctx.sessionId)],
                    registry,
                    provider,
                    policy,
                    taskStore,
                    sessionStore,
                    signal: new AbortController().signal,
                    taskId: generateId(),
                })
            ).rejects.toMatchObject({
                code: "PROVIDER_ERROR",
                message: expect.stringContaining("upstream API exploded"),
            });
        });
    });

    describe("parallel concurrent tool dispatch via Promise.all", () => {
        it("invokes multiple tool calls concurrently and appends all results in original order", async () => {
            const ctx = makeCtx({ timeoutMs: 5000 });
            const toolCallIds = [generateId(), generateId()];
            const invokedTools: string[] = [];
            const appendedToolCallIds: string[] = [];

            // Provider returns two tool calls in one batch, then completes.
            let callCount = 0;
            const provider: LLMProvider = {
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
                                    { id: toolCallIds[0], server: "test-server", tool: "tool-alpha", arguments: {} },
                                    { id: toolCallIds[1], server: "test-server", tool: "tool-beta", arguments: {} },
                                ],
                                createdAt: nowIso(),
                            },
                            stopReason: "tool_calls" as const,
                        };
                    }
                    // Second call — return completed
                    return {
                        message: {
                            id: generateId(),
                            sessionId: ctx.sessionId,
                            role: "assistant",
                            content: "done",
                            createdAt: nowIso(),
                        },
                        stopReason: "completed" as const,
                    };
                },
            };

            // Registry stub that records which tools were called
            const parallelRegistry = {
                listAllTools: async () => [
                    { name: "test-server__tool-alpha", description: "", inputSchema: { type: "object", properties: {} } },
                    { name: "test-server__tool-beta", description: "", inputSchema: { type: "object", properties: {} } },
                ],
                getClient: async (server: string) => ({
                    callTool: async (tool: string) => {
                        invokedTools.push(`${server}__${tool}`);
                        return `result-from-${tool}`;
                    },
                }),
                closeAll: async () => {},
            } as unknown as McpClientRegistry;

            // SessionStore stub that records toolCallIds from appended tool result messages
            const parallelSessionStore = {
                appendMessage: (sessionId: string, msg: { role?: string; toolResults?: Array<{ toolCallId: string }> }) => {
                    if (msg.role === "tool" && msg.toolResults) {
                        for (const tr of msg.toolResults) {
                            appendedToolCallIds.push(tr.toolCallId);
                        }
                    }
                },
            } as unknown as SessionStore;

            const orch = new Orchestrator();
            const result = await orch.run({
                executionContext: ctx,
                messages: [makeUserMessage(ctx.sessionId)],
                registry: parallelRegistry,
                provider,
                policy,
                taskStore,
                sessionStore: parallelSessionStore,
                signal: new AbortController().signal,
                taskId: generateId(),
            });

            expect(result.result).toBe("done");

            // Both tools were invoked
            expect(invokedTools).toContain("test-server__tool-alpha");
            expect(invokedTools).toContain("test-server__tool-beta");
            expect(invokedTools).toHaveLength(2);

            // Results appended in original toolCalls order (alpha before beta)
            expect(appendedToolCallIds).toEqual([toolCallIds[0], toolCallIds[1]]);
        });

        it("non-fatal tool error surfaces as isError=true and does not abort the batch", async () => {
            const ctx = makeCtx({ timeoutMs: 5000 });
            const toolCallIds = [generateId(), generateId()];
            const appendedResults: Array<{ toolCallId: string; isError: boolean }> = [];

            let callCount = 0;
            const provider: LLMProvider = {
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
                                    { id: toolCallIds[0], server: "test-server", tool: "failing-tool", arguments: {} },
                                    { id: toolCallIds[1], server: "test-server", tool: "ok-tool", arguments: {} },
                                ],
                                createdAt: nowIso(),
                            },
                            stopReason: "tool_calls" as const,
                        };
                    }
                    return {
                        message: {
                            id: generateId(),
                            sessionId: ctx.sessionId,
                            role: "assistant",
                            content: "recovered",
                            createdAt: nowIso(),
                        },
                        stopReason: "completed" as const,
                    };
                },
            };

            const errorRegistry = {
                listAllTools: async () => [],
                getClient: async (_server: string) => ({
                    callTool: async (tool: string) => {
                        if (tool === "failing-tool") throw new Error("non-fatal tool error");
                        return "ok-result";
                    },
                }),
                closeAll: async () => {},
            } as unknown as McpClientRegistry;

            const errorSessionStore = {
                appendMessage: (_sessionId: string, msg: { role?: string; toolResults?: Array<{ toolCallId: string; isError: boolean }> }) => {
                    if (msg.role === "tool" && msg.toolResults) {
                        for (const tr of msg.toolResults) {
                            appendedResults.push({ toolCallId: tr.toolCallId, isError: tr.isError });
                        }
                    }
                },
            } as unknown as SessionStore;

            const orch = new Orchestrator();
            const result = await orch.run({
                executionContext: ctx,
                messages: [makeUserMessage(ctx.sessionId)],
                registry: errorRegistry,
                provider,
                policy,
                taskStore,
                sessionStore: errorSessionStore,
                signal: new AbortController().signal,
                taskId: generateId(),
            });

            expect(result.result).toBe("recovered");
            // First tool (failing) is isError=true, second is isError=false
            expect(appendedResults[0]).toMatchObject({ toolCallId: toolCallIds[0], isError: true });
            expect(appendedResults[1]).toMatchObject({ toolCallId: toolCallIds[1], isError: false });
        });

        it("fatal policy violation re-throws and aborts the entire task (not isError)", async () => {
            const ctx = makeCtx({ timeoutMs: 5000 });
            const toolCallId = generateId();

            const provider: LLMProvider = {
                chat: async () => ({
                    message: {
                        id: generateId(),
                        sessionId: ctx.sessionId,
                        role: "assistant",
                        content: null,
                        toolCalls: [
                            { id: toolCallId, server: "test-server", tool: "some-tool", arguments: {} },
                        ],
                        createdAt: nowIso(),
                    },
                    stopReason: "tool_calls" as const,
                }),
            };

            // policy that throws MAX_TOOL_LOOPS_EXCEEDED
            const strictPolicy = {
                check: () => {
                    throw new ToolError("MAX_TOOL_LOOPS_EXCEEDED", "too many tool loops");
                },
            } as unknown as PolicyEngine;

            const orch = new Orchestrator();
            await expect(
                orch.run({
                    executionContext: ctx,
                    messages: [makeUserMessage(ctx.sessionId)],
                    registry,
                    provider,
                    policy: strictPolicy,
                    taskStore,
                    sessionStore,
                    signal: new AbortController().signal,
                    taskId: generateId(),
                })
            ).rejects.toMatchObject({
                code: "MAX_TOOL_LOOPS_EXCEEDED",
            });
        });
    });
});
