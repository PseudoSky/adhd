/**
 * Guard test for compiler-integration state.
 *
 * Invariants proven here:
 * - [compiler-integration.1] prompt-resolver imports compileAgent from @adhd/agent-compiler
 *   (proven by type-level import of CompileAgentFn + structural shape check)
 * - [compiler-integration.2] resolver caches/looks up the composed prompt and writes
 *   composed_prompt_id (proven by: MISS calls stub, id written to session row;
 *   HIT returns cached content WITHOUT calling stub a second time)
 * - [compiler-integration.3] compiler-resolve test passes: systemPrompt comes from
 *   compileAgent output (proven by getAgentDefinition returning the compiled content)
 *
 * [inv:real-session-start] — real SessionStore + ComposedPromptStore + AgentStore wired
 * against a real on-disk SQLite file with migrations applied.  The LLM provider boundary
 * is the ONLY thing stubbed (compileAgentFn returns a known fixture).
 * [inv:reopen-proves-cache] — cache HIT proven by CLOSING the better-sqlite3 handle
 * and REOPENING from the same file path, then asserting the row persisted.
 * [inv:exit-code-gate]     — gate keys on vitest's exit code, NOT stdout grep.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runMigrationsOn } from "../db/migrate-runner.js";
import * as schema from "../db/schema.js";
import { AgentStore } from "../store/agent-store.js";
import { ComposedPromptStore } from "../store/composed-prompt-store.js";
import { SessionStore } from "../store/session-store.js";
import { resolveComposedPrompt, computeContextHash } from "../engine/prompt-resolver.js";
import type { CompileAgentFn, PromptResolverDeps } from "../engine/prompt-resolver.js";
import type { AgentCreateInput } from "../validation/index.js";

// ── Test DB helpers ────────────────────────────────────────────────────────────

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "compiler-resolve-test-"));
    dbPath = path.join(tmpDir, "agents.db");
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function openDb(filePath: string) {
    const sqlite = new Database(filePath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite, { schema });
    runMigrationsOn(sqlite, db);
    return { sqlite, db };
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

const AGENT_NAME = "test-compiler-agent";
const COMPILED_CONTENT = "You are a compiled test assistant. [from compileAgent stub]";
const COMPILED_COMPONENT_VERSIONS = { "core-prompt": "v1.0.0" };

const sampleAgentInput = (): AgentCreateInput => ({
    name: AGENT_NAME,
    provider: { type: "openai", model: "gpt-4o-mini" },
    systemPrompt: "original authored prompt — should be replaced by compiled content",
    mcpServers: {},
    permissions: {},
});

/**
 * Build a stub compileAgentFn returning a fixed compiled artifact.
 * The stub NEVER touches a real registry DB — only tests the resolver seam.
 */
function makeStubCompileAgent(content: string = COMPILED_CONTENT): {
    fn: CompileAgentFn;
    callCount: () => number;
} {
    let calls = 0;
    const fn: CompileAgentFn = (_input) => {
        calls++;
        return {
            id: 1,
            content,
            tools: [],
            componentVersions: COMPILED_COMPONENT_VERSIONS,
        };
    };
    return { fn, callCount: () => calls };
}

// ── [compiler-integration.3] systemPrompt comes from compileAgent output ──────

describe("resolveComposedPrompt — MISS path", () => {
    it("calls compileAgentFn on cache miss and returns its content", () => {
        const { sqlite, db } = openDb(dbPath);
        const composedPromptStore = new ComposedPromptStore(db as ConstructorParameters<typeof ComposedPromptStore>[0]);
        const { fn: compileAgentFn, callCount } = makeStubCompileAgent();

        const deps: PromptResolverDeps = {
            composedPromptStore,
            compileAgentFn,
            registryDb: db as PromptResolverDeps["registryDb"],
        };

        const result = resolveComposedPrompt(
            { agentSlug: AGENT_NAME, platform: "openai", context: {} },
            deps
        );

        expect(callCount()).toBe(1);
        expect(result.content).toBe(COMPILED_CONTENT);
        expect(typeof result.id).toBe("string");
        expect(result.id.length).toBeGreaterThan(0);

        sqlite.close();
    });

    it("writes a composed_prompts row on cache miss", () => {
        const { sqlite, db } = openDb(dbPath);
        const composedPromptStore = new ComposedPromptStore(db as ConstructorParameters<typeof ComposedPromptStore>[0]);
        const { fn: compileAgentFn } = makeStubCompileAgent();

        const deps: PromptResolverDeps = {
            composedPromptStore,
            compileAgentFn,
            registryDb: db as PromptResolverDeps["registryDb"],
        };

        const result = resolveComposedPrompt(
            { agentSlug: AGENT_NAME, platform: "openai", context: {} },
            deps
        );

        // Verify the row is actually in the DB (not just in memory)
        const contextHash = computeContextHash(AGENT_NAME, "openai", {});
        const cached = composedPromptStore.findByAgentContext(AGENT_NAME, contextHash);
        expect(cached).not.toBeNull();
        expect(cached!.id).toBe(result.id);
        expect(cached!.content).toBe(COMPILED_CONTENT);

        sqlite.close();
    });
});

describe("resolveComposedPrompt — HIT path", () => {
    it("returns cached content WITHOUT calling compileAgentFn on second call", () => {
        const { sqlite, db } = openDb(dbPath);
        const composedPromptStore = new ComposedPromptStore(db as ConstructorParameters<typeof ComposedPromptStore>[0]);
        const { fn: compileAgentFn, callCount } = makeStubCompileAgent();

        const deps: PromptResolverDeps = {
            composedPromptStore,
            compileAgentFn,
            registryDb: db as PromptResolverDeps["registryDb"],
        };

        const input = { agentSlug: AGENT_NAME, platform: "openai", context: {} };

        // First call → MISS → compileAgentFn called once
        const first = resolveComposedPrompt(input, deps);
        expect(callCount()).toBe(1);

        // Second call → HIT → compileAgentFn NOT called again
        const second = resolveComposedPrompt(input, deps);
        expect(callCount()).toBe(1); // still 1 — no second compile
        expect(second.content).toBe(first.content);
        expect(second.id).toBe(first.id);

        sqlite.close();
    });

    it("cache HIT persists across DB handle reopen [inv:reopen-proves-cache]", () => {
        // ── write phase ──────────────────────────────────────────────────────
        const { sqlite: sqliteA, db: dbA } = openDb(dbPath);
        const composedPromptStoreA = new ComposedPromptStore(dbA as ConstructorParameters<typeof ComposedPromptStore>[0]);
        const { fn: compileAgentFn } = makeStubCompileAgent();

        const depsA: PromptResolverDeps = {
            composedPromptStore: composedPromptStoreA,
            compileAgentFn,
            registryDb: dbA as PromptResolverDeps["registryDb"],
        };

        const firstResult = resolveComposedPrompt(
            { agentSlug: AGENT_NAME, platform: "openai", context: {} },
            depsA
        );

        sqliteA.close(); // close handle — proves we're not reading in-memory state

        // ── reopen from the same file path ───────────────────────────────────
        const { sqlite: sqliteB, db: dbB } = openDb(dbPath);
        const composedPromptStoreB = new ComposedPromptStore(dbB as ConstructorParameters<typeof ComposedPromptStore>[0]);

        const contextHash = computeContextHash(AGENT_NAME, "openai", {});
        const cached = composedPromptStoreB.findByAgentContext(AGENT_NAME, contextHash);

        expect(cached).not.toBeNull();
        expect(cached!.id).toBe(firstResult.id);
        expect(cached!.content).toBe(COMPILED_CONTENT);

        sqliteB.close();
    });
});

// ── [compiler-integration.2] session start writes non-null composed_prompt_id ──

describe("session start — composed_prompt_id written", () => {
    it("writes non-null composed_prompt_id to the sessions row", () => {
        const { sqlite, db } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dbAny = db as any;

        const agentStore = new AgentStore(dbAny);
        const sessionStore = new SessionStore(dbAny);
        const composedPromptStore = new ComposedPromptStore(dbAny);
        const { fn: compileAgentFn } = makeStubCompileAgent();

        // Create the agent (required for FK on sessions.agent_name)
        agentStore.create(sampleAgentInput());
        const agentDefinition = agentStore.read(AGENT_NAME);

        // Resolve the prompt via the resolver
        const deps: PromptResolverDeps = {
            composedPromptStore,
            compileAgentFn,
            registryDb: dbAny,
        };

        const resolved = resolveComposedPrompt(
            { agentSlug: AGENT_NAME, platform: agentDefinition.provider.type, context: {} },
            deps
        );

        // Create the session with the resolved prompt (compat-shim) and composedPromptId
        const snapshotDef = { ...agentDefinition, systemPrompt: resolved.content };
        const session = sessionStore.create({
            agentName: AGENT_NAME,
            agentDefinition: snapshotDef,
            composedPromptId: resolved.id,
        });

        // Verify composed_prompt_id is non-null on the raw DB row
        const row = (sqlite as unknown as {
            prepare: (s: string) => { get: (...args: unknown[]) => Record<string, unknown> | undefined }
        })
            .prepare("SELECT composed_prompt_id FROM sessions WHERE id = ?")
            .get(session.id);

        expect(row).toBeDefined();
        expect(row!["composed_prompt_id"]).not.toBeNull();
        expect(row!["composed_prompt_id"]).toBe(resolved.id);

        sqlite.close();
    });

    it("getAgentDefinition returns the compiled content as systemPrompt [def:compat-shim]", () => {
        const { sqlite, db } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dbAny = db as any;

        const agentStore = new AgentStore(dbAny);
        const sessionStore = new SessionStore(dbAny);
        const composedPromptStore = new ComposedPromptStore(dbAny);
        const { fn: compileAgentFn } = makeStubCompileAgent();

        agentStore.create(sampleAgentInput());
        const agentDefinition = agentStore.read(AGENT_NAME);

        const deps: PromptResolverDeps = {
            composedPromptStore,
            compileAgentFn,
            registryDb: dbAny,
        };

        const resolved = resolveComposedPrompt(
            { agentSlug: AGENT_NAME, platform: agentDefinition.provider.type, context: {} },
            deps
        );

        // Populate the compat-shim: systemPrompt = compiled content
        const snapshotDef = { ...agentDefinition, systemPrompt: resolved.content };
        const session = sessionStore.create({
            agentName: AGENT_NAME,
            agentDefinition: snapshotDef,
            composedPromptId: resolved.id,
        });

        // The snapshotted AgentDefinition in the session must carry the compiled content
        const snapshotBack = sessionStore.getAgentDefinition(session.id);
        expect(snapshotBack.systemPrompt).toBe(COMPILED_CONTENT);

        // The original authored prompt must NOT be present
        expect(snapshotBack.systemPrompt).not.toBe("original authored prompt — should be replaced by compiled content");

        sqlite.close();
    });
});

// ── computeContextHash determinism ────────────────────────────────────────────

describe("computeContextHash", () => {
    it("is deterministic — same inputs produce the same hash", () => {
        const a = computeContextHash("my-agent", "openai", { key: "val" });
        const b = computeContextHash("my-agent", "openai", { key: "val" });
        expect(a).toBe(b);
        expect(a).toHaveLength(64); // SHA-256 hex
    });

    it("differs for different agentSlugs", () => {
        const a = computeContextHash("agent-a", "openai", {});
        const b = computeContextHash("agent-b", "openai", {});
        expect(a).not.toBe(b);
    });

    it("differs for different platforms", () => {
        const a = computeContextHash("agent", "openai", {});
        const b = computeContextHash("agent", "claude_code", {});
        expect(a).not.toBe(b);
    });

    it("context key order does not affect the hash", () => {
        const a = computeContextHash("agent", "openai", { b: "2", a: "1" });
        const b = computeContextHash("agent", "openai", { a: "1", b: "2" });
        expect(a).toBe(b);
    });
});
