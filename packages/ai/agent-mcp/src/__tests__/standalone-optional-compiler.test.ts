/**
 * standalone-optional-compiler.test.ts
 *
 * Proves that @adhd/agent-compiler is OPTIONAL at runtime: when compileAgentFn
 * is absent from BuildPromptResolverOpts, buildPromptResolver returns undefined
 * and every agent falls back to its flat systemPrompt — exactly as when the
 * registry DB is absent.
 *
 * Invariants proven:
 *
 * [standalone.no-compileAgentFn-returns-undefined]
 *   buildPromptResolver with a valid registryDbPath but NO compileAgentFn returns
 *   undefined.  The compiler package being absent does not throw.
 *
 * [standalone.no-compileAgentFn-flat-prompt-fallback]
 *   When buildPromptResolver returns undefined (no compileAgentFn), agentTool
 *   preserves the authored flat systemPrompt and composed_prompt_id is NULL.
 *
 * [standalone.negative-control-with-stub]
 *   MANDATORY TEETH: with a stub compileAgentFn + a valid registry DB path,
 *   buildPromptResolver returns a non-undefined PromptResolverDeps and
 *   resolveComposedPrompt reaches the compiler.  This confirms [standalone.no-
 *   compileAgentFn-returns-undefined] would go RED if the compileAgentFn gate
 *   were removed from buildPromptResolver.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { buildPromptResolver } from "../index.js";
import { runMigrationsOn } from "../db/migrate-runner.js";
import * as agentMcpSchema from "../db/schema.js";
import { AgentStore } from "../store/agent-store.js";
import { SessionStore } from "../store/session-store.js";
import { ComposedPromptStore } from "../store/composed-prompt-store.js";
import { PolicyEngine } from "../engine/policy.js";
import { agentTool } from "../tools/session.js";
import type { SessionDeps } from "../tools/session.js";
import type { CompileAgentFn, PromptResolverDeps } from "../engine/prompt-resolver.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Open and migrate a fresh agent-mcp SQLite file.  Returns {conn, dbAny}. */
function openAgentMcpDb(dbPath: string): { conn: Database.Database; dbAny: unknown } {
    const conn = new Database(dbPath);
    conn.pragma("journal_mode = WAL");
    conn.pragma("foreign_keys = ON");
    const db = drizzle(conn, { schema: agentMcpSchema });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbAny = db as any;
    runMigrationsOn(conn, db);
    return { conn, dbAny };
}

/**
 * Create a minimal valid (but empty — no registry tables) SQLite file at
 * `filePath`.  Simulates a registry DB path that exists on disk but has no
 * data, so that the fileMustExist guard passes while compileAgent would throw.
 */
function createEmptyRegistryFile(filePath: string): void {
    const conn = new Database(filePath);
    conn.pragma("journal_mode = WAL");
    conn.close();
}

/**
 * Stub compileAgentFn — returns a known compiled artifact without touching any
 * real registry DB.  Used only in the negative-control test.
 */
function makeStubCompileAgentFn(content: string): CompileAgentFn {
    return (_input) => ({
        id: 1,
        content,
        tools: [],
        componentVersions: { "stub-component": "v0.0.1" },
    });
}

// ── Fixture constants ─────────────────────────────────────────────────────────

const FLAT_AGENT_NAME   = "standalone-flat-agent";
const FLAT_AGENT_PROMPT = "flat-authored-prompt-standalone-test";
const STUB_COMPILED     = "compiled-by-stub-standalone-test";

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("standalone-optional-compiler — compileAgentFn optional gate", () => {
    let tmpDir: string;
    let agentMcpDbPath: string;
    let emptyRegistryPath: string;

    beforeAll(() => {
        tmpDir          = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mcp-standalone-opt-"));
        agentMcpDbPath  = path.join(tmpDir, "agents.db");
        emptyRegistryPath = path.join(tmpDir, "empty-registry.db");

        // Bootstrap the agent-mcp DB and seed a flat-prompt agent.
        const { conn, dbAny } = openAgentMcpDb(agentMcpDbPath);
        const agentStore = new AgentStore(dbAny);
        agentStore.create({
            name:         FLAT_AGENT_NAME,
            provider:     { type: "openai", model: "gpt-4o-mini" },
            systemPrompt: FLAT_AGENT_PROMPT,
            mcpServers:   {},
            permissions:  {},
        });
        conn.close();

        // A real SQLite file that passes fileMustExist but has no registry tables.
        createEmptyRegistryFile(emptyRegistryPath);
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ── [standalone.no-compileAgentFn-returns-undefined] ─────────────────────
    //
    // The core standalone-path invariant: with a valid registryDbPath but NO
    // compileAgentFn, buildPromptResolver must return undefined rather than throw.

    it("[standalone.no-compileAgentFn-returns-undefined] missing compileAgentFn with valid DB path → undefined", () => {
        const { conn, dbAny } = openAgentMcpDb(agentMcpDbPath);

        // registryDbPath is present and the file exists, but compileAgentFn is absent.
        const result = buildPromptResolver({
            registryDbPath: emptyRegistryPath,
            agentMcpDb: dbAny,
            // compileAgentFn intentionally absent
        });

        expect(result).toBeUndefined();

        conn.close();
    });

    // ── [standalone.no-compileAgentFn-flat-prompt-fallback] ──────────────────
    //
    // End-to-end: when buildPromptResolver returns undefined because compileAgentFn
    // is absent, agentTool preserves the authored flat systemPrompt and the
    // sessions row has composed_prompt_id = NULL.

    it("[standalone.no-compileAgentFn-flat-prompt-fallback] absent compileAgentFn → flat systemPrompt preserved, composed_prompt_id NULL", async () => {
        const { conn, dbAny } = openAgentMcpDb(agentMcpDbPath);

        const agentStore   = new AgentStore(dbAny);
        const sessionStore = new SessionStore(dbAny);
        const policy       = new PolicyEngine({ serverMaxDepth: 10, serverMaxToolLoops: 50 });

        // No compileAgentFn → buildPromptResolver returns undefined → promptResolver absent.
        const promptResolver = buildPromptResolver({
            registryDbPath: emptyRegistryPath,
            agentMcpDb: dbAny,
        });
        expect(promptResolver).toBeUndefined();

        const deps: SessionDeps = { agentStore, sessionStore, policy };
        const { session_id: sessionId } = await agentTool({ name: FLAT_AGENT_NAME }, deps);

        conn.close();

        // Reopen from disk — proves persistence, not in-memory state.
        const { conn: conn2, dbAny: dbAny2 } = openAgentMcpDb(agentMcpDbPath);

        const snapshotStore = new SessionStore(dbAny2);
        const snapshotDef   = snapshotStore.getAgentDefinition(sessionId);

        // systemPrompt must be the authored flat value — not a compiled artifact.
        expect(snapshotDef.systemPrompt).toBe(FLAT_AGENT_PROMPT);

        // composed_prompt_id must be NULL — the compiler was never invoked.
        const raw = (conn2 as unknown as {
            prepare: (s: string) => { get: (...args: unknown[]) => Record<string, unknown> | undefined }
        })
            .prepare("SELECT composed_prompt_id FROM sessions WHERE id = ?")
            .get(sessionId);

        expect(raw).toBeDefined();
        expect(raw!["composed_prompt_id"]).toBeNull();

        conn2.close();
    });

    // ── [standalone.negative-control-with-stub] ───────────────────────────────
    //
    // MANDATORY TEETH: proves the gate in buildPromptResolver is load-bearing.
    //
    // When compileAgentFn IS provided (even a stub), buildPromptResolver returns
    // a non-undefined PromptResolverDeps and passes the fn through to the resolver.
    // If the compileAgentFn check were removed from buildPromptResolver, this test
    // would still pass — but [standalone.no-compileAgentFn-returns-undefined] would
    // go RED (because removing the check lets the function continue past it and
    // return non-undefined even without compileAgentFn).
    //
    // The two tests together form the falsifying pair:
    //   positive (this): stub provided  → non-undefined result (compiled content reaches session)
    //   negative (above): stub absent   → undefined (flat prompt preserved)

    it("[standalone.negative-control-with-stub] with stub compileAgentFn + valid DB path → wired resolver reaches session", async () => {
        const { conn, dbAny } = openAgentMcpDb(agentMcpDbPath);

        const agentStore   = new AgentStore(dbAny);
        const sessionStore = new SessionStore(dbAny);
        const composedPromptStore = new ComposedPromptStore(dbAny);
        const policy       = new PolicyEngine({ serverMaxDepth: 10, serverMaxToolLoops: 50 });

        const stubFn = makeStubCompileAgentFn(STUB_COMPILED);

        // With a stub compileAgentFn, the factory must return a non-undefined resolver.
        const promptResolver = buildPromptResolver({
            registryDbPath: emptyRegistryPath,
            agentMcpDb: dbAny,
            compileAgentFn: stubFn,
        });

        // Gate: resolver is wired (stub fn makes it non-undefined)
        expect(promptResolver).not.toBeUndefined();

        // Verify the returned resolver carries the stub fn through.
        // Even though registryDb is an empty SQLite (no registry tables), the stub
        // never queries the DB — it returns the fixed STUB_COMPILED content.
        const resolverDeps = promptResolver as PromptResolverDeps;
        expect(resolverDeps.compileAgentFn).toBe(stubFn);

        // Drive agentTool with the stub resolver: compiled content must reach the session.
        const deps: SessionDeps = { agentStore, sessionStore, policy, promptResolver };
        const { session_id: sessionId } = await agentTool({ name: FLAT_AGENT_NAME }, deps);

        conn.close();

        const { conn: conn2, dbAny: dbAny2 } = openAgentMcpDb(agentMcpDbPath);
        const snapshotStore = new SessionStore(dbAny2);
        const snapshotDef   = snapshotStore.getAgentDefinition(sessionId);

        // systemPrompt must be the stub-compiled content — NOT the flat authored prompt.
        expect(snapshotDef.systemPrompt).toBe(STUB_COMPILED);
        expect(snapshotDef.systemPrompt).not.toBe(FLAT_AGENT_PROMPT);

        // composed_prompt_id must be non-null — the stub compiler was invoked.
        const raw = (conn2 as unknown as {
            prepare: (s: string) => { get: (...args: unknown[]) => Record<string, unknown> | undefined }
        })
            .prepare("SELECT composed_prompt_id FROM sessions WHERE id = ?")
            .get(sessionId);

        expect(raw).toBeDefined();
        expect(raw!["composed_prompt_id"]).not.toBeNull();
        expect(typeof raw!["composed_prompt_id"]).toBe("string");
        expect((raw!["composed_prompt_id"] as string).length).toBeGreaterThan(0);

        conn2.close();
    });
});
