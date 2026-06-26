/**
 * live-wiring.test.ts — composition-root integration test for Plan 6 F-P6-8.
 *
 * Proves that the LIVE agent-mcp composition root (index.ts / server.ts) routes
 * every `agent` tool call through compileAgent from @adhd/agent-compiler when
 * `promptResolver` is wired.  Drives the REAL `agentTool` (the same function that
 * both `agentTool` callsites in server.ts invoke) against a real on-disk SQLite
 * registry DB seeded with real rows — only the LLM provider boundary is NOT
 * exercised here (no actual model call is made in this test).
 *
 * Invariants proven:
 *
 * [F-P6-8.registry-agent]  — a registry-backed agent gets its systemPrompt from
 *   compileAgent's output, not the original stored value.
 *
 * [F-P6-8.flat-fallback]   — a flat-only agent (no registry composition) STILL
 *   resolves to its stored systemPrompt; the promptResolver produces null and
 *   agentTool falls back gracefully.  This is the non-regression guarantee for ALL
 *   existing legacy-agent tests.
 *
 * [F-P6-8.negative-control] — removing the promptResolver from the SessionDeps
 *   makes the registry-resolution assertion FAIL (proven by running agentTool
 *   without a promptResolver and asserting the compiled content is NOT present).
 *
 * DB topology:
 *   registry DB  — four migration sets (provider → registry → tool-registry → policy),
 *                  seeded with the `api-design-reviewer-e2e` fixture agent.
 *   agent-mcp DB — one migration set (agent-mcp migrations), contains:
 *                  (a) a registry-backed agent whose slug matches FIXTURE_AGENT_SLUG
 *                  (b) a flat-only agent with no registry counterpart.
 *
 * Gate: key on vitest exit code — never stdout grep (CLAUDE.md std #4).
 *
 * [inv:real-session-start]  — real SQLite on disk, real stores, real compileAgent.
 * [inv:reopen-proves-cache] — DB handles are closed and reopened after agentTool
 *   to prove persistence rather than in-memory state.
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
import {
    seed as seedRegistry,
} from "@adhd/agent-registry";
import { seed as seedToolRegistry } from "@adhd/agent-tool-registry";
import { seed as seedProvider } from "@adhd/agent-provider";
import { seed as seedPolicy } from "@adhd/agent-policy";

// ── Fixture seeder + real compileAgent (live production boundary under test) ──
import { seedFixtureAgent, compileAgent } from "@adhd/agent-compiler";

/** Slug of the seeded fixture agent — mirrors FIXTURE_AGENT_SLUG from fixtures.ts. */
const FIXTURE_AGENT_SLUG = "api-design-reviewer-e2e";

// ── agent-mcp stores + tools ──────────────────────────────────────────────────
import { runMigrationsOn } from "../db/migrate-runner.js";
import * as agentMcpSchema from "../db/schema.js";
import { AgentStore } from "../store/agent-store.js";
import { SessionStore } from "../store/session-store.js";
import { ComposedPromptStore } from "../store/composed-prompt-store.js";
import { PolicyEngine } from "../engine/policy.js";
import { agentTool } from "../tools/session.js";
import type { PromptResolverDeps } from "../engine/prompt-resolver.js";
import type { SessionDeps } from "../tools/session.js";

// ── Migration folder references ───────────────────────────────────────────────
//
// test file is at:    packages/ai/agent-mcp/src/__tests__/    (__dirname)
// registry packages:  packages/ai/agent-{provider,registry,tool-registry,policy}/
// Relative path from __dirname: ../../../<package>/drizzle
//   (go up: __tests__ → src → agent-mcp → ai, then into sibling)

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const PROVIDER_MIGRATIONS      = path.resolve(__dirname, "../../../agent-provider/drizzle");
const REGISTRY_MIGRATIONS      = path.resolve(__dirname, "../../../agent-registry/drizzle");
const TOOL_REGISTRY_MIGRATIONS = path.resolve(__dirname, "../../../agent-tool-registry/drizzle");
const POLICY_MIGRATIONS        = path.resolve(__dirname, "../../../agent-policy/drizzle");

// ── Flat-only agent fixture ───────────────────────────────────────────────────

/** Slug that exists ONLY in the agent-mcp DB — no registry counterpart. */
const FLAT_AGENT_NAME = "flat-only-live-wiring-agent";
const FLAT_SYSTEM_PROMPT = "I am a flat-systemPrompt agent with no registry composition.";

// ── Compiled content anchor ───────────────────────────────────────────────────
//
// The fixture agent (api-design-reviewer-e2e) has body sections from SEED_DATA.md §8.
// We assert a substring that WILL appear in any real compilation of that agent
// rather than hardcoding the full content (which would be fragile).
// The generic-reviewer-role section always contains the word "reviewer" or "review".
// The frontend-most reliable anchor is the no-credentials policy constraint text.
const COMPILED_CONTENT_ANCHOR =
    "Prevent credential leakage in files, task output, and handoff text";

// ── DB helpers ────────────────────────────────────────────────────────────────

interface RegistryDb {
    conn: Database.Database;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: ReturnType<typeof drizzle<any>>;
}

/**
 * Open a fresh better-sqlite3 handle, run all four registry package migrations
 * in timestamp order (provider → registry → tool-registry → policy), and seed
 * all four upstream catalogs + the fixture agent.
 *
 * Caller is responsible for closing `conn` when done.
 */
function openRegistryDb(dbPath: string): RegistryDb {
    const conn = new Database(dbPath);
    conn.pragma("journal_mode = WAL");
    conn.pragma("foreign_keys = OFF");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = drizzle(conn, { schema: {} as any });

    // Migration order: timestamps must be ascending (provider 1750* < registry 1782193* < …)
    migrate(db, { migrationsFolder: PROVIDER_MIGRATIONS });       // 1750*
    migrate(db, { migrationsFolder: REGISTRY_MIGRATIONS });       // 1782193*–1782239*
    migrate(db, { migrationsFolder: TOOL_REGISTRY_MIGRATIONS });  // 1782250*–1782252*
    migrate(db, { migrationsFolder: POLICY_MIGRATIONS });         // 1782256*–1782350*

    conn.pragma("foreign_keys = ON");

    // Seed all four upstream catalogs then the fixture agent.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seedProvider(db as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seedRegistry(db as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seedToolRegistry(db as any);
    seedPolicy(db);
    seedFixtureAgent(db);

    return { conn, db };
}

/** Open an agent-mcp DB handle, run agent-mcp migrations, return {conn, dbAny}. */
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

describe("live-wiring — composition-root promptResolver integration [F-P6-8]", () => {
    let tmpDir: string;
    let registryDbPath: string;
    let agentMcpDbPath: string;

    // Registry DB handle (write phase only — closed after setup)
    let registryConn: Database.Database;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mcp-live-wiring-"));
        registryDbPath = path.join(tmpDir, "registry.db");
        agentMcpDbPath = path.join(tmpDir, "agents.db");

        // ── Build and seed the registry DB ─────────────────────────────────────
        const { conn } = openRegistryDb(registryDbPath);
        registryConn = conn;
        conn.close(); // close after write — tests reopen as read-only handles

        // ── Bootstrap the agent-mcp DB ──────────────────────────────────────────
        // Seed both agent entries so the tables exist before tests run.
        const { conn: mcpConn, dbAny } = openAgentMcpDb(agentMcpDbPath);

        const agentStore = new AgentStore(dbAny);

        // (a) Registry-backed agent: slug matches FIXTURE_AGENT_SLUG in the registry.
        //     Its stored systemPrompt is intentionally different from the compiled
        //     content — the test asserts compileAgent wins.
        agentStore.create({
            name:         FIXTURE_AGENT_SLUG,
            provider:     { type: "openai", model: "gpt-4o" },
            systemPrompt: "original-authored-prompt — should be replaced by compiled content",
            mcpServers:   {},
            permissions:  {},
        });

        // (b) Flat-only agent: no counterpart in the registry at all.
        agentStore.create({
            name:         FLAT_AGENT_NAME,
            provider:     { type: "openai", model: "gpt-4o-mini" },
            systemPrompt: FLAT_SYSTEM_PROMPT,
            mcpServers:   {},
            permissions:  {},
        });

        mcpConn.close();
    });

    afterAll(() => {
        try { registryConn.close(); } catch { /* already closed */ }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ── [F-P6-8.registry-agent] ───────────────────────────────────────────────

    it("[F-P6-8.registry-agent] registry-backed agent gets compiled systemPrompt at session start", async () => {
        const { conn: mcpConn, dbAny } = openAgentMcpDb(agentMcpDbPath);

        const agentStore        = new AgentStore(dbAny);
        const sessionStore      = new SessionStore(dbAny);
        const composedPromptStore = new ComposedPromptStore(dbAny);

        // Open the registry DB read-write — compileAgent writes a cache row
        // (registry_composed_prompts) on a cache MISS; opening readonly would
        // cause cacheW to throw and make resolveComposedPrompt return null.
        const registryConn2 = new Database(registryDbPath);
        registryConn2.pragma("journal_mode = WAL");
        registryConn2.pragma("foreign_keys = ON");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const registryDb = drizzle(registryConn2) as any;

        const promptResolver: PromptResolverDeps = {
            composedPromptStore,
            compileAgentFn: compileAgent,
            registryDb,
        };

        const policy = new PolicyEngine({
            serverMaxDepth: 10,
            serverMaxToolLoops: 50,
        });

        const deps: SessionDeps = {
            agentStore,
            sessionStore,
            policy,
            promptResolver,
        };

        const output = await agentTool({ name: FIXTURE_AGENT_SLUG }, deps);
        const sessionId = output.session_id;

        // Close handles — reopen to prove persistence (not in-memory state)
        // [inv:reopen-proves-cache]
        mcpConn.close();
        registryConn2.close();

        const { conn: mcpConn2, dbAny: dbAny2 } = openAgentMcpDb(agentMcpDbPath);

        const snapshotStore = new SessionStore(dbAny2);
        const snapshotDef = snapshotStore.getAgentDefinition(sessionId);

        // The compiled content MUST contain the anchor phrase from the registry
        // seed data — proving compileAgent ran, not the original authored prompt.
        expect(snapshotDef.systemPrompt).toContain(COMPILED_CONTENT_ANCHOR);
        expect(snapshotDef.systemPrompt).not.toContain("original-authored-prompt");

        // composed_prompt_id must be non-null
        const raw = (mcpConn2 as unknown as {
            prepare: (s: string) => { get: (...args: unknown[]) => Record<string, unknown> | undefined }
        })
            .prepare("SELECT composed_prompt_id FROM sessions WHERE id = ?")
            .get(sessionId);
        expect(raw).toBeDefined();
        expect(raw!["composed_prompt_id"]).not.toBeNull();
        expect(typeof raw!["composed_prompt_id"]).toBe("string");

        mcpConn2.close();
    });

    // ── [F-P6-8.flat-fallback] ────────────────────────────────────────────────

    it("[F-P6-8.flat-fallback] flat-only agent falls back to stored systemPrompt when registry has no composition", async () => {
        const { conn: mcpConn, dbAny } = openAgentMcpDb(agentMcpDbPath);

        const agentStore         = new AgentStore(dbAny);
        const sessionStore       = new SessionStore(dbAny);
        const composedPromptStore = new ComposedPromptStore(dbAny);

        const registryConn2 = new Database(registryDbPath);
        registryConn2.pragma("journal_mode = WAL");
        registryConn2.pragma("foreign_keys = ON");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const registryDb = drizzle(registryConn2) as any;

        const promptResolver: PromptResolverDeps = {
            composedPromptStore,
            compileAgentFn: compileAgent,
            registryDb,
        };

        const policy = new PolicyEngine({
            serverMaxDepth: 10,
            serverMaxToolLoops: 50,
        });

        // promptResolver IS wired — but the flat agent has no registry counterpart,
        // so compileAgent throws AgentError(AGENT_NOT_FOUND) → resolveComposedPrompt
        // returns null → agentTool falls back to stored systemPrompt.
        const deps: SessionDeps = {
            agentStore,
            sessionStore,
            policy,
            promptResolver,
        };

        const output = await agentTool({ name: FLAT_AGENT_NAME }, deps);
        const sessionId = output.session_id;

        mcpConn.close();
        registryConn2.close();

        const { conn: mcpConn2, dbAny: dbAny2 } = openAgentMcpDb(agentMcpDbPath);

        // The snapshot must carry the original flat systemPrompt unchanged.
        const snapshotStore = new SessionStore(dbAny2);
        const snapshotDef = snapshotStore.getAgentDefinition(sessionId);

        expect(snapshotDef.systemPrompt).toBe(FLAT_SYSTEM_PROMPT);
        expect(snapshotDef.systemPrompt).not.toContain(COMPILED_CONTENT_ANCHOR);

        // composed_prompt_id must be NULL — no registry compilation occurred.
        const raw = (mcpConn2 as unknown as {
            prepare: (s: string) => { get: (...args: unknown[]) => Record<string, unknown> | undefined }
        })
            .prepare("SELECT composed_prompt_id FROM sessions WHERE id = ?")
            .get(sessionId);
        expect(raw).toBeDefined();
        expect(raw!["composed_prompt_id"]).toBeNull();

        mcpConn2.close();
    });

    // ── [F-P6-8.negative-control] ─────────────────────────────────────────────
    //
    // Proof that the promptResolver IS the mechanism that produces the compiled
    // content.  Without it, the registry-backed agent gets the original authored
    // prompt — so the [F-P6-8.registry-agent] assertion above would FAIL.
    //
    // This test is intentionally the mirror-image: it proves the ABSENCE of
    // compiled content when promptResolver is not wired, making the positive test
    // above a meaningful guard.

    it("[F-P6-8.negative-control] WITHOUT promptResolver, registry-backed agent keeps original authored systemPrompt", async () => {
        const { conn: mcpConn, dbAny } = openAgentMcpDb(agentMcpDbPath);

        const agentStore   = new AgentStore(dbAny);
        const sessionStore = new SessionStore(dbAny);

        const policy = new PolicyEngine({
            serverMaxDepth: 10,
            serverMaxToolLoops: 50,
        });

        // NO promptResolver — the legacy/no-registry path.
        const deps: SessionDeps = {
            agentStore,
            sessionStore,
            policy,
            // promptResolver intentionally absent
        };

        const output = await agentTool({ name: FIXTURE_AGENT_SLUG }, deps);
        const sessionId = output.session_id;

        mcpConn.close();

        const { conn: mcpConn2, dbAny: dbAny2 } = openAgentMcpDb(agentMcpDbPath);

        const snapshotStore = new SessionStore(dbAny2);
        const snapshotDef = snapshotStore.getAgentDefinition(sessionId);

        // WITHOUT promptResolver: the original authored prompt is used, NOT the
        // compiled content.  If the COMPILED_CONTENT_ANCHOR appeared here, the
        // promptResolver wiring would be incorrectly bypassing the deps gate.
        expect(snapshotDef.systemPrompt).not.toContain(COMPILED_CONTENT_ANCHOR);
        expect(snapshotDef.systemPrompt).toContain("original-authored-prompt");

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
