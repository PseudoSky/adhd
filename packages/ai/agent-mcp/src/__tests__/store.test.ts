import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it, beforeEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AgentStore } from "../store/agent-store.js";
import { SessionStore } from "../store/session-store.js";
import { TaskStore } from "../store/task-store.js";
import * as schema from "../db/schema.js";
import { nowIso } from "../utils/timestamps.js";
import type { AgentCreateInput } from "../validation/index.js";
import type { ErrorCode } from "../validation/errors.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../drizzle");

function makeTestDb() {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder });
    return db;
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

const sampleAgentInput = (): AgentCreateInput => ({
    name: "test-agent",
    provider: { type: "openai", model: "gpt-4o-mini" },
    systemPrompt: "You are a helpful assistant.",
    mcpServers: {},
    permissions: {},
});

describe("AgentStore", () => {
    let db: ReturnType<typeof makeTestDb>;
    let store: AgentStore;

    beforeEach(() => {
        db = makeTestDb();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        store = new AgentStore(db as any);
    });

    it("creates an agent with version=1", () => {
        const agent = store.create(sampleAgentInput());
        expect(agent.version).toBe(1);
        expect(agent.name).toBe("test-agent");
    });

    it("reads an agent by name", () => {
        store.create(sampleAgentInput());
        const agent = store.read("test-agent");
        expect(agent.name).toBe("test-agent");
    });

    it("throws AGENT_ALREADY_EXISTS on duplicate create", () => {
        store.create(sampleAgentInput());
        expectToolError(() => store.create(sampleAgentInput()), "AGENT_ALREADY_EXISTS");
    });

    it("throws AGENT_NOT_FOUND on read of missing agent", () => {
        expectToolError(() => store.read("nonexistent"), "AGENT_NOT_FOUND");
    });

    it("updates agent and bumps version", () => {
        store.create(sampleAgentInput());
        const updated = store.update({
            name: "test-agent",
            patch: { systemPrompt: "Updated prompt" },
        });
        expect(updated.version).toBe(2);
        expect(updated.systemPrompt).toBe("Updated prompt");
    });

    it("update preserves name and createdAt", () => {
        const original = store.create(sampleAgentInput());
        const updated = store.update({
            name: "test-agent",
            patch: { systemPrompt: "Updated" },
        });
        expect(updated.name).toBe(original.name);
        expect(updated.createdAt).toBe(original.createdAt);
    });

    it("update deep-merges mcpServers instead of replacing (BUG-005)", () => {
        store.create({
            ...sampleAgentInput(),
            mcpServers: {
                filesystem: { transport: "stdio", command: "node", args: ["fs.js"] },
                shell: { transport: "stdio", command: "sh" },
            },
        });
        // Update with only one server — should not drop the other
        const updated = store.update({
            name: "test-agent",
            patch: {
                mcpServers: {
                    shell: { transport: "stdio", command: "bash" },
                },
            },
        });
        // Both servers must still exist
        expect(updated.mcpServers.filesystem).toBeDefined();
        expect(updated.mcpServers.filesystem.command).toBe("node");
        // Shell was updated
        expect(updated.mcpServers.shell.command).toBe("bash");
    });

    it("update deep-merges permissions instead of replacing (BUG-005)", () => {
        store.create({
            ...sampleAgentInput(),
            permissions: { allowedAgents: ["reviewer"] },
        });
        // Update with empty permissions — should not drop existing
        const updated = store.update({
            name: "test-agent",
            patch: { permissions: {} },
        });
        expect(updated.permissions.allowedAgents).toEqual(["reviewer"]);
    });

    it("lists all agents", () => {
        store.create(sampleAgentInput());
        store.create({ ...sampleAgentInput(), name: "agent-2" });
        const agents = store.list();
        expect(agents).toHaveLength(2);
    });

    it("deletes an agent with no active sessions", () => {
        store.create(sampleAgentInput());
        store.delete("test-agent");
        expectToolError(() => store.read("test-agent"), "AGENT_NOT_FOUND");
    });

    it("throws AGENT_NOT_FOUND when deleting nonexistent agent", () => {
        expectToolError(() => store.delete("nonexistent"), "AGENT_NOT_FOUND");
    });
});

describe("SessionStore", () => {
    let db: ReturnType<typeof makeTestDb>;
    let agentStore: AgentStore;
    let sessionStore: SessionStore;

    beforeEach(() => {
        db = makeTestDb();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        agentStore = new AgentStore(db as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sessionStore = new SessionStore(db as any);
    });

    it("creates a session with status=active", () => {
        const agent = agentStore.create(sampleAgentInput());
        const session = sessionStore.create({
            agentName: agent.name,
            agentDefinition: agent,
        });
        expect(session.status).toBe("active");
        expect(session.agentName).toBe("test-agent");
        expect(session.agentVersion).toBe(1);
    });

    it("getAgentDefinition returns snapshotted definition", () => {
        const agent = agentStore.create(sampleAgentInput());
        const session = sessionStore.create({
            agentName: agent.name,
            agentDefinition: agent,
        });

        // Update agent — session should still have old definition
        agentStore.update({
            name: agent.name,
            patch: { systemPrompt: "New prompt" },
        });

        const snapshotted = sessionStore.getAgentDefinition(session.id);
        expect(snapshotted.systemPrompt).toBe("You are a helpful assistant.");
        expect(snapshotted.version).toBe(1);
    });

    it("closes a session", () => {
        const agent = agentStore.create(sampleAgentInput());
        const session = sessionStore.create({
            agentName: agent.name,
            agentDefinition: agent,
        });

        const closed = sessionStore.close(session.id);
        expect(closed.status).toBe("closed");
        expect(closed.closedAt).toBeDefined();
    });

    it("throws SESSION_CLOSED when closing an already-closed session", () => {
        const agent = agentStore.create(sampleAgentInput());
        const session = sessionStore.create({
            agentName: agent.name,
            agentDefinition: agent,
        });
        sessionStore.close(session.id);
        expectToolError(() => sessionStore.close(session.id), "SESSION_CLOSED");
    });

    it("throws SESSION_NOT_FOUND for unknown session", () => {
        expectToolError(
            () => sessionStore.read("00000000-0000-0000-0000-000000000000"),
            "SESSION_NOT_FOUND"
        );
    });
});

describe("TaskStore", () => {
    let db: ReturnType<typeof makeTestDb>;
    let agentStore: AgentStore;
    let sessionStore: SessionStore;
    let taskStore: TaskStore;
    let sessionId: string;

    beforeEach(() => {
        db = makeTestDb();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        agentStore = new AgentStore(db as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sessionStore = new SessionStore(db as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        taskStore = new TaskStore(db as any);

        const agent = agentStore.create(sampleAgentInput());
        const session = sessionStore.create({
            agentName: agent.name,
            agentDefinition: agent,
        });
        sessionId = session.id;
    });

    it("creates a task with status=pending", () => {
        const task = taskStore.create({ sessionId, prompt: "Hello" });
        expect(task.status).toBe("pending");
        expect(task.prompt).toBe("Hello");
        expect(task.recursionDepth).toBe(0);
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
        // controller was unregistered, so it should NOT have been aborted
        expect(controller.signal.aborted).toBe(false);
    });

    it("throws TASK_NOT_FOUND for unknown task", () => {
        expectToolError(
            () => taskStore.read("00000000-0000-0000-0000-000000000000"),
            "TASK_NOT_FOUND"
        );
    });

    it("appends task events", () => {
        const task = taskStore.create({ sessionId, prompt: "Hello" });
        taskStore.appendEvent({ taskId: task.id, type: "MODEL_REQUEST", payload: { count: 1 } });
        taskStore.appendEvent({ taskId: task.id, type: "MODEL_RESPONSE", payload: { done: true } });
    });
});

describe("FK cascade", () => {
    let db: ReturnType<typeof makeTestDb>;
    let agentStore: AgentStore;
    let sessionStore: SessionStore;

    beforeEach(() => {
        db = makeTestDb();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        agentStore = new AgentStore(db as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sessionStore = new SessionStore(db as any);
    });

    it("AgentStore.delete rejects when active sessions exist", () => {
        const agent = agentStore.create(sampleAgentInput());
        sessionStore.create({ agentName: agent.name, agentDefinition: agent });
        expectToolError(() => agentStore.delete("test-agent"), "AGENT_HAS_ACTIVE_SESSIONS");
    });

    it("AgentStore.delete succeeds after session is closed", () => {
        const agent = agentStore.create(sampleAgentInput());
        const session = sessionStore.create({ agentName: agent.name, agentDefinition: agent });
        sessionStore.close(session.id);
        agentStore.delete("test-agent"); // should not throw
    });
});
