/**
 * hitl-suspend-resume.e2e.test.ts
 *
 * DEBT-AGENTMCP-HITL-TEST-001 — agent-mcp HITL suspend/resume
 * (request_human_input / task_resume) had NO default-running behavioral test.
 * The scripted-provider 'hitl' fixture existed but was unused; the only HITL
 * coverage was the AUTHOR-ONLY live-oauth.e2e.test.ts (gated behind
 * AGENT_MCP_LIVE=1, real paid model).
 *
 * This file drives the REAL orchestrator + REAL taskTool/taskResume paths with
 * the ONLY stub being the LLM (ScriptedProvider 'hitl' fixture — exactly the
 * allowance the debt states). NO env gate: runs in default CI.
 *
 * Full chain asserted:
 *   1. task suspends → status 'awaiting_input', resumeToken persisted
 *      (orchestrator.ts suspend path: updateStatus + module-level hitlResolvers)
 *   2. taskResume validates status + resumeToken (wrong token → VALIDATION_ERROR)
 *   3. resume with the correct token → { success: true }, the suspended
 *      orchestrator.run wakes in-process (hitlResolvers map, no mocks)
 *   4. orchestrator continues → second scripted turn ('completed') → status
 *      'completed', result is the second turn's content ('confirmed')
 *   5. TOOL_CALL task_event recorded for request_human_input (with resumeToken)
 *
 * Ephemeral-task guard (orchestrator.ts) is not hit: harness tasks are DB-backed
 * (taskTool background path → TaskStore.create → real tasks row).
 */

import { describe, it, expect } from "vitest";
import { taskEventsTable } from "@adhd/agent-store-runtime";
import { ScriptedProvider } from "./scripted-provider.js";

describe("HITL suspend/resume (DEBT-AGENTMCP-HITL-TEST-001)", () => {
    it("suspends on request_human_input, resumes via task_resume, completes with the human-confirmed turn", async () => {
        const { buildHarness, enqueueTaskWithProvider, createSessionAndAgent, drainQueue, taskResume } =
            await import("./harness.js");
        const { eq } = await import("drizzle-orm");

        const scripted = new ScriptedProvider([
            { type: "hitl", prompt: "do you confirm?" },
            { type: "completed", content: "confirmed" },
        ]);

        const harness = await buildHarness({ defaultProvider: scripted });

        try {
            // allowHumanInput: true → builtin__request_human_input is advertised
            // (same precondition as the live test, live-oauth.e2e.test.ts:139)
            const { sessionId } = await createSessionAndAgent(harness, scripted, {
                allowHumanInput: true,
            });

            // Background → taskTool returns { task_id } immediately while the
            // orchestrator runs in the queue worker.
            const taskOut = await enqueueTaskWithProvider(
                harness,
                sessionId,
                "Ask the operator to confirm before answering.",
                scripted
            );
            const taskId = taskOut.task_id;

            // ── 1. Suspension ──────────────────────────────────────────────────
            // Bounded deadline loop mirroring live-oauth.e2e.test.ts:179-185.
            const deadline = Date.now() + 15_000;
            let row = harness.taskStore.read(taskId);
            while (Date.now() < deadline) {
                row = harness.taskStore.read(taskId);
                if (row.status === "awaiting_input") break;
                if (["completed", "failed", "cancelled"].includes(row.status)) break;
                await new Promise((r) => setTimeout(r, 100));
            }

            const suspended = harness.taskStore.read(taskId);
            expect(suspended.status, `task ${taskId} should suspend on request_human_input, got '${suspended.status}'`).toBe(
                "awaiting_input"
            );
            const resumeToken = suspended.resumeToken;
            expect(resumeToken, "awaiting_input task must carry a resumeToken").toBeTruthy();

            // ── 2. resumeToken validation (real tools/task.ts taskResume path) ─
            await expect(
                taskResume(
                    {
                        taskId,
                        resumeToken: "00000000-0000-4000-8000-000000000000",
                        userInput: "stale answer",
                    },
                    { taskStore: harness.taskStore }
                )
            ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

            // ── 3. Resume with the correct token ──────────────────────────────
            if (!resumeToken) throw new Error("expected resumeToken to be defined");
            const resumeOut = await taskResume(
                {
                    taskId,
                    resumeToken,
                    userInput: "yes",
                },
                { taskStore: harness.taskStore }
            );
            expect(resumeOut.success).toBe(true);

            // ── 4. Completion ─────────────────────────────────────────────────
            await drainQueue(harness.queue, 15_000);
            const final = harness.taskStore.read(taskId);
            expect(final.status).toBe("completed");
            // Orchestrator feeds the resumed user input back as the tool result
            // and loops → second scripted turn ('completed'/'confirmed') ends it.
            expect(final.result).toBe("confirmed");

            // ── 5. TOOL_CALL task_event for request_human_input ───────────────
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const db = harness.db as any;
            const events = db
                .select()
                .from(taskEventsTable)
                .where(eq(taskEventsTable.taskId, taskId))
                .all() as Array<{ type: string; payload: string | null }>;

            const hitlToolCalls = events.filter(
                (e) => e.type === "TOOL_CALL" && (e.payload ?? "").includes("request_human_input")
            );
            expect(
                hitlToolCalls.length,
                "a TOOL_CALL event for request_human_input must be recorded (orchestrator.ts:545-549)"
            ).toBeGreaterThanOrEqual(1);
            expect(
                (hitlToolCalls[0]?.payload ?? "").includes(resumeToken),
                "TOOL_CALL payload must carry the resumeToken of this suspension"
            ).toBe(true);
        } finally {
            await harness.teardown();
        }
    }, 60_000);
});
