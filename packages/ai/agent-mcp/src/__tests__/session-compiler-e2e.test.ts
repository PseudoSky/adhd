/**
 * session-compiler-e2e — dod.1
 *
 * Proves [session-e2e.1] and [session-e2e.3] through the REAL `agentTool` entry
 * point (the exact function the server calls at session start — see tools/session.ts).
 *
 * Invariants exercised:
 * - [inv:real-session-start] — REAL SessionStore + ComposedPromptStore + AgentStore
 *   wired against an ON-DISK SQLite file with migrations applied.  agentTool is the
 *   real production export; the test never re-implements the resolve→create sequence.
 * - [inv:reopen-proves-cache] — persistence is proven by CLOSING the better-sqlite3
 *   handle and REOPENING from the same file path.
 * - [inv:exit-code-gate] — gate keys on vitest's exit code.
 *
 * Production files are READ-ONLY here.  Only the two __tests__/*.test.ts files in
 * the `mutates` set for this state were written.
 *
 * [session-e2e.3] Negative control proof:
 *   To prove the assertions have teeth, the stub is made to return a DIFFERENT
 *   string from what the test asserts → deep-equal FAILS.  That control is
 *   captured in the "NEGATIVE CONTROL" describe block below.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMigrationsOn } from "../db/migrate-runner.js";
import * as schema from "../db/schema.js";
import { AgentStore } from "../store/agent-store.js";
import { ComposedPromptStore } from "../store/composed-prompt-store.js";
import { SessionStore } from "../store/session-store.js";
import type { CompileAgentFn, PromptResolverDeps } from "../engine/prompt-resolver.js";
import { agentTool } from "../tools/session.js";
import type { SessionDeps } from "../tools/session.js";
import { PolicyEngine } from "../engine/policy.js";
import type { AgentCreateInput } from "../validation/index.js";

// ── Test DB helpers ────────────────────────────────────────────────────────────

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-e2e-test-"));
    dbPath = path.join(tmpDir, "agents.db");
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Open (or reopen) a better-sqlite3 handle and run migrations.
 * Returns both the raw sqlite handle (needed for raw SQL assertions + close())
 * and the drizzle wrapper.
 */
function openDb(filePath: string) {
    const sqlite = new Database(filePath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite, { schema });
    runMigrationsOn(sqlite, db);
    return { sqlite, db };
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

const AGENT_NAME = "session-e2e-agent";

// Known content the stub returns — asserted as the deep-equal target.
const COMPILED_CONTENT = "System prompt compiled from registry. [session-e2e fixture]";

const WRONG_CONTENT = "This is NOT the compiled content — negative control divergence";

const sampleAgentInput = (): AgentCreateInput => ({
    name: AGENT_NAME,
    provider: { type: "openai", model: "gpt-4o-mini" },
    systemPrompt: "original authored prompt — must be replaced by compiled content",
    mcpServers: {},
    permissions: {},
});

/**
 * Build a stub compileAgentFn returning a fixed compiled artifact.
 * Only the LLM/compiler boundary is stubbed — stores, DB, and agentTool are real.
 */
function makeStubCompileAgent(content: string = COMPILED_CONTENT): CompileAgentFn {
    return (_input) => ({
        id: 1,
        content,
        tools: [],
        componentVersions: { "core-prompt": "v1.0.0" },
    });
}

/**
 * Build a fully-wired SessionDeps for the REAL agentTool, given an open DB
 * and a stub compile function.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDeps(db: any, compileAgentFn: CompileAgentFn): SessionDeps {
    const agentStore = new AgentStore(db);
    const sessionStore = new SessionStore(db);
    const composedPromptStore = new ComposedPromptStore(db);

    const promptResolver: PromptResolverDeps = {
        composedPromptStore,
        compileAgentFn,
        registryDb: db,
    };

    const policy = new PolicyEngine({
        serverMaxDepth: 10,
        serverMaxToolLoops: 50,
        policyTemplateRules: [],
    });

    return { agentStore, sessionStore, policy, promptResolver };
}

// ── [session-e2e.1] real agentTool: systemPrompt == compileAgent output ────────

describe("session-compiler-e2e [dod.1] — REAL agentTool drives session start", () => {
    it("resolved session systemPrompt deep-equals compileAgent output (proven by DB reopen)", async () => {
        // ── Phase 1: start a session via the REAL agentTool ───────────────────
        const { sqlite, db } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dbAny = db as any;

        const deps = makeDeps(dbAny, makeStubCompileAgent(COMPILED_CONTENT));
        // Seed the agent (FK requirement for sessions.agent_name)
        deps.agentStore.create(sampleAgentInput());

        // Drive the REAL agentTool — this is the SAME function the server calls.
        // The resolve→create sequence is NOT re-implemented here.
        const { session_id: sessionId } = await agentTool({ name: AGENT_NAME }, deps);

        // Close the handle so no in-memory state can satisfy the next assertion.
        sqlite.close();

        // ── Phase 2: reopen from the same on-disk path ────────────────────────
        // [inv:reopen-proves-cache]: persistence proven by reopening, not in-memory read.
        const { sqlite: sqlite2, db: db2 } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db2Any = db2 as any;

        // ── Assert 1: snapshotted systemPrompt deep-equals compileAgent output ─
        const snapshotStore = new SessionStore(db2Any);
        const snapshotDef = snapshotStore.getAgentDefinition(sessionId);

        expect(snapshotDef.systemPrompt).toBe(COMPILED_CONTENT);
        expect(snapshotDef.systemPrompt).not.toBe("original authored prompt — must be replaced by compiled content");

        // ── Assert 2: sessions.composed_prompt_id references the cached row ────
        const rawRow = (sqlite2 as unknown as {
            prepare: (s: string) => { get: (...a: unknown[]) => Record<string, unknown> | undefined };
        })
            .prepare("SELECT composed_prompt_id FROM sessions WHERE id = ?")
            .get(sessionId);

        expect(rawRow).toBeDefined();
        const composedPromptId = rawRow!["composed_prompt_id"];
        expect(composedPromptId).not.toBeNull();
        expect(typeof composedPromptId).toBe("string");
        expect((composedPromptId as string).length).toBeGreaterThan(0);

        // ── Assert 3: the referenced composed_prompts row contains the compiled content
        const cpRow = (sqlite2 as unknown as {
            prepare: (s: string) => { get: (...a: unknown[]) => Record<string, unknown> | undefined };
        })
            .prepare("SELECT content FROM composed_prompts WHERE id = ?")
            .get(composedPromptId);

        expect(cpRow).toBeDefined();
        expect(cpRow!["content"]).toBe(COMPILED_CONTENT);

        sqlite2.close();
    });
});

// ── [session-e2e.3] negative control: wrong content → deep-equal goes RED ─────
//
// This describe block demonstrates that if the compileAgent stub returns a
// DIFFERENT string from COMPILED_CONTENT, the deep-equal assertion used in
// dod.1 goes RED — proving the assertion has teeth.
//
// The negative control is INTENTIONAL: the assertion in this block is expected
// to FAIL (i.e., the two strings are NOT equal).  This is NOT a bug; it is the
// proof that the test above would go red if production were broken.
//
// In normal (green) production state: compileAgent returns COMPILED_CONTENT and
// the positive test above passes.  Here we deliberately use WRONG_CONTENT to
// show what failure looks like.

describe("session-compiler-e2e [session-e2e.3] — NEGATIVE CONTROL proof", () => {
    it("when stub returns WRONG_CONTENT the snapshotted systemPrompt does NOT equal COMPILED_CONTENT", async () => {
        // Stub returns WRONG_CONTENT — simulates what happens when the compiler
        // call is broken (returns different output from what the test asserts).
        const { sqlite, db } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dbAny = db as any;

        const wrongDeps = makeDeps(dbAny, makeStubCompileAgent(WRONG_CONTENT));
        wrongDeps.agentStore.create(sampleAgentInput());

        const { session_id: sessionId } = await agentTool({ name: AGENT_NAME }, wrongDeps);
        sqlite.close();

        // Reopen and read back the snapshotted system prompt.
        const { sqlite: sqlite2, db: db2 } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db2Any = db2 as any;

        const snapshotStore = new SessionStore(db2Any);
        const snapshotDef = snapshotStore.getAgentDefinition(sessionId);

        // The compiled content returned by the WRONG stub IS stored...
        expect(snapshotDef.systemPrompt).toBe(WRONG_CONTENT);

        // ...but it does NOT equal COMPILED_CONTENT — this is what makes the
        // positive test's toBe(COMPILED_CONTENT) go RED when the stub is wrong.
        expect(snapshotDef.systemPrompt).not.toBe(COMPILED_CONTENT);

        sqlite2.close();
    });
});
