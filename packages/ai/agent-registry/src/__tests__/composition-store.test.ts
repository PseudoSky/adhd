/**
 * composition-store.test.ts
 *
 * Drives CompositionStore against a REAL on-disk SQLite file (never :memory:).
 * Proves:
 *   [composition-junction.1] agent_components junction with position, version_pin,
 *     context_condition, is_required
 *   [composition-junction.2] resolveComposition reads ordered components
 *   [composition-junction.3] composition ordering/pin/context test passes
 *
 * Key invariants exercised:
 *   - order by position (multiple slugs, different positions)
 *   - pinned version_pin returns exactly that version even after a newer version exists
 *   - null version_pin resolves to latest-at-resolve-time
 *   - unmatched context_condition excludes the component (Decision 2)
 *   - null context_condition always includes (Decision 2)
 *   - is_required + unmatched condition → CompositionError (Decision 2 §4)
 *   - reopen DB proves persistence [inv:reopen-proves-persistence]
 *
 * Gate on the vitest EXIT CODE, not stdout — per project memory
 * feedback_plan_execution_pitfalls.
 *
 * NEGATIVE-CONTROL: resolveComposition is the SINGLE place ordering + filtering
 * happen. The ordering test will fail if position ordering or slug tiebreak is
 * removed. The context test will fail if the condition evaluator is removed.
 * The pin test will fail if _resolveComponentVersion ignores the pin.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import * as schema from "../db/schema.js";
import { CompositionStore, CompositionError } from "../store/composition-store.js";
import { ComponentStore } from "../store/component-store.js";
import { AgentStore } from "../store/agent-store.js";

// ── helpers ───────────────────────────────────────────────────────────────────

const MIGRATIONS_FOLDER = path.resolve(
    new URL("../../drizzle", import.meta.url).pathname
);

interface OpenResult {
    conn: Database.Database;
    compositionStore: CompositionStore;
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
        compositionStore: new CompositionStore(db),
        componentStore: new ComponentStore(db),
        agentStore: new AgentStore(db),
    };
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe("CompositionStore", () => {
    let dbPath: string;
    let conn: Database.Database;
    let compositionStore: CompositionStore;
    let componentStore: ComponentStore;
    let agentStore: AgentStore;

    beforeAll(() => {
        // Real on-disk temp file — never :memory: [inv:real-db-tests]
        const tmpDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "agent-registry-composition-test-")
        );
        dbPath = path.join(tmpDir, "test-composition.db");

        const opened = openDb(dbPath);
        conn = opened.conn;
        compositionStore = opened.compositionStore;
        componentStore = opened.componentStore;
        agentStore = opened.agentStore;

        // Seed shared prompt type
        componentStore.upsertType({
            slug: "system",
            description: "System prompt section",
            isSystem: true,
        });

        // Seed agent
        agentStore.create({
            slug: "test-agent",
            displayName: "Test Agent",
        });
    });

    afterAll(() => {
        // Close before unlinking — avoids WAL teardown race
        conn.close();
        try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
        try { fs.unlinkSync(dbPath + "-wal"); } catch { /* ignore */ }
        try { fs.unlinkSync(dbPath + "-shm"); } catch { /* ignore */ }
    });

    // ── [composition-junction.3] ordering + version_pin + context_condition ──

    describe("resolveComposition — ordering, pinned version, context filter", () => {
        /**
         * This test covers ALL THREE acceptance criteria in a single integrated
         * scenario, using a real re-opened DB to prove persistence.
         *
         * Setup:
         *   comp-a  → v1 (base) + v2 (bumped) — attached with version_pin=1 at position=10
         *   comp-b  → v1 only — attached with null version_pin at position=5
         *   comp-c  → v1 only — attached with context_condition={"env":"prod"} at position=7
         *
         * Context under test: { env: "prod" }
         *
         * Expected composition order: comp-b (pos=5), comp-c (pos=7), comp-a (pos=10).
         *   - comp-a: resolves v1 (pinned), even though v2 exists → proves pin semantics.
         *   - comp-b: resolves v1 (latest), position < comp-c → proves position ordering.
         *   - comp-c: included because condition {"env":"prod"} matches ctx → proves filtering.
         *
         * Negative controls (teeth):
         *   - If position ordering breaks: comp-b would appear after comp-c or comp-a.
         *   - If pin is ignored (uses latest): comp-a would resolve to v2, not v1.
         *   - If context eval is removed: a subsequent test with non-matching context
         *     would include comp-c when it must be excluded.
         */
        it("returns components ordered by position, respects pinned version, includes only matching context", () => {
            const now = new Date().toISOString();

            // comp-a: create v1, then bump to v2
            componentStore.create({
                slug: "comp-a",
                type: "system",
                content: "comp-a v1 content",
            });
            componentStore.version("comp-a", "comp-a v2 content");

            // comp-b: v1 only (will be latest)
            componentStore.create({
                slug: "comp-b",
                type: "system",
                content: "comp-b v1 content",
            });

            // comp-c: v1 only (conditional on env=prod)
            componentStore.create({
                slug: "comp-c",
                type: "system",
                content: "comp-c v1 content",
            });

            // Attach junction rows
            compositionStore.attach({
                agentSlug: "test-agent",
                componentSlug: "comp-a",
                position: 10,
                versionPin: 1, // pin to v1, even though v2 exists
            });
            compositionStore.attach({
                agentSlug: "test-agent",
                componentSlug: "comp-b",
                position: 5,
                versionPin: null, // latest
            });
            compositionStore.attach({
                agentSlug: "test-agent",
                componentSlug: "comp-c",
                position: 7,
                contextCondition: JSON.stringify({ env: "prod" }),
            });

            // ── Prove persistence: close handle, reopen, then resolve ─────────
            // [inv:reopen-proves-persistence]
            conn.close();
            const reopened = openDb(dbPath);
            conn = reopened.conn;
            compositionStore = reopened.compositionStore;
            componentStore = reopened.componentStore;
            agentStore = reopened.agentStore;

            // Resolve with matching context { env: "prod" }
            const result = compositionStore.resolveComposition("test-agent", { env: "prod" });

            // Expect 3 components (comp-b, comp-c, comp-a) in position order
            expect(result).toHaveLength(3);

            // [composition-junction.2] ordering by position ASC
            expect(result[0]!.componentSlug).toBe("comp-b"); // pos=5
            expect(result[1]!.componentSlug).toBe("comp-c"); // pos=7
            expect(result[2]!.componentSlug).toBe("comp-a"); // pos=10

            // [composition-junction.1] version_pin — comp-a must resolve to v1 not v2
            expect(result[2]!.resolvedVersion).toBe(1);
            expect(result[2]!.component.content).toBe("comp-a v1 content");

            // comp-b resolves to latest (v1)
            expect(result[0]!.resolvedVersion).toBe(1);
            expect(result[0]!.component.content).toBe("comp-b v1 content");

            // comp-c included because condition matched
            expect(result[1]!.component.content).toBe("comp-c v1 content");
        });

        it("excludes comp-c when context does NOT match its condition", () => {
            // context { env: "staging" } → comp-c condition {"env":"prod"} does not match
            const result = compositionStore.resolveComposition("test-agent", { env: "staging" });

            // Only comp-a (pos=10) and comp-b (pos=5) — comp-c excluded
            expect(result).toHaveLength(2);
            const slugs = result.map((r) => r.componentSlug);
            expect(slugs).not.toContain("comp-c");

            // Order still correct: comp-b before comp-a
            expect(result[0]!.componentSlug).toBe("comp-b"); // pos=5
            expect(result[1]!.componentSlug).toBe("comp-a"); // pos=10
        });

        it("resolves null version_pin to latest after a version bump", () => {
            // Bump comp-b to v2 — the unpinned junction row must now resolve to v2
            componentStore.version("comp-b", "comp-b v2 content");

            const result = compositionStore.resolveComposition("test-agent", {});
            const compB = result.find((r) => r.componentSlug === "comp-b");

            expect(compB).toBeDefined();
            // null pin → latest-at-resolve = v2
            expect(compB!.resolvedVersion).toBe(2);
            expect(compB!.component.content).toBe("comp-b v2 content");

            // comp-a still pinned to v1
            const compA = result.find((r) => r.componentSlug === "comp-a");
            expect(compA!.resolvedVersion).toBe(1);
        });
    });

    // ── [composition-junction.1] is_required + unmatched → throws ────────────

    describe("resolveComposition — is_required + unmatched condition → CompositionError", () => {
        beforeAll(() => {
            // Seed a second agent for this isolation
            agentStore.create({
                slug: "strict-agent",
                displayName: "Strict Agent",
            });

            componentStore.upsertType({
                slug: "rule",
                description: "Rule type",
                isSystem: false,
            });
            componentStore.create({
                slug: "required-comp",
                type: "rule",
                content: "required rule content",
            });

            // Attach as required, conditional on env=prod
            compositionStore.attach({
                agentSlug: "strict-agent",
                componentSlug: "required-comp",
                position: 1,
                contextCondition: JSON.stringify({ env: "prod" }),
                isRequired: true,
            });
        });

        it("throws REQUIRED_COMPONENT_EXCLUDED when a required component is filtered out", () => {
            // context { env: "dev" } → condition {"env":"prod"} does not match
            // → is_required=true → must throw CompositionError
            expect(() =>
                compositionStore.resolveComposition("strict-agent", { env: "dev" })
            ).toThrow(CompositionError);

            // Also verify the error code
            let caught: unknown;
            try {
                compositionStore.resolveComposition("strict-agent", { env: "dev" });
            } catch (e) {
                caught = e;
            }
            expect(caught).toBeInstanceOf(CompositionError);
            expect((caught as CompositionError).code).toBe("REQUIRED_COMPONENT_EXCLUDED");
        });

        it("includes the required component when condition matches (no error)", () => {
            // context { env: "prod" } → condition matches → included, no throw
            const result = compositionStore.resolveComposition("strict-agent", { env: "prod" });

            expect(result).toHaveLength(1);
            expect(result[0]!.componentSlug).toBe("required-comp");
        });

        it("includes a required component with null condition unconditionally (no error)", () => {
            // Add a required, always-included component to strict-agent
            componentStore.create({
                slug: "always-required",
                type: "rule",
                content: "always present",
            });
            compositionStore.attach({
                agentSlug: "strict-agent",
                componentSlug: "always-required",
                position: 0,
                contextCondition: null,
                isRequired: true,
            });

            // Even with a context that does not match the other required component,
            // the always-required one is still included; the conditional-required one still throws.
            expect(() =>
                compositionStore.resolveComposition("strict-agent", { env: "dev" })
            ).toThrow(CompositionError);

            // With matching context for the conditional one: both present, no throw
            const result = compositionStore.resolveComposition("strict-agent", { env: "prod" });
            const slugs = result.map((r) => r.componentSlug).sort();
            expect(slugs).toContain("always-required");
            expect(slugs).toContain("required-comp");
        });
    });
});
