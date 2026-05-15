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
        it("throws PROVIDER_ERROR with timeout message when timeoutMs elapses", async () => {
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
                code: "PROVIDER_ERROR",
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
                code: "PROVIDER_ERROR",
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
                    code: "PROVIDER_ERROR",
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
});
