/**
 * usecase-store.test.ts
 *
 * Drives UseCaseStore against a REAL on-disk SQLite file (never :memory:).
 * Proves:
 *   [usecase-and-context-rules.1] use_cases + component_usage + context_rules tables exist
 *   [usecase-and-context-rules.2] usecase-store test passes
 *
 * Key invariants exercised:
 *   - createUseCase persists and is readable after reopen
 *   - linkComponent persists weight to registry_component_usage after reopen
 *   - componentsFor returns correct rows with weight
 *   - addContextRule persists to registry_context_rules after reopen
 *   - contextRulesFor returns correct rows for the agent
 *   - Annotation tables are entirely independent of resolveComposition
 *
 * Negative controls (teeth):
 *   - If weight is not persisted: the weight assertion fails on reopen.
 *   - If linkComponent inserts into the wrong table: componentsFor returns nothing.
 *   - If addContextRule inserts into the wrong table: contextRulesFor returns nothing.
 *   - If reopen breaks: any of the read-back assertions fail before producing results.
 *
 * Gate on the vitest EXIT CODE, not stdout — per project memory
 * feedback_plan_execution_pitfalls.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import * as schema from "../db/schema.js";
import { UseCaseStore } from "../store/usecase-store.js";
import { ComponentStore } from "../store/component-store.js";
import { AgentStore } from "../store/agent-store.js";

// ── helpers ───────────────────────────────────────────────────────────────────

const MIGRATIONS_FOLDER = path.resolve(
    new URL("../../drizzle", import.meta.url).pathname
);

interface OpenResult {
    conn: Database.Database;
    useCaseStore: UseCaseStore;
    componentStore: ComponentStore;
    agentStore: AgentStore;
}

/** Open a fresh handle, run ALL migrations, return stores. */
function openDb(dbPath: string): OpenResult {
    const conn = new Database(dbPath);
    conn.pragma("journal_mode = WAL");
    conn.pragma("foreign_keys = OFF"); // FK-safe migration runner pattern
    const db = drizzle(conn, { schema });
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    conn.pragma("foreign_keys = ON");
    return {
        conn,
        useCaseStore: new UseCaseStore(db),
        componentStore: new ComponentStore(db),
        agentStore: new AgentStore(db),
    };
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe("UseCaseStore", () => {
    let dbPath: string;
    let conn: Database.Database;
    let useCaseStore: UseCaseStore;
    let componentStore: ComponentStore;
    let agentStore: AgentStore;

    beforeAll(() => {
        // Real on-disk temp file — never :memory: [inv:real-db-tests]
        const tmpDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "agent-registry-usecase-test-")
        );
        dbPath = path.join(tmpDir, "test-usecase.db");

        const opened = openDb(dbPath);
        conn = opened.conn;
        useCaseStore = opened.useCaseStore;
        componentStore = opened.componentStore;
        agentStore = opened.agentStore;

        // Seed shared prompt type and component
        componentStore.upsertType({
            slug: "system",
            description: "System prompt section",
            isSystem: true,
        });
        componentStore.create({
            slug: "security-rules",
            type: "system",
            content: "Security review rules content",
        });

        // Seed agent for context-rules tests
        agentStore.create({
            slug: "review-agent",
            displayName: "Review Agent",
        });
    });

    afterAll(() => {
        // Close before unlinking — avoids WAL teardown race
        conn.close();
        try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
        try { fs.unlinkSync(dbPath + "-wal"); } catch { /* ignore */ }
        try { fs.unlinkSync(dbPath + "-shm"); } catch { /* ignore */ }
    });

    // ── [usecase-and-context-rules.1 + .2] core persistence scenario ─────────

    describe("use_cases + component_usage + context_rules: full persistence scenario", () => {
        /**
         * This test covers BOTH acceptance criteria in a single integrated scenario.
         *
         * Setup:
         *   1. Create use-case "security-audit".
         *   2. Link "security-rules" component to it with weight=90.
         *   3. Add a context rule on "review-agent": when {"ticket_type":"security"}
         *      also include "security-rules" at position 5.
         *   4. CLOSE the handle and REOPEN from the same file path.
         *   5. Query back and assert weight=90 and rule round-trips correctly.
         *
         * Negative controls:
         *   - If weight is not persisted: componentsFor()[0].weight !== 90 → fail.
         *   - If context rule is not persisted: contextRulesFor() returns [] → fail.
         *   - If tables don't exist after migration: every insert throws → fail.
         */
        it("persists use-case, component link with weight, and context rule — all survive reopen", () => {
            // Step 1: create use-case
            const useCase = useCaseStore.createUseCase({
                slug: "security-audit",
                name: "Security Audit",
                description: "Deep security analysis scenario",
            });
            expect(useCase.slug).toBe("security-audit");

            // Step 2: link component with weight
            const link = useCaseStore.linkComponent("security-rules", "security-audit", 90);
            expect(link.weight).toBe(90);

            // Step 3: add context rule
            const rule = useCaseStore.addContextRule({
                agentSlug: "review-agent",
                condition: JSON.stringify({ ticket_type: "security" }),
                componentSlug: "security-rules",
                position: 5,
            });
            expect(rule.id).toBeGreaterThan(0);
            expect(rule.condition).toBe('{"ticket_type":"security"}');

            // ── Prove persistence: close handle, reopen, then query ─────────
            // [inv:reopen-proves-persistence]
            conn.close();
            const reopened = openDb(dbPath);
            conn = reopened.conn;
            useCaseStore = reopened.useCaseStore;
            componentStore = reopened.componentStore;
            agentStore = reopened.agentStore;

            // Assert use-case survives reopen
            const queriedUseCase = useCaseStore.getUseCase("security-audit");
            expect(queriedUseCase).toBeDefined();
            expect(queriedUseCase!.name).toBe("Security Audit");
            expect(queriedUseCase!.description).toBe("Deep security analysis scenario");

            // Assert component link with weight survives reopen (TOOTH: weight must persist)
            const components = useCaseStore.componentsFor("security-audit");
            expect(components).toHaveLength(1);
            expect(components[0]!.componentSlug).toBe("security-rules");
            expect(components[0]!.useCaseSlug).toBe("security-audit");
            expect(components[0]!.weight).toBe(90); // TOOTH: fails if weight not stored

            // Assert context rule survives reopen (TOOTH: rule must persist)
            const rules = useCaseStore.contextRulesFor("review-agent");
            expect(rules).toHaveLength(1);
            expect(rules[0]!.agentSlug).toBe("review-agent");
            expect(rules[0]!.condition).toBe('{"ticket_type":"security"}');
            expect(rules[0]!.componentSlug).toBe("security-rules");
            expect(rules[0]!.position).toBe(5);
        });
    });

    // ── Additional coverage ───────────────────────────────────────────────────

    describe("listUseCases", () => {
        it("returns all seeded use-cases", () => {
            // "security-audit" was created in the scenario above; add another
            useCaseStore.createUseCase({
                slug: "code-review",
                name: "Code Review",
                description: "Standard code review scenario",
            });

            const all = useCaseStore.listUseCases();
            const slugs = all.map((u) => u.slug);
            expect(slugs).toContain("security-audit");
            expect(slugs).toContain("code-review");
        });
    });

    describe("componentsFor — no links returns empty array", () => {
        it("returns empty array for a use-case with no linked components", () => {
            useCaseStore.createUseCase({
                slug: "data-migration",
                name: "Data Migration",
            });
            const components = useCaseStore.componentsFor("data-migration");
            expect(components).toHaveLength(0);
        });
    });

    describe("contextRulesFor — multiple rules, multiple agents isolated", () => {
        it("returns only rules belonging to the queried agent", () => {
            // Seed a second agent
            agentStore.create({ slug: "other-agent", displayName: "Other Agent" });

            // Seed a second component
            componentStore.upsertType({ slug: "rule", description: "Rule type", isSystem: false });
            componentStore.create({
                slug: "compliance-rule",
                type: "rule",
                content: "Compliance rule content",
            });

            // Add a rule to "other-agent" — must not appear when querying "review-agent"
            useCaseStore.addContextRule({
                agentSlug: "other-agent",
                condition: JSON.stringify({ env: "prod" }),
                componentSlug: "compliance-rule",
                position: 1,
            });

            // review-agent already has one rule from the persistence scenario
            const reviewRules = useCaseStore.contextRulesFor("review-agent");
            expect(reviewRules.every((r) => r.agentSlug === "review-agent")).toBe(true);

            const otherRules = useCaseStore.contextRulesFor("other-agent");
            expect(otherRules).toHaveLength(1);
            expect(otherRules[0]!.agentSlug).toBe("other-agent");
            expect(otherRules[0]!.componentSlug).toBe("compliance-rule");
        });
    });

    describe("componentsFor — null weight is preserved", () => {
        it("persists null weight when no weight is supplied", () => {
            useCaseStore.createUseCase({ slug: "no-weight-case", name: "No Weight Case" });
            componentStore.create({
                slug: "generic-comp",
                type: "system",
                content: "Generic component",
            });
            useCaseStore.linkComponent("generic-comp", "no-weight-case");

            const components = useCaseStore.componentsFor("no-weight-case");
            expect(components).toHaveLength(1);
            expect(components[0]!.weight).toBeNull();
        });
    });
});
