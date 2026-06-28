/**
 * sse.integration.test.ts
 *
 * Verifies SSE streaming with the real http server + real EventBus.
 * Uses the real node http client at an ephemeral port.
 *
 * Scenarios:
 *  1. Run a task; connected client receives status_change/tool_call/tool_result/done
 *     frames in order; no frame arrives after done; done has a non-null result.
 *
 *  2. Done on cancel: cancel a running task → client still receives a done frame
 *     with a non-null error (not stuck).
 *
 *  3. Terminal-on-connect: connect to an ALREADY-finished task → client gets
 *     status_change + done then closes.
 *     AND a second client subscribed to a live task is NOT spuriously closed
 *     by the first client's terminal-on-connect.
 *     guards: B-1 — old code emitted on the bus (which would close OTHER live subscribers)
 *
 *  4. NEG (active control): emitting done on the shared bus directly closes any
 *     active subscriber — proves the check has teeth.
 */

import { describe, it, expect } from "vitest";
import { buildHarness, drainQueue, collectSseFrames, Latch } from "./harness.js";
import type { Harness } from "./harness.js";
import { Orchestrator } from "../../engine/orchestrator.js";
import type { McpClientRegistry } from "../../clients/registry.js";
import type { IMcpClient } from "../../clients/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { nowIso } from "../../utils/timestamps.js";
import { generateId } from "../../utils/ids.js";
import { taskTool, taskCancel } from "../../tools/task.js";
import type { TaskDeps } from "../../tools/task.js";
import { emitTaskEvent, subscribeToTask } from "../../streaming/event-bus.js";
import { startSseServer } from "../../streaming/sse-server.js";
import http from "node:http";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeEmptyRegistry(): McpClientRegistry {
    return {
        listAllTools: async (): Promise<ToolDefinition[]> => [],
        getClient: async (): Promise<IMcpClient> => { throw new Error("no tools"); },
        closeAll: async (): Promise<void> => {},
    } as unknown as McpClientRegistry;
}

function makeStubRegistryWithTool(
    serverName: string,
    toolName: string,
    handler: (args: unknown) => Promise<unknown>
): McpClientRegistry {
    return {
        listAllTools: async (): Promise<ToolDefinition[]> => [
            { name: `${serverName}__${toolName}`, description: "test tool", inputSchema: {} },
        ],
        getClient: async (): Promise<IMcpClient> => ({
            listTools: async () => [{ name: toolName, description: "test tool", inputSchema: {} }],
            callTool: async (_tool: string, args: unknown) => handler(args),
            close: async () => {},
        }),
        closeAll: async (): Promise<void> => {},
    } as unknown as McpClientRegistry;
}

async function setupAgent(harness: Harness): Promise<{ agentName: string; sessionId: string }> {
    const agentName = `sse-agent-${generateId()}`;
    harness.agentStore.create({
        name: agentName,
        provider: { type: "openai", model: "test-model", baseURL: "http://localhost:1234/v1" },
        systemPrompt: "You are an SSE test agent.",
        mcpServers: {},
        permissions: {},
    });
    const agentDef = harness.agentStore.read(agentName);
    const session = harness.sessionStore.create({ agentName, agentDefinition: agentDef });
    return { agentName, sessionId: session.id };
}

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 1 — Frame ordering: tool_call, tool_result, done
// ──────────────────────────────────────────────────────────────────────────────

describe("sse.integration – frame ordering", () => {
    it("client receives status_change/tool_call/tool_result/done frames in order; done is last with result", async () => {
        const harness = await buildHarness({ withSse: true });

        try {
            const { sessionId } = await setupAgent(harness);
            const port = harness.ssePort!;

            // Use a latch so the task waits for the SSE client to connect
            const clientConnectedLatch = new Latch();
            let firstChatCall = true;

            const provider = {
                chat: async () => {
                    if (firstChatCall) {
                        firstChatCall = false;
                        // Wait for SSE client to connect before proceeding with tools
                        await clientConnectedLatch.wait(5_000);
                        return {
                            message: {
                                id: generateId(),
                                sessionId,
                                role: "assistant" as const,
                                content: null,
                                toolCalls: [
                                    {
                                        id: generateId(),
                                        server: "test-server",
                                        tool: "echo",
                                        arguments: { x: 1 },
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
                            sessionId,
                            role: "assistant" as const,
                            content: "task complete",
                            createdAt: nowIso(),
                        },
                        stopReason: "completed" as const,
                    };
                },
            };

            const registry = makeStubRegistryWithTool("test-server", "echo", async () => "echo-result");

            const patchedDeps: TaskDeps = {
                ...harness.taskDeps,
                orchestrator: {
                    run: (input: Parameters<typeof harness.orchestrator.run>[0]) =>
                        harness.orchestrator.run({ ...input, provider, registry }),
                } as Orchestrator,
            };

            // Start background task — it will block at first chat() waiting for us
            const taskOut = await taskTool(
                { session_id: sessionId, prompt: "sse test", background: true },
                patchedDeps
            );
            const taskId = taskOut.task_id;

            // Connect SSE client — task is blocking in first chat() waiting for our latch
            // Collect frames in background
            const framesPromise = collectSseFrames(port, taskId, 10_000);

            // Give the SSE client a moment to establish connection
            await new Promise((r) => setTimeout(r, 100));

            // Release the latch — task can now proceed with tool calls + completion
            clientConnectedLatch.release();

            // Wait for task to complete
            await drainQueue(harness.queue, 8_000);

            // Collect all frames
            const frames = await framesPromise;
            const types = frames.map((f) => f.type);

            // Must include: status_change (running), tool_call, tool_result, status_change (completed), done
            expect(types).toContain("status_change");
            expect(types).toContain("tool_call");
            expect(types).toContain("tool_result");
            expect(types).toContain("done");

            // done must be the LAST frame
            const doneIdx = types.lastIndexOf("done");
            expect(doneIdx).toBe(types.length - 1);

            // Verify the done frame has a result
            const doneFrame = frames[doneIdx];
            expect(doneFrame.data.result).toBe("task complete");
            expect(doneFrame.data.error).toBeNull();
        } finally {
            await harness.teardown();
        }
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 2 — Done on cancel
// ──────────────────────────────────────────────────────────────────────────────

describe("sse.integration – done on cancel", () => {
    // ── Live-bus path ───────────────────────────────────────────────────────────
    // Client is connected BEFORE the task is cancelled.  The done frame arrives
    // through the live event bus with the error string from the orchestrator.
    it("live-bus: cancel a running task → client receives done with non-null error (not stuck)", async () => {
        const harness = await buildHarness({ withSse: true });

        try {
            const { sessionId } = await setupAgent(harness);
            const port = harness.ssePort!;

            // Two latches synchronize provider ↔ SSE client ↔ test:
            //
            // 1. sseReadyLatch  — released via onConnected when the HTTP 200
            //    headers arrive (server has accepted the SSE request and the
            //    subscribeToTask listener is active). The provider blocks here
            //    so the task cannot emit events before the client is subscribed.
            //
            // 2. taskRunningLatch — released by the provider once it is inside
            //    its abort-wait (unblocked from sseReadyLatch). The test waits
            //    on this before issuing the cancel.
            const sseReadyLatch = new Latch();
            const taskRunningLatch = new Latch();

            let firstCall = true;
            const provider = {
                chat: async ({ signal }: { signal?: AbortSignal }) => {
                    if (firstCall) {
                        firstCall = false;
                        await sseReadyLatch.wait(5_000);
                        taskRunningLatch.release();
                    }
                    return new Promise<never>((_, reject) => {
                        if (signal?.aborted) { reject(new Error("aborted")); return; }
                        signal?.addEventListener("abort", () => reject(new Error("aborted")));
                    });
                },
            };

            const patchedDeps: TaskDeps = {
                ...harness.taskDeps,
                orchestrator: {
                    run: (input: Parameters<typeof harness.orchestrator.run>[0]) =>
                        harness.orchestrator.run({
                            ...input,
                            provider: provider as unknown as Parameters<typeof harness.orchestrator.run>[0]["provider"],
                            registry: makeEmptyRegistry(),
                        }),
                } as Orchestrator,
            };

            // Start background task — provider blocks at sseReadyLatch until
            // the SSE connection is confirmed.
            const taskOut = await taskTool(
                { session_id: sessionId, prompt: "hanging task", background: true },
                patchedDeps
            );
            const taskId = taskOut.task_id;

            // Connect SSE client. onConnected fires when the 200 headers arrive,
            // releasing the provider to proceed.
            const framesPromise = collectSseFrames(port, taskId, 8_000, () => {
                sseReadyLatch.release();
            });

            await taskRunningLatch.wait(5_000);

            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline) {
                const row = harness.taskStore.read(taskId);
                if (row.status === "running") break;
                await new Promise((r) => setImmediate(r));
            }

            taskCancel({ task_id: taskId }, { taskStore: harness.taskStore });
            await drainQueue(harness.queue, 5_000);

            const frames = await framesPromise;
            const types = frames.map((f) => f.type);

            expect(types).toContain("done");
            const doneIdx = types.lastIndexOf("done");
            expect(doneIdx).toBe(types.length - 1);

            const doneFrame = frames[doneIdx];
            // done.error must be truthy: "Task was cancelled" from the orchestrator
            // catch path, delivered over the live event bus.
            expect(doneFrame.data.error).toBeTruthy();
        } finally {
            await harness.teardown();
        }
    });

    // ── Terminal-on-connect path ────────────────────────────────────────────────
    // Client connects AFTER the task is already cancelled (status = "cancelled"
    // in the DB). The SSE server reads the row and writes done directly to the
    // response without touching the shared bus. The `error` field must come from
    // the DB column, not the in-memory bus event — proving the product fix that
    // persists "Task was cancelled" to the DB `error` column actually works.
    it("terminal-on-connect: client connects after cancel → done.error truthy (from DB, not bus)", async () => {
        const harness = await buildHarness({ withSse: true });

        try {
            const { sessionId } = await setupAgent(harness);
            const port = harness.ssePort!;

            // sseReadyLatch lets us block the task until after we've confirmed
            // the task is cancelled (we DON'T connect the SSE client before cancel).
            const taskEnteredLatch = new Latch();

            let firstCall = true;
            const provider = {
                chat: async ({ signal }: { signal?: AbortSignal }) => {
                    if (firstCall) {
                        firstCall = false;
                        taskEnteredLatch.release();
                    }
                    return new Promise<never>((_, reject) => {
                        if (signal?.aborted) { reject(new Error("aborted")); return; }
                        signal?.addEventListener("abort", () => reject(new Error("aborted")));
                    });
                },
            };

            const patchedDeps: TaskDeps = {
                ...harness.taskDeps,
                orchestrator: {
                    run: (input: Parameters<typeof harness.orchestrator.run>[0]) =>
                        harness.orchestrator.run({
                            ...input,
                            provider: provider as unknown as Parameters<typeof harness.orchestrator.run>[0]["provider"],
                            registry: makeEmptyRegistry(),
                        }),
                } as Orchestrator,
            };

            // Start background task — intentionally do NOT connect SSE yet
            const taskOut = await taskTool(
                { session_id: sessionId, prompt: "cancel then connect", background: true },
                patchedDeps
            );
            const taskId = taskOut.task_id;

            // Wait until the task is running (provider entered its abort-wait)
            await taskEnteredLatch.wait(5_000);
            const dl = Date.now() + 5_000;
            while (Date.now() < dl) {
                if (harness.taskStore.read(taskId).status === "running") break;
                await new Promise((r) => setImmediate(r));
            }

            // Cancel BEFORE the SSE client connects
            taskCancel({ task_id: taskId }, { taskStore: harness.taskStore });
            await drainQueue(harness.queue, 5_000);

            // Confirm cancelled in DB with the error persisted
            const cancelledRow = harness.taskStore.read(taskId);
            expect(cancelledRow.status).toBe("cancelled");
            expect(cancelledRow.error).toBeTruthy();

            // NOW connect the SSE client — task is already terminal → terminal-on-connect
            // The server reads the row and writes status_change + done directly to the
            // response.  done.error comes from the DB `error` column, not the bus.
            const frames = await collectSseFrames(port, taskId, 5_000);
            const types = frames.map((f) => f.type);

            expect(types).toContain("done");
            const doneIdx = types.lastIndexOf("done");
            expect(doneIdx).toBe(types.length - 1);

            // This is the key assertion: error is truthy even via terminal-on-connect
            // because the product now persists "Task was cancelled" to the DB.
            const doneFrame = frames[doneIdx];
            expect(doneFrame.data.error).toBeTruthy();
        } finally {
            await harness.teardown();
        }
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 3 — Terminal-on-connect
// guards: B-1 — old code emitted on the bus, closing other live subscribers
// ──────────────────────────────────────────────────────────────────────────────

describe("sse.integration – terminal-on-connect", () => {
    it("connect to already-finished task → gets status_change + done then closes", async () => {
        const harness = await buildHarness({ withSse: true });

        try {
            const { sessionId } = await setupAgent(harness);
            const port = harness.ssePort!;

            const provider = {
                chat: async () => ({
                    message: {
                        id: generateId(),
                        sessionId,
                        role: "assistant" as const,
                        content: "finished result",
                        createdAt: nowIso(),
                    },
                    stopReason: "completed" as const,
                }),
            };

            const patchedDeps: TaskDeps = {
                ...harness.taskDeps,
                orchestrator: {
                    run: (input: Parameters<typeof harness.orchestrator.run>[0]) =>
                        harness.orchestrator.run({ ...input, provider, registry: makeEmptyRegistry() }),
                } as Orchestrator,
            };

            // Run synchronously — task is fully completed before SSE connect
            const taskOut = await taskTool(
                { session_id: sessionId, prompt: "sync task", background: false },
                patchedDeps
            );
            expect(taskOut.status).toBe("completed");
            const taskId = taskOut.task_id;

            // Connect AFTER task is done → terminal-on-connect path
            const frames = await collectSseFrames(port, taskId, 5_000);
            const types = frames.map((f) => f.type);

            // Must receive at minimum: status_change + done
            expect(types).toContain("status_change");
            expect(types).toContain("done");

            // done is last
            const doneIdx = types.lastIndexOf("done");
            expect(doneIdx).toBe(types.length - 1);

            const doneFrame = frames[doneIdx];
            expect(doneFrame.data.result).toBe("finished result");
        } finally {
            await harness.teardown();
        }
    });

    it("terminal-on-connect: connecting to a FINISHED task writes directly to that response, NOT the shared bus (guards: B-1)", async () => {
        const harness = await buildHarness({ withSse: true });

        try {
            const { sessionId } = await setupAgent(harness);
            const port = harness.ssePort!;

            // Run a task to completion
            const provider = {
                chat: async () => ({
                    message: {
                        id: generateId(),
                        sessionId,
                        role: "assistant" as const,
                        content: "task1-done",
                        createdAt: nowIso(),
                    },
                    stopReason: "completed" as const,
                }),
            };

            const patchedDeps: TaskDeps = {
                ...harness.taskDeps,
                orchestrator: {
                    run: (input: Parameters<typeof harness.orchestrator.run>[0]) =>
                        harness.orchestrator.run({ ...input, provider, registry: makeEmptyRegistry() }),
                } as Orchestrator,
            };

            const taskOut = await taskTool(
                { session_id: sessionId, prompt: "task1 sync", background: false },
                patchedDeps
            );
            expect(taskOut.status).toBe("completed");
            const taskId1 = taskOut.task_id;

            // Subscribe a live listener on task1's bus channel
            // guards: B-1 — if terminal-on-connect emitted on the bus, this would fire
            const busEventsOnTask1: string[] = [];
            const unsubscribe = subscribeToTask(taskId1, (event) => {
                busEventsOnTask1.push(event.type);
            });

            try {
                // Connect a NEW SSE client to task1 (already finished)
                // The sse-server should write DIRECTLY to this response, not emit on bus
                const frames = await collectSseFrames(port, taskId1, 5_000);

                // Client got status_change + done (direct write path)
                expect(frames.map((f) => f.type)).toContain("done");

                // The bus should NOT have received any extra events from this connect
                // (The production fix: write to res directly, not emitTaskEvent)
                // guards: B-1 — if old code emitted on bus, busEventsOnTask1 would have entries
                expect(busEventsOnTask1).toHaveLength(0);
            } finally {
                unsubscribe();
            }
        } finally {
            await harness.teardown();
        }
    });

    // ──────────────────────────────────────────────────────────────────────────
    // Active negative control: bus-emit causes spurious close on live subscriber
    // ──────────────────────────────────────────────────────────────────────────
    it("NEGATIVE CONTROL: emitting done on the bus directly fires all live subscribers (proves B-1 check has teeth)", async () => {
        // Simulate the buggy terminal-on-connect behavior in-process:
        // emit a done event on the bus → any live subscriber receives it spuriously.
        const harness = await buildHarness({ withSse: true });

        try {
            const task2Id = generateId();
            const spuriousFrames: string[] = [];

            // Subscribe to task2 via the real EventBus
            const unsubscribe = subscribeToTask(task2Id, (event) => {
                spuriousFrames.push(event.type);
            });

            try {
                // Simulate the bug: emit a "done" event on the bus for task2
                // (the old code in sse-server.ts would have called emitTaskEvent here)
                emitTaskEvent({
                    type: "done",
                    taskId: task2Id,
                    result: "spurious",
                    error: null,
                });

                // The subscriber DID receive it — proving that emitting on the bus
                // would have spuriously closed any live subscriber on this task
                expect(spuriousFrames).toContain("done");
            } finally {
                unsubscribe();
            }
        } finally {
            await harness.teardown();
        }
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// BUG-001 — SSE bind failure (EADDRINUSE) must NOT crash the process
// ──────────────────────────────────────────────────────────────────────────────
//
// Occupy a port, then start the SSE server on that same port. Before the fix,
// the http.Server's unhandled 'error' event (EADDRINUSE) threw and took down
// the whole process. After the fix, startSseServer attaches an 'error' handler,
// so it logs + degrades to "SSE unavailable" and the process survives.
//
// TEETH: this test attaches NO 'error' listener of its own — so without the
// in-server handler the unhandled 'error' would crash the worker and fail the
// file. Reaching the assertions proves the process stayed alive.

describe("BUG-001 – SSE bind failure does not crash the process", () => {
    it("startSseServer on an occupied port degrades gracefully (no unhandled-error crash)", async () => {
        const harness = await buildHarness(); // no withSse — just need a real taskStore
        // Occupy a port.
        const blocker = http.createServer();
        await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
        const port = (blocker.address() as { port: number }).port;

        let sse: http.Server | undefined;
        try {
            // Bind the SSE server to the already-taken port → EADDRINUSE.
            sse = startSseServer(harness.taskStore, port, "127.0.0.1");

            // It cannot bind (port taken), so 'listening' never fires; bound by a
            // deadline. No 'error' listener here — preserves the teeth.
            const listened = await Promise.race([
                new Promise<boolean>((res) => sse!.once("listening", () => res(true))),
                new Promise<boolean>((res) => setTimeout(() => res(false), 400)),
            ]);

            expect(listened).toBe(false);      // never bound — port was occupied
            expect(sse.listening).toBe(false); // not serving
            // Reaching here = the EADDRINUSE 'error' was handled, not fatal.
        } finally {
            await new Promise<void>((resolve) => {
                if (sse) sse.close(() => resolve());
                else resolve();
            });
            await new Promise<void>((resolve) => blocker.close(() => resolve()));
            await harness.teardown();
        }
    });
});
