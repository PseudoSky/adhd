import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it, beforeEach, vi } from "vitest";

import { TaskStore } from "@adhd/agent-store-runtime";
import { DagEngine } from "../engine/dag-engine.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";

type TestDb = ReturnType<typeof drizzle>;

function makeTestDb(): TestDb {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = OFF");

    sqlite.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            agent_name TEXT NOT NULL,
            agent_version INTEGER NOT NULL,
            agent_data TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            closed_at TEXT,
            composed_prompt_id TEXT
        );
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            role TEXT NOT NULL,
            content TEXT,
            tool_calls TEXT,
            tool_results TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            session_id TEXT,
            parent_task_id TEXT,
            is_ephemeral INTEGER NOT NULL DEFAULT 0,
            recursion_depth INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
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
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            type TEXT NOT NULL,
            payload TEXT,
            created_at TEXT NOT NULL
        );
    `);

    const db = drizzle(sqlite);
    return db as unknown as TestDb;
}

function makeQueue() {
    return {
        enqueue: vi.fn(),
        pending: 0,
        size: 0,
    };
}

describe("DagEngine — cycle detection (validateNoCycle)", () => {
    let db: TestDb;
    let taskStore: TaskStore;
    let dagEngine: DagEngine;

    beforeEach(() => {
        db = makeTestDb();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        taskStore = new TaskStore(db as any);
        const dispatchFn = vi.fn().mockResolvedValue(undefined);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dagEngine = new DagEngine(db as any, makeQueue(), taskStore, dispatchFn);
    });

    it("does not throw when no dependencies (empty dependsOn)", () => {
        const newId = generateId();
        expect(() => dagEngine.validateNoCycle(newId, [])).not.toThrow();
    });

    it("does not throw for a valid linear chain A → B (B added second)", () => {
        const taskA = taskStore.create({ sessionId: null, prompt: "A" });
        const newBId = generateId();
        expect(() => dagEngine.validateNoCycle(newBId, [taskA.id])).not.toThrow();
    });

    it("throws VALIDATION_ERROR when newTaskId already appears in dependency chain", () => {
        const taskA = taskStore.create({ sessionId: null, prompt: "A" });
        const taskB = taskStore.create({ sessionId: null, prompt: "B", dependsOn: [taskA.id] });

        let caught: Error | null = null;
        try {
            dagEngine.validateNoCycle(taskA.id, [taskB.id]);
        } catch (e) {
            caught = e as Error;
        }
        expect(caught).not.toBeNull();
        expect((caught as unknown as { code: string }).code).toBe("VALIDATION_ERROR");
    });

    it("detects deep cycle (A → B → C → and back to A)", () => {
        const taskA = taskStore.create({ sessionId: null, prompt: "A" });
        const taskB = taskStore.create({ sessionId: null, prompt: "B", dependsOn: [taskA.id] });
        const taskC = taskStore.create({ sessionId: null, prompt: "C", dependsOn: [taskB.id] });

        let caught: Error | null = null;
        try {
            dagEngine.validateNoCycle(taskA.id, [taskC.id]);
        } catch (e) {
            caught = e as Error;
        }
        expect(caught).not.toBeNull();
        expect((caught as unknown as { code: string }).code).toBe("VALIDATION_ERROR");
    });

    it("does not throw for a valid fan-out (A → B, A → C)", () => {
        const taskA = taskStore.create({ sessionId: null, prompt: "A" });
        const taskB = taskStore.create({ sessionId: null, prompt: "B", dependsOn: [taskA.id] });
        const newCId = generateId();
        expect(() => dagEngine.validateNoCycle(newCId, [taskA.id, taskB.id])).not.toThrow();
    });
});

describe("DagEngine — dispatchReady", () => {
    let db: TestDb;
    let taskStore: TaskStore;
    let dispatchFn: ReturnType<typeof vi.fn>;
    let dagEngine: DagEngine;

    beforeEach(() => {
        db = makeTestDb();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        taskStore = new TaskStore(db as any);
        dispatchFn = vi.fn().mockResolvedValue(undefined);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dagEngine = new DagEngine(db as any, makeQueue(), taskStore, dispatchFn);
    });

    it("dispatches a waiting task when its single dependency completes", async () => {
        const taskA = taskStore.create({ sessionId: null, prompt: "A" });
        expect(taskA.status).toBe("pending");

        const taskB = taskStore.create({ sessionId: null, prompt: "B", dependsOn: [taskA.id] });
        expect(taskB.status).toBe("waiting");

        taskStore.updateStatus(taskA.id, "completed", {
            result: "result-of-A",
            completedAt: nowIso(),
        });

        await dagEngine.dispatchReady(taskA.id);

        const updatedB = taskStore.read(taskB.id);
        expect(updatedB.status).toBe("pending");
        expect(dispatchFn).toHaveBeenCalledWith(taskB.id);
    });

    it("does not dispatch if not all dependencies are terminal", async () => {
        const taskA = taskStore.create({ sessionId: null, prompt: "A" });
        const taskB = taskStore.create({ sessionId: null, prompt: "B" });
        const taskC = taskStore.create({ sessionId: null, prompt: "C", dependsOn: [taskA.id, taskB.id] });
        expect(taskC.status).toBe("waiting");

        taskStore.updateStatus(taskA.id, "completed", { result: "a-result", completedAt: nowIso() });

        await dagEngine.dispatchReady(taskA.id);

        const updatedC = taskStore.read(taskC.id);
        expect(updatedC.status).toBe("waiting");
        expect(dispatchFn).not.toHaveBeenCalled();
    });

    it("dispatches fan-in task only after all upstream deps complete", async () => {
        const taskA = taskStore.create({ sessionId: null, prompt: "A" });
        const taskB = taskStore.create({ sessionId: null, prompt: "B" });
        const taskC = taskStore.create({ sessionId: null, prompt: "C", dependsOn: [taskA.id, taskB.id] });
        expect(taskC.status).toBe("waiting");

        taskStore.updateStatus(taskA.id, "completed", { result: "a-result", completedAt: nowIso() });
        await dagEngine.dispatchReady(taskA.id);
        expect(dispatchFn).not.toHaveBeenCalled();

        taskStore.updateStatus(taskB.id, "completed", { result: "b-result", completedAt: nowIso() });
        await dagEngine.dispatchReady(taskB.id);

        expect(dispatchFn).toHaveBeenCalledWith(taskC.id);
    });
});

describe("DagEngine — on_upstream_failure='fail' propagation", () => {
    let db: TestDb;
    let taskStore: TaskStore;
    let dispatchFn: ReturnType<typeof vi.fn>;
    let dagEngine: DagEngine;

    beforeEach(() => {
        db = makeTestDb();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        taskStore = new TaskStore(db as any);
        dispatchFn = vi.fn().mockResolvedValue(undefined);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dagEngine = new DagEngine(db as any, makeQueue(), taskStore, dispatchFn);
    });

    it("marks downstream as failed when upstream fails (default policy)", async () => {
        const taskA = taskStore.create({ sessionId: null, prompt: "A" });
        const taskB = taskStore.create({ sessionId: null, prompt: "B", dependsOn: [taskA.id] });
        expect(taskB.status).toBe("waiting");

        taskStore.updateStatus(taskA.id, "failed", { error: "A exploded" });
        await dagEngine.dispatchReady(taskA.id);

        const updatedB = taskStore.read(taskB.id);
        expect(updatedB.status).toBe("failed");
        expect(updatedB.error).toContain(taskA.id);
        expect(dispatchFn).not.toHaveBeenCalledWith(taskB.id);
    });

    it("propagates failure transitively (C waits on B, B fails because A failed)", async () => {
        const taskA = taskStore.create({ sessionId: null, prompt: "A" });
        const taskB = taskStore.create({ sessionId: null, prompt: "B", dependsOn: [taskA.id] });
        const taskC = taskStore.create({ sessionId: null, prompt: "C", dependsOn: [taskB.id] });

        taskStore.updateStatus(taskA.id, "failed", { error: "A failed" });
        await dagEngine.dispatchReady(taskA.id);

        expect(taskStore.read(taskB.id).status).toBe("failed");
        expect(taskStore.read(taskC.id).status).toBe("failed");
        expect(dispatchFn).not.toHaveBeenCalledWith(taskB.id);
        expect(dispatchFn).not.toHaveBeenCalledWith(taskC.id);
    });

    it("marks downstream as failed when upstream is cancelled", async () => {
        const taskA = taskStore.create({ sessionId: null, prompt: "A" });
        const taskB = taskStore.create({ sessionId: null, prompt: "B", dependsOn: [taskA.id] });

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

    beforeEach(() => {
        db = makeTestDb();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        taskStore = new TaskStore(db as any);
        dispatchFn = vi.fn().mockResolvedValue(undefined);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dagEngine = new DagEngine(db as any, makeQueue(), taskStore, dispatchFn);
    });

    it("dispatches downstream even when upstream fails (skip policy)", async () => {
        const taskA = taskStore.create({ sessionId: null, prompt: "A" });
        const taskB = taskStore.create({
            sessionId: null,
            prompt: "B",
            dependsOn: [taskA.id],
            onUpstreamFailure: "skip",
        });

        taskStore.updateStatus(taskA.id, "failed", { error: "A failed" });
        await dagEngine.dispatchReady(taskA.id);

        expect(dispatchFn).toHaveBeenCalledWith(taskB.id);
        const updatedB = taskStore.read(taskB.id);
        expect(updatedB.status).toBe("pending");
    });

    it("skip: only completed upstreams contribute to inputs (failed upstreams omitted)", async () => {
        const taskA = taskStore.create({ sessionId: null, prompt: "A" });
        const taskB = taskStore.create({ sessionId: null, prompt: "B" });
        const taskC = taskStore.create({
            sessionId: null,
            prompt: "C",
            dependsOn: [taskA.id, taskB.id],
            onUpstreamFailure: "skip",
        });

        taskStore.updateStatus(taskA.id, "completed", { result: "a-result", completedAt: nowIso() });
        taskStore.updateStatus(taskB.id, "failed", { error: "B failed" });

        dispatchFn.mockClear();
        await dagEngine.dispatchReady(taskB.id);

        const updatedC = taskStore.read(taskC.id);
        expect(updatedC.status).toBe("pending");
        expect(dispatchFn).toHaveBeenCalledWith(taskC.id);
    });
});
