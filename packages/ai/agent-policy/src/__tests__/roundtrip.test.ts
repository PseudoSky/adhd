/**
 * roundtrip.test.ts — Seed + idempotency + persistence end-to-end suite.
 *
 * Proves [dod.3]: the `seed()` function populates the policy library from
 * SEED_DATA, is idempotent, and round-trips through a real on-disk SQLite DB.
 *
 * Invariants under test:
 *  [inv:reopen-proves-persistence] — every read is from a CLOSED + REOPENED handle.
 *  [inv:enforcement-is-array]      — `no-credentials` enforcement survives as ["agent","ci"].
 *
 * Acceptance criteria:
 *  [seed-and-roundtrip.1] seed + reopen + idempotency round-trip suite passes.
 *  [seed-and-roundtrip.2] seed lists SEED_DATA templates incl. multi-value enforcement.
 *  [seed-and-roundtrip.3] negative control: plain INSERT (non-idempotent) duplicates
 *                          rows and fails the second-seed assertion.
 *
 * Gate on EXIT CODE — not stdout. [project-memory: feedback_plan_execution_pitfalls]
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { describe, it, expect, afterEach } from "vitest";

import { runMigrationsOn } from "../db/migrate-runner.js";
import * as schema from "../db/schema.js";
import { PolicyTemplateStore } from "../store/policy-template-store.js";
import { AgentPolicyStore } from "../store/agent-policy-store.js";
import { seed, POLICY_TYPES, POLICY_TEMPLATES } from "../seed/index.js";

// ── helpers ────────────────────────────────────────────────────────────────

/** Open a fresh better-sqlite3 connection + drizzle wrapper at `dbPath`. */
function openDb(dbPath: string): {
    sqlite: Database.Database;
    db: BetterSQLite3Database<typeof schema>;
} {
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite, { schema });
    return { sqlite, db };
}

/** Create an isolated tmp file path (file does not exist yet). */
function tmpDbPath(): string {
    return path.join(
        os.tmpdir(),
        `agent-policy-roundtrip-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
}

/** Count rows in a table using raw SQL (works when drizzle count isn't available). */
function countRows(sqlite: Database.Database, tableName: string): number {
    const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${tableName}`).get() as { n: number };
    return row.n;
}

// Track open handles for afterEach cleanup (avoids zombie connections on teardown).
const openHandles: Database.Database[] = [];
const tmpPaths: string[] = [];

afterEach(() => {
    while (openHandles.length) {
        try { openHandles.pop()!.close(); } catch { /* already closed */ }
    }
    for (const p of tmpPaths) {
        try { fs.unlinkSync(p); } catch { /* may already be deleted */ }
    }
    tmpPaths.length = 0;
});

// ── tests ──────────────────────────────────────────────────────────────────

describe("policy seed + roundtrip", () => {

    /**
     * [seed-and-roundtrip.1] + [inv:enforcement-is-array] + [inv:reopen-proves-persistence]
     *
     * Seed → CLOSE → REOPEN → assert `no-credentials` reads back with its full
     * enforcement array intact, and that an agent resolves its effective policy
     * through the lazy inheritance path.
     */
    it("policy template round-trips after reopen", () => {
        const dbPath = tmpDbPath();
        tmpPaths.push(dbPath);

        // ── WRITE PHASE: seed the full library ───────────────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            openHandles.push(sqlite);

            runMigrationsOn(sqlite, db);
            seed(db);

            // Close — next read must come from disk. [inv:reopen-proves-persistence]
            sqlite.close();
            openHandles.pop();
        }

        // ── READ PHASE: reopen from same path ────────────────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            openHandles.push(sqlite);

            runMigrationsOn(sqlite, db); // idempotent

            const templateStore = new PolicyTemplateStore(db);

            // Primary round-trip assertion: `no-credentials` deep-equals seed row.
            const tpl = templateStore.read("no-credentials");

            expect(tpl.slug).toBe("no-credentials");
            expect(tpl.type).toBe("safety");
            expect(tpl.description).toBe(
                "Prevent credential leakage in files, task output, and handoff text"
            );
            expect(tpl.version).toBe(1);
            expect(tpl.isSystem).toBe(true);

            // [inv:enforcement-is-array] — must be a JS array, never a string.
            expect(Array.isArray(tpl.enforcement)).toBe(true);
            // Multi-value case: BOTH "agent" and "ci" survive the round-trip.
            expect(tpl.enforcement).toEqual(["agent", "ci"]);

            // rules JSON round-trip.
            expect(tpl.rules).toMatchObject({
                ci_scan_targets: ["committed_files", "task_output", "handoff_text"],
            });
            expect((tpl.rules["forbidden_patterns"] as string[]).length).toBeGreaterThan(0);

            // ── Lazy inheritance path ─────────────────────────────────────────
            // Attach a policy to a category, add an agent to that category, then
            // resolve via AgentPolicyStore.resolveForAgent — proves the lazy
            // join returns the template with inheritedFrom set. [Decision 1]
            const agentPolicyStore = new AgentPolicyStore(db);

            agentPolicyStore.attachToCategory({
                categorySlug: "quality-security",
                policySlug:   "no-credentials",
                isMandatory:  true,
            });
            agentPolicyStore.addAgentToCategory({
                agentSlug:    "code-reviewer",
                categorySlug: "quality-security",
            });

            sqlite.close();
            openHandles.pop();
        }

        // ── RESOLVE PHASE: reopen and resolve [inv:reopen-proves-persistence] ──
        {
            const { sqlite, db } = openDb(dbPath);
            openHandles.push(sqlite);

            runMigrationsOn(sqlite, db);

            const agentPolicyStore = new AgentPolicyStore(db);
            const resolved = agentPolicyStore.resolveForAgent("code-reviewer");

            // The inherited row must appear with inherited_from = category slug.
            const inherited = resolved.find(r => r.policySlug === "no-credentials");
            expect(inherited).toBeDefined();
            expect(inherited!.isMandatory).toBe(true);
            expect(inherited!.inheritedFrom).toBe("quality-security");
        }
    });

    /**
     * [seed-and-roundtrip.1] — Idempotency: running seed twice must produce
     * exactly the same row counts; no duplicate rows and no error on the second call.
     */
    it("seed is idempotent on re-run", () => {
        const dbPath = tmpDbPath();
        tmpPaths.push(dbPath);

        const { sqlite, db } = openDb(dbPath);
        openHandles.push(sqlite);

        runMigrationsOn(sqlite, db);

        // ── FIRST SEED ───────────────────────────────────────────────────────
        seed(db);

        const typesAfterFirst  = countRows(sqlite, "policy_policy_types");
        const tmpltAfterFirst  = countRows(sqlite, "policy_policy_templates");

        // Sanity: at minimum the 7 types and 9 templates from SEED_DATA §3/§9.
        expect(typesAfterFirst).toBe(POLICY_TYPES.length);
        expect(tmpltAfterFirst).toBe(POLICY_TEMPLATES.length);

        // ── SECOND SEED (must be a no-op) ────────────────────────────────────
        seed(db);

        const typesAfterSecond = countRows(sqlite, "policy_policy_types");
        const tmpltAfterSecond = countRows(sqlite, "policy_policy_templates");

        // Counts must be identical — no duplication. [seed-and-roundtrip.1]
        expect(typesAfterSecond).toBe(typesAfterFirst);
        expect(tmpltAfterSecond).toBe(tmpltAfterFirst);

        // Version must NOT have been bumped on re-seed.
        const templateStore = new PolicyTemplateStore(db);
        const noCredentials = templateStore.read("no-credentials");
        expect(noCredentials.version).toBe(1);
    });

    /**
     * [seed-and-roundtrip.2] — Every template from SEED_DATA §9 is present after
     * seeding, and the multi-value enforcement case is confirmed.
     */
    it("seed populates all SEED_DATA templates including multi-value enforcement", () => {
        const dbPath = tmpDbPath();
        tmpPaths.push(dbPath);

        const { sqlite, db } = openDb(dbPath);
        openHandles.push(sqlite);

        runMigrationsOn(sqlite, db);
        seed(db);

        const templateStore = new PolicyTemplateStore(db);
        const all = templateStore.list();

        // Every slug in POLICY_TEMPLATES must be present.
        const seededSlugs = new Set(all.map(t => t.slug));
        for (const tmpl of POLICY_TEMPLATES) {
            expect(seededSlugs.has(tmpl.slug)).toBe(true);
        }

        // Spot-check the four required templates from the context doc.
        const reviewerPosture  = templateStore.read("reviewer-posture");
        const noCredentials    = templateStore.read("no-credentials");
        const soxAuditTrail    = templateStore.read("sox-audit-trail");
        const maxRework3       = templateStore.read("max-rework-3");

        expect(reviewerPosture.type).toBe("safety");
        expect(reviewerPosture.enforcement).toEqual(["agent"]);

        // The multi-value case [inv:enforcement-is-array].
        expect(noCredentials.type).toBe("safety");
        expect(noCredentials.enforcement).toEqual(["agent", "ci"]);

        expect(soxAuditTrail.type).toBe("audit");
        expect(soxAuditTrail.enforcement).toEqual(["hook"]);
        // Confirm it is observational (Decision 2 — not pre:model_request blocking).
        expect(soxAuditTrail.rules["hook_type"]).toBe("observational");

        expect(maxRework3.type).toBe("rate");
        expect(maxRework3.enforcement).toEqual(["runtime"]);
        expect(maxRework3.rules["max_rework"]).toBe(3);
    });

    /**
     * [seed-and-roundtrip.3] — NEGATIVE CONTROL: teeth verification.
     *
     * This test proves that a plain `INSERT` (non-idempotent) seeder WOULD
     * cause the second-seed assertion to fail — i.e. the idempotency test
     * above is not trivially passing because the count never changes.
     *
     * We simulate the broken seeder inline: insert one type row twice with
     * raw `INSERT` (not `INSERT OR IGNORE`) and assert we get a constraint
     * violation, confirming the test _would_ have gone red without
     * `onConflictDoNothing()`. [seed-and-roundtrip.3]
     */
    it("negative control — plain INSERT on duplicate slug throws (idempotency teeth)", () => {
        const dbPath = tmpDbPath();
        tmpPaths.push(dbPath);

        const { sqlite, db } = openDb(dbPath);
        openHandles.push(sqlite);

        runMigrationsOn(sqlite, db);

        // First plain INSERT succeeds.
        db.insert(schema.policyTypesTable)
            .values({ slug: "safety", description: "forbidden content" })
            .run();

        // Second plain INSERT WITHOUT onConflictDoNothing must throw a UNIQUE
        // constraint violation — this is the failure our idempotent seeder avoids.
        let threw = false;
        try {
            db.insert(schema.policyTypesTable)
                .values({ slug: "safety", description: "duplicate" })
                .run();
        } catch (err) {
            threw = true;
            // SQLite raises SQLITE_CONSTRAINT_PRIMARYKEY.
            expect((err as Error).message).toMatch(/UNIQUE constraint failed|already exists/i);
        }

        // If this assertion fails it means SQLite stopped enforcing UNIQUE on the
        // PK — a critical regression in test isolation or schema.
        expect(threw).toBe(true);
    });
});
