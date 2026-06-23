/**
 * AgentPolicyStore — real on-disk SQLite integration tests.
 *
 * [inv:reopen-proves-persistence]: every test that asserts persisted data CLOSES
 * the better-sqlite3 handle and REOPENS from the same path before performing the
 * read-back.  This proves the row is durable on disk, not resident only in memory.
 *
 * [inv:no-cross-pkg-fk]: `agent_slug` is NOT a SQLite FK.  One test proves this
 * by inserting a row whose `agent_slug` has no matching row in any `agents` table
 * and asserting the insert succeeds.  If a cross-package FK existed this test
 * would throw a SQLITE_CONSTRAINT error.
 *
 * [agent-policy-junction.1]: junction table (agent, policy, override_config,
 *   is_mandatory, inherited_from) exists and is migrated.
 * [agent-policy-junction.2]: AgentPolicyStore.attach inserts a direct-attach row.
 * [agent-policy-junction.3]: direct-attach round-trip after reopen.
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
import {
    AgentPolicyStore,
    AgentPolicyError,
    resolveEffectiveRules,
} from "../store/agent-policy-store.js";

// ── helpers ────────────────────────────────────────────────────────────────

/** Open a fresh better-sqlite3 connection + drizzle wrapper at `dbPath`. */
function openDb(
    dbPath: string
): { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema> } {
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite, { schema });
    return { sqlite, db };
}

/** Create an isolated tmp file path (not yet created). */
function tmpDbPath(): string {
    return path.join(
        os.tmpdir(),
        `agent-policy-junction-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
}

/** Track open handles so afterEach can close them, preventing zombie connections. */
const openHandles: Database.Database[] = [];

afterEach(() => {
    while (openHandles.length) {
        try {
            openHandles.pop()!.close();
        } catch {
            /* already closed */
        }
    }
});

// ── fixtures ────────────────────────────────────────────────────────────────

const QUALITY_TYPE_ROW = {
    slug:        "quality",
    description: "Quality-control policies",
} as const;

const MAX_REWORK_TEMPLATE = {
    slug:        "max-rework-3",
    type:        "quality",
    description: "Limit rework iterations to prevent infinite loops",
    rules:       { max_rework: 3, on_exceed: "fail" },
    enforcement: ["agent"] as string[],
} as const;

/** Slug of an agent that owns NO row in any registry_agents table. */
const PHANTOM_AGENT_SLUG = "phantom-agent-no-registry-row";

/** Slug of a real (seeded) agent used for attach tests. */
const TEST_AGENT_SLUG = "test-agent-alpha";

// ── seed helpers ────────────────────────────────────────────────────────────

/**
 * Seed the minimum fixtures required to attach a policy:
 *  - a `policy_policy_types` row (FK dependency of the template)
 *  - a `policy_policy_templates` row (FK dependency of the junction)
 *
 * We do NOT seed an `agents` table row here — `agent_slug` is a plain text
 * column, no FK, so no seeding is required.  This is intentional: the
 * cross-package invariant test below relies on the same absence.
 */
function seedTemplateFixtures(db: BetterSQLite3Database<typeof schema>): void {
    db.insert(schema.policyTypesTable).values(QUALITY_TYPE_ROW).run();
    db.insert(schema.policyTemplatesTable)
        .values({
            slug:        MAX_REWORK_TEMPLATE.slug,
            type:        MAX_REWORK_TEMPLATE.type,
            description: MAX_REWORK_TEMPLATE.description,
            rules:       MAX_REWORK_TEMPLATE.rules as unknown as string,
            enforcement: MAX_REWORK_TEMPLATE.enforcement as unknown as string,
            version:     1,
            isSystem:    false,
        })
        .run();
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("AgentPolicyStore — agent_policies junction", () => {
    // ── [agent-policy-junction.3] direct-attach round-trip after reopen ──────

    it("direct-attach with override_config and isMandatory round-trips after reopen [agent-policy-junction.3]", () => {
        const dbPath = tmpDbPath();

        // ── WRITE PHASE ──────────────────────────────────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            openHandles.push(sqlite);

            // Apply all migrations (idempotent; runs 0001 for the first time).
            runMigrationsOn(sqlite, db);
            seedTemplateFixtures(db);

            const store = new AgentPolicyStore(db);
            const attached = store.attach({
                agentSlug:      TEST_AGENT_SLUG,
                policySlug:     MAX_REWORK_TEMPLATE.slug,
                overrideConfig: { max_rework: 5 },
                isMandatory:    true,
            });

            // Immediate read-back from the same handle to confirm the row exists.
            expect(attached.agentSlug).toBe(TEST_AGENT_SLUG);
            expect(attached.policySlug).toBe(MAX_REWORK_TEMPLATE.slug);
            expect(attached.isMandatory).toBe(true);
            expect(attached.overrideConfig).toEqual({ max_rework: 5 });
            // Direct attach must always set inherited_from to null. [Decision 1]
            expect(attached.inheritedFrom).toBeNull();

            // Close the handle — subsequent assertions must read from disk.
            sqlite.close();
            openHandles.pop(); // already closed
        }

        // ── READ PHASE (new handle, same file) ───────────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            openHandles.push(sqlite);

            // Migrations are idempotent — safe to re-run on an existing DB.
            runMigrationsOn(sqlite, db);

            const store = new AgentPolicyStore(db);
            const rows = store.listForAgent(TEST_AGENT_SLUG);

            expect(rows).toHaveLength(1);
            const row = rows[0]!;

            expect(row.agentSlug).toBe(TEST_AGENT_SLUG);
            expect(row.policySlug).toBe(MAX_REWORK_TEMPLATE.slug);
            // isMandatory survives close + reopen as a boolean true.
            expect(row.isMandatory).toBe(true);
            // overrideConfig JSON survives serialisation round-trip intact.
            expect(row.overrideConfig).toEqual({ max_rework: 5 });
            // Direct-attach must carry inheritedFrom = null. [def:agent-policy-row]
            expect(row.inheritedFrom).toBeNull();
        }

        fs.unlinkSync(dbPath);
    });

    // ── [inv:no-cross-pkg-fk] agent_slug is NOT a SQLite FK ─────────────────

    it("accepts a phantom agent_slug with no matching agents row [inv:no-cross-pkg-fk]", () => {
        // This proves the cross-package invariant: if agent_slug had a SQLite FK
        // to registry_agents.slug the insert below would throw
        // SQLITE_CONSTRAINT_FOREIGNKEY.  Its success is the proof.
        const dbPath = tmpDbPath();
        const { sqlite, db } = openDb(dbPath);
        openHandles.push(sqlite);

        runMigrationsOn(sqlite, db);
        seedTemplateFixtures(db);

        const store = new AgentPolicyStore(db);

        // PHANTOM_AGENT_SLUG has no row anywhere — no agents table in this package.
        // The insert must succeed because agent_slug is a plain text column.
        let caughtErr: unknown;
        let attached: ReturnType<typeof store.attach> | undefined;
        try {
            attached = store.attach({
                agentSlug:  PHANTOM_AGENT_SLUG,
                policySlug: MAX_REWORK_TEMPLATE.slug,
            });
        } catch (err) {
            caughtErr = err;
        }

        // No error should have been thrown — cross-package FK is absent.
        expect(caughtErr).toBeUndefined();
        expect(attached).toBeDefined();
        expect(attached!.agentSlug).toBe(PHANTOM_AGENT_SLUG);

        fs.unlinkSync(dbPath);
    });

    // ── [agent-policy-junction.2] attach + listForAgent ──────────────────────

    it("listForAgent returns only policies for the requested agent [agent-policy-junction.2]", () => {
        const dbPath = tmpDbPath();
        const { sqlite, db } = openDb(dbPath);
        openHandles.push(sqlite);

        runMigrationsOn(sqlite, db);
        seedTemplateFixtures(db);

        // Seed a second template so we can attach two policies to different agents.
        db.insert(schema.policyTypesTable)
            .values({ slug: "permission", description: "Permission policies" })
            .run();
        db.insert(schema.policyTemplatesTable)
            .values({
                slug:        "read-only",
                type:        "permission",
                description: "Read-only tool access",
                rules:       { disallow_write: true } as unknown as string,
                enforcement: ["agent"] as unknown as string,
                version:     1,
                isSystem:    false,
            })
            .run();

        const store = new AgentPolicyStore(db);

        // Attach two policies to agent-alpha and one policy to agent-beta.
        store.attach({ agentSlug: "agent-alpha", policySlug: MAX_REWORK_TEMPLATE.slug });
        store.attach({ agentSlug: "agent-alpha", policySlug: "read-only" });
        store.attach({ agentSlug: "agent-beta",  policySlug: MAX_REWORK_TEMPLATE.slug });

        const alphaRows = store.listForAgent("agent-alpha");
        expect(alphaRows).toHaveLength(2);
        expect(alphaRows.map(r => r.policySlug).sort()).toEqual([
            MAX_REWORK_TEMPLATE.slug,
            "read-only",
        ].sort());

        const betaRows = store.listForAgent("agent-beta");
        expect(betaRows).toHaveLength(1);
        expect(betaRows[0]!.policySlug).toBe(MAX_REWORK_TEMPLATE.slug);

        const gammaRows = store.listForAgent("agent-gamma-no-policies");
        expect(gammaRows).toHaveLength(0);

        fs.unlinkSync(dbPath);
    });

    // ── duplicate-attach error ────────────────────────────────────────────────

    it("attach throws AGENT_POLICY_ALREADY_ATTACHED on duplicate (agentSlug, policySlug)", () => {
        const dbPath = tmpDbPath();
        const { sqlite, db } = openDb(dbPath);
        openHandles.push(sqlite);

        runMigrationsOn(sqlite, db);
        seedTemplateFixtures(db);

        const store = new AgentPolicyStore(db);
        store.attach({ agentSlug: TEST_AGENT_SLUG, policySlug: MAX_REWORK_TEMPLATE.slug });

        let caught: unknown;
        try {
            store.attach({ agentSlug: TEST_AGENT_SLUG, policySlug: MAX_REWORK_TEMPLATE.slug });
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(AgentPolicyError);
        expect((caught as AgentPolicyError).code).toBe("AGENT_POLICY_ALREADY_ATTACHED");

        fs.unlinkSync(dbPath);
    });

    // ── no override_config defaults ───────────────────────────────────────────

    it("attach without overrideConfig stores null and defaults isMandatory to false", () => {
        const dbPath = tmpDbPath();
        const { sqlite, db } = openDb(dbPath);
        openHandles.push(sqlite);

        runMigrationsOn(sqlite, db);
        seedTemplateFixtures(db);

        const store = new AgentPolicyStore(db);
        const row = store.attach({
            agentSlug:  TEST_AGENT_SLUG,
            policySlug: MAX_REWORK_TEMPLATE.slug,
        });

        expect(row.overrideConfig).toBeNull();
        expect(row.isMandatory).toBe(false);
        expect(row.inheritedFrom).toBeNull();

        fs.unlinkSync(dbPath);
    });
});

// ── resolveEffectiveRules ────────────────────────────────────────────────────

describe("resolveEffectiveRules [Decision 3 — shallow merge]", () => {
    it("returns template rules unchanged when overrideConfig is null", () => {
        const result = resolveEffectiveRules({ max_rework: 3, on_exceed: "fail" }, null);
        expect(result).toEqual({ max_rework: 3, on_exceed: "fail" });
    });

    it("shallow-merges overrideConfig on top of template rules", () => {
        const result = resolveEffectiveRules(
            { max_rework: 3, on_exceed: "fail", mode: "strict" },
            { max_rework: 5 }
        );
        // Override key replaces the template key.
        expect(result.max_rework).toBe(5);
        // Un-overridden keys fall through from the template.
        expect(result.on_exceed).toBe("fail");
        expect(result.mode).toBe("strict");
    });

    it("override replaces arrays wholesale (not concat/union) — safety invariant", () => {
        const result = resolveEffectiveRules(
            { disallow_tools: ["write", "delete"] },
            { disallow_tools: ["write"] }
        );
        // The narrower list replaces; no union occurs.
        expect(result.disallow_tools).toEqual(["write"]);
    });

    it("returns template rules unchanged when overrideConfig is an empty object", () => {
        const result = resolveEffectiveRules({ max_rework: 3 }, {});
        expect(result).toEqual({ max_rework: 3 });
    });
});
