import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it, beforeEach, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AgentStore } from "../store/agent-store.js";
import { SessionStore } from "../store/session-store.js";
import { TaskStore } from "../store/task-store.js";
import { DagEngine } from "../engine/dag-engine.js";
import type { BackgroundQueue } from "../engine/queue.js";
import * as schema from "../db/schema.js";
import type { AgentCreateInput } from "../validation/index.js";
import type { ErrorCode } from "../validation/errors.js";
import { nowIso } from "../utils/timestamps.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../drizzle");

function makeTestDb() {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder });
    return db;
}

type TestDb = ReturnType<typeof makeTestDb>;

function makeQueue(): BackgroundQueue {
    return {
        enqueue: vi.fn(),
        pending: 0,
        size: 0,
    } as unknown as BackgroundQueue;
}

const sampleAgentInput = (): AgentCreateInput => ({
    name: "test-agent",
    provider: { type: "openai", model: "gpt-4o-mini" },
    systemPrompt: "You are a helpful assistant.",
    mcpServers: {},
    permissions: {},
});

function makeStores(db: TestDb) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agentStore = new AgentStore(db as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessionStore = new SessionStore(db as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const taskStore = new TaskStore(db as any);
    return { agentStore, sessionStore, taskStore };
}

function makeSession(agentStore: AgentStore, sessionStore: SessionStore) {
    const agent = agentStore.create(sampleAgentInput());
    const session = sessionStore.create({
        agentName: agent.name,
        agentDefinition: agent,
    });
    return { agent, session };
}

/** Assert that an async fn throws a ToolError with the expected code */
async function expectAsyncToolError(fn: () => Promise<unknown>, code: ErrorCode) {
    try {
        await fn();
        expect.fail(`Expected a ToolError with code '${code}' to be thrown`);
    } catch (error: unknown) {
        expect((error as { code?: string }).code).toBe(code);
    }
}

/** Assert that a sync fn throws a ToolError with the expected code */
function expectToolError(fn: () => unknown, code: ErrorCode) {
    try {
        fn();
        expect.fail(`Expected a ToolError with code '${code}' to be thrown`);
    } catch (error: unknown) {
        expect((error as { code?: string }).code).toBe(code);
    }
}

describe("DagEngine — cycle detection (validateNoCycle)", () => {
    let db: TestDb;
    let taskStore: TaskStore;
    let dagEngine: DagEngine;
    let sessionId: string;

    beforeEach(() => {
        db = makeTestDb();
        const { agentStore, sessionStore, taskStore: ts } = makeStores(db);
        taskStore = ts;
        const { session } = makeSession(agentStore, sessionStore);
        sessionId = session.id;

        const dispatchFn = vi.fn().mockResolvedValue(undefined);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dagEngine = new DagEngine(db as any, makeQueue(), taskStore, dispatchFn);
    });

    it("does not throw when no dependencies (empty dependsOn)", () => {
        const newId = "00000000-0000-0000-0000-000000000001";
        // Should not throw
        expect(() => dagEngine.validateNoCycle(newId, [])).not.toThrow();
    });

    it("does not throw for a valid linear chain A → B (B added second)", () => {
        // Create A (no deps)
        const taskA = taskStore.create({ sessionId, prompt: "A" });

        // Creating B that depends on A is valid — A is not downstream of B
        const newBId = "00000000-0000-0000-0000-000000000002";
        expect(() => dagEngine.validateNoCycle(newBId, [taskA.id])).not.toThrow();
    });

    it("throws VALIDATION_ERROR when newTaskId already appears in dependency chain", () => {
        // Create A, then B depending on A
        const taskA = taskStore.create({ sessionId, prompt: "A" });
        const taskB = taskStore.create({ sessionId, prompt: "B", dependsOn: [taskA.id] });

        // Now try to create A again (same ID) depending on B → cycle: A→B→A
        // validateNoCycle should detect that newTaskId (taskA.id) appears in
        // B's ancestor chain (B depends on A, so BFS from B reaches A)
        expectToolError(
            () => dagEngine.validateNoCycle(taskA.id, [taskB.id]),
            "VALIDATION_ERROR"
        );
    });

    it("detects deep cycle (A → B → C → and back to A)", () => {
        const taskA = taskStore.create({ sessionId, prompt: "A" });
        const taskB = taskStore.create({ sessionId, prompt: "B", dependsOn: [taskA.id] });
        const taskC = taskStore.create({ sessionId, prompt: "C", dependsOn: [taskB.id] });

        // Trying to create A (same ID) depending on C → cycle A→B→C→A
        expectToolError(
            () => dagEngine.validateNoCycle(taskA.id, [taskC.id]),
            "VALIDATION_ERROR"
        );
    });

    it("does not throw for a valid fan-out (A → B, A → C)", () => {
        const taskA = taskStore.create({ sessionId, prompt: "A" });
        const taskB = taskStore.create({ sessionId, prompt: "B", dependsOn: [taskA.id] });

        // Creating C that also depends on A is valid
        const newCId = "00000000-0000-0000-0000-000000000003";
        expect(() => dagEngine.validateNoCycle(newCId, [taskA.id, taskB.id])).not.toThrow();
    });
});

describe("DagEngine — dispatchReady (single-dep dispatch)", () => {
    let db: TestDb;
    let taskStore: TaskStore;
    let dispatchFn: ReturnType<typeof vi.fn>;
    let dagEngine: DagEngine;
    let sessionId: string;

    beforeEach(() => {
        db = makeTestDb();
        const { agentStore, sessionStore, taskStore: ts } = makeStores(db);
        taskStore = ts;
        const { session } = makeSession(agentStore, sessionStore);
        sessionId = session.id;

        dispatchFn = vi.fn().mockResolvedValue(undefined);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dagEngine = new DagEngine(db as any, makeQueue(), taskStore, dispatchFn);
    });

    it("dispatches a waiting task when its single dependency completes", async () => {
        // Create upstream A (no deps → pending)
        const taskA = taskStore.create({ sessionId, prompt: "A" });
        expect(taskA.status).toBe("pending");

        // Create downstream B waiting on A
        const taskB = taskStore.create({ sessionId, prompt: "B", dependsOn: [taskA.id] });
        expect(taskB.status).toBe("waiting");

        // Simulate A completing
        taskStore.updateStatus(taskA.id, "completed", {
            result: "result-of-A",
            completedAt: nowIso(),
        });

        await dagEngine.dispatchReady(taskA.id);

        // B should now be pending and dispatchFn called
        const updatedB = taskStore.read(taskB.id);
        expect(updatedB.status).toBe("pending");
        expect(dispatchFn).toHaveBeenCalledWith(taskB.id);

        // inputs should contain A's result
        expect(updatedB.inputs).toEqual({ [taskA.id]: "result-of-A" });
    });

    it("does not dispatch if not all dependencies are terminal", async () => {
        const taskA = taskStore.create({ sessionId, prompt: "A" });
        const taskB = taskStore.create({ sessionId, prompt: "B" });
        // C waits on both A and B
        const taskC = taskStore.create({ sessionId, prompt: "C", dependsOn: [taskA.id, taskB.id] });
        expect(taskC.status).toBe("waiting");

        // Only A completes
        taskStore.updateStatus(taskA.id, "completed", { result: "a-result", completedAt: nowIso() });

        await dagEngine.dispatchReady(taskA.id);

        // C should still be waiting — B hasn't completed
        const updatedC = taskStore.read(taskC.id);
        expect(updatedC.status).toBe("waiting");
        expect(dispatchFn).not.toHaveBeenCalled();
    });

    it("does not dispatch the same task twice (optimistic lock)", async () => {
        const taskA = taskStore.create({ sessionId, prompt: "A" });
        const taskB = taskStore.create({ sessionId, prompt: "B", dependsOn: [taskA.id] });

        taskStore.updateStatus(taskA.id, "completed", { result: "r", completedAt: nowIso() });

        // Simulate two concurrent dispatchReady calls
        await Promise.all([
            dagEngine.dispatchReady(taskA.id),
            dagEngine.dispatchReady(taskA.id),
        ]);

        // dispatchFn should only be called once due to optimistic locking
        expect(dispatchFn).toHaveBeenCalledTimes(1);
        expect(dispatchFn).toHaveBeenCalledWith(taskB.id);
    });
});

describe("DagEngine — fan-in (multiple deps)", () => {
    let db: TestDb;
    let taskStore: TaskStore;
    let dispatchFn: ReturnType<typeof vi.fn>;
    let dagEngine: DagEngine;
    let sessionId: string;

    beforeEach(() => {
        db = makeTestDb();
        const { agentStore, sessionStore, taskStore: ts } = makeStores(db);
        taskStore = ts;
        const { session } = makeSession(agentStore, sessionStore);
        sessionId = session.id;

        dispatchFn = vi.fn().mockResolvedValue(undefined);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dagEngine = new DagEngine(db as any, makeQueue(), taskStore, dispatchFn);
    });

    it("dispatches fan-in task only after all upstream deps complete", async () => {
        const taskA = taskStore.create({ sessionId, prompt: "A" });
        const taskB = taskStore.create({ sessionId, prompt: "B" });
        const taskC = taskStore.create({
            sessionId,
            prompt: "C",
            dependsOn: [taskA.id, taskB.id],
        });
        expect(taskC.status).toBe("waiting");

        // A completes first
        taskStore.updateStatus(taskA.id, "completed", { result: "a-result", completedAt: nowIso() });
        await dagEngine.dispatchReady(taskA.id);
        expect(dispatchFn).not.toHaveBeenCalled();
        expect(taskStore.read(taskC.id).status).toBe("waiting");

        // B completes second
        taskStore.updateStatus(taskB.id, "completed", { result: "b-result", completedAt: nowIso() });
        await dagEngine.dispatchReady(taskB.id);

        // Now C should be dispatched
        expect(dispatchFn).toHaveBeenCalledWith(taskC.id);
        const updatedC = taskStore.read(taskC.id);
        expect(updatedC.status).toBe("pending");
        expect(updatedC.inputs).toEqual({
            [taskA.id]: "a-result",
            [taskB.id]: "b-result",
        });
    });
});

describe("DagEngine — on_upstream_failure='fail' propagation", () => {
    let db: TestDb;
    let taskStore: TaskStore;
    let dispatchFn: ReturnType<typeof vi.fn>;
    let dagEngine: DagEngine;
    let sessionId: string;

    beforeEach(() => {
        db = makeTestDb();
        const { agentStore, sessionStore, taskStore: ts } = makeStores(db);
        taskStore = ts;
        const { session } = makeSession(agentStore, sessionStore);
        sessionId = session.id;

        dispatchFn = vi.fn().mockResolvedValue(undefined);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dagEngine = new DagEngine(db as any, makeQueue(), taskStore, dispatchFn);
    });

    it("marks downstream as failed when upstream fails (default policy)", async () => {
        const taskA = taskStore.create({ sessionId, prompt: "A" });
        const taskB = taskStore.create({
            sessionId,
            prompt: "B",
            dependsOn: [taskA.id],
            // default policy is "fail"
        });
        expect(taskB.status).toBe("waiting");

        taskStore.updateStatus(taskA.id, "failed", { error: "A exploded" });

        await dagEngine.dispatchReady(taskA.id);

        const updatedB = taskStore.read(taskB.id);
        expect(updatedB.status).toBe("failed");
        expect(updatedB.error).toContain(taskA.id);
        // dispatchFn should NOT be called for a failed-propagated task
        expect(dispatchFn).not.toHaveBeenCalledWith(taskB.id);
    });

    it("marks downstream as failed when upstream fails with explicit onUpstreamFailure='fail'", async () => {
        const taskA = taskStore.create({ sessionId, prompt: "A" });
        const taskB = taskStore.create({
            sessionId,
            prompt: "B",
            dependsOn: [taskA.id],
            onUpstreamFailure: "fail",
        });

        taskStore.updateStatus(taskA.id, "failed", { error: "A failed" });
        await dagEngine.dispatchReady(taskA.id);

        expect(taskStore.read(taskB.id).status).toBe("failed");
        expect(dispatchFn).not.toHaveBeenCalledWith(taskB.id);
    });

    it("propagates failure transitively (C waits on B, B fails because A failed)", async () => {
        const taskA = taskStore.create({ sessionId, prompt: "A" });
        const taskB = taskStore.create({ sessionId, prompt: "B", dependsOn: [taskA.id] });
        const taskC = taskStore.create({ sessionId, prompt: "C", dependsOn: [taskB.id] });

        taskStore.updateStatus(taskA.id, "failed", { error: "A failed" });
        await dagEngine.dispatchReady(taskA.id);

        expect(taskStore.read(taskB.id).status).toBe("failed");
        expect(taskStore.read(taskC.id).status).toBe("failed");
        expect(dispatchFn).not.toHaveBeenCalledWith(taskB.id);
        expect(dispatchFn).not.toHaveBeenCalledWith(taskC.id);
    });

    it("marks downstream as failed when upstream is cancelled", async () => {
        const taskA = taskStore.create({ sessionId, prompt: "A" });
        const taskB = taskStore.create({ sessionId, prompt: "B", dependsOn: [taskA.id] });

        taskStore.updateStatus(taskA.id, "cancelled", { cancelledAt: nowIso() });
        await dagEngine.dispatchReady(taskA.id);

        expect(taskStore.read(taskB.id).status).toBe("failed");
        expect(taskStore.read(taskB.id).error).toContain("cancelled");
    });
});

describe("DagEngine — on_upstream_failure='skip'", () => {
    let db: TestDb;
    let taskStore: TaskStore;
    let dispatchFn: ReturnType<typeof vi.fn>;
    let dagEngine: DagEngine;
    let sessionId: string;

    beforeEach(() => {
        db = makeTestDb();
        const { agentStore, sessionStore, taskStore: ts } = makeStores(db);
        taskStore = ts;
        const { session } = makeSession(agentStore, sessionStore);
        sessionId = session.id;

        dispatchFn = vi.fn().mockResolvedValue(undefined);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dagEngine = new DagEngine(db as any, makeQueue(), taskStore, dispatchFn);
    });

    it("dispatches downstream even when upstream fails (skip policy)", async () => {
        const taskA = taskStore.create({ sessionId, prompt: "A" });
        const taskB = taskStore.create({
            sessionId,
            prompt: "B",
            dependsOn: [taskA.id],
            onUpstreamFailure: "skip",
        });

        taskStore.updateStatus(taskA.id, "failed", { error: "A failed" });
        await dagEngine.dispatchReady(taskA.id);

        // B should be dispatched despite A failing
        expect(dispatchFn).toHaveBeenCalledWith(taskB.id);
        const updatedB = taskStore.read(taskB.id);
        expect(updatedB.status).toBe("pending");
    });

    it("skip: only completed upstreams contribute to inputs (failed upstreams omitted)", async () => {
        const taskA = taskStore.create({ sessionId, prompt: "A" });
        const taskB = taskStore.create({ sessionId, prompt: "B" });
        const taskC = taskStore.create({
            sessionId,
            prompt: "C",
            dependsOn: [taskA.id, taskB.id],
            onUpstreamFailure: "skip",
        });

        // A completes with a result, B fails
        taskStore.updateStatus(taskA.id, "completed", { result: "a-result", completedAt: nowIso() });
        taskStore.updateStatus(taskB.id, "failed", { error: "B failed" });

        // Both are now terminal — trigger dispatchReady from the last one to finish
        await dagEngine.dispatchReady(taskA.id);
        // A alone doesn't trigger (B not terminal yet at scan time? No — B IS terminal)
        // Actually by the time dispatchReady is called, both are terminal in DB
        // Let's trigger from B's perspective
        // Reset mock to check after B trigger
        dispatchFn.mockClear();
        await dagEngine.dispatchReady(taskB.id);

        const updatedC = taskStore.read(taskC.id);
        expect(updatedC.status).toBe("pending");
        expect(updatedC.inputs).toEqual({ [taskA.id]: "a-result" });
        // B is NOT in inputs (failed upstream skipped)
        expect(updatedC.inputs).not.toHaveProperty(taskB.id);
    });

    it("skip: downstream dispatches even if all upstreams failed (empty inputs)", async () => {
        const taskA = taskStore.create({ sessionId, prompt: "A" });
        const taskB = taskStore.create({
            sessionId,
            prompt: "B",
            dependsOn: [taskA.id],
            onUpstreamFailure: "skip",
        });

        taskStore.updateStatus(taskA.id, "failed", { error: "A failed" });
        await dagEngine.dispatchReady(taskA.id);

        expect(dispatchFn).toHaveBeenCalledWith(taskB.id);
        const updatedB = taskStore.read(taskB.id);
        expect(updatedB.status).toBe("pending");
        // inputs should be empty object (no completed upstreams)
        expect(updatedB.inputs).toEqual({});
    });
});
