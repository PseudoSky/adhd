/**
 * PolicyTemplateStore — real on-disk SQLite integration tests.
 *
 * [inv:reopen-proves-persistence]: every test that asserts data exists
 * CLOSES the better-sqlite3 handle and REOPENS from the same path before
 * performing the read-back. This proves the row is durable on disk, not
 * resident only in memory.
 *
 * [inv:enforcement-is-array]: the `enforcement` column is a JSON ARRAY.
 * Tests assert Array.isArray() + length ≥ 2 on a multi-mechanism template.
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
import { PolicyTemplateStore, PolicyError } from "../store/policy-template-store.js";

// ── helpers ────────────────────────────────────────────────────────────────

/** Open a fresh better-sqlite3 connection + drizzle wrapper at `dbPath`. */
function openDb(dbPath: string): { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema> } {
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
        `agent-policy-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
}

// Track open handles so afterEach can close them, preventing zombie
// connections on better-sqlite3 teardown.
const openHandles: Database.Database[] = [];

afterEach(() => {
    while (openHandles.length) {
        try { openHandles.pop()!.close(); } catch { /* already closed */ }
    }
});

// ── fixture ────────────────────────────────────────────────────────────────

const RATE_TYPE_ROW = {
    slug:        "rate",
    description: "Rate-limiting and token-budget policies",
} as const;

const NO_CREDENTIALS_TEMPLATE = {
    slug:        "no-credentials",
    type:        "rate",
    description: "Prevent credential leakage in tool outputs",
    rules:       { disallow_patterns: ["password", "api_key", "token"] },
    // Multi-value enforcement — the core invariant under test.
    enforcement: ["agent", "ci"] as string[],
} as const;

// ── tests ──────────────────────────────────────────────────────────────────

describe("PolicyTemplateStore", () => {
    it("policy template round-trips after reopen", () => {
        const dbPath = tmpDbPath();

        // ── WRITE PHASE ──────────────────────────────────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            openHandles.push(sqlite);

            // Apply migrations before any table access.
            runMigrationsOn(sqlite, db);

            // Seed the FK dependency: policy_policy_types row.
            db.insert(schema.policyTypesTable)
                .values(RATE_TYPE_ROW)
                .run();

            const store = new PolicyTemplateStore(db);
            store.create({ ...NO_CREDENTIALS_TEMPLATE });

            // Close the connection — subsequent reads must come from disk.
            sqlite.close();
            openHandles.pop(); // already closed; remove from cleanup list
        }

        // ── READ PHASE (new handle, same file) ───────────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            openHandles.push(sqlite);

            // Migrations are idempotent — safe to re-run on an existing DB.
            runMigrationsOn(sqlite, db);

            const store = new PolicyTemplateStore(db);
            const template = store.read(NO_CREDENTIALS_TEMPLATE.slug);

            // Structural identity
            expect(template.slug).toBe(NO_CREDENTIALS_TEMPLATE.slug);
            expect(template.type).toBe(NO_CREDENTIALS_TEMPLATE.type);
            expect(template.description).toBe(NO_CREDENTIALS_TEMPLATE.description);
            expect(template.version).toBe(1);
            expect(template.isSystem).toBe(false);

            // JSON column round-trip — rules object survives serialisation.
            expect(template.rules).toEqual(NO_CREDENTIALS_TEMPLATE.rules);

            // enforcement array round-trip — must be an array, not a string.
            expect(template.enforcement).toEqual([...NO_CREDENTIALS_TEMPLATE.enforcement]);
        }

        fs.unlinkSync(dbPath);
    });

    it("enforcement is stored as a JSON array, not a scalar", () => {
        const dbPath = tmpDbPath();

        // Write
        {
            const { sqlite, db } = openDb(dbPath);
            openHandles.push(sqlite);

            runMigrationsOn(sqlite, db);
            db.insert(schema.policyTypesTable).values(RATE_TYPE_ROW).run();

            const store = new PolicyTemplateStore(db);
            store.create({ ...NO_CREDENTIALS_TEMPLATE });

            sqlite.close();
            openHandles.pop();
        }

        // Read — [inv:reopen-proves-persistence]
        {
            const { sqlite, db } = openDb(dbPath);
            openHandles.push(sqlite);

            runMigrationsOn(sqlite, db);

            const store = new PolicyTemplateStore(db);
            const template = store.read(NO_CREDENTIALS_TEMPLATE.slug);

            // Must deserialise to a JS array, never a plain string.
            expect(Array.isArray(template.enforcement)).toBe(true);
            // Both mechanisms must survive the round-trip.
            expect(template.enforcement.length).toBeGreaterThanOrEqual(2);
            expect(template.enforcement).toContain("agent");
            expect(template.enforcement).toContain("ci");
        }

        fs.unlinkSync(dbPath);
    });

    it("create throws POLICY_TEMPLATE_ALREADY_EXISTS on duplicate slug", () => {
        const dbPath = tmpDbPath();
        const { sqlite, db } = openDb(dbPath);
        openHandles.push(sqlite);

        runMigrationsOn(sqlite, db);
        db.insert(schema.policyTypesTable).values(RATE_TYPE_ROW).run();

        const store = new PolicyTemplateStore(db);
        store.create({ ...NO_CREDENTIALS_TEMPLATE });

        let caught: unknown;
        try {
            store.create({ ...NO_CREDENTIALS_TEMPLATE });
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(PolicyError);
        expect((caught as PolicyError).code).toBe("POLICY_TEMPLATE_ALREADY_EXISTS");

        fs.unlinkSync(dbPath);
    });

    it("read throws POLICY_TEMPLATE_NOT_FOUND for unknown slug", () => {
        const dbPath = tmpDbPath();
        const { sqlite, db } = openDb(dbPath);
        openHandles.push(sqlite);

        runMigrationsOn(sqlite, db);

        const store = new PolicyTemplateStore(db);

        let caught: unknown;
        try {
            store.read("does-not-exist");
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(PolicyError);
        expect((caught as PolicyError).code).toBe("POLICY_TEMPLATE_NOT_FOUND");

        fs.unlinkSync(dbPath);
    });

    it("list returns all templates; typeFilter narrows by type slug", () => {
        const dbPath = tmpDbPath();
        const { sqlite, db } = openDb(dbPath);
        openHandles.push(sqlite);

        runMigrationsOn(sqlite, db);

        // Seed two policy types.
        db.insert(schema.policyTypesTable).values([
            { slug: "rate",       description: "Rate limits"  },
            { slug: "permission", description: "Permissions"  },
        ]).run();

        const store = new PolicyTemplateStore(db);
        store.create({ ...NO_CREDENTIALS_TEMPLATE, slug: "template-rate",       type: "rate"       });
        store.create({ ...NO_CREDENTIALS_TEMPLATE, slug: "template-permission",  type: "permission" });

        const all = store.list();
        expect(all).toHaveLength(2);

        const rateOnly = store.list("rate");
        expect(rateOnly).toHaveLength(1);
        expect(rateOnly[0]!.slug).toBe("template-rate");

        const permOnly = store.list("permission");
        expect(permOnly).toHaveLength(1);
        expect(permOnly[0]!.slug).toBe("template-permission");

        fs.unlinkSync(dbPath);
    });
});
