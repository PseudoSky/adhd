/**
 * task-tool-dag-wiring.test.ts
 *
 * Regression tests for two wiring bugs found in code review of
 * task-dependency-dag (the unit DagEngine tests passed because they called
 * TaskStore.create directly, bypassing the taskTool wiring):
 *
 *  - BLOCK-1: taskTool dropped on_upstream_failure, so the "skip" policy was
 *    dead for any task created via the `task` tool.
 *  - BLOCK-2: the cycle check ran against a throwaway id while TaskStore.create
 *    generated a different id for the inserted row.
 */
import { describe, expect, it, vi } from "vitest";
import { taskTool } from "../tools/task.js";
import type { TaskDeps } from "../tools/task.js";
import type { Task, TaskToolInput } from "../validation/index.js";
import { nowIso } from "../utils/timestamps.js";
import { generateId } from "../utils/ids.js";

function makeTask(id: string): Task {
    return {
        id,
        sessionId: generateId(),
        recursionDepth: 0,
        status: "waiting",
        prompt: "test prompt",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        dependsOn: null,
        onUpstreamFailure: null,
        inputs: null,
        resumeToken: null,
    };
}

function makeDeps() {
    const agentDef = {
        name: "test-agent",
        version: 1,
        provider: { type: "openai" as const, model: "gpt-4o-mini", baseURL: "http://localhost:1234/v1" },
        systemPrompt: "You are helpful.",
        mcpServers: {},
        permissions: {},
        createdAt: nowIso(),
        updatedAt: nowIso(),
    };

    // create() echoes the caller-supplied id back into the returned task so we
    // can assert id propagation end-to-end.
    const create = vi.fn((input: { id?: string }) => makeTask(input.id ?? generateId()));
    const validateNoCycle = vi.fn();

    const deps = {
        agentStore: { read: vi.fn(() => agentDef) } as unknown as TaskDeps["agentStore"],
        sessionStore: {
            read: vi.fn(() => ({ status: "active", id: generateId() })),
            getAgentDefinition: vi.fn(() => agentDef),
            getMessages: vi.fn(() => []),
            appendMessage: vi.fn(async () => {}),
        } as unknown as TaskDeps["sessionStore"],
        taskStore: {
            create,
            read: vi.fn((id: string) => makeTask(id)),
            registerCancellation: vi.fn(),
            updateStatus: vi.fn(),
            appendEvent: vi.fn(),
            unregisterCancellation: vi.fn(),
        } as unknown as TaskDeps["taskStore"],
        orchestrator: { run: vi.fn(async () => ({ result: "done" })) } as unknown as TaskDeps["orchestrator"],
        queue: { enqueue: vi.fn() } as unknown as TaskDeps["queue"],
        policy: { check: vi.fn() } as unknown as TaskDeps["policy"],
        hooks: { register: vi.fn(), emit: vi.fn(async () => {}) } as unknown as TaskDeps["hooks"],
        selfUrl: undefined,
        inProcessDescriptors: [],
        inProcessHandler: vi.fn(async () => { throw new Error("not used"); }) as unknown as TaskDeps["inProcessHandler"],
        db: {} as TaskDeps["db"],
        dagEngine: {
            validateNoCycle,
            dispatchReady: vi.fn(async () => {}),
        } as unknown as TaskDeps["dagEngine"],
    };
    return { deps, create, validateNoCycle };
}

function makeInput(overrides: Partial<{ depends_on: string[]; on_upstream_failure: "fail" | "skip" }>): TaskToolInput {
    return {
        session_id: generateId(),
        prompt: "do a task",
        background: true,
        depends_on: overrides.depends_on,
        on_upstream_failure: overrides.on_upstream_failure,
    } as unknown as TaskToolInput;
}

describe("task tool — DagEngine wiring", () => {
    it("BLOCK-1: forwards on_upstream_failure to TaskStore.create", async () => {
        const { deps, create } = makeDeps();
        const input = makeInput({ depends_on: [generateId()], on_upstream_failure: "skip" });

        await taskTool(input, deps);

        expect(create).toHaveBeenCalledTimes(1);
        expect(create.mock.calls[0]![0]).toMatchObject({ onUpstreamFailure: "skip" });
    });

    it("BLOCK-2: cycle check validates the SAME id that is inserted", async () => {
        const { deps, create, validateNoCycle } = makeDeps();
        const input = makeInput({ depends_on: [generateId(), generateId()] });

        await taskTool(input, deps);

        expect(validateNoCycle).toHaveBeenCalledTimes(1);
        const checkedId = validateNoCycle.mock.calls[0]![0] as string;
        const insertedId = (create.mock.calls[0]![0] as { id?: string }).id;
        expect(insertedId).toBeDefined();
        expect(checkedId).toBe(insertedId);
    });

    it("does not call validateNoCycle when there are no dependencies", async () => {
        const { deps, validateNoCycle } = makeDeps();
        const input = makeInput({});

        await taskTool(input, deps);

        expect(validateNoCycle).not.toHaveBeenCalled();
    });
});
