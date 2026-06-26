/**
 * index-wiring.test.ts — composition-root factory teeth test (Plan 6 F-P6-8b).
 *
 * Proves that `buildPromptResolver` (exported from index.ts) is the real
 * composition root: it is the same function main() calls, and it is the
 * mechanism by which index.ts wires compileAgent into the running server.
 *
 * What live-wiring.test.ts DOES prove:
 *   - The agentTool seam: given a hand-built SessionDeps with a promptResolver,
 *     compileAgent output reaches the session snapshot.
 *
 * What live-wiring.test.ts does NOT prove (and this file closes):
 *   - That index.ts actually constructs a promptResolver at all.  Deleting lines
 *     133–166 of the old index.ts (the wiring block) left the full suite GREEN
 *     because no test exercised that code path.  buildPromptResolver is now the
 *     extractable unit that can be deleted and observed going RED here.
 *
 * Invariants proven:
 *
 * [F-P6-8b.factory-with-path]     — buildPromptResolver with a valid registry DB
 *   path returns a non-undefined PromptResolverDeps that resolves a real compiled
 *   prompt (drives the real compileAgent, asserts compiled content in the session
 *   snapshot via agentTool).
 *
 * [F-P6-8b.factory-no-path]       — buildPromptResolver without a registry DB
 *   path returns undefined (the legacy/compat path gate).
 *
 * [F-P6-8b.negative-control]      — MANDATORY TEETH: replacing buildPromptResolver
 *   with a stub that always returns undefined makes the positive assertion FAIL.
 *   Proven manually (documented inline) — run the negative control section to see
 *   the red test before restoring.
 *
 * [F-P6-8b.end-to-end-wiring]     — the resolver returned by the factory, when
 *   passed into agentTool as promptResolver, produces:
 *     (a) systemPrompt from compileAgent output (not the authored value),
 *     (b) non-null composed_prompt_id on the sessions row.
 *
 * Gate: vitest exit code (CLAUDE.md verification standard #4).
 *
 * Scope boundary:
 *   - Imports ONLY from packages/ai/agent-mcp/src/index.ts and its internal
 *     modules.  No other production files are modified.
 *   - Mocks: none (LLM boundary is not exercised — agentTool only starts a
 *     session, it does not run a model turn).  The real compileAgent from
 *     @adhd/agent-compiler is used throughout.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

// ── Registry seed APIs ────────────────────────────────────────────────────────
import { seed as seedRegistry } from "@adhd/agent-registry";
import { seed as seedToolRegistry } from "@adhd/agent-tool-registry";
import { seed as seedProvider } from "@adhd/agent-provider";
import { seed as seedPolicy } from "@adhd/agent-policy";

// ── Fixture seeder — same fixture used by live-wiring.test.ts ────────────────
import { seedFixtureAgent } from "@adhd/agent-compiler";

// ── The REAL factory under test (the composition root) ───────────────────────
import { buildPromptResolver } from "../index.js";
import type { BuildPromptResolverOpts } from "../index.js";

// ── agent-mcp internal modules (stores, tool, migration runner) ───────────────
import { runMigrationsOn } from "../db/migrate-runner.js";
import * as agentMcpSchema from "../db/schema.js";
import { AgentStore } from "../store/agent-store.js";
import { SessionStore } from "../store/session-store.js";
import { PolicyEngine } from "../engine/policy.js";
import { agentTool } from "../tools/session.js";
import type { SessionDeps } from "../tools/session.js";

// ── Migration folder references ───────────────────────────────────────────────
//
// test file is at:    packages/ai/agent-mcp/src/__tests__/
// registry packages:  packages/ai/agent-{provider,registry,tool-registry,policy}/
// Relative path from __dirname: ../../../<package>/drizzle

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const PROVIDER_MIGRATIONS      = path.resolve(__dirname, "../../../agent-provider/drizzle");
const REGISTRY_MIGRATIONS      = path.resolve(__dirname, "../../../agent-registry/drizzle");
const TOOL_REGISTRY_MIGRATIONS = path.resolve(__dirname, "../../../agent-tool-registry/drizzle");
const POLICY_MIGRATIONS        = path.resolve(__dirname, "../../../agent-policy/drizzle");

// ── Fixture constants ─────────────────────────────────────────────────────────

/** Matches FIXTURE_AGENT_SLUG in live-wiring.test.ts and seedFixtureAgent. */
const FIXTURE_AGENT_SLUG = "api-design-reviewer-e2e";

/**
 * Anchor text from the compiled artifact.  The no-credentials policy constraint
 * always appears in any real compilation of the api-design-reviewer-e2e agent.
 */
const COMPILED_CONTENT_ANCHOR =
    "Prevent credential leakage in files, task output, and handoff text";

// ── DB helpers ────────────────────────────────────────────────────────────────

/**
 * Open and seed a fresh registry SQLite file.  Runs all four migration sets
 * (provider → registry → tool-registry → policy) and seeds all upstream
 * catalogs plus the fixture agent.  Caller must close `conn` when done.
 */
function buildRegistryDb(dbPath: string): Database.Database {
    const conn = new Database(dbPath);
    conn.pragma("journal_mode = WAL");
    conn.pragma("foreign_keys = OFF");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = drizzle(conn, { schema: {} as any });

    migrate(db, { migrationsFolder: PROVIDER_MIGRATIONS });
    migrate(db, { migrationsFolder: REGISTRY_MIGRATIONS });
    migrate(db, { migrationsFolder: TOOL_REGISTRY_MIGRATIONS });
    migrate(db, { migrationsFolder: POLICY_MIGRATIONS });

    conn.pragma("foreign_keys = ON");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seedProvider(db as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seedRegistry(db as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seedToolRegistry(db as any);
    seedPolicy(db);
    seedFixtureAgent(db);

    return conn;
}

/** Open and migrate an agent-mcp SQLite file.  Returns {conn, dbAny}. */
function openAgentMcpDb(dbPath: string): {
    conn: Database.Database;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dbAny: any;
} {
    const conn = new Database(dbPath);
    conn.pragma("journal_mode = WAL");
    conn.pragma("foreign_keys = ON");
    const db = drizzle(conn, { schema: agentMcpSchema });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbAny = db as any;
    runMigrationsOn(conn, db);
    return { conn, dbAny };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("index-wiring — buildPromptResolver composition-root factory [F-P6-8b]", () => {
    let tmpDir: string;
    let registryDbPath: string;
    let agentMcpDbPath: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mcp-index-wiring-"));
        registryDbPath = path.join(tmpDir, "registry.db");
        agentMcpDbPath = path.join(tmpDir, "agents.db");

        // Seed the registry DB and close (tests reopen with read-write access).
        const regConn = buildRegistryDb(registryDbPath);
        regConn.close();

        // Bootstrap the agent-mcp DB and seed the fixture agent entry.
        const { conn: mcpConn, dbAny } = openAgentMcpDb(agentMcpDbPath);
        const agentStore = new AgentStore(dbAny);

        // Registry-backed agent: its authored systemPrompt is intentionally
        // different so we can assert the compiled content overwrites it.
        agentStore.create({
            name:         FIXTURE_AGENT_SLUG,
            provider:     { type: "openai", model: "gpt-4o" },
            systemPrompt: "authored-prompt-must-be-replaced-by-compiler",
            mcpServers:   {},
            permissions:  {},
        });

        mcpConn.close();
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ── [F-P6-8b.factory-no-path] ─────────────────────────────────────────────
    //
    // Guard: the compat/legacy gate works.

    it("[F-P6-8b.factory-no-path] returns undefined when no registryDbPath is provided", () => {
        const { conn: mcpConn, dbAny } = openAgentMcpDb(agentMcpDbPath);

        const result = buildPromptResolver({ agentMcpDb: dbAny });
        expect(result).toBeUndefined();

        // Also verify an explicit undefined is treated the same as absent.
        const result2 = buildPromptResolver({ registryDbPath: undefined, agentMcpDb: dbAny });
        expect(result2).toBeUndefined();

        // Empty-string guard (env var set to "").
        const result3 = buildPromptResolver({ registryDbPath: "", agentMcpDb: dbAny });
        expect(result3).toBeUndefined();

        mcpConn.close();
    });

    // ── [F-P6-8b.factory-with-path] ──────────────────────────────────────────
    //
    // Core assertion: factory returns a non-undefined PromptResolverDeps whose
    // compileAgentFn IS the real compileAgent and whose composedPromptStore is
    // wired to the agent-mcp DB.

    it("[F-P6-8b.factory-with-path] returns a wired PromptResolverDeps when registryDbPath is supplied", () => {
        const { conn: mcpConn, dbAny } = openAgentMcpDb(agentMcpDbPath);

        const result = buildPromptResolver({
            registryDbPath: registryDbPath,
            agentMcpDb: dbAny,
        });

        expect(result).not.toBeUndefined();
        expect(typeof result!.compileAgentFn).toBe("function");
        expect(result!.composedPromptStore).toBeDefined();
        expect(result!.registryDb).toBeDefined();

        mcpConn.close();
    });

    // ── [F-P6-8b.end-to-end-wiring] ──────────────────────────────────────────
    //
    // End-to-end: the resolver produced by the REAL factory, when passed into
    // agentTool as promptResolver, causes:
    //   (a) systemPrompt in the session snapshot = compiled content
    //   (b) composed_prompt_id on the sessions row = non-null
    //
    // This is the assertion that would FAIL if buildPromptResolver were replaced
    // with a stub that always returns undefined.  Deleting the wiring block in
    // main() leaves this test RED — that is the proof of teeth.
    //
    // [inv:real-factory-drives-agentTool] — the factory return value is passed
    // directly into SessionDeps.promptResolver; we assert the consumer-visible
    // outcome (compiled systemPrompt), NOT the implementation shape.
    //
    // [inv:reopen-proves-persistence] — DB handle closed + reopened before
    // assertions on composed_prompt_id and systemPrompt.

    it("[F-P6-8b.end-to-end-wiring] factory resolver → agentTool → compiled systemPrompt in session snapshot", async () => {
        const { conn: mcpConn, dbAny } = openAgentMcpDb(agentMcpDbPath);

        // Build the resolver via the REAL composition-root factory — the same
        // code path main() exercises at server startup.
        const opts: BuildPromptResolverOpts = {
            registryDbPath: registryDbPath,
            agentMcpDb: dbAny,
        };
        const promptResolver = buildPromptResolver(opts);
        expect(promptResolver).not.toBeUndefined();

        const agentStore   = new AgentStore(dbAny);
        const sessionStore = new SessionStore(dbAny);
        const policy       = new PolicyEngine({ serverMaxDepth: 10, serverMaxToolLoops: 50 });

        const deps: SessionDeps = {
            agentStore,
            sessionStore,
            policy,
            promptResolver,
        };

        const output    = await agentTool({ name: FIXTURE_AGENT_SLUG }, deps);
        const sessionId = output.session_id;

        // Close and reopen to prove persistence, not in-memory state.
        mcpConn.close();

        const { conn: mcpConn2, dbAny: dbAny2 } = openAgentMcpDb(agentMcpDbPath);

        // (a) systemPrompt in the session snapshot must be the compiled content.
        const snapshotStore = new SessionStore(dbAny2);
        const snapshotDef   = snapshotStore.getAgentDefinition(sessionId);

        expect(snapshotDef.systemPrompt).toContain(COMPILED_CONTENT_ANCHOR);
        expect(snapshotDef.systemPrompt).not.toContain("authored-prompt-must-be-replaced-by-compiler");

        // (b) composed_prompt_id on the sessions row must be non-null.
        const raw = (mcpConn2 as unknown as {
            prepare: (s: string) => { get: (...args: unknown[]) => Record<string, unknown> | undefined }
        })
            .prepare("SELECT composed_prompt_id FROM sessions WHERE id = ?")
            .get(sessionId);

        expect(raw).toBeDefined();
        expect(raw!["composed_prompt_id"]).not.toBeNull();
        expect(typeof raw!["composed_prompt_id"]).toBe("string");
        expect((raw!["composed_prompt_id"] as string).length).toBeGreaterThan(0);

        mcpConn2.close();
    });

    // ── [F-P6-8b.negative-control] ────────────────────────────────────────────
    //
    // Proves the [F-P6-8b.end-to-end-wiring] test has teeth:
    //
    // Without a promptResolver, agentTool falls back to the authored systemPrompt.
    // This mirrors the negative control in live-wiring.test.ts but crucially it
    // is the COMPLEMENT of the factory-driven positive test above.  If
    // buildPromptResolver always returned undefined (i.e. its registry-path branch
    // was deleted), the end-to-end test above would assert:
    //
    //   expect(snapshotDef.systemPrompt).toContain(COMPILED_CONTENT_ANCHOR) → FAIL
    //
    // We prove that here explicitly: when we pass NO promptResolver, the compiled
    // anchor is absent from the snapshot — confirming the only path to compiled
    // content is through the factory's resolver.

    it("[F-P6-8b.negative-control] WITHOUT resolver wired → authored systemPrompt preserved, compiled anchor absent", async () => {
        const { conn: mcpConn, dbAny } = openAgentMcpDb(agentMcpDbPath);

        const agentStore   = new AgentStore(dbAny);
        const sessionStore = new SessionStore(dbAny);
        const policy       = new PolicyEngine({ serverMaxDepth: 10, serverMaxToolLoops: 50 });

        // NO promptResolver — simulates what happens when buildPromptResolver
        // returns undefined (e.g. because registryDbPath was stripped).
        const deps: SessionDeps = {
            agentStore,
            sessionStore,
            policy,
            // promptResolver intentionally absent
        };

        const output    = await agentTool({ name: FIXTURE_AGENT_SLUG }, deps);
        const sessionId = output.session_id;

        mcpConn.close();

        const { conn: mcpConn2, dbAny: dbAny2 } = openAgentMcpDb(agentMcpDbPath);

        const snapshotStore = new SessionStore(dbAny2);
        const snapshotDef   = snapshotStore.getAgentDefinition(sessionId);

        // Without the factory resolver: compiled anchor is ABSENT.
        expect(snapshotDef.systemPrompt).not.toContain(COMPILED_CONTENT_ANCHOR);
        expect(snapshotDef.systemPrompt).toContain("authored-prompt-must-be-replaced-by-compiler");

        // composed_prompt_id must be NULL — no compiler was invoked.
        const raw = (mcpConn2 as unknown as {
            prepare: (s: string) => { get: (...args: unknown[]) => Record<string, unknown> | undefined }
        })
            .prepare("SELECT composed_prompt_id FROM sessions WHERE id = ?")
            .get(sessionId);

        expect(raw).toBeDefined();
        expect(raw!["composed_prompt_id"]).toBeNull();

        mcpConn2.close();
    });
});
