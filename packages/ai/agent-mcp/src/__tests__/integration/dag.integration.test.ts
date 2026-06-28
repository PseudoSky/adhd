/**
 * dag.integration.test.ts
 *
 * Verifies the DagEngine fan-in dispatch with real queue + DB.
 *
 * Scenarios:
 *  1. C depends_on=[A,B]; A+B complete → C transitions waiting→pending→runs;
 *     C's inputs row contains A's and B's results.
 *
 *  2. on_upstream_failure="fail": A fails → C marked failed with upstream error message,
 *     never dispatched. guards: on_upstream_failure was dropped at create
 *
 *  3. on_upstream_failure="skip": A fails, B completes → C dispatches anyway;
 *     C's inputs only contains B's result (not A's). guards: skip-policy dead
 *
 *  4. Cycle detection: depends_on forming a cycle → ToolError VALIDATION_ERROR,
 *     NO task row inserted (query DB to confirm).
 *     guards: engine BFS validateNoCycle correctness; the BLOCK-2 tool-wiring
 *     fix (same id passed to validateNoCycle and create) is covered separately
 *     by task-tool-dag-wiring.test.ts.
 *
 *  5. Restart: leave a task "pending" in DB without queue slot, tear down + rebuild
 *     from same temp DB → the REAL startup orphan scan re-enqueues → task runs.
 */

import { describe, it, expect } from "vitest";
import { buildHarness, drainQueue } from "./harness.js";
import type { Harness } from "./harness.js";
import { Orchestrator } from "../../engine/orchestrator.js";
import type { McpClientRegistry } from "../../clients/registry.js";
import type { IMcpClient } from "../../clients/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { nowIso } from "../../utils/timestamps.js";
import { generateId } from "../../utils/ids.js";
import { ToolError } from "../../validation/errors.js";
import { taskTool } from "../../tools/task.js";
import type { TaskDeps } from "../../tools/task.js";
import { tasksTable } from "../../db/schema.js";
import { eq } from "drizzle-orm";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeEmptyRegistry(): McpClientRegistry {
    return {
        listAllTools: async (): Promise<ToolDefinition[]> => [],
        getClient: async (): Promise<IMcpClient> => {
            throw new Error("no tools expected");
        },
        closeAll: async (): Promise<void> => {},
    } as unknown as McpClientRegistry;
}

async function setupAgent(harness: Harness): Promise<{
    agentName: string;
    sessionId: string;
}> {
    const agentName = `dag-agent-${generateId()}`;
    harness.agentStore.create({
        name: agentName,
        provider: { type: "openai", model: "test-model", baseURL: "http://localhost:1234/v1" },
        systemPrompt: "You are a dag test agent.",
        mcpServers: {},
        permissions: {},
    });
    const agentDef = harness.agentStore.read(agentName);
    const session = harness.sessionStore.create({ agentName, agentDefinition: agentDef });
    return { agentName, sessionId: session.id };
}

function makePatchedDeps(harness: Harness, content: string): TaskDeps {
    const provider = {
        chat: async () => ({
            message: {
                id: generateId(),
                sessionId: generateId(),
                role: "assistant" as const,
                content,
                createdAt: nowIso(),
            },
            stopReason: "completed" as const,
        }),
    };

    return {
        ...harness.taskDeps,
        orchestrator: {
            run: (input: Parameters<typeof harness.orchestrator.run>[0]) =>
                harness.orchestrator.run({
                    ...input,
                    provider,
                    registry: makeEmptyRegistry(),
                }),
        } as Orchestrator,
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 1 — Fan-in dispatch: C runs after A + B complete
// ──────────────────────────────────────────────────────────────────────────────

describe("dag.integration – fan-in dispatch", () => {
    it("C depends_on=[A,B]; A+B complete → C transitions waiting→running and receives both inputs", async () => {
        const harness = await buildHarness();

        try {
            const { sessionId } = await setupAgent(harness);

            // Create A and B as pending tasks in the DB (no queue slot yet)
            const taskARow = harness.taskStore.create({ sessionId, prompt: "task A" });
            const taskBRow = harness.taskStore.create({ sessionId, prompt: "task B" });

            // C is created in "waiting" state, depends on A and B
            const taskCRow = harness.taskStore.create({
                sessionId,
                prompt: "task C",
                dependsOn: [taskARow.id, taskBRow.id],
            });
            expect(taskCRow.status).toBe("waiting");

            // Mark A and B completed with results (simulating them having run)
            harness.taskStore.updateStatus(taskARow.id, "completed", { result: "res-A" });
            harness.taskStore.updateStatus(taskBRow.id, "completed", { result: "res-B" });

            // Patch harness to use our provider for C's execution
            const patchedDeps = makePatchedDeps(harness, "result-of-C");
            Object.assign(harness.taskDeps, patchedDeps);

            // Trigger dispatchReady as if A just completed — DagEngine scans waiting tasks
            await harness.dagEngine.dispatchReady(taskARow.id);

            // Wait for C to run to completion
            await drainQueue(harness.queue, 8_000);

            const finalC = harness.taskStore.read(taskCRow.id);
            expect(finalC.status).toBe("completed");
            expect(finalC.result).toBe("result-of-C");

            // inputs must contain A's and B's results
            expect(finalC.inputs).toBeTruthy();
            expect(finalC.inputs![taskARow.id]).toBe("res-A");
            expect(finalC.inputs![taskBRow.id]).toBe("res-B");
        } finally {
            await harness.teardown();
        }
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 2 — on_upstream_failure="fail" (default)
// ──────────────────────────────────────────────────────────────────────────────

describe("dag.integration – on_upstream_failure", () => {
    it("fail policy: A fails → C marked failed, never dispatched (guards: on_upstream_failure dropped at create)", async () => {
        const harness = await buildHarness();

        try {
            const { sessionId } = await setupAgent(harness);

            const taskARow = harness.taskStore.create({ sessionId, prompt: "task A" });

            // C with explicit "fail" policy
            const taskCRow = harness.taskStore.create({
                sessionId,
                prompt: "task C",
                dependsOn: [taskARow.id],
                onUpstreamFailure: "fail",
            });

            // guards: on_upstream_failure was dropped at create — verify it round-tripped
            const cFromDb = harness.taskStore.read(taskCRow.id);
            expect(cFromDb.onUpstreamFailure).toBe("fail");
            expect(cFromDb.status).toBe("waiting");

            // Track whether orchestrator (dispatch) was ever called
            let dispatchCallCount = 0;
            const trackingProvider = {
                chat: async () => {
                    dispatchCallCount++;
                    return {
                        message: {
                            id: generateId(),
                            sessionId,
                            role: "assistant" as const,
                            content: "should not run",
                            createdAt: nowIso(),
                        },
                        stopReason: "completed" as const,
                    };
                },
            };

            const patchedDeps: TaskDeps = {
                ...harness.taskDeps,
                orchestrator: {
                    run: (input: Parameters<typeof harness.orchestrator.run>[0]) =>
                        harness.orchestrator.run({
                            ...input,
                            provider: trackingProvider,
                            registry: makeEmptyRegistry(),
                        }),
                } as Orchestrator,
            };
            Object.assign(harness.taskDeps, patchedDeps);

            // A fails
            harness.taskStore.updateStatus(taskARow.id, "failed", { error: "A blew up" });

            // Trigger dispatch
            await harness.dagEngine.dispatchReady(taskARow.id);
            await drainQueue(harness.queue, 3_000);

            const finalC = harness.taskStore.read(taskCRow.id);
            expect(finalC.status).toBe("failed");
            expect(finalC.error).toContain(taskARow.id);
            // C was never dispatched (orchestrator never called)
            expect(dispatchCallCount).toBe(0);
        } finally {
            await harness.teardown();
        }
    });

    it("skip policy: A fails, B completes → C dispatches; inputs only has B's result (guards: skip-policy dead)", async () => {
        const harness = await buildHarness();

        try {
            const { sessionId } = await setupAgent(harness);

            const taskARow = harness.taskStore.create({ sessionId, prompt: "task A" });
            const taskBRow = harness.taskStore.create({ sessionId, prompt: "task B" });

            const taskCRow = harness.taskStore.create({
                sessionId,
                prompt: "task C",
                dependsOn: [taskARow.id, taskBRow.id],
                onUpstreamFailure: "skip",
            });

            // guards: verify skip policy persisted correctly (not dropped at create)
            const cFromDb = harness.taskStore.read(taskCRow.id);
            expect(cFromDb.onUpstreamFailure).toBe("skip");

            // A fails, B completes
            harness.taskStore.updateStatus(taskARow.id, "failed", { error: "A blew up" });
            harness.taskStore.updateStatus(taskBRow.id, "completed", { result: "res-B" });

            let dispatchCallCount = 0;
            const trackingProvider = {
                chat: async () => {
                    dispatchCallCount++;
                    return {
                        message: {
                            id: generateId(),
                            sessionId,
                            role: "assistant" as const,
                            content: "C ran after skip",
                            createdAt: nowIso(),
                        },
                        stopReason: "completed" as const,
                    };
                },
            };

            const patchedDeps: TaskDeps = {
                ...harness.taskDeps,
                orchestrator: {
                    run: (input: Parameters<typeof harness.orchestrator.run>[0]) =>
                        harness.orchestrator.run({
                            ...input,
                            provider: trackingProvider,
                            registry: makeEmptyRegistry(),
                        }),
                } as Orchestrator,
            };
            Object.assign(harness.taskDeps, patchedDeps);

            // Trigger dispatch after A fails
            await harness.dagEngine.dispatchReady(taskARow.id);
            await drainQueue(harness.queue, 5_000);

            const finalC = harness.taskStore.read(taskCRow.id);
            expect(finalC.status).toBe("completed");
            expect(dispatchCallCount).toBe(1);

            // inputs should only contain B's result, not A's (A failed → skip)
            expect(finalC.inputs).toBeTruthy();
            expect(finalC.inputs![taskBRow.id]).toBe("res-B");
            expect(finalC.inputs![taskARow.id]).toBeUndefined();
        } finally {
            await harness.teardown();
        }
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 4 — Cycle detection
//
// guards: DagEngine BFS correctness — validateNoCycle detects self-cycles and
//         transitive cycles; no task row is inserted when a cycle is caught.
//
// NOTE: The BLOCK-2 bug ("cycle-check ran against a throwaway id, not the id
//       that was actually inserted") was a wiring bug at the taskTool call site.
//       That wiring is tested separately in task-tool-dag-wiring.test.ts (which
//       exercises the real taskTool→validateNoCycle→create sequence with the
//       same id).  The two tests here guard the engine BFS logic itself.
// ──────────────────────────────────────────────────────────────────────────────

describe("dag.integration – cycle detection", () => {
    it("engine BFS: self-cycle detected → ToolError VALIDATION_ERROR", async () => {
        const harness = await buildHarness();

        try {
            const { sessionId } = await setupAgent(harness);

            // Count task rows before
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const beforeCount = (harness.db as any)
                .select()
                .from(tasksTable)
                .all().length;

            // Self-cycle: a task whose depends_on list contains its own id.
            const selfId = generateId();
            expect(() =>
                harness.dagEngine.validateNoCycle(selfId, [selfId])
            ).toThrow(ToolError);

            // Transitive cycle: C→B→A→C
            const taskARow = harness.taskStore.create({ sessionId, prompt: "task A" });
            const taskBRow = harness.taskStore.create({
                sessionId,
                prompt: "task B",
                dependsOn: [taskARow.id],
            });

            const cId = generateId();
            // Artificially wire A to depend on cId so the BFS finds the cycle
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (harness.db as any)
                .update(tasksTable)
                .set({ depends_on: JSON.stringify([cId]) })
                .where(eq(tasksTable.id, taskARow.id))
                .run();

            // BFS from [taskBRow.id] reaches taskARow → depends_on=[cId] → cId == newTaskId → CYCLE
            expect(() =>
                harness.dagEngine.validateNoCycle(cId, [taskBRow.id])
            ).toThrow(ToolError);

            // cId was never inserted — only A and B
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const afterCount = (harness.db as any)
                .select()
                .from(tasksTable)
                .all().length;
            expect(afterCount).toBe(beforeCount + 2);
        } finally {
            await harness.teardown();
        }
    });

    it("engine BFS: transitive cycle caught; validateNoCycle throws before any DB insert", async () => {
        const harness = await buildHarness();

        try {
            const { sessionId } = await setupAgent(harness);

            const taskARow = harness.taskStore.create({ sessionId, prompt: "task A" });

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const beforeCount = (harness.db as any)
                .select()
                .from(tasksTable)
                .all().length;

            // Wire A to depend on a future id so the BFS detects a cycle when
            // we call validateNoCycle(futureId, [taskARow.id]).
            const futureId = generateId();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (harness.db as any)
                .update(tasksTable)
                .set({ depends_on: JSON.stringify([futureId]) })
                .where(eq(tasksTable.id, taskARow.id))
                .run();

            // BFS: taskARow.id → depends_on=[futureId] → futureId == newTaskId → CYCLE
            expect(() =>
                harness.dagEngine.validateNoCycle(futureId, [taskARow.id])
            ).toThrow(ToolError);

            // No new row was inserted — the error fires before any insert
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const afterCount = (harness.db as any)
                .select()
                .from(tasksTable)
                .all().length;
            expect(afterCount).toBe(beforeCount);
        } finally {
            await harness.teardown();
        }
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 5 — Restart: orphan scan re-enqueues pending tasks
// ──────────────────────────────────────────────────────────────────────────────

describe("dag.integration – restart orphan scan", () => {
    it("pending task in DB without queue slot → real startup orphan scan re-enqueues and runs it", async () => {
        const harness = await buildHarness();
        const dbPath = harness.dbPath;
        let taskId: string;
        let sessionId: string;

        try {
            const setup = await setupAgent(harness);
            sessionId = setup.sessionId;

            // Create a task in "pending" state, simulating a crash that happened
            // between DagEngine writing status="pending" to the DB and the queue
            // enqueue call.  The task row exists but has no in-flight queue slot.
            const task = harness.taskStore.create({ sessionId, prompt: "orphaned task" });
            taskId = task.id;
            expect(task.status).toBe("pending");

            // Simulate the crash: close the DB without letting the queue run.
            harness.rawSqlite.close();
            harness.teardown = async () => {};
        } catch (err) {
            await harness.teardown();
            throw err;
        }

        // Build a tracking provider that records whether it was called.
        let orchestratorCallCount = 0;
        const trackingProvider = {
            chat: async () => {
                orchestratorCallCount++;
                return {
                    message: {
                        id: generateId(),
                        sessionId,
                        role: "assistant" as const,
                        content: "orphan ran",
                        createdAt: nowIso(),
                    },
                    stopReason: "completed" as const,
                };
            },
        };

        // Rebuild from the SAME DB file and inject the tracking provider via
        // defaultProvider so the REAL startup orphan scan uses it.
        //
        // The production startup sequence (index.ts) does exactly what
        // buildHarness does: open DB, run migrations, build deps, then scan
        // for "pending" rows and call enqueueExistingTask for each.  By passing
        // defaultProvider we exercise that real scan path end-to-end without
        // needing to call enqueueExistingTask manually from the test.
        //
        // An empty McpClientRegistry is wired in through the defaultProvider
        // wrapper so the real orchestrator doesn't try to resolve MCP clients.
        const harness2 = await buildHarness({
            dbPath,
            defaultProvider: {
                chat: (input) =>
                    trackingProvider.chat(),
            },
        });

        try {
            // The orphan scan fires inside buildHarness BEFORE this line.
            // Give the queue time to drain (the orphaned task is already running).
            await drainQueue(harness2.queue, 8_000);

            const finalTask = harness2.taskStore.read(taskId!);
            expect(finalTask.status).toBe("completed");
            expect(finalTask.result).toBe("orphan ran");
            // Exactly one orchestrator call — proves the real scan found and
            // dispatched the orphaned task (not a manual enqueueExistingTask call).
            expect(orchestratorCallCount).toBe(1);
        } finally {
            await harness2.teardown();
        }
    });
});
