import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it, beforeEach } from "vitest";

import { SessionStore } from "../store/session-store.js";
import { TaskStore } from "../store/task-store.js";
import type { AgentDefinition } from "../validation/schemas.js";
import * as schema from "../db/schema.js";
import { nowIso } from "../utils/timestamps.js";
import type { ErrorCode } from "../validation/errors.js";

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    agent_name TEXT NOT NULL,
    agent_version INTEGER NOT NULL,
    agent_data TEXT NOT NULL,
    status TEXT DEFAULT 'active' NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT,
    composed_prompt_id TEXT
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT,
    tool_calls TEXT,
    tool_results TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT,
    parent_task_id TEXT,
    is_ephemeral INTEGER DEFAULT 0 NOT NULL,
    recursion_depth INTEGER DEFAULT 0 NOT NULL,
    status TEXT DEFAULT 'pending' NOT NULL,
    prompt TEXT NOT NULL,
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    cancelled_at TEXT,
    depends_on TEXT,
    on_upstream_failure TEXT,
    inputs TEXT,
    resume_token TEXT
);

CREATE TABLE IF NOT EXISTS task_events (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS composed_prompts (
    id TEXT PRIMARY KEY NOT NULL,
    agent_slug TEXT NOT NULL,
    context_hash TEXT NOT NULL,
    content TEXT NOT NULL,
    component_versions TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_composed_prompts_agent_ctx ON composed_prompts (agent_slug, context_hash);

CREATE TABLE IF NOT EXISTS experiment_assignments (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    experiment_slug TEXT NOT NULL,
    variant TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_usage (
    task_id TEXT PRIMARY KEY NOT NULL,
    root_task_id TEXT,
    agent_name TEXT NOT NULL,
    provider_type TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0 NOT NULL,
    output_tokens INTEGER DEFAULT 0 NOT NULL,
    tool_call_count INTEGER DEFAULT 0 NOT NULL,
    model_calls INTEGER DEFAULT 0 NOT NULL,
    latency_ms INTEGER DEFAULT 0 NOT NULL,
    is_complete INTEGER DEFAULT 0 NOT NULL,
    stop_reason TEXT,
    max_tokens INTEGER,
    cache_read_input_tokens INTEGER,
    cache_creation_input_tokens INTEGER,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_usage_root_task_id ON task_usage (root_task_id);
`;

function makeTestDb() {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(CREATE_TABLES_SQL);
    const db = drizzle(sqlite, { schema });
    return db;
}

function sampleAgentDefinition(): AgentDefinition {
    return {
        name: "test-agent",
        version: 1,
        provider: { type: "openai", model: "gpt-4o-mini" } as AgentDefinition["provider"],
        systemPrompt: "You are a helpful assistant.",
        mcpServers: {},
        permissions: {},
        createdAt: nowIso(),
        updatedAt: nowIso(),
    };
}

/** Helper to assert that a function throws a ToolError with the expected code */
function expectToolError(fn: () => unknown, code: ErrorCode) {
    try {
        fn();
        expect.fail(`Expected a ToolError with code '${code}' to be thrown`);
    } catch (error: unknown) {
        expect((error as { code?: string }).code).toBe(code);
    }
}

describe("TaskStore", () => {
    let db: ReturnType<typeof makeTestDb>;
    let sessionStore: SessionStore;
    let taskStore: TaskStore;
    let sessionId: string;

    beforeEach(() => {
        db = makeTestDb();
        sessionStore = new SessionStore(db as Parameters<typeof SessionStore.prototype.constructor>[0]);
        taskStore = new TaskStore(db as Parameters<typeof TaskStore.prototype.constructor>[0]);

        const agentDef = sampleAgentDefinition();
        const session = sessionStore.create({ agentName: agentDef.name, agentDefinition: agentDef });
        sessionId = session.id;
    });

    it("creates a task with status=pending", () => {
        const task = taskStore.create({ sessionId, prompt: "Hello" });
        expect(task.status).toBe("pending");
        expect(task.prompt).toBe("Hello");
        expect(task.recursionDepth).toBe(0);
    });

    it("creates a task with dependsOn starts in waiting status", () => {
        const task = taskStore.create({
            sessionId,
            prompt: "Hello",
            dependsOn: ["11111111-1111-4111-8111-111111111111"],
        });
        expect(task.status).toBe("waiting");
        expect(task.dependsOn).toEqual(["11111111-1111-4111-8111-111111111111"]);
    });

    it("creates a task with custom id", () => {
        const customId = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const task = taskStore.create({ sessionId, prompt: "Hello", id: customId });
        expect(task.id).toBe(customId);
    });

    it("reads a task by id", () => {
        const task = taskStore.create({ sessionId, prompt: "Hello" });
        const read = taskStore.read(task.id);
        expect(read.id).toBe(task.id);
        expect(read.prompt).toBe("Hello");
    });

    it("throws TASK_NOT_FOUND for unknown task", () => {
        expectToolError(
            () => taskStore.read("00000000-0000-0000-0000-000000000000"),
            "TASK_NOT_FOUND"
        );
    });

    it("updates task status to running", () => {
        const task = taskStore.create({ sessionId, prompt: "Hello" });
        const updated = taskStore.updateStatus(task.id, "running");
        expect(updated.status).toBe("running");
    });

    it("updates task to completed with result", () => {
        const task = taskStore.create({ sessionId, prompt: "Hello" });
        taskStore.updateStatus(task.id, "running");
        const completed = taskStore.updateStatus(task.id, "completed", {
            result: "Done!",
            completedAt: nowIso(),
        });
        expect(completed.status).toBe("completed");
        expect(completed.result).toBe("Done!");
        expect(completed.completedAt).toBeDefined();
    });

    it("updates task to failed with error", () => {
        const task = taskStore.create({ sessionId, prompt: "Hello" });
        const failed = taskStore.updateStatus(task.id, "failed", {
            error: "Something went wrong",
        });
        expect(failed.status).toBe("failed");
        expect(failed.error).toBe("Something went wrong");
    });

    it("cancels a task via AbortController", () => {
        const task = taskStore.create({ sessionId, prompt: "Hello" });
        taskStore.updateStatus(task.id, "running");

        const controller = new AbortController();
        taskStore.registerCancellation(task.id, controller);

        expect(controller.signal.aborted).toBe(false);
        taskStore.cancel(task.id);
        expect(controller.signal.aborted).toBe(true);

        const cancelled = taskStore.read(task.id);
        expect(cancelled.status).toBe("cancelled");
        expect(cancelled.cancelledAt).toBeDefined();
    });

    it("unregisters cancellation — controller not aborted after unregister", () => {
        const task = taskStore.create({ sessionId, prompt: "Hello" });
        const controller = new AbortController();
        taskStore.registerCancellation(task.id, controller);
        taskStore.unregisterCancellation(task.id);

        taskStore.updateStatus(task.id, "running");
        taskStore.cancel(task.id);
        expect(controller.signal.aborted).toBe(false);
    });

    it("appends task events", () => {
        const task = taskStore.create({ sessionId, prompt: "Hello" });
        expect(() => {
            taskStore.appendEvent({ taskId: task.id, type: "MODEL_REQUEST", payload: { count: 1 } });
            taskStore.appendEvent({ taskId: task.id, type: "MODEL_RESPONSE", payload: { done: true } });
            taskStore.appendEvent({ taskId: task.id, type: "TASK_COMPLETED" });
        }).not.toThrow();
    });

    it("lists tasks by session_id", () => {
        taskStore.create({ sessionId, prompt: "Task 1" });
        taskStore.create({ sessionId, prompt: "Task 2" });
        const list = taskStore.list({ session_id: sessionId });
        expect(list).toHaveLength(2);
    });

    it("lists tasks by status", () => {
        const t1 = taskStore.create({ sessionId, prompt: "Task 1" });
        taskStore.create({ sessionId, prompt: "Task 2" });
        taskStore.updateStatus(t1.id, "running");

        const running = taskStore.list({ status: "running" });
        expect(running).toHaveLength(1);
    });

    it("lists ephemeral tasks only", () => {
        taskStore.create({ sessionId: null, prompt: "Ephemeral", isEphemeral: true });
        taskStore.create({ sessionId, prompt: "Session-backed" });

        const ephemeral = taskStore.list({ is_ephemeral: true });
        expect(ephemeral).toHaveLength(1);
        expect(ephemeral[0].isEphemeral).toBe(true);

        const sessionBacked = taskStore.list({ is_ephemeral: false });
        expect(sessionBacked).toHaveLength(1);
        expect(sessionBacked[0].isEphemeral).toBe(false);
    });

    it("lists all tasks when no filter", () => {
        taskStore.create({ sessionId, prompt: "Task 1" });
        taskStore.create({ sessionId: null, prompt: "Ephemeral", isEphemeral: true });
        expect(taskStore.list({})).toHaveLength(2);
    });

    it("creates a task with parentTaskId and recursionDepth", () => {
        const parent = taskStore.create({ sessionId, prompt: "Parent" });
        const child = taskStore.create({
            sessionId,
            prompt: "Child",
            parentTaskId: parent.id,
            recursionDepth: 1,
        });
        expect(child.parentTaskId).toBe(parent.id);
        expect(child.recursionDepth).toBe(1);
    });

    it("creates a task with onUpstreamFailure and inputs", () => {
        const task = taskStore.create({
            sessionId,
            prompt: "Test",
            onUpstreamFailure: "skip",
            inputs: { "dep-1": "result from dep-1" },
        });
        expect(task.onUpstreamFailure).toBe("skip");
        expect(task.inputs).toEqual({ "dep-1": "result from dep-1" });
    });

    it("updates task with resumeToken", () => {
        const task = taskStore.create({ sessionId, prompt: "Hello" });
        const updated = taskStore.updateStatus(task.id, "awaiting_input", {
            resumeToken: "aaaaaaa1-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        });
        expect(updated.status).toBe("awaiting_input");
        expect(updated.resumeToken).toBe("aaaaaaa1-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    });

    it("updateStatus does not wipe resumeToken when not supplied", () => {
        const task = taskStore.create({ sessionId, prompt: "Hello" });
        taskStore.updateStatus(task.id, "awaiting_input", {
            resumeToken: "aaaaaaa1-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        });
        const updated = taskStore.updateStatus(task.id, "running"); // no resumeToken
        expect(updated.resumeToken).toBe("aaaaaaa1-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    });
});
