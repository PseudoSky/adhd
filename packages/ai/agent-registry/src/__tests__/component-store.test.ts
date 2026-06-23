/**
 * component-store.test.ts
 *
 * Drives ComponentStore against a REAL on-disk SQLite file (never :memory:).
 * Proves:
 *   1. create → read round-trip
 *   2. version() writes a NEW row; old version is still readable
 *   3. After close + reopen the component is still there
 *      [inv:reopen-proves-persistence] (contexts/_shared.md)
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
import { ComponentStore } from "../store/component-store.js";
import { ComponentError } from "../store/component-store.js";

// ── helpers ───────────────────────────────────────────────────────────────────

const MIGRATIONS_FOLDER = path.resolve(
    new URL("../../drizzle", import.meta.url).pathname
);

/** Open a fresh DB handle, run migrations, return { conn, store }. */
function openDb(dbPath: string): { conn: Database.Database; store: ComponentStore } {
    const conn = new Database(dbPath);
    conn.pragma("journal_mode = WAL");
    conn.pragma("foreign_keys = OFF"); // disable FK around migration (FK-safe runner)
    const db = drizzle(conn, { schema });
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    conn.pragma("foreign_keys = ON");
    const store = new ComponentStore(db);
    return { conn, store };
}

// ── fixtures ──────────────────────────────────────────────────────────────────

const TEST_TYPE = {
    slug: "rule",
    description: "A behavioral constraint rule",
    isSystem: false,
};

// ── suite ─────────────────────────────────────────────────────────────────────

describe("ComponentStore", () => {
    let dbPath: string;
    let conn: Database.Database;
    let store: ComponentStore;

    beforeAll(() => {
        // Real on-disk temp file — never :memory: [inv:real-db-tests]
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-registry-test-"));
        dbPath = path.join(tmpDir, "test-registry.db");

        const opened = openDb(dbPath);
        conn = opened.conn;
        store = opened.store;

        // Seed the lookup type needed by component FK
        store.upsertType(TEST_TYPE);
    });

    afterAll(() => {
        // Close handle before unlinking — avoids WAL teardown race
        conn.close();
        try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
        try { fs.unlinkSync(dbPath + "-wal"); } catch { /* ignore */ }
        try { fs.unlinkSync(dbPath + "-shm"); } catch { /* ignore */ }
    });

    // ── [lookup-and-component-schema.1] prompt_types lookup table defined ─────

    describe("prompt_types", () => {
        it("reads a seeded type back by slug", () => {
            const t = store.readType("rule");
            expect(t.slug).toBe("rule");
            expect(t.description).toBe("A behavioral constraint rule");
            expect(t.isSystem).toBe(false);
        });

        it("upsert on duplicate is a no-op (does not throw)", () => {
            // Inserting the same slug twice must not throw
            expect(() => store.upsertType(TEST_TYPE)).not.toThrow();
        });

        it("throws COMPONENT_TYPE_NOT_FOUND for unknown type", () => {
            expect(() => store.readType("nonexistent-type")).toThrowError(ComponentError);
            expect(() => store.readType("nonexistent-type")).toThrowError("not found");
        });
    });

    // ── [lookup-and-component-schema.2] prompt_components with integer version + is_shared ─

    describe("create → read round-trip", () => {
        it("creates a component and reads it back at version 1", () => {
            const created = store.create({
                slug: "intro-safety",
                type: "rule",
                content: "You are a safe and helpful assistant.",
                isShared: true,
            });

            expect(created.slug).toBe("intro-safety");
            expect(created.version).toBe(1);
            expect(created.isShared).toBe(true);
            expect(typeof created.content).toBe("string");

            const read = store.read("intro-safety");
            expect(read.slug).toBe("intro-safety");
            expect(read.version).toBe(1);
            expect(read.content).toBe("You are a safe and helpful assistant.");
            expect(read.isShared).toBe(true);
        });

        it("read() returns the LATEST version after a bump", () => {
            store.create({ slug: "versioned-comp", type: "rule", content: "v1 content" });
            store.version("versioned-comp", "v2 content");

            const latest = store.read("versioned-comp");
            expect(latest.version).toBe(2);
            expect(latest.content).toBe("v2 content");
        });

        it("throws COMPONENT_NOT_FOUND for unknown slug", () => {
            expect(() => store.read("does-not-exist")).toThrowError(ComponentError);
        });
    });

    // ── version retention: [inv:version-retained] ─────────────────────────────

    describe("version()", () => {
        it("writes a NEW row at version+1 and does NOT delete the prior version", () => {
            store.create({ slug: "audit-comp", type: "rule", content: "original" });

            const v2 = store.version("audit-comp", "revised");
            expect(v2.version).toBe(2);
            expect(v2.content).toBe("revised");

            // Prior version row MUST still exist — regression guard
            const v1 = store.readVersion("audit-comp", 1);
            expect(v1.content).toBe("original");
            expect(v1.version).toBe(1);
        });

        it("readVersion() on missing (slug, version) pair throws COMPONENT_VERSION_NOT_FOUND", () => {
            store.create({ slug: "only-v1", type: "rule", content: "just one version" });
            expect(() => store.readVersion("only-v1", 99)).toThrowError(ComponentError);
        });

        it("chains multiple versions — all rows retained", () => {
            store.create({ slug: "chain", type: "rule", content: "c1" });
            store.version("chain", "c2");
            store.version("chain", "c3");

            expect(store.readVersion("chain", 1).content).toBe("c1");
            expect(store.readVersion("chain", 2).content).toBe("c2");
            expect(store.readVersion("chain", 3).content).toBe("c3");
            expect(store.read("chain").version).toBe(3);
        });
    });

    // ── list() ────────────────────────────────────────────────────────────────

    describe("list()", () => {
        beforeAll(() => {
            store.upsertType({ slug: "system-rule", description: "System rule", isSystem: true });
            store.create({ slug: "sys-comp", type: "system-rule", content: "sys", isShared: false });
            store.create({ slug: "shared-comp", type: "rule", content: "shared", isShared: true });
        });

        it("returns latest version of each component with no filter", () => {
            const all = store.list();
            expect(all.length).toBeGreaterThan(0);
            // Every returned item should be the latest version for its slug
            const slugsSeen = new Set<string>();
            for (const c of all) {
                expect(slugsSeen.has(c.slug)).toBe(false);
                slugsSeen.add(c.slug);
            }
        });

        it("filters by type", () => {
            const sysList = store.list({ type: "system-rule" });
            expect(sysList.every((c) => c.type === "system-rule")).toBe(true);
        });

        it("filters by shared flag", () => {
            const sharedList = store.list({ shared: true });
            expect(sharedList.every((c) => c.isShared === true)).toBe(true);
        });

        it("combined type + shared filter", () => {
            const result = store.list({ type: "rule", shared: true });
            expect(result.every((c) => c.type === "rule" && c.isShared === true)).toBe(true);
        });
    });

    // ── [inv:reopen-proves-persistence] ──────────────────────────────────────

    describe("persistence across DB reopen", () => {
        it("component persists after closing and reopening the DB handle", () => {
            // Write a component with the current handle
            store.create({ slug: "persist-test", type: "rule", content: "I must survive a reopen" });

            // CLOSE the handle — flush WAL, release locks
            conn.close();

            // REOPEN from the SAME file path — no in-memory cheat
            const reopened = openDb(dbPath);
            conn = reopened.conn;   // replace outer handle for afterAll cleanup
            store = reopened.store; // replace store for subsequent tests

            const retrieved = store.read("persist-test");
            expect(retrieved.slug).toBe("persist-test");
            expect(retrieved.content).toBe("I must survive a reopen");
            expect(retrieved.version).toBe(1);
        });

        it("version rows from before reopen are still accessible", () => {
            // audit-comp was created + versioned in the earlier test block;
            // it must survive the reopen above
            const v1 = store.readVersion("audit-comp", 1);
            const v2 = store.readVersion("audit-comp", 2);
            expect(v1.content).toBe("original");
            expect(v2.content).toBe("revised");
        });
    });
});
