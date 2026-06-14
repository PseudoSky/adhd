/**
 * stream-task-tool.test.ts
 *
 * Verifies that the task tool includes stream_url in the response when
 * stream: true, and omits it when stream is false or not provided.
 *
 * Acceptance criteria:
 *  - [stream-task-tool.2] stream_url present when stream=true
 *  - [stream-task-tool.4] stream_url NOT present when stream=false or omitted
 *  - [stream-task-tool.3] SSE_BASE_URL env var used in URL construction
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { taskTool } from "../tools/task.js";
import type { TaskDeps } from "../tools/task.js";
import type { Task, TaskToolInput } from "../validation/index.js";
import { nowIso } from "../utils/timestamps.js";
import { generateId } from "../utils/ids.js";

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeTask(id: string): Task {
    return {
        id,
        sessionId: generateId(),
        recursionDepth: 0,
        status: "pending",
        prompt: "test prompt",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        dependsOn: null,
        onUpstreamFailure: null,
        inputs: null,
        resumeToken: null,
    };
}

function makeDeps(taskId: string): TaskDeps {
    const task = makeTask(taskId);
    const agentDef = {
        name: "test-agent",
        version: 1,
        provider: { type: "openai" as const, model: "gpt-4o-mini" },
        systemPrompt: "You are helpful.",
        mcpServers: {},
        permissions: {},
        createdAt: nowIso(),
        updatedAt: nowIso(),
    };

    return {
        agentStore: {
            read: vi.fn(() => agentDef),
        } as unknown as TaskDeps["agentStore"],

        sessionStore: {
            read: vi.fn(() => ({ status: "active", id: generateId() })),
            getAgentDefinition: vi.fn(() => agentDef),
            getMessages: vi.fn(() => []),
            appendMessage: vi.fn(async () => {}),
        } as unknown as TaskDeps["sessionStore"],

        taskStore: {
            create: vi.fn(() => task),
            read: vi.fn(() => task),
            registerCancellation: vi.fn(),
            updateStatus: vi.fn(() => task),
            appendEvent: vi.fn(),
            unregisterCancellation: vi.fn(),
        } as unknown as TaskDeps["taskStore"],

        orchestrator: {
            run: vi.fn(async () => ({ result: "done" })),
        } as unknown as TaskDeps["orchestrator"],

        queue: {
            enqueue: vi.fn(),
        } as unknown as TaskDeps["queue"],

        policy: {
            check: vi.fn(),
        } as unknown as TaskDeps["policy"],

        hooks: {
            register: vi.fn(),
            emit: vi.fn(async () => {}),
        } as unknown as TaskDeps["hooks"],

        selfUrl: undefined,
        inProcessDescriptors: [],
        inProcessHandler: vi.fn(async () => { throw new Error("not used"); }) as unknown as TaskDeps["inProcessHandler"],

        db: {} as TaskDeps["db"],

        dagEngine: {
            validateNoCycle: vi.fn(),
            dispatchReady: vi.fn(async () => {}),
        } as unknown as TaskDeps["dagEngine"],
    };
}

function makeSessionInput(overrides: Partial<{ stream: boolean; background: boolean }> = {}): TaskToolInput {
    return {
        session_id: generateId(),
        prompt: "do a task",
        background: overrides.background ?? true,
        stream: overrides.stream,
    } as TaskToolInput;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("stream-task-tool — stream_url in task response", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        // Restore env: clear, then conditionally restore the original value.
        delete process.env["SSE_PORT"];
        delete process.env["SSE_BASE_URL"];
        if (originalEnv["SSE_PORT"]) process.env["SSE_PORT"] = originalEnv["SSE_PORT"];
        if (originalEnv["SSE_BASE_URL"]) process.env["SSE_BASE_URL"] = originalEnv["SSE_BASE_URL"];
    });

    describe("stream: true", () => {
        it("includes stream_url in response when stream=true (background mode)", async () => {
            const taskId = generateId();
            const deps = makeDeps(taskId);
            const input = makeSessionInput({ stream: true, background: true });

            const result = await taskTool(input, deps);

            expect(result.stream_url).toBeDefined();
            expect(result.stream_url).toContain(`/tasks/${taskId}/stream`);
        });

        it("stream_url uses default base URL (http://localhost:3001) when SSE_BASE_URL not set", async () => {
            delete process.env["SSE_BASE_URL"];
            delete process.env["SSE_PORT"];

            const taskId = generateId();
            const deps = makeDeps(taskId);
            const input = makeSessionInput({ stream: true, background: true });

            const result = await taskTool(input, deps);

            expect(result.stream_url).toBe(`http://localhost:3001/tasks/${taskId}/stream`);
        });

        it("stream_url uses SSE_BASE_URL env var when set", async () => {
            process.env["SSE_BASE_URL"] = "https://api.example.com";

            const taskId = generateId();
            const deps = makeDeps(taskId);
            const input = makeSessionInput({ stream: true, background: true });

            const result = await taskTool(input, deps);

            expect(result.stream_url).toBe(`https://api.example.com/tasks/${taskId}/stream`);
        });

        it("stream_url uses SSE_PORT when SSE_BASE_URL not set but SSE_PORT is set", async () => {
            delete process.env["SSE_BASE_URL"];
            process.env["SSE_PORT"] = "4242";

            const taskId = generateId();
            const deps = makeDeps(taskId);
            const input = makeSessionInput({ stream: true, background: true });

            const result = await taskTool(input, deps);

            expect(result.stream_url).toBe(`http://localhost:4242/tasks/${taskId}/stream`);
        });
    });

    describe("stream: false or omitted", () => {
        it("does NOT include stream_url when stream=false", async () => {
            const taskId = generateId();
            const deps = makeDeps(taskId);
            const input = makeSessionInput({ stream: false, background: true });

            const result = await taskTool(input, deps);

            expect(result.stream_url).toBeUndefined();
        });

        it("does NOT include stream_url when stream is omitted", async () => {
            const taskId = generateId();
            const deps = makeDeps(taskId);
            const input = makeSessionInput({ background: true }); // no stream field

            const result = await taskTool(input, deps);

            expect(result.stream_url).toBeUndefined();
        });
    });

    describe("stream_url format", () => {
        it("stream_url matches expected pattern: {base}/tasks/{taskId}/stream", async () => {
            process.env["SSE_BASE_URL"] = "http://localhost:3001";

            const taskId = generateId();
            const deps = makeDeps(taskId);
            const input = makeSessionInput({ stream: true, background: true });

            const result = await taskTool(input, deps);

            const expectedPattern = /^http:\/\/localhost:3001\/tasks\/[0-9a-f-]+\/stream$/;
            expect(result.stream_url).toMatch(expectedPattern);
        });
    });
});
