import { describe, expect, it } from "vitest";
import { Orchestrator, resolveHitl } from "../engine/orchestrator.js";
import type { OrchestratorTaskStore, OrchestratorSessionStore } from "../engine/orchestrator.js";
import { ToolError } from "../validation/errors.js";
import { nowIso } from "../utils/timestamps.js";
import { generateId } from "../utils/ids.js";
import type { LLMProvider, ProviderChatResponse } from "../providers/types.js";
import type { ExecutionContext, Message } from "../validation/index.js";
import type { McpClientRegistry } from "../clients/registry.js";
import { PolicyEngine } from "../engine/policy.js";

// ---------------------------------------------------------------------------
// Minimal stubs — only the methods the orchestrator actually calls
// ---------------------------------------------------------------------------

const registry = {
    listAllTools: async () => [],
    closeAll: async () => { /* no-op: test stub */ },
    getClient: async () => {
        throw new Error("shared registry stub: getClient must not be reached");
    },
} as unknown as McpClientRegistry;

const policy = {
    check: () => { /* no-op: test stub — policy always permits */ },
} as unknown as PolicyEngine;

const taskStore: OrchestratorTaskStore = {
    updateStatus: () => { /* no-op: test stub */ },
    appendEvent: () => { /* no-op: test stub */ },
    unregisterCancellation: () => { /* no-op: test stub */ },
};

const sessionStore: OrchestratorSessionStore = {
    appendMessage: async () => { /* no-op: test stub */ },
    close: () => { /* no-op: test stub */ },
};

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
                const sig = signal;
                if (sig) sig.addEventListener("abort", () => reject(sig.reason));
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
            const sdkStyleProvider: LLMProvider = {
                chat: ({ signal }) =>
                    new Promise<ProviderChatResponse>((_, reject) => {
                        signal?.addEventListener("abort", () => {
                            const err = new Error("Request was aborted.");
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

    describe("tool-loop cap enforcement (regression: off-by-one)", () => {
        it("executes exactly serverMaxToolLoops tool calls before MAX_TOOL_LOOPS_EXCEEDED", async () => {
            const MAX = 3;
            const ctx = makeCtx({ timeoutMs: 5000 });
            const realPolicy = new PolicyEngine({ serverMaxDepth: 10, serverMaxToolLoops: MAX });

            let executed = 0;
            const countingRegistry = {
                listAllTools: async () => [
                    { name: "test-server__loop-tool", description: "", inputSchema: { type: "object", properties: {} } },
                ],
                getClient: async () => ({
                    callTool: async () => {
                        executed++;
                        return "ok";
                    },
                }),
                closeAll: async () => { /* no-op: test stub */ },
            } as unknown as McpClientRegistry;

            const loopingProvider: LLMProvider = {
                chat: async () => ({
                    message: {
                        id: generateId(),
                        sessionId: ctx.sessionId,
                        role: "assistant",
                        content: null,
                        toolCalls: [
                            { id: generateId(), server: "test-server", tool: "loop-tool", arguments: {} },
                        ],
                        createdAt: nowIso(),
                    },
                    stopReason: "tool_calls" as const,
                }),
            };

            await expect(
                new Orchestrator().run({
                    executionContext: ctx,
                    messages: [makeUserMessage(ctx.sessionId)],
                    registry: countingRegistry,
                    provider: loopingProvider,
                    policy: realPolicy,
                    taskStore,
                    sessionStore,
                    signal: new AbortController().signal,
                    taskId: generateId(),
                })
            ).rejects.toMatchObject({ code: "MAX_TOOL_LOOPS_EXCEEDED" });

            expect(executed).toBe(MAX);
        });
    });

    describe("parallel concurrent tool dispatch via Promise.all", () => {
        it("invokes multiple tool calls concurrently and appends all results in original order", async () => {
            const ctx = makeCtx({ timeoutMs: 5000 });
            const toolCallIds = [generateId(), generateId()];
            const invokedTools: string[] = [];
            const appendedToolCallIds: string[] = [];

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
                closeAll: async () => { /* no-op: test stub */ },
            } as unknown as McpClientRegistry;

            const parallelSessionStore: OrchestratorSessionStore = {
                appendMessage: async (_sessionId: string, msg: { role?: string; toolResults?: Array<{ toolCallId: string }> }) => {
                    if (msg.role === "tool" && msg.toolResults) {
                        for (const tr of msg.toolResults) {
                            appendedToolCallIds.push(tr.toolCallId);
                        }
                    }
                },
                close: () => { /* no-op */ },
            };

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

            expect(invokedTools).toContain("test-server__tool-alpha");
            expect(invokedTools).toContain("test-server__tool-beta");
            expect(invokedTools).toHaveLength(2);

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
                closeAll: async () => { /* no-op: test stub */ },
            } as unknown as McpClientRegistry;

            const errorSessionStore: OrchestratorSessionStore = {
                appendMessage: async (_sessionId: string, msg: { role?: string; toolResults?: Array<{ toolCallId: string; isError: boolean }> }) => {
                    if (msg.role === "tool" && msg.toolResults) {
                        for (const tr of msg.toolResults) {
                            appendedResults.push({ toolCallId: tr.toolCallId, isError: tr.isError });
                        }
                    }
                },
                close: () => { /* no-op */ },
            };

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

    // ─────────────────────────────────────────────────────────────────────
    // HITL suspend ordering — DEBT-AGENTMCP-HITL-TEST-CLEANUP-001
    // ─────────────────────────────────────────────────────────────────────
    describe("HITL suspend/resume ordering", () => {
        it("registers the hitl resolver BEFORE the awaiting_input status write (no resume-in-window race)", async () => {
            const ctx = makeCtx();
            const orch = new Orchestrator();
            const taskId = generateId();

            // Simulates a taskResume landing the INSTANT the 'awaiting_input'
            // status becomes observable: the status write itself is the resume
            // trigger. If the orchestrator writes the status before registering
            // the resolver, this synchronous resume returns false (the
            // catastrophic TASK_NOT_RESUMABLE path) — the assertion below then
            // goes red. The setImmediate retry mirrors a real client polling +
            // retrying after observing the status, so the run always completes
            // and the assertion — not a timeout — is the red signal.
            let resolverPresentAtStatusWrite: boolean | undefined;
            const hitlTaskStore: OrchestratorTaskStore = {
                updateStatus: (tid, status) => {
                    if (status === "awaiting_input") {
                        resolverPresentAtStatusWrite = resolveHitl(tid, "yes");
                        if (resolverPresentAtStatusWrite === false) {
                            setImmediate(() => resolveHitl(tid, "yes"));
                        }
                    }
                },
                appendEvent: () => { /* no-op: test stub */ },
                unregisterCancellation: () => { /* no-op: test stub */ },
            };

            // Turn 1 → request_human_input; after resume → 'completed'.
            let turn = 0;
            const hitlProvider: LLMProvider = {
                chat: async (): Promise<ProviderChatResponse> => {
                    turn++;
                    if (turn === 1) {
                        return {
                            message: {
                                id: generateId(),
                                sessionId: ctx.sessionId,
                                role: "assistant",
                                content: "",
                                toolCalls: [
                                    {
                                        id: generateId(),
                                        server: "builtin",
                                        tool: "request_human_input",
                                        arguments: { prompt: "do you confirm?" },
                                    },
                                ],
                                createdAt: nowIso(),
                            },
                            stopReason: "tool_calls",
                        };
                    }
                    return {
                        message: {
                            id: generateId(),
                            sessionId: ctx.sessionId,
                            role: "assistant",
                            content: "confirmed",
                            createdAt: nowIso(),
                        },
                        stopReason: "completed",
                    };
                },
            };

            const result = await orch.run({
                executionContext: ctx,
                messages: [makeUserMessage(ctx.sessionId)],
                registry,
                provider: hitlProvider,
                policy,
                taskStore: hitlTaskStore,
                sessionStore,
                signal: new AbortController().signal,
                taskId,
            });

            expect(
                resolverPresentAtStatusWrite,
                "hitl resolver must be registered before the awaiting_input status is written (a resume in that window must not see TASK_NOT_RESUMABLE)"
            ).toBe(true);
            expect(result.result).toBe("confirmed");
        }, 10_000);

        it("failed awaiting_input status_change emit does not kill the suspension or leak the resolver (DEBT-AGENTMCP-HITL-TEST-CLEANUP-001)", async () => {
            const ctx = makeCtx();
            const orch = new Orchestrator();
            const taskId = generateId();

            // Host's push-notification layer is broken: the awaiting_input
            // broadcast throws (SSE listener failure). The status WRITE must
            // still be the source of truth — the suspension survives, a
            // resume completes normally, and no resolver is left dangling
            // after the run finishes.
            const warnCalls: unknown[] = [];
            const testLogger = {
                info: () => {},
                warn: (msg: string | Record<string, unknown>) => {
                    warnCalls.push(msg);
                },
                error: () => {},
                debug: () => {},
            };
            const emitTaskEvent = (
                event: { type: string; taskId: string; status?: string }
            ) => {
                if (
                    event.type === "status_change" &&
                    event.status === "awaiting_input"
                ) {
                    throw new Error("simulated SSE broadcast failure");
                }
            };

            let turn = 0;
            const hitlProvider: LLMProvider = {
                chat: async (): Promise<ProviderChatResponse> => {
                    turn++;
                    if (turn === 1) {
                        return {
                            message: {
                                id: generateId(),
                                sessionId: ctx.sessionId,
                                role: "assistant",
                                content: "",
                                toolCalls: [
                                    {
                                        id: generateId(),
                                        server: "builtin",
                                        tool: "request_human_input",
                                        arguments: { prompt: "do you confirm?" },
                                    },
                                ],
                                createdAt: nowIso(),
                            },
                            stopReason: "tool_calls",
                        };
                    }
                    return {
                        message: {
                            id: generateId(),
                            sessionId: ctx.sessionId,
                            role: "assistant",
                            content: "confirmed",
                            createdAt: nowIso(),
                        },
                        stopReason: "completed",
                    };
                },
            };

            // Resume the suspension the moment the durable awaiting_input
            // status is written (exactly how taskResume operates: it reads the
            // STORE, not the failed broadcast). The emit failure must not
            // have torn the suspension down — the resume completes normally.
            const hitlTaskStore: OrchestratorTaskStore = {
                updateStatus: (tid, status) => {
                    if (status === "awaiting_input") {
                        resolveHitl(tid, "yes");
                    }
                },
                appendEvent: () => { /* no-op: test stub */ },
                unregisterCancellation: () => { /* no-op: test stub */ },
            };

            try {
                const result = await orch.run({
                    executionContext: ctx,
                    messages: [makeUserMessage(ctx.sessionId)],
                    registry,
                    provider: hitlProvider,
                    policy,
                    taskStore: hitlTaskStore,
                    sessionStore,
                    signal: new AbortController().signal,
                    taskId,
                    emitTaskEvent,
                    logger: testLogger,
                });

                // The broadcast failure was a notification loss only — the
                // suspension survived and the resume completed the task.
                // Pre-fix this rejects instead (resolver leaked, run died).
                expect(result.result).toBe("confirmed");
            } finally {
                // Defensive: if the run dies (pre-fix leak), drop any stray
                // resolver so the module-level map never pollutes other tests.
                resolveHitl(taskId, "test-cleanup");
            }

            // The failure was surfaced as a warn, not an exception.
            expect(
                warnCalls.length,
                "emit failure must be logged at warn level, not thrown"
            ).toBeGreaterThan(0);

            // After a completed suspension the resolver is gone — a late
            // resume must NOT "succeed" against a dangling entry.
            expect(resolveHitl(taskId, "late")).toBe(false);
        }, 10_000);

        it("abort-during-status-write + write failure produces no unhandledRejection (DEBT-AGENTMCP-HITL-TEST-CLEANUP-001)", async () => {
            const ctx = makeCtx();
            const orch = new Orchestrator();
            const taskId = generateId();
            const controller = new AbortController();

            // If the AbortSignal fires DURING the awaiting_input write and the
            // write then throws, abortHandler has already rejected
            // userInputPromise — a promise that is never awaited on this path.
            // That rejection must be marked handled (void .catch in the
            // catch block), otherwise Node 15+ crashes the process with
            // unhandledRejection.
            const unhandledRejections: unknown[] = [];
            const onUnhandledRejection = (reason: unknown) => {
                unhandledRejections.push(reason);
            };
            // Listen at the process level — the rejection escapes on a later
            // event-loop tick, not in the same synchronous frame as the abort,
            // so the listener must survive the drain below before it is
            // removed (a premature removal would make the assertion vacuous).
            process.on("unhandledRejection", onUnhandledRejection);

            const hitlTaskStore: OrchestratorTaskStore = {
                updateStatus: (tid, status) => {
                    if (status === "awaiting_input") {
                        // Fire the abort handler synchronously (it rejects
                        // userInputPromise), then fail the write.
                        controller.abort();
                        throw new Error("simulated write failure during abort");
                    }
                },
                appendEvent: () => { /* no-op: test stub */ },
                unregisterCancellation: () => { /* no-op: test stub */ },
            };

            const hitlProvider: LLMProvider = {
                chat: async (): Promise<ProviderChatResponse> => {
                    return {
                        message: {
                            id: generateId(),
                            sessionId: ctx.sessionId,
                            role: "assistant",
                            content: "",
                            toolCalls: [
                                {
                                    id: generateId(),
                                    server: "builtin",
                                    tool: "request_human_input",
                                    arguments: { prompt: "do you confirm?" },
                                },
                            ],
                            createdAt: nowIso(),
                        },
                        stopReason: "tool_calls",
                    };
                },
            };

            try {
                await expect(
                    orch.run({
                        executionContext: ctx,
                        messages: [makeUserMessage(ctx.sessionId)],
                        registry,
                        provider: hitlProvider,
                        policy,
                        taskStore: hitlTaskStore,
                        sessionStore,
                        signal: controller.signal,
                        taskId,
                    })
                ).rejects.toThrow("simulated write failure during abort");
            } finally {
                // Drain macro/microtask queues so a pre-fix unhandledRejection
                // (emitted on a later tick) is observed by the listener before
                // it is removed — no vacuous pass on timing.
                await new Promise((resolve) => setTimeout(resolve, 20));
                process.removeListener(
                    "unhandledRejection",
                    onUnhandledRejection
                );
            }

            expect(
                unhandledRejections,
                "the abort-race rejection of userInputPromise must be marked handled"
            ).toEqual([]);
        }, 10_000);
    });
});
