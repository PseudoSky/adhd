/**
 * composed-prompt-store.test.ts
 *
 * Drives ComposedPromptStore + contextHash against a REAL on-disk SQLite file.
 * Proves:
 *   [composed-prompt-cache.1] composed_prompts table: agent slug, context hash,
 *                             content, component versions JSON
 *   [composed-prompt-cache.2] composed-prompt-store cache lookup test passes
 *
 * Key invariants exercised:
 *   - write() persists a composed prompt row
 *   - lookup() returns the row after REOPENING the DB handle (persistence proof)
 *   - lookup() returns null for a DIFFERENT context_hash (cache miss)
 *   - componentVersions JSON round-trips correctly (audit trail integrity)
 *   - contextHash() is order-independent: same map with shuffled keys → same hash
 *
 * Negative controls (teeth):
 *   - If hashing becomes order-dependent: the order-independence test fails.
 *   - If component_versions is not persisted as JSON: the parsed map assertion fails.
 *   - If lookup matches the wrong hash: the cache-miss assertion returns non-null.
 *   - If reopen breaks: any read-back assertion fails before returning results.
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
import { ComposedPromptStore, contextHash } from "../store/composed-prompt-store.js";

// ── helpers ───────────────────────────────────────────────────────────────────

const MIGRATIONS_FOLDER = path.resolve(
    new URL("../../drizzle", import.meta.url).pathname
);

interface OpenResult {
    conn: Database.Database;
    store: ComposedPromptStore;
}

/** Open a fresh handle, run ALL migrations, return the store. */
function openDb(dbPath: string): OpenResult {
    const conn = new Database(dbPath);
    conn.pragma("journal_mode = WAL");
    conn.pragma("foreign_keys = OFF"); // FK-safe migration runner pattern
    const db = drizzle(conn, { schema });
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    conn.pragma("foreign_keys = ON");
    return {
        conn,
        store: new ComposedPromptStore(db),
    };
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe("ComposedPromptStore", () => {
    let dbPath: string;
    let conn: Database.Database;
    let store: ComposedPromptStore;

    beforeAll(() => {
        // Real on-disk temp file — never :memory: [inv:real-db-tests]
        const tmpDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "agent-registry-composed-prompt-test-")
        );
        dbPath = path.join(tmpDir, "test-composed-prompt.db");

        const opened = openDb(dbPath);
        conn = opened.conn;
        store = opened.store;
    });

    afterAll(() => {
        // Close before unlinking — avoids WAL teardown race
        conn.close();
        try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
        try { fs.unlinkSync(dbPath + "-wal"); } catch { /* ignore */ }
        try { fs.unlinkSync(dbPath + "-shm"); } catch { /* ignore */ }
    });

    // ── [composed-prompt-cache.1 + .2] core persistence + cache scenario ──────

    describe("write + reopen + lookup: full persistence + cache scenario", () => {
        /**
         * This test covers BOTH acceptance criteria in one integrated scenario.
         *
         * Setup:
         *   1. Compute a context hash for { model: "opus", mode: "review" }.
         *   2. Write a composed prompt with a component_versions audit map.
         *   3. CLOSE the handle and REOPEN from the same file path.
         *   4. lookup() by (agent_slug, context_hash) returns the written row.
         *   5. lookup() by (agent_slug, DIFFERENT_hash) returns null.
         *
         * Negative controls:
         *   - If component_versions JSON is not stored: parsed map assertion fails.
         *   - If lookup ignores the hash: the cache-miss assertion returns non-null.
         *   - If reopen breaks: the read-back assertions fire before returning.
         */
        it("persists a composed prompt and retrieves it by cache key after reopen", () => {
            const agentSlug = "code-review-agent";
            const context = { model: "opus", mode: "review" };
            const hash = contextHash(context);

            const written = store.write({
                agentSlug,
                contextHash: hash,
                content: "You are a code review agent.\n\nReview the code carefully.",
                componentVersions: {
                    "system-intro": 2,
                    "review-criteria": 1,
                    "output-format": 3,
                },
            });

            expect(written.id).toBeGreaterThan(0);
            expect(written.agentSlug).toBe(agentSlug);
            expect(written.contextHash).toBe(hash);
            expect(written.content).toBe(
                "You are a code review agent.\n\nReview the code carefully."
            );
            // TOOTH: component_versions must be persisted as a parsed map
            expect(written.componentVersions).toEqual({
                "system-intro": 2,
                "review-criteria": 1,
                "output-format": 3,
            });

            // ── Prove persistence: close handle, reopen, then query ─────────
            // [inv:reopen-proves-persistence]
            conn.close();
            const reopened = openDb(dbPath);
            conn = reopened.conn;
            store = reopened.store;

            // Cache HIT: same (agent_slug, context_hash) → row returned
            const found = store.lookup(agentSlug, hash);
            expect(found).not.toBeNull();
            expect(found!.id).toBe(written.id);
            expect(found!.agentSlug).toBe(agentSlug);
            expect(found!.contextHash).toBe(hash);
            expect(found!.content).toBe(
                "You are a code review agent.\n\nReview the code carefully."
            );
            // TOOTH: audit map must survive JSON round-trip through reopen
            expect(found!.componentVersions).toEqual({
                "system-intro": 2,
                "review-criteria": 1,
                "output-format": 3,
            });

            // Cache MISS: different hash → null  (TOOTH: fails if lookup ignores hash)
            const differentHash = contextHash({ model: "sonnet", mode: "review" });
            expect(differentHash).not.toBe(hash); // guard: confirm hashes differ
            const notFound = store.lookup(agentSlug, differentHash);
            expect(notFound).toBeNull();
        });
    });

    // ── read() by PK id ───────────────────────────────────────────────────────

    describe("read(id)", () => {
        it("returns the row by PK id after write", () => {
            const hash = contextHash({ env: "prod" });
            const written = store.write({
                agentSlug: "deploy-agent",
                contextHash: hash,
                content: "Deploy prompt content.",
                componentVersions: { "deploy-intro": 1 },
            });

            const read = store.read(written.id);
            expect(read.id).toBe(written.id);
            expect(read.agentSlug).toBe("deploy-agent");
            expect(read.componentVersions).toEqual({ "deploy-intro": 1 });
        });

        it("throws NOT_FOUND for a non-existent id", () => {
            expect(() => store.read(999_999)).toThrow();
        });
    });

    // ── lookup() isolation across agents ─────────────────────────────────────

    describe("lookup() — agent isolation", () => {
        it("does not return a row belonging to a different agent", () => {
            const hash = contextHash({ mode: "fast" });

            store.write({
                agentSlug: "agent-alpha",
                contextHash: hash,
                content: "Alpha prompt.",
                componentVersions: { "alpha-intro": 1 },
            });

            // Same hash, different agent slug → cache miss
            const miss = store.lookup("agent-beta", hash);
            expect(miss).toBeNull();
        });
    });
});

// ── contextHash helper ────────────────────────────────────────────────────────

describe("contextHash", () => {
    /**
     * Order-independence is the critical property of the cache key algorithm.
     * The same logical context in any key-insertion order MUST hash identically,
     * because @adhd/agent-compiler and @adhd/agent-mcp may construct the context
     * map independently with differing key orders.
     *
     * TOOTH: if sorting is removed from contextHash(), this test goes red.
     */
    it("produces the same hash regardless of key insertion order", () => {
        const map1 = { model: "opus", mode: "review", env: "prod" };
        // Same logical map but keys in shuffled order
        const map2 = { env: "prod", model: "opus", mode: "review" };
        const map3 = { mode: "review", env: "prod", model: "opus" };

        const h1 = contextHash(map1);
        const h2 = contextHash(map2);
        const h3 = contextHash(map3);

        expect(h1).toBe(h2);
        expect(h2).toBe(h3);
    });

    it("produces DIFFERENT hashes for different context values", () => {
        const h1 = contextHash({ model: "opus" });
        const h2 = contextHash({ model: "sonnet" });
        expect(h1).not.toBe(h2);
    });

    it("produces a 64-character hex string", () => {
        const h = contextHash({ a: "1" });
        expect(h).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is stable: same input always returns the same hash", () => {
        const context = { model: "opus", mode: "review" };
        expect(contextHash(context)).toBe(contextHash(context));
    });

    it("empty context hashes to a stable value", () => {
        const h1 = contextHash({});
        const h2 = contextHash({});
        expect(h1).toBe(h2);
        expect(h1).toHaveLength(64);
    });
});
