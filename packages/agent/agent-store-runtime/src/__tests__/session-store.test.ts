import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it, beforeEach, vi } from "vitest";

import { SessionStore, estimateTokens, windowMessages } from "../store/session-store.js";
import type { AgentDefinition, Message } from "../validation/schemas.js";
import { HookRegistry } from "@adhd/agent-base-types";
import * as schema from "../db/schema.js";
import { nowIso } from "../utils/timestamps.js";
import type { ErrorCode } from "../validation/errors.js";

/** Helper to assert that a function throws a ToolError with the expected code */
function expectToolError(fn: () => unknown, code: ErrorCode) {
    try {
        fn();
        expect.fail(`Expected a ToolError with code '${code}' to be thrown`);
    } catch (error: unknown) {
        expect((error as { code?: string }).code).toBe(code);
    }
}

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

function sampleAgentDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
    return {
        name: "test-agent",
        version: 1,
        provider: { type: "openai", model: "gpt-4o-mini" } as AgentDefinition["provider"],
        systemPrompt: "You are a helpful assistant.",
        mcpServers: {},
        permissions: {},
        createdAt: nowIso(),
        updatedAt: nowIso(),
        ...overrides,
    };
}

describe("SessionStore", () => {
    let db: ReturnType<typeof makeTestDb>;
    let store: SessionStore;

    beforeEach(() => {
        db = makeTestDb();
        store = new SessionStore(db as Parameters<typeof SessionStore.prototype.constructor>[0]);
    });

    it("creates a session with status=active", () => {
        const agentDef = sampleAgentDefinition();
        const session = store.create({ agentName: agentDef.name, agentDefinition: agentDef });
        expect(session.status).toBe("active");
        expect(session.agentName).toBe("test-agent");
        expect(session.agentVersion).toBe(1);
    });

    it("reads a session by id", () => {
        const agentDef = sampleAgentDefinition();
        const session = store.create({ agentName: agentDef.name, agentDefinition: agentDef });
        const read = store.read(session.id);
        expect(read.id).toBe(session.id);
        expect(read.status).toBe("active");
    });

    it("getAgentDefinition returns snapshotted definition", () => {
        const agentDef = sampleAgentDefinition({ systemPrompt: "Original prompt" });
        const session = store.create({ agentName: agentDef.name, agentDefinition: agentDef });

        const snapshotted = store.getAgentDefinition(session.id);
        expect(snapshotted.systemPrompt).toBe("Original prompt");
        expect(snapshotted.version).toBe(1);
    });

    it("throws SESSION_NOT_FOUND for unknown session", () => {
        expectToolError(
            () => store.read("00000000-0000-0000-0000-000000000000"),
            "SESSION_NOT_FOUND"
        );
    });

    it("closes a session", () => {
        const agentDef = sampleAgentDefinition();
        const session = store.create({ agentName: agentDef.name, agentDefinition: agentDef });

        const closed = store.close(session.id);
        expect(closed.status).toBe("closed");
        expect(closed.closedAt).toBeDefined();
    });

    it("throws SESSION_CLOSED when closing an already-closed session", () => {
        const agentDef = sampleAgentDefinition();
        const session = store.create({ agentName: agentDef.name, agentDefinition: agentDef });
        store.close(session.id);
        expectToolError(() => store.close(session.id), "SESSION_CLOSED");
    });

    it("lists sessions by agentName", () => {
        const agentDef = sampleAgentDefinition();
        store.create({ agentName: agentDef.name, agentDefinition: agentDef });
        store.create({ agentName: agentDef.name, agentDefinition: { ...agentDef, version: 2 } });

        const list = store.list({ agentName: "test-agent" });
        expect(list).toHaveLength(2);
    });

    it("lists sessions by status", () => {
        const agentDef = sampleAgentDefinition();
        const s1 = store.create({ agentName: agentDef.name, agentDefinition: agentDef });
        store.create({ agentName: agentDef.name, agentDefinition: { ...agentDef, name: "agent-2" } });
        store.close(s1.id);

        const active = store.list({ status: "active" });
        expect(active).toHaveLength(1);

        const closed = store.list({ status: "closed" });
        expect(closed).toHaveLength(1);
    });

    it("lists all sessions when no filter", () => {
        const agentDef = sampleAgentDefinition();
        store.create({ agentName: agentDef.name, agentDefinition: agentDef });
        store.create({ agentName: agentDef.name, agentDefinition: { ...agentDef, name: "agent-2" } });
        expect(store.list({})).toHaveLength(2);
    });

    it("creates session with composedPromptId", () => {
        const agentDef = sampleAgentDefinition();
        const session = store.create({
            agentName: agentDef.name,
            agentDefinition: agentDef,
            composedPromptId: "prompt-123",
        });
        expect(session.id).toBeDefined();
    });

    it("emits session:created hook", () => {
        const hooks = new HookRegistry();
        const onCreated = vi.fn();
        hooks.register("session:created", onCreated);

        const hookedStore = new SessionStore(
            db as Parameters<typeof SessionStore.prototype.constructor>[0],
            hooks
        );

        const agentDef = sampleAgentDefinition();
        hookedStore.create({ agentName: agentDef.name, agentDefinition: agentDef });

        expect(onCreated).toHaveBeenCalledOnce();
        expect(onCreated.mock.calls[0][0].session.agentName).toBe("test-agent");
    });

    it("clearMessages removes messages for session", () => {
        const agentDef = sampleAgentDefinition();
        const session = store.create({ agentName: agentDef.name, agentDefinition: agentDef });

        const msg: Message = {
            id: "msg-1",
            sessionId: session.id,
            role: "user",
            content: "Hello",
            createdAt: nowIso(),
        };
        store.appendMessage(session.id, msg);
        expect(store.getMessages(session.id)).toHaveLength(1);

        const cleared = store.clearMessages(session.id);
        expect(cleared).toBe(1);
        expect(store.getMessages(session.id)).toHaveLength(0);
    });

    it("clearMessages throws SESSION_CLOSED for closed session", () => {
        const agentDef = sampleAgentDefinition();
        const session = store.create({ agentName: agentDef.name, agentDefinition: agentDef });
        store.close(session.id);
        expectToolError(() => store.clearMessages(session.id), "SESSION_CLOSED");
    });

    it("appendMessage and getMessages round-trip", () => {
        const agentDef = sampleAgentDefinition();
        const session = store.create({ agentName: agentDef.name, agentDefinition: agentDef });

        store.appendMessage(session.id, {
            id: "msg-1",
            sessionId: session.id,
            role: "user",
            content: "Hello",
            createdAt: nowIso(),
        });
        store.appendMessage(session.id, {
            id: "msg-2",
            sessionId: session.id,
            role: "assistant",
            content: "Hi there!",
            toolCalls: [{ id: "tc-1", server: "srv", tool: "t", arguments: {} }],
            createdAt: nowIso(),
        });

        const msgs = store.getMessages(session.id);
        expect(msgs).toHaveLength(2);
        expect(msgs[0].role).toBe("user");
        expect(msgs[1].role).toBe("assistant");
        expect(msgs[1].toolCalls).toHaveLength(1);
    });
});

describe("estimateTokens", () => {
    it("returns 0 for empty array", () => {
        expect(estimateTokens([])).toBe(0);
    });

    it("estimates based on content length", () => {
        const msgs: Message[] = [
            { id: "1", sessionId: "s1", role: "user", content: "Hello world, this is a test message.", createdAt: nowIso() },
        ];
        const tokens = estimateTokens(msgs);
        expect(tokens).toBeGreaterThan(0);
        const content = msgs[0].content;
        expect(content).not.toBeNull();
        expect(tokens).toBe(Math.ceil(content.length / 4));
    });
});

describe("windowMessages", () => {
    it("returns original when tokenLimit <= 0", () => {
        const msgs: Message[] = [
            { id: "1", sessionId: "s1", role: "user", content: "test", createdAt: nowIso() },
        ];
        expect(windowMessages(msgs, 0)).toBe(msgs);
    });

    it("preserves system messages", () => {
        const msgs: Message[] = [
            { id: "sys", sessionId: "s1", role: "system", content: "system prompt here", createdAt: nowIso() },
            { id: "1", sessionId: "s1", role: "user", content: "hello", createdAt: nowIso() },
        ];
        const result = windowMessages(msgs, 2); // very tight budget
        const sysInResult = result.filter((m) => m.role === "system");
        expect(sysInResult).toHaveLength(1);
    });

    it("keeps at least one non-system message even if over budget", () => {
        const msgs: Message[] = [
            { id: "sys", sessionId: "s1", role: "system", content: "system", createdAt: nowIso() },
            { id: "1", sessionId: "s1", role: "user", content: "very long message that exceeds any reasonable budget", createdAt: nowIso() },
        ];
        const result = windowMessages(msgs, 1);
        expect(result.filter((m) => m.role !== "system").length).toBeGreaterThanOrEqual(1);
    });
});

// ──────────────────────────────────────────────────────────────────────
// Atomic state transitions (S2 / BUG-AGENTMCP-SESSION-STORE-ATOMICITY-001)
//
// These tests interleave a concurrent writer DETERMINISTICALLY, with no
// sleeps: they drive a second connection to flip the session's status to
// 'closed' from inside a spy on the method's leading `read()` — i.e. in the
// exact window between the leading read returning and the method issuing its
// authoritative write. A black-box two-connection race cannot deterministically
// hit that window against a synchronous method because better-sqlite3 blocks
// the event loop; the read-hook makes the interleaving reproducible.
// ──────────────────────────────────────────────────────────────────────

describe("SessionStore — atomic state transitions (S2)", () => {
    type StoreDb = Parameters<typeof SessionStore.prototype.constructor>[0];

    /** Open a real on-disk DB (WAL) so a second connection can observe/race it. */
    function makeOnDiskTestDb(dir: string) {
        const dbPath = path.join(dir, "session-atomicity.db");
        const sqlite = new Database(dbPath);
        sqlite.pragma("journal_mode = WAL");
        sqlite.pragma("foreign_keys = ON");
        sqlite.exec(CREATE_TABLES_SQL);
        const db = drizzle(sqlite, { schema });
        return { dbPath, sqlite, db };
    }

    /** A timestamp distinguishable from any `nowIso()` value the code would write. */
    const SENTINEL_CLOSED_AT = "1999-12-31T23:59:59.000Z";

    /**
     * Install a spy on `store.read` that runs the real read, then (exactly once)
     * has the second connection close the row — the concurrent deletion/close
     * the read-then-write code could not survive.
     */
    function interleaveCloseAfterLeadingRead(
        store: SessionStore,
        other: InstanceType<typeof Database>
    ): () => void {
        const originalRead = store.read.bind(store);
        let flipped = false;
        const spy = vi.spyOn(store, "read").mockImplementation((id: string) => {
            const result = originalRead(id);
            if (!flipped) {
                flipped = true;
                other
                    .prepare(
                        "UPDATE sessions SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?"
                    )
                    .run(SENTINEL_CLOSED_AT, SENTINEL_CLOSED_AT, id);
            }
            return result;
        });
        return () => spy.mockRestore();
    }

    it("close(): a session closed right after the leading read throws SESSION_CLOSED and closedAt is not rewritten", () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-close-race-"));
        const { dbPath, sqlite, db } = makeOnDiskTestDb(tmpDir);
        try {
            const store = new SessionStore(db as StoreDb);
            const agentDef = sampleAgentDefinition();
            const session = store.create({ agentName: agentDef.name, agentDefinition: agentDef });

            const other = new Database(dbPath);
            other.pragma("foreign_keys = ON");

            const restore = interleaveCloseAfterLeadingRead(store, other);
            try {
                expectToolError(() => store.close(session.id), "SESSION_CLOSED");
            } finally {
                restore();
            }

            // The losing close() must NOT have rewritten closedAt (nor updatedAt).
            const after = store.read(session.id);
            expect(after.status).toBe("closed");
            expect(after.closedAt).toBe(SENTINEL_CLOSED_AT);

            other.close();
        } finally {
            sqlite.close();
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("clearMessages(): a session closed right after the leading read is refused by the in-transaction guard and its messages survive", () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-clear-race-"));
        const { dbPath, sqlite, db } = makeOnDiskTestDb(tmpDir);
        try {
            const store = new SessionStore(db as StoreDb);
            const agentDef = sampleAgentDefinition();
            const session = store.create({ agentName: agentDef.name, agentDefinition: agentDef });

            store.appendMessage(session.id, {
                id: "msg-keep",
                sessionId: session.id,
                role: "user",
                content: "keep me",
                createdAt: nowIso(),
            });
            expect(store.getMessages(session.id)).toHaveLength(1);

            const other = new Database(dbPath);
            other.pragma("foreign_keys = ON");

            const restore = interleaveCloseAfterLeadingRead(store, other);
            try {
                expectToolError(() => store.clearMessages(session.id), "SESSION_CLOSED");
            } finally {
                restore();
            }

            // The guard ran before the delete: nothing was cleared.
            expect(store.getMessages(session.id)).toHaveLength(1);

            other.close();
        } finally {
            sqlite.close();
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("clearMessages(): the status guard and the DELETE execute through the same immediate transaction handle", () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-clear-tx-"));
        const { sqlite, db } = makeOnDiskTestDb(tmpDir);
        try {
            const outerOps: string[] = [];
            const txOps: string[] = [];
            let transactionConfig: unknown;

            // Instrument the drizzle handle: record every operation issued
            // directly on the store's connection, and every operation issued on
            // the transaction handle it hands the callback. Proves the guard
            // SELECT and the DELETE are both transaction-scoped (share one tx),
            // and that the tx is BEGIN IMMEDIATE.
            const instrumented = new Proxy(db as unknown as Record<string, unknown>, {
                get(target, prop) {
                    if (prop === "transaction") {
                        return (cb: (tx: unknown) => unknown, cfg?: unknown) => {
                            transactionConfig = cfg;
                            const run = target["transaction"] as (
                                cb: (tx: unknown) => unknown,
                                cfg?: unknown
                            ) => unknown;
                            return run.call(target, (tx: unknown) => {
                                const txProxy = new Proxy(tx as Record<string, unknown>, {
                                    get(t, p) {
                                        const value = t[String(p)];
                                        if (typeof value === "function") {
                                            return (...args: unknown[]) => {
                                                txOps.push(String(p));
                                                return (value as (...a: unknown[]) => unknown).apply(t, args);
                                            };
                                        }
                                        return value;
                                    },
                                });
                                return cb(txProxy);
                            }, cfg);
                        };
                    }
                    const value = target[String(prop)];
                    if (typeof value === "function") {
                        return (...args: unknown[]) => {
                            outerOps.push(String(prop));
                            return (value as (...a: unknown[]) => unknown).apply(target, args);
                        };
                    }
                    return value;
                },
            }) as unknown as StoreDb;

            const store = new SessionStore(instrumented);
            const agentDef = sampleAgentDefinition();
            const session = store.create({ agentName: agentDef.name, agentDefinition: agentDef });
            store.appendMessage(session.id, {
                id: "msg-1",
                sessionId: session.id,
                role: "user",
                content: "hi",
                createdAt: nowIso(),
            });

            outerOps.length = 0;
            txOps.length = 0;
            transactionConfig = undefined;

            const cleared = store.clearMessages(session.id);

            expect(cleared).toBe(1);
            expect(transactionConfig).toEqual({ behavior: "immediate" });
            // The guard SELECT and the DELETE both ran on the tx handle ...
            expect(txOps).toContain("select");
            expect(txOps).toContain("delete");
            // ... and the DELETE never escaped to the outer connection.
            expect(outerOps).not.toContain("delete");
        } finally {
            sqlite.close();
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
