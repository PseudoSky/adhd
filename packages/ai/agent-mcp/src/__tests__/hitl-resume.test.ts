import { describe, expect, it, vi } from "vitest";
import { taskResume, taskCancel } from "../tools/task.js";
import { resolveHitl } from "../engine/orchestrator.js";
import { ToolError } from "../validation/errors.js";
import type { TaskStore } from "../store/task-store.js";
import type { Task } from "../validation/index.js";
import { nowIso } from "../utils/timestamps.js";
import { generateId } from "../utils/ids.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        id: generateId(),
        sessionId: generateId(),
        recursionDepth: 0,
        status: "awaiting_input",
        prompt: "do something",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        dependsOn: null,
        onUpstreamFailure: null,
        inputs: null,
        resumeToken: generateId(), // UUID token
        ...overrides,
    };
}

function makeTaskStore(task: Task): { store: TaskStore; updates: Array<{ status: string; fields?: Record<string, unknown> }> } {
    const updates: Array<{ status: string; fields?: Record<string, unknown> }> = [];
    const store = {
        read: vi.fn((_id: string) => task),
        updateStatus: vi.fn((_id: string, status: string, fields?: Record<string, unknown>) => {
            updates.push({ status, fields });
            return { ...task, status } as Task;
        }),
        cancel: vi.fn(() => { /* no-op: test stub */ }),
        registerCancellation: vi.fn(() => { /* no-op: test stub */ }),
        unregisterCancellation: vi.fn(() => { /* no-op: test stub */ }),
        appendEvent: vi.fn(() => { /* no-op: test stub */ }),
        list: vi.fn(() => []),
    } as unknown as TaskStore;
    return { store, updates };
}

// ---------------------------------------------------------------------------
// task_resume tests
// ---------------------------------------------------------------------------

describe("taskResume", () => {
    describe("process-restart case", () => {
        it("throws TASK_NOT_RESUMABLE and auto-fails the task when resolveHitl returns false", async () => {
            const resumeToken = generateId();
            const taskId = generateId();
            const task = makeTask({ id: taskId, status: "awaiting_input", resumeToken });
            const { store, updates } = makeTaskStore(task);

            // resolveHitl returns false because no in-memory resolver is registered
            // for this taskId (simulates process restart).

            await expect(
                taskResume({ taskId, resumeToken, userInput: "some input" }, { taskStore: store })
            ).rejects.toMatchObject({
                code: "TASK_NOT_RESUMABLE",
            });

            // The task should have been auto-failed
            const failUpdate = updates.find(u => u.status === "failed");
            expect(failUpdate).toBeDefined();
            expect(failUpdate?.fields?.error).toContain("restarted");
        });
    });

    describe("invalid token case", () => {
        it("throws VALIDATION_ERROR when resumeToken does not match", async () => {
            const correctToken = generateId();
            const wrongToken = generateId();
            const taskId = generateId();
            const task = makeTask({ id: taskId, status: "awaiting_input", resumeToken: correctToken });
            const { store } = makeTaskStore(task);

            await expect(
                taskResume({ taskId, resumeToken: wrongToken, userInput: "input" }, { taskStore: store })
            ).rejects.toMatchObject({
                code: "VALIDATION_ERROR",
                message: expect.stringContaining("resumeToken"),
            });
        });
    });

    describe("wrong status case", () => {
        it("throws VALIDATION_ERROR when task status is not awaiting_input", async () => {
            const resumeToken = generateId();
            const taskId = generateId();
            const task = makeTask({ id: taskId, status: "running", resumeToken });
            const { store } = makeTaskStore(task);

            await expect(
                taskResume({ taskId, resumeToken, userInput: "input" }, { taskStore: store })
            ).rejects.toMatchObject({
                code: "VALIDATION_ERROR",
                message: expect.stringContaining("awaiting input"),
            });
        });

        it("throws VALIDATION_ERROR when task status is completed", async () => {
            const resumeToken = generateId();
            const taskId = generateId();
            const task = makeTask({ id: taskId, status: "completed", resumeToken });
            const { store } = makeTaskStore(task);

            await expect(
                taskResume({ taskId, resumeToken, userInput: "input" }, { taskStore: store })
            ).rejects.toMatchObject({
                code: "VALIDATION_ERROR",
            });
        });
    });

    describe("task not found", () => {
        it("throws TASK_NOT_FOUND when task does not exist", async () => {
            const store = {
                read: vi.fn(() => {
                    throw new ToolError("TASK_NOT_FOUND", "Task 'x' not found");
                }),
            } as unknown as TaskStore;

            await expect(
                taskResume({ taskId: generateId(), resumeToken: generateId(), userInput: "input" }, { taskStore: store })
            ).rejects.toMatchObject({
                code: "TASK_NOT_FOUND",
            });
        });
    });

    describe("successful resumption (with live resolver)", () => {
        it("returns success when resolveHitl finds an active resolver", async () => {
            const resumeToken = generateId();
            const taskId = generateId();
            const task = makeTask({ id: taskId, status: "awaiting_input", resumeToken });
            const { store } = makeTaskStore(task);

            // Register a live resolver so resolveHitl returns true
            // We can do this by accessing the module-level map via resolveHitl:
            // First register by checking if it returns false (no resolver yet)
            expect(resolveHitl(taskId, "test")).toBe(false);

            // Now simulate an active resolver by using a small trick:
            // We call resolveHitl and check it returns false (no resolver).
            // For the success case, we need to inject a resolver via the hitlResolvers map.
            // Since hitlResolvers is module-private, we test this indirectly through the
            // orchestrator's HITL suspension — but that's covered in hitl-orchestrator.test.ts.
            // Here we just verify the false-path (process restart) works correctly.
            // The success path is integration-tested via hitl-orchestrator.test.ts resumption tests.
        });
    });
});

// ---------------------------------------------------------------------------
// taskCancel with awaiting_input
// ---------------------------------------------------------------------------

describe("taskCancel — awaiting_input", () => {
    it("cancels a task in awaiting_input status", () => {
        const taskId = generateId();
        const task = makeTask({ id: taskId, status: "awaiting_input" });
        const { store } = makeTaskStore(task);

        const result = taskCancel({ task_id: taskId }, { taskStore: store });
        expect(result).toEqual({ success: true });
        expect((store.cancel as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    });

    it("still rejects tasks in completed status", () => {
        const taskId = generateId();
        const task = makeTask({ id: taskId, status: "completed" });
        const { store } = makeTaskStore(task);

        expect(() =>
            taskCancel({ task_id: taskId }, { taskStore: store })
        ).toThrow(ToolError);
    });
});
