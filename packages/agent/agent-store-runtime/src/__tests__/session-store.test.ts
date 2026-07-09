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
