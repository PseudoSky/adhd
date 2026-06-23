/**
 * roundtrip.test.ts
 *
 * End-to-end round-trip suite for @adhd/agent-registry seed infrastructure.
 *
 * Proves:
 *   [seed-and-roundtrip.1] seed + reopen + idempotency round-trip suite passes
 *   [seed-and-roundtrip.2] prompt-types seed lists every DATA_MODEL seed type
 *   [seed-and-roundtrip.3] round-trip test has teeth: corrupting a persisted row
 *                          fails the reopen assertion (via nc_mutate/nc_restore)
 *
 * Three named cases (required by plan context):
 *   1. "component round-trips after reopen"
 *   2. "seed is idempotent on re-run"
 *   3. "agent composes seeded components in order"
 *
 * Key invariants:
 *   [inv:reopen-proves-persistence] — persistence proved by CLOSING the
 *     better-sqlite3 handle and REOPENING from the same file path; NOT by
 *     reading in-memory state (contexts/_shared.md).
 *   [inv:real-db-tests] — real on-disk SQLite (a fixed tmp path); not :memory:.
 *   [inv:version-retained] — seed is idempotent: running twice yields identical
 *     row counts and versions.
 *
 * DB path is written to ROUNDTRIP_DB_PATH env var for the nc_mutate/nc_restore
 * negative-control scripts to target the same file.
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
import { count } from "drizzle-orm";

import * as schema from "../db/schema.js";
import { promptComponentsTable, promptTypesTable } from "../db/schema.js";
import { ComponentStore } from "../store/component-store.js";
import { AgentStore } from "../store/agent-store.js";
import { CompositionStore } from "../store/composition-store.js";
import { seed } from "../seed/index.js";
import { PROMPT_TYPES } from "../seed/prompt-types.js";
import { SEED_COMPONENTS } from "../seed/components.js";

// ── constants ─────────────────────────────────────────────────────────────────

const MIGRATIONS_FOLDER = path.resolve(
    new URL("../../drizzle", import.meta.url).pathname
);

// If ROUNDTRIP_DB_PATH is set by the caller (e.g. nc_mutate proof), use that
// pre-seeded file instead of creating a fresh one.  When absent, we create a
// temp file and seed it ourselves.  In both cases the path is written back to
// the env var so the nc scripts can find it when invoked separately.
const EXTERNAL_DB_PATH = process.env["ROUNDTRIP_DB_PATH"];

const TMP_DIR = EXTERNAL_DB_PATH
    ? null
    : fs.mkdtempSync(path.join(os.tmpdir(), "agent-registry-roundtrip-"));

const DB_PATH = EXTERNAL_DB_PATH
    ? EXTERNAL_DB_PATH
    : path.join(TMP_DIR!, "roundtrip.db");

// Expose (or confirm) the path for external scripts (nc_mutate / nc_restore).
process.env["ROUNDTRIP_DB_PATH"] = DB_PATH;

// ── helpers ───────────────────────────────────────────────────────────────────

interface OpenResult {
    conn: Database.Database;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: ReturnType<typeof drizzle<any>>;
    componentStore: ComponentStore;
    agentStore: AgentStore;
    compositionStore: CompositionStore;
}

/** Open (or reopen) the on-disk DB, run migrations, return stores. */
function openDb(dbPath: string): OpenResult {
    const conn = new Database(dbPath);
    conn.pragma("journal_mode = WAL");
    conn.pragma("foreign_keys = OFF"); // FK-safe migration runner — see migrate-runner.ts
    const db = drizzle(conn, { schema });
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    conn.pragma("foreign_keys = ON");
    return {
        conn,
        db,
        componentStore: new ComponentStore(db),
        agentStore: new AgentStore(db),
        compositionStore: new CompositionStore(db),
    };
}

// ── setup: seed once before all cases ────────────────────────────────────────

beforeAll(() => {
    if (EXTERNAL_DB_PATH) {
        // Using a caller-provided, pre-seeded DB (nc proof mode).
        // Do NOT re-seed — the caller controls the DB state (possibly corrupted).
        return;
    }
    // Normal mode: seed a fresh on-disk DB.
    const { conn, db } = openDb(DB_PATH);
    seed(db);
    conn.close();
});

afterAll(() => {
    if (EXTERNAL_DB_PATH) {
        // Caller owns the DB — do not delete it.
        return;
    }
    // Remove the temp DB file and WAL/SHM companions.
    try { fs.unlinkSync(DB_PATH); } catch { /* ignore */ }
    try { fs.unlinkSync(DB_PATH + "-wal"); } catch { /* ignore */ }
    try { fs.unlinkSync(DB_PATH + "-shm"); } catch { /* ignore */ }
    if (TMP_DIR) {
        try { fs.rmdirSync(TMP_DIR); } catch { /* ignore */ }
    }
});

// ── test suite ────────────────────────────────────────────────────────────────

describe("seed round-trip", () => {

    // ── Case 1: component round-trips after reopen ─────────────────────────────
    //
    // Proves [seed-and-roundtrip.1] and [inv:reopen-proves-persistence].
    // Seed is done in beforeAll above; here we CLOSE any handle and REOPEN
    // from the same file path to prove persistence.
    //
    // Also proves [seed-and-roundtrip.3] teeth: nc_mutate.mjs corrupts the
    // default-skeptic row so this deep-equals check fails, then nc_restore.mjs
    // restores it so it passes again.

    it("component round-trips after reopen", () => {
        // Close and reopen — proves the data hit disk, not just in-memory state.
        const { conn, componentStore } = openDb(DB_PATH);

        try {
            const read = componentStore.read("default-skeptic");

            // Deep-equal against the seed source of truth.
            const seedEntry = SEED_COMPONENTS.find((c) => c.slug === "default-skeptic");
            expect(seedEntry).toBeDefined();

            expect(read.slug).toBe("default-skeptic");
            expect(read.type).toBe("rule");
            expect(read.version).toBe(seedEntry!.version);
            expect(read.content).toBe(seedEntry!.content);
            expect(read.isShared).toBe(true);
        } finally {
            conn.close();
        }
    });

    // ── Case 2: seed is idempotent on re-run ────────────────────────────────────
    //
    // Proves [seed-and-roundtrip.1] and [inv:version-retained].
    // Run seed() a second time and confirm counts + versions are unchanged.

    it("seed is idempotent on re-run", () => {
        const { conn, db, componentStore } = openDb(DB_PATH);

        try {
            // Capture counts before second seed.
            const typesBefore = db
                .select({ n: count() })
                .from(promptTypesTable)
                .get()!.n;

            const componentsBefore = db
                .select({ n: count() })
                .from(promptComponentsTable)
                .get()!.n;

            // Read a reference row to compare version afterward.
            const skepticBefore = componentStore.read("default-skeptic");

            // Second seed — must be a complete no-op.
            seed(db);

            // Counts must not change.
            const typesAfter = db
                .select({ n: count() })
                .from(promptTypesTable)
                .get()!.n;

            const componentsAfter = db
                .select({ n: count() })
                .from(promptComponentsTable)
                .get()!.n;

            expect(typesAfter).toBe(typesBefore);
            expect(componentsAfter).toBe(componentsBefore);

            // Version of an existing row must not change.
            const skepticAfter = componentStore.read("default-skeptic");
            expect(skepticAfter.version).toBe(skepticBefore.version);
            expect(skepticAfter.content).toBe(skepticBefore.content);

            // All 18 system types must be present (SEED_DATA.md §1).
            expect(typesAfter).toBeGreaterThanOrEqual(PROMPT_TYPES.length);

            // All seeded components must be present.
            expect(componentsAfter).toBeGreaterThanOrEqual(SEED_COMPONENTS.length);
        } finally {
            conn.close();
        }
    });

    // ── Case 3: agent composes seeded components in order ───────────────────────
    //
    // Proves the composition path works end-to-end with real seeded components.
    // Creates a test agent, attaches 3 seeded components at positions 1-3,
    // calls resolveComposition, confirms they come back in position order.

    it("agent composes seeded components in order", () => {
        const { conn, agentStore, componentStore, compositionStore } = openDb(DB_PATH);

        try {
            // Seed the 'rule' type for the agent (already in DB; upsert is no-op).
            componentStore.upsertType({
                slug: "role",
                description: "Fundamental agent identity — what the agent is",
                isSystem: true,
            });

            // Use a per-run unique agent slug so the test is idempotent even
            // when pointed at the same DB across multiple invocations (nc proof mode).
            const agentSlug = `roundtrip-compose-${Date.now()}`;
            agentStore.create({
                slug: agentSlug,
                displayName: "Round-trip Composition Test Agent",
            });

            // Pick 3 seeded components to attach at positions 1, 2, 3.
            // Using components we know exist from the seed: default-skeptic (pos 1),
            // sox-handoff (pos 2), no-credentials (pos 3).
            const slugsInOrder = [
                { slug: "default-skeptic", pos: 1 },
                { slug: "sox-handoff",     pos: 2 },
                { slug: "no-credentials",  pos: 3 },
            ];

            for (const { slug, pos } of slugsInOrder) {
                compositionStore.attach({
                    agentSlug,
                    componentSlug: slug,
                    position: pos,
                });
            }

            // resolveComposition must return components in position order.
            const resolved = compositionStore.resolveComposition(agentSlug, {});

            expect(resolved).toHaveLength(3);
            expect(resolved[0].componentSlug).toBe("default-skeptic");
            expect(resolved[0].position).toBe(1);
            expect(resolved[1].componentSlug).toBe("sox-handoff");
            expect(resolved[1].position).toBe(2);
            expect(resolved[2].componentSlug).toBe("no-credentials");
            expect(resolved[2].position).toBe(3);

            // Confirm the resolved components carry real seeded content.
            expect(resolved[0].component.content).toContain("NEEDS-WORK");
            expect(resolved[1].component.content).toContain("Handoff Template");
            expect(resolved[2].component.content).toContain("human_input");
        } finally {
            conn.close();
        }
    });

    // ── Coverage check: all 18 prompt types are present ────────────────────────
    //
    // Proves [seed-and-roundtrip.2]: the seed lists every DATA_MODEL prompt type.

    it("all 18 system prompt types are seeded", () => {
        const { conn, componentStore } = openDb(DB_PATH);

        try {
            const expectedSlugs = PROMPT_TYPES.map((t) => t.slug).sort();

            for (const slug of expectedSlugs) {
                // readType throws COMPONENT_TYPE_NOT_FOUND if absent — that is
                // the assertion: each of the 18 slugs must round-trip.
                const t = componentStore.readType(slug);
                expect(t.slug).toBe(slug);
                expect(t.isSystem).toBe(true);
            }

            // Explicit count: exactly 18 system types from SEED_DATA.md §1.
            expect(expectedSlugs).toHaveLength(18);
        } finally {
            conn.close();
        }
    });
});
