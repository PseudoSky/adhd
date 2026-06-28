/**
 * hitl.integration.test.ts
 *
 * Verifies the Human-in-the-Loop (HITL) flow end-to-end with real components.
 *
 * Scenarios:
 *  1. request_human_input → task becomes "awaiting_input" + resume_token in DB
 *     BEFORE the await resolves; taskResume(token, input) → task completes with
 *     injected input as the tool result.
 *
 *  2. NEG: taskResume with wrong token → VALIDATION_ERROR
 *     NEG: taskResume when status not awaiting_input → VALIDATION_ERROR
 *
 *  3. Restart: clear in-memory resolvers (simulate process restart) → taskResume →
 *     TASK_NOT_RESUMABLE; task is auto-failed.
 *
 *  4. Cancel during HITL: taskCancel on awaiting_input task → abort signal rejects
 *     the suspension promise → task ends failed (not stuck).
 *     guards: awaiting_input added to cancellableStatuses + abort wiring
 */

import { describe, it, expect, afterEach } from "vitest";
import { buildHarness, drainQueue, taskResume, taskCancel } from "./harness.js";
import type { Harness } from "./harness.js";
import { Orchestrator, resolveHitl } from "../../engine/orchestrator.js";
import type { McpClientRegistry } from "../../clients/registry.js";
import type { IMcpClient } from "../../clients/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { PolicyEngine } from "../../engine/policy.js";
import { nowIso } from "../../utils/timestamps.js";
import { generateId } from "../../utils/ids.js";
import { taskTool } from "../../tools/task.js";
import type { TaskDeps } from "../../tools/task.js";
import { ToolError } from "../../validation/errors.js";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeEmptyRegistry(): McpClientRegistry {
    return {
        listAllTools: async (): Promise<ToolDefinition[]> => [],
        getClient: async (): Promise<IMcpClient> => { throw new Error("no tools"); },
        closeAll: async (): Promise<void> => { /* no-op: test stub */ },
    } as unknown as McpClientRegistry;
}

async function setupAgent(harness: Harness): Promise<{ agentName: string; sessionId: string }> {
    const agentName = `hitl-agent-${generateId()}`;
    harness.agentStore.create({
        name: agentName,
        provider: { type: "openai", model: "test-model", baseURL: "http://localhost:1234/v1" },
        systemPrompt: "You are a HITL test agent.",
        mcpServers: {},
        permissions: {},
    });
    const agentDef = harness.agentStore.read(agentName);
    const session = harness.sessionStore.create({ agentName, agentDefinition: agentDef });
    return { agentName, sessionId: session.id };
}

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 1 — Happy path HITL flow
// ──────────────────────────────────────────────────────────────────────────────

describe("hitl.integration – request_human_input happy path", () => {
    it("task suspends to awaiting_input + resume_token in DB BEFORE await resolves; taskResume completes task", async () => {
        const harness = await buildHarness();

        try {
            const { sessionId } = await setupAgent(harness);

            // Track HITL suspension: we need to read the DB while the task is suspended
            let suspendedDetected = false;
            let resumeTokenFromDb: string | undefined;

            // Provider: turn 1 = request_human_input; turn 2 = completed (after resume)
            let callCount = 0;
            const hitlProvider = {
                chat: async () => {
                    callCount++;
                    if (callCount === 1) {
                        return {
                            message: {
                                id: generateId(),
                                sessionId,
                                role: "assistant" as const,
                                content: null,
                                toolCalls: [
                                    {
                                        id: generateId(),
                                        server: "builtin",
                                        tool: "request_human_input",
                                        arguments: { prompt: "Please confirm" },
                                    },
                                ],
                                createdAt: nowIso(),
                            },
                            stopReason: "tool_calls" as const,
                        };
                    }
                    // Turn 2: after resume
                    return {
                        message: {
                            id: generateId(),
                            sessionId,
                            role: "assistant" as const,
                            content: "done after human input",
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
                            provider: hitlProvider,
                            registry: makeEmptyRegistry(),
                        }),
                } as Orchestrator,
            };

            // Launch as background — the task will suspend waiting for human input
            const taskOut = await taskTool(
                { session_id: sessionId, prompt: "trigger HITL", background: true },
                patchedDeps
            );
            const capturedTaskId = taskOut.task_id;

            // Wait for the task to reach awaiting_input status
            // Poll the DB — event-driven (no sleep): check in a tight loop with a bounded deadline
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline) {
                const row = harness.taskStore.read(capturedTaskId);
                if (row.status === "awaiting_input") {
                    suspendedDetected = true;
                    resumeTokenFromDb = row.resumeToken ?? undefined;
                    break;
                }
                await new Promise((r) => setImmediate(r));
            }

            expect(suspendedDetected).toBe(true);
            expect(resumeTokenFromDb).toBeTruthy();

            // Verify resume_token was written to DB BEFORE the promise resolved
            // (The task is still suspended — it hasn't returned yet)
            const taskRow = harness.taskStore.read(capturedTaskId);
            expect(taskRow.status).toBe("awaiting_input");
            expect(taskRow.resumeToken).toBe(resumeTokenFromDb);

            // Resume with correct token and user input
            const resumeResult = await taskResume(
                { taskId: capturedTaskId, resumeToken: resumeTokenFromDb!, userInput: "user says yes" },
                { taskStore: harness.taskStore }
            );
            expect(resumeResult.success).toBe(true);

            // Wait for the task to complete
            await drainQueue(harness.queue, 5_000);

            const finalRow = harness.taskStore.read(capturedTaskId);
            expect(finalRow.status).toBe("completed");
            expect(finalRow.result).toBe("done after human input");
        } finally {
            await harness.teardown();
        }
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 2 — Negative controls
// ──────────────────────────────────────────────────────────────────────────────

describe("hitl.integration – negative controls", () => {
    it("taskResume with wrong token → VALIDATION_ERROR", async () => {
        const harness = await buildHarness();

        try {
            const { sessionId } = await setupAgent(harness);

            // Get the task into awaiting_input
            const task = harness.taskStore.create({ sessionId, prompt: "hitl" });
            const correctToken = generateId();
            harness.taskStore.updateStatus(task.id, "awaiting_input", {
                resumeToken: correctToken,
            });

            const wrongToken = generateId(); // different UUID — wrong token
            await expect(
                taskResume(
                    {
                        taskId: task.id,
                        resumeToken: wrongToken,
                        userInput: "anything",
                    },
                    { taskStore: harness.taskStore }
                )
            ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        } finally {
            await harness.teardown();
        }
    });

    it("taskResume when task not in awaiting_input → VALIDATION_ERROR", async () => {
        const harness = await buildHarness();

        try {
            const { sessionId } = await setupAgent(harness);

            // Task is still pending
            const task = harness.taskStore.create({ sessionId, prompt: "not waiting" });

            await expect(
                taskResume(
                    {
                        taskId: task.id,
                        resumeToken: "aaaabbbb-1111-2222-3333-ccccddddeeee",
                        userInput: "anything",
                    },
                    { taskStore: harness.taskStore }
                )
            ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        } finally {
            await harness.teardown();
        }
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 3 — Restart: resolvers cleared → TASK_NOT_RESUMABLE
// ──────────────────────────────────────────────────────────────────────────────

describe("hitl.integration – restart clears in-memory resolvers", () => {
    it("taskResume after resolver cleared → TASK_NOT_RESUMABLE; task auto-failed", async () => {
        const harness = await buildHarness();

        try {
            const { sessionId } = await setupAgent(harness);

            // Put a task in awaiting_input state WITH a real resume token in DB
            // but WITHOUT registering an in-memory resolver (simulates process restart)
            const task = harness.taskStore.create({ sessionId, prompt: "hitl restart" });
            const realToken = generateId(); // real UUID
            harness.taskStore.updateStatus(task.id, "awaiting_input", {
                resumeToken: realToken,
            });

            // resolveHitl is the in-memory map — no resolver was registered (simulates restart)
            // taskResume will call resolveHitl() → returns false → TASK_NOT_RESUMABLE
            await expect(
                taskResume(
                    {
                        taskId: task.id,
                        resumeToken: realToken,
                        userInput: "too late",
                    },
                    { taskStore: harness.taskStore }
                )
            ).rejects.toMatchObject({ code: "TASK_NOT_RESUMABLE" });

            // Task should be auto-failed
            const finalRow = harness.taskStore.read(task.id);
            expect(finalRow.status).toBe("failed");
            expect(finalRow.error).toContain("server restarted");
        } finally {
            await harness.teardown();
        }
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 4 — Cancel during HITL
// guards: awaiting_input added to cancellableStatuses + abort wiring
// ──────────────────────────────────────────────────────────────────────────────

describe("hitl.integration – cancel during awaiting_input", () => {
    it("taskCancel on awaiting_input task → abort signal fires → task ends failed (not stuck)", async () => {
        const harness = await buildHarness();

        try {
            const { sessionId } = await setupAgent(harness);

            // Provider: suspends via HITL and never resumes on its own
            let callCount = 0;
            const hitlProvider = {
                chat: async () => {
                    callCount++;
                    if (callCount === 1) {
                        return {
                            message: {
                                id: generateId(),
                                sessionId,
                                role: "assistant" as const,
                                content: null,
                                toolCalls: [
                                    {
                                        id: generateId(),
                                        server: "builtin",
                                        tool: "request_human_input",
                                        arguments: { prompt: "waiting forever" },
                                    },
                                ],
                                createdAt: nowIso(),
                            },
                            stopReason: "tool_calls" as const,
                        };
                    }
                    // Should never reach here after cancel
                    return {
                        message: {
                            id: generateId(),
                            sessionId,
                            role: "assistant" as const,
                            content: "should not complete",
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
                            provider: hitlProvider,
                            registry: makeEmptyRegistry(),
                        }),
                } as Orchestrator,
            };

            // Start as background
            const taskOut = await taskTool(
                { session_id: sessionId, prompt: "trigger HITL then cancel", background: true },
                patchedDeps
            );
            const taskId = taskOut.task_id;

            // Wait for task to reach awaiting_input
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline) {
                const row = harness.taskStore.read(taskId);
                if (row.status === "awaiting_input") break;
                await new Promise((r) => setImmediate(r));
            }

            const suspendedRow = harness.taskStore.read(taskId);
            expect(suspendedRow.status).toBe("awaiting_input");

            // Cancel — guards: awaiting_input must be in cancellableStatuses
            const cancelResult = taskCancel({ task_id: taskId }, { taskStore: harness.taskStore });
            expect(cancelResult.success).toBe(true);

            // Wait for the abort to propagate through the orchestrator
            await drainQueue(harness.queue, 5_000);

            const finalRow = harness.taskStore.read(taskId);
            // The task should end in either "cancelled" or "failed" — not stuck in "awaiting_input"
            // (The abort signal causes the HITL promise to reject with PROVIDER_ERROR → "failed" path)
            expect(["cancelled", "failed"]).toContain(finalRow.status);
        } finally {
            await harness.teardown();
        }
    });
});
