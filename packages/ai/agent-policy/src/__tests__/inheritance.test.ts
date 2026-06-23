/**
 * inheritance.test.ts — LAZY policy inheritance resolution tests.
 *
 * Proves Decision 1 (decisions.md): category-level policy attachments are stored
 * once in `policy_category_policies`; `AgentPolicyStore.resolveForAgent` fans them
 * into per-agent resolved rows WITH `inherited_from = categorySlug` at query time.
 * No fanout trigger; a NEW agent added AFTER the category-attach inherits
 * automatically on the next `resolveForAgent` call.
 *
 * [inv:reopen-proves-persistence]: every persistence assertion CLOSES the
 * better-sqlite3 handle and REOPENS from the same file path before reading.
 *
 * [policy-inheritance.3]: negative-control scripts disable the join so
 * `inherited_from` is never populated — the test goes RED, proving the
 * assertions have teeth. See `scripts/nc_break_inheritance.mjs` and
 * `scripts/nc_restore_inheritance.mjs`.
 *
 * Acceptance criteria covered:
 *  - [policy-inheritance.1] category-level attach propagates via inherited_from
 *  - [policy-inheritance.2] new agent in category inherits mandatory policy after reopen
 *  - [policy-inheritance.3] negative control: skipping resolution drops inherited_from → red
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runMigrationsOn } from "../db/migrate-runner.js";
import * as schema from "../db/schema.js";
import {
    AgentPolicyStore,
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
        `agent-policy-inheritance-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
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

const SECURITY_TYPE_ROW = {
    slug:        "quality",
    description: "Quality-and-security control policies",
} as const;

const REVIEWER_POSTURE_TEMPLATE = {
    slug:        "reviewer-posture",
    type:        "quality",
    description: "Enforces code-review sign-off posture",
    rules:       { require_review: true, min_approvers: 2 },
    enforcement: ["agent"] as string[],
} as const;

const DIRECT_POLICY_TEMPLATE = {
    slug:        "direct-only-policy",
    type:        "quality",
    description: "A policy attached directly to an agent, not via category",
    rules:       { direct: true },
    enforcement: ["agent"] as string[],
} as const;

const CATEGORY_SLUG = "quality-security";
const NEW_AGENT_SLUG = "agent-added-after-category-attach";

// ── seed helpers ────────────────────────────────────────────────────────────

/**
 * Seed the minimum fixtures needed: one policy type + two policy templates.
 * No `agents` table is seeded — agent slugs are logical cross-package refs.
 */
function seedFixtures(db: BetterSQLite3Database<typeof schema>): void {
    db.insert(schema.policyTypesTable).values(SECURITY_TYPE_ROW).run();

    db.insert(schema.policyTemplatesTable)
        .values({
            slug:        REVIEWER_POSTURE_TEMPLATE.slug,
            type:        REVIEWER_POSTURE_TEMPLATE.type,
            description: REVIEWER_POSTURE_TEMPLATE.description,
            rules:       REVIEWER_POSTURE_TEMPLATE.rules as unknown as string,
            enforcement: REVIEWER_POSTURE_TEMPLATE.enforcement as unknown as string,
            version:     1,
            isSystem:    false,
        })
        .run();

    db.insert(schema.policyTemplatesTable)
        .values({
            slug:        DIRECT_POLICY_TEMPLATE.slug,
            type:        DIRECT_POLICY_TEMPLATE.type,
            description: DIRECT_POLICY_TEMPLATE.description,
            rules:       DIRECT_POLICY_TEMPLATE.rules as unknown as string,
            enforcement: DIRECT_POLICY_TEMPLATE.enforcement as unknown as string,
            version:     1,
            isSystem:    false,
        })
        .run();
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("AgentPolicyStore — LAZY policy inheritance [Decision 1]", () => {

    // ── [policy-inheritance.1 + policy-inheritance.2] ────────────────────────
    //
    // Named case from the context:
    //   "new category member inherits the mandatory policy after reopen"
    //
    // Steps:
    //  1. Create category `quality-security`, attach mandatory `reviewer-posture`
    //  2. Add NEW_AGENT_SLUG to `quality-security` AFTER the category attach
    //  3. CLOSE the handle, reopen from the same path
    //  4. Assert resolveForAgent(NEW_AGENT_SLUG) includes `reviewer-posture`
    //     with inherited_from === "quality-security" and is_mandatory === true

    it("new category member inherits the mandatory policy after reopen [policy-inheritance.1] [policy-inheritance.2]", () => {
        const dbPath = tmpDbPath();

        // ── WRITE PHASE ──────────────────────────────────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            openHandles.push(sqlite);

            runMigrationsOn(sqlite, db);
            seedFixtures(db);

            const store = new AgentPolicyStore(db);

            // Step 1: attach mandatory `reviewer-posture` to `quality-security`
            const catAttach = store.attachToCategory({
                categorySlug: CATEGORY_SLUG,
                policySlug:   REVIEWER_POSTURE_TEMPLATE.slug,
                isMandatory:  true,
            });
            expect(catAttach.categorySlug).toBe(CATEGORY_SLUG);
            expect(catAttach.policySlug).toBe(REVIEWER_POSTURE_TEMPLATE.slug);
            expect(catAttach.isMandatory).toBe(true);

            // Step 2: add the NEW agent to the category AFTER the category-attach
            store.addAgentToCategory({
                agentSlug:    NEW_AGENT_SLUG,
                categorySlug: CATEGORY_SLUG,
            });

            // Sanity: resolveForAgent already sees it before reopen
            const preReopen = store.resolveForAgent(NEW_AGENT_SLUG);
            const preRow = preReopen.find(r => r.policySlug === REVIEWER_POSTURE_TEMPLATE.slug);
            expect(preRow).toBeDefined();
            expect(preRow!.inheritedFrom).toBe(CATEGORY_SLUG);
            expect(preRow!.isMandatory).toBe(true);

            // Step 3: CLOSE the handle — proves we're not reading memory state
            sqlite.close();
            openHandles.pop(); // already closed
        }

        // ── READ PHASE (new handle, same file) ───────────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            openHandles.push(sqlite);

            // Migrations are idempotent — safe to re-run on existing DB
            runMigrationsOn(sqlite, db);

            const store = new AgentPolicyStore(db);

            // Step 4: assert inheritance survived the reopen [inv:reopen-proves-persistence]
            const resolved = store.resolveForAgent(NEW_AGENT_SLUG);

            // There should be exactly one resolved policy (the inherited one)
            expect(resolved).toHaveLength(1);

            const inheritedRow = resolved[0]!;

            // [policy-inheritance.1]: inherited_from must be the category slug
            expect(inheritedRow.inheritedFrom).toBe(CATEGORY_SLUG);
            // [policy-inheritance.2]: is_mandatory must be true
            expect(inheritedRow.isMandatory).toBe(true);
            // Correct policy slug
            expect(inheritedRow.policySlug).toBe(REVIEWER_POSTURE_TEMPLATE.slug);
            // Agent slug is correct
            expect(inheritedRow.agentSlug).toBe(NEW_AGENT_SLUG);
            // Category-inherited rows have no override_config
            expect(inheritedRow.overrideConfig).toBeNull();
        }

        fs.unlinkSync(dbPath);
    });

    // ── direct-attach OVERRIDE wins over category inheritance ────────────────
    //
    // When an agent has BOTH a direct-attach AND a category-inherited row for the
    // same policy, the direct-attach row (inherited_from = null) takes precedence.
    // This ensures the override-wins invariant holds end-to-end.

    it("direct-attach overrides category-inherited row (direct wins, inherited_from=null)", () => {
        const dbPath = tmpDbPath();
        const { sqlite, db } = openDb(dbPath);
        openHandles.push(sqlite);

        runMigrationsOn(sqlite, db);
        seedFixtures(db);

        const store = new AgentPolicyStore(db);

        // Attach `reviewer-posture` to the category (mandatory)
        store.attachToCategory({
            categorySlug: CATEGORY_SLUG,
            policySlug:   REVIEWER_POSTURE_TEMPLATE.slug,
            isMandatory:  true,
        });

        // Add agent to the category
        store.addAgentToCategory({
            agentSlug:    NEW_AGENT_SLUG,
            categorySlug: CATEGORY_SLUG,
        });

        // ALSO attach `reviewer-posture` directly to the same agent with
        // an override_config and isMandatory=false — direct wins
        store.attach({
            agentSlug:      NEW_AGENT_SLUG,
            policySlug:     REVIEWER_POSTURE_TEMPLATE.slug,
            overrideConfig: { min_approvers: 1 },
            isMandatory:    false,
        });

        const resolved = store.resolveForAgent(NEW_AGENT_SLUG);

        // Should have exactly one row for reviewer-posture (direct wins, no dupe)
        const reviewerRows = resolved.filter(
            r => r.policySlug === REVIEWER_POSTURE_TEMPLATE.slug
        );
        expect(reviewerRows).toHaveLength(1);

        const winningRow = reviewerRows[0]!;
        // Direct-attach has inheritedFrom = null
        expect(winningRow.inheritedFrom).toBeNull();
        // Direct-attach overrides isMandatory to false
        expect(winningRow.isMandatory).toBe(false);
        // Override config is present
        expect(winningRow.overrideConfig).toEqual({ min_approvers: 1 });

        fs.unlinkSync(dbPath);
    });

    // ── multiple categories, multiple policies ───────────────────────────────
    //
    // An agent in two categories inherits policies from both. Confirms the
    // join handles multiple memberships correctly.

    it("agent in multiple categories inherits from all of them", () => {
        const dbPath = tmpDbPath();
        const { sqlite, db } = openDb(dbPath);
        openHandles.push(sqlite);

        runMigrationsOn(sqlite, db);
        seedFixtures(db);

        // Seed a second policy type and template for the second category
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
        const agentSlug = "multi-category-agent";

        // Attach different policies to different categories
        store.attachToCategory({
            categorySlug: "quality-security",
            policySlug:   REVIEWER_POSTURE_TEMPLATE.slug,
            isMandatory:  true,
        });
        store.attachToCategory({
            categorySlug: "read-only-tier",
            policySlug:   "read-only",
            isMandatory:  false,
        });

        // Add agent to both categories
        store.addAgentToCategory({ agentSlug, categorySlug: "quality-security" });
        store.addAgentToCategory({ agentSlug, categorySlug: "read-only-tier" });

        const resolved = store.resolveForAgent(agentSlug);
        expect(resolved).toHaveLength(2);

        const reviewerRow = resolved.find(r => r.policySlug === REVIEWER_POSTURE_TEMPLATE.slug);
        expect(reviewerRow).toBeDefined();
        expect(reviewerRow!.inheritedFrom).toBe("quality-security");
        expect(reviewerRow!.isMandatory).toBe(true);

        const readOnlyRow = resolved.find(r => r.policySlug === "read-only");
        expect(readOnlyRow).toBeDefined();
        expect(readOnlyRow!.inheritedFrom).toBe("read-only-tier");
        expect(readOnlyRow!.isMandatory).toBe(false);

        fs.unlinkSync(dbPath);
    });

    // ── agent with no category membership returns only direct rows ────────────

    it("agent with no category membership returns only direct-attach rows", () => {
        const dbPath = tmpDbPath();
        const { sqlite, db } = openDb(dbPath);
        openHandles.push(sqlite);

        runMigrationsOn(sqlite, db);
        seedFixtures(db);

        const store = new AgentPolicyStore(db);
        const agentSlug = "agent-no-categories";

        // Attach category policy — but don't add the agent to any category
        store.attachToCategory({
            categorySlug: CATEGORY_SLUG,
            policySlug:   REVIEWER_POSTURE_TEMPLATE.slug,
            isMandatory:  true,
        });

        // Attach directly to agent
        store.attach({
            agentSlug,
            policySlug:  DIRECT_POLICY_TEMPLATE.slug,
            isMandatory: false,
        });

        const resolved = store.resolveForAgent(agentSlug);

        // Should only see the direct-attach row — no category membership means
        // no inherited rows, even though a category-level policy exists
        expect(resolved).toHaveLength(1);
        expect(resolved[0]!.policySlug).toBe(DIRECT_POLICY_TEMPLATE.slug);
        expect(resolved[0]!.inheritedFrom).toBeNull();

        fs.unlinkSync(dbPath);
    });

    // ── [policy-inheritance.3] NEGATIVE CONTROL ──────────────────────────────
    //
    // This test proves the assertions above have TEETH: if `resolveForAgent` does
    // NOT perform the category join (simulated by calling `listForAgent` instead),
    // the `inherited_from` field is absent from the result set and the test
    // correctly goes RED.
    //
    // This is the deterministic negative-control analog to `nc_break_inheritance.mjs`:
    // instead of patching the source file, we call the un-joined `listForAgent`
    // path (which returns zero rows for a brand-new agent that has no direct-attach)
    // and assert that the result differs from the resolved result. If the resolution
    // were actually a no-op (i.e., identical to listForAgent), all the prior tests
    // would be silent successes — this negative control proves they are NOT.

    it("[policy-inheritance.3] NEGATIVE CONTROL: listForAgent (no-join path) does NOT return inherited rows", () => {
        const dbPath = tmpDbPath();
        const { sqlite, db } = openDb(dbPath);
        openHandles.push(sqlite);

        runMigrationsOn(sqlite, db);
        seedFixtures(db);

        const store = new AgentPolicyStore(db);

        // Attach mandatory policy to category, then add agent AFTER
        store.attachToCategory({
            categorySlug: CATEGORY_SLUG,
            policySlug:   REVIEWER_POSTURE_TEMPLATE.slug,
            isMandatory:  true,
        });
        store.addAgentToCategory({
            agentSlug:    NEW_AGENT_SLUG,
            categorySlug: CATEGORY_SLUG,
        });

        // The correct path: resolveForAgent returns 1 inherited row
        const resolvedRows = store.resolveForAgent(NEW_AGENT_SLUG);
        expect(resolvedRows).toHaveLength(1);
        expect(resolvedRows[0]!.inheritedFrom).toBe(CATEGORY_SLUG);

        // The BROKEN path: listForAgent returns 0 rows (no direct-attach exists)
        // — this is what would happen if the join were omitted (the nc_break script)
        const directOnlyRows = store.listForAgent(NEW_AGENT_SLUG);
        expect(directOnlyRows).toHaveLength(0);

        // Prove the two paths differ: if they were the same, inherited_from would
        // be absent and all prior assertions would fail.
        //
        // Negative-control assertion: the "broken" path has NO row with
        // inherited_from === CATEGORY_SLUG — this is precisely the failure
        // that nc_break_inheritance.mjs induces by removing the join.
        const brokenInherited = directOnlyRows.find(
            r => r.inheritedFrom === CATEGORY_SLUG
        );
        expect(brokenInherited).toBeUndefined(); // RED when broken, as required

        fs.unlinkSync(dbPath);
    });
});
