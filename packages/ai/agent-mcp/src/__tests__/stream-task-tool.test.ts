/**
 * stream-task-tool.test.ts
 *
 * Verifies that the task tool includes stream_url in the response when
 * stream: true, and omits it when stream is false or not provided.
 *
 * The SSE base URL is read from `config.sse.baseUrl`, which is the frozen
 * singleton value derived from ADHD_AGENT_SSE_BASE_URL / ADHD_AGENT_SSE_PORT
 * at startup time. Dynamic env-var mutations during tests don't affect it —
 * that behavior is covered by config.test.ts (CFG-004).
 *
 * Acceptance criteria:
 *  - [stream-task-tool.2] stream_url present when stream=true
 *  - [stream-task-tool.4] stream_url NOT present when stream=false or omitted
 *  - [stream-task-tool.3] stream_url format is {config.sse.baseUrl}/tasks/{taskId}/stream
 */
import { describe, expect, it, vi } from "vitest";
import { taskTool } from "../tools/task.js";
import { config } from "../config.js";
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
        // baseURL: localhost → config.getProviderConfig applies localhost exemption,
        // no ADHD_AGENT_OPENAI_SECRET required.
        provider: { type: "openai" as const, model: "gpt-4o-mini", baseURL: "http://localhost:1234/v1" },
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
            appendMessage: vi.fn(async () => { /* no-op: test stub */ }),
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
            emit: vi.fn(async () => { /* no-op: test stub */ }),
        } as unknown as TaskDeps["hooks"],

        selfUrl: undefined,
        inProcessDescriptors: [],
        inProcessHandler: vi.fn(async () => { throw new Error("not used"); }) as unknown as TaskDeps["inProcessHandler"],

        db: {} as TaskDeps["db"],

        dagEngine: {
            validateNoCycle: vi.fn(),
            dispatchReady: vi.fn(async () => { /* no-op: test stub */ }),
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
    // The SSE base URL from the frozen singleton
    const sseBase = config.sse.baseUrl;

    describe("stream: true", () => {
        it("includes stream_url in response when stream=true (background mode)", async () => {
            const taskId = generateId();
            const deps = makeDeps(taskId);
            const input = makeSessionInput({ stream: true, background: true });

            const result = await taskTool(input, deps);

            expect(result.stream_url).toBeDefined();
            expect(result.stream_url).toContain(`/tasks/${taskId}/stream`);
        });

        it("stream_url uses config.sse.baseUrl (the frozen singleton value)", async () => {
            const taskId = generateId();
            const deps = makeDeps(taskId);
            const input = makeSessionInput({ stream: true, background: true });

            const result = await taskTool(input, deps);

            expect(result.stream_url).toBe(`${sseBase}/tasks/${taskId}/stream`);
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
            const taskId = generateId();
            const deps = makeDeps(taskId);
            const input = makeSessionInput({ stream: true, background: true });

            const result = await taskTool(input, deps);

            // Pattern: {sseBase}/tasks/{uuid}/stream
            const expectedPattern = new RegExp(
                `^${sseBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/tasks/[0-9a-f-]+/stream$`
            );
            expect(result.stream_url).toMatch(expectedPattern);
        });
    });
});
