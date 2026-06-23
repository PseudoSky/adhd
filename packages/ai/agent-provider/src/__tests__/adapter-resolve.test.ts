/**
 * adapter-resolve.test.ts
 *
 * Guard for [provider-adapter-contract.3]: the adapter resolves a canonical
 * model id through the binding table to the correct per-platform string.
 *
 * Tests drive the REAL ProviderAdapterImpl against a REAL on-disk SQLite DB
 * (migrations applied, real binding data seeded) — no mocks.
 *
 * [inv:reopen-proves-persistence] is honoured: the DB handle is CLOSED after
 * seeding and REOPENED before the adapter is constructed, so we prove the
 * binding survives disk persistence, not just an in-memory write.
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runMigrationsOn } from "../db/migrate-runner.js";
import { ModelStore, ModelStoreError } from "../store/model-store.js";
import { ProviderAdapterImpl } from "../adapter/provider-adapter.js";
import * as schema from "../db/schema.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// Migrations live two levels up from __tests/
const migrationsFolder = path.resolve(__dirname, "../../drizzle");

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

type TestDb = BetterSQLite3Database<Record<string, never>>;

/** Open a real on-disk SQLite connection and apply migrations. */
function openDb(dbPath: string): { sqlite: Database.Database; db: TestDb } {
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = drizzle(sqlite, { schema }) as any as TestDb;
    runMigrationsOn(sqlite, db, migrationsFolder);
    return { sqlite, db };
}

// ──────────────────────────────────────────────
// Test state
// ──────────────────────────────────────────────

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-provider-adapter-test-"));
    dbPath = path.join(tmpDir, "test.db");
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────
// [provider-adapter-contract.3] — model resolution through binding table
// ──────────────────────────────────────────────

describe("ProviderAdapterImpl — resolves model id through binding table", () => {
    it("resolves claude_opus_4_8 to claude-opus-4-8 on claude_api after DB close+reopen", () => {
        // ── SEED (DB open) ──────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            const store = new ModelStore(db);

            store.create({
                id: "claude_opus_4_8",
                contextWindow: 200_000,
                outputLimit: 32_000,
                vision: true,
                promptCaching: true,
                pricingTier: "premium",
            });

            // Seed two bindings so the WHERE platform=? filter is exercised
            store.createBinding({
                modelId: "claude_opus_4_8",
                platform: "claude_api",
                platformModelId: "claude-opus-4-8",
            });
            store.createBinding({
                modelId: "claude_opus_4_8",
                platform: "claude_code",
                platformModelId: "opus",
            });

            // Close the handle — proves persistence on disk, not in-memory
            sqlite.close();
        }

        // ── REOPEN + ASSERT ─────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            const store = new ModelStore(db);
            const adapter = new ProviderAdapterImpl(store, "claude_api");

            // Convenience method asserts resolution via the binding table
            const resolved = adapter.resolveModelId("claude_opus_4_8");
            expect(resolved).toBe("claude-opus-4-8");

            sqlite.close();
        }
    });

    it("resolves to the correct per-platform id — claude_code platform returns opus", () => {
        // ── SEED ────────────────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            const store = new ModelStore(db);

            store.create({
                id: "claude_opus_4_8",
                contextWindow: 200_000,
                outputLimit: 32_000,
                pricingTier: "premium",
            });
            store.createBinding({
                modelId: "claude_opus_4_8",
                platform: "claude_api",
                platformModelId: "claude-opus-4-8",
            });
            store.createBinding({
                modelId: "claude_opus_4_8",
                platform: "claude_code",
                platformModelId: "opus",
            });

            sqlite.close();
        }

        // ── REOPEN + ASSERT ─────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            const store = new ModelStore(db);

            // claude_code adapter must NOT return the claude_api id
            const adapter = new ProviderAdapterImpl(store, "claude_code");
            const resolved = adapter.resolveModelId("claude_opus_4_8");
            expect(resolved).toBe("opus");
            expect(resolved).not.toBe("claude-opus-4-8");

            sqlite.close();
        }
    });

    it("stream() yields the resolved model id as the first text chunk", async () => {
        // ── SEED ────────────────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            const store = new ModelStore(db);

            store.create({
                id: "claude_opus_4_8",
                contextWindow: 200_000,
                outputLimit: 32_000,
                pricingTier: "premium",
            });
            store.createBinding({
                modelId: "claude_opus_4_8",
                platform: "claude_api",
                platformModelId: "claude-opus-4-8",
            });

            sqlite.close();
        }

        // ── REOPEN + ASSERT via stream ───────────
        {
            const { sqlite, db } = openDb(dbPath);
            const store = new ModelStore(db);
            const adapter = new ProviderAdapterImpl(store, "claude_api");

            const chunks: Array<{ type: string; text?: string }> = [];
            for await (const chunk of adapter.stream([], undefined, "claude_opus_4_8")) {
                chunks.push(chunk);
            }

            expect(chunks.length).toBeGreaterThan(0);
            const firstChunk = chunks[0];
            expect(firstChunk.type).toBe("text");
            // The stream surface-exposes the resolved id — proves contract end-to-end
            expect((firstChunk as { type: "text"; text: string }).text).toBe("claude-opus-4-8");

            sqlite.close();
        }
    });

    it("throws MODEL_BINDING_NOT_FOUND for an unknown (model, platform) pair", () => {
        // Negative-control: adapter must fail loudly, never silently resolve
        const { sqlite, db } = openDb(dbPath);
        const store = new ModelStore(db);

        store.create({
            id: "claude_opus_4_8",
            contextWindow: 200_000,
            outputLimit: 32_000,
            pricingTier: "premium",
        });
        // Intentionally NO binding seeded for "nonexistent_platform"

        const adapter = new ProviderAdapterImpl(store, "nonexistent_platform");

        expect(() => adapter.resolveModelId("claude_opus_4_8")).toThrow(ModelStoreError);
        // ModelStoreError carries the code in err.code, not in the message —
        // assert via the thrown instance directly.
        let caught: unknown;
        try {
            adapter.resolveModelId("claude_opus_4_8");
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(ModelStoreError);
        expect((caught as ModelStoreError).code).toBe("MODEL_BINDING_NOT_FOUND");

        sqlite.close();
    });
});
