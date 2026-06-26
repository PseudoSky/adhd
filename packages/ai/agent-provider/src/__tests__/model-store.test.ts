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
import { ProviderStore, ProviderStoreError } from "../store/provider-store.js";
import * as schema from "../db/schema.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// Migrations live at packages/ai/agent-provider/drizzle/ — two levels up from __tests__
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-provider-test-"));
    dbPath = path.join(tmpDir, "test.db");
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────
// ModelStore — persistence (reopen)
// ──────────────────────────────────────────────

describe("ModelStore — persistence via close + reopen", () => {
    it("round-trips a model with all fields identical after store is closed and reopened", () => {
        const input = {
            id: "claude_opus_4_8",
            contextWindow: 200_000,
            outputLimit: 32_000,
            vision: true,
            promptCaching: true,
            extendedThinking: true,
            pricingTier: "premium",
        };

        // ── WRITE ──────────────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            const store = new ModelStore(db);
            store.create(input);
            // Explicitly close the handle — proves we're not reading cached memory
            sqlite.close();
        }

        // ── REOPEN + READ ──────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            const store = new ModelStore(db);
            const model = store.read("claude_opus_4_8");

            expect(model.id).toBe("claude_opus_4_8");
            expect(model.contextWindow).toBe(200_000);
            expect(model.outputLimit).toBe(32_000);
            expect(model.pricingTier).toBe("premium");

            // Capability flags must be JS booleans, NOT 0/1 integers
            expect(typeof model.vision).toBe("boolean");
            expect(typeof model.promptCaching).toBe("boolean");
            expect(typeof model.extendedThinking).toBe("boolean");

            expect(model.vision).toBe(true);
            expect(model.promptCaching).toBe(true);
            expect(model.extendedThinking).toBe(true);

            sqlite.close();
        }
    });

    it("stores false capability flags and reads them back as false booleans after reopen", () => {
        {
            const { sqlite, db } = openDb(dbPath);
            const store = new ModelStore(db);
            store.create({
                id: "gpt_4o_mini",
                contextWindow: 128_000,
                outputLimit: 16_384,
                vision: false,
                promptCaching: false,
                extendedThinking: false,
                pricingTier: "economy",
            });
            sqlite.close();
        }

        {
            const { sqlite, db } = openDb(dbPath);
            const store = new ModelStore(db);
            const model = store.read("gpt_4o_mini");

            expect(typeof model.vision).toBe("boolean");
            expect(typeof model.promptCaching).toBe("boolean");
            expect(typeof model.extendedThinking).toBe("boolean");

            expect(model.vision).toBe(false);
            expect(model.promptCaching).toBe(false);
            expect(model.extendedThinking).toBe(false);

            sqlite.close();
        }
    });
});

// ──────────────────────────────────────────────
// ModelStore — CRUD contract
// ──────────────────────────────────────────────

describe("ModelStore — CRUD", () => {
    it("throws MODEL_ALREADY_EXISTS on duplicate create", () => {
        const { sqlite, db } = openDb(dbPath);
        const store = new ModelStore(db);

        store.create({ id: "m1", contextWindow: 10_000, outputLimit: 2_000, pricingTier: "standard" });

        let caught: unknown;
        try {
            store.create({ id: "m1", contextWindow: 10_000, outputLimit: 2_000, pricingTier: "standard" });
        } catch (e) {
            caught = e;
        }

        expect(caught).toBeInstanceOf(ModelStoreError);
        expect((caught as ModelStoreError).code).toBe("MODEL_ALREADY_EXISTS");

        sqlite.close();
    });

    it("throws MODEL_NOT_FOUND for a missing id", () => {
        const { sqlite, db } = openDb(dbPath);
        const store = new ModelStore(db);

        let caught: unknown;
        try {
            store.read("nonexistent");
        } catch (e) {
            caught = e;
        }

        expect(caught).toBeInstanceOf(ModelStoreError);
        expect((caught as ModelStoreError).code).toBe("MODEL_NOT_FOUND");

        sqlite.close();
    });

    it("lists all inserted models", () => {
        const { sqlite, db } = openDb(dbPath);
        const store = new ModelStore(db);

        store.create({ id: "m1", contextWindow: 10_000, outputLimit: 2_000, pricingTier: "standard" });
        store.create({ id: "m2", contextWindow: 20_000, outputLimit: 4_000, pricingTier: "premium" });

        const all = store.list();
        expect(all).toHaveLength(2);
        expect(all.map(m => m.id).sort()).toEqual(["m1", "m2"]);

        sqlite.close();
    });

    it("defaults capability flags to false when not specified", () => {
        const { sqlite, db } = openDb(dbPath);
        const store = new ModelStore(db);

        store.create({ id: "m_defaults", contextWindow: 8_000, outputLimit: 1_000, pricingTier: "economy" });
        const m = store.read("m_defaults");

        expect(m.vision).toBe(false);
        expect(m.promptCaching).toBe(false);
        expect(m.extendedThinking).toBe(false);

        sqlite.close();
    });
});

// ──────────────────────────────────────────────
// ProviderStore — smoke tests
// ──────────────────────────────────────────────

describe("ProviderStore — CRUD", () => {
    it("creates and reads a provider", () => {
        const { sqlite, db } = openDb(dbPath);
        const store = new ProviderStore(db);

        const p = store.create({
            id: "anthropic",
            transport: "HTTP",
            authPattern: "bearer",
            baseUrl: "https://api.anthropic.com",
        });

        expect(p.id).toBe("anthropic");
        expect(p.transport).toBe("HTTP");
        expect(p.authPattern).toBe("bearer");
        expect(p.baseUrl).toBe("https://api.anthropic.com");
        expect(p.endpointTemplate).toBeNull();

        const read = store.read("anthropic");
        expect(read).toStrictEqual(p);

        sqlite.close();
    });

    it("creates a stdio provider with null baseUrl", () => {
        const { sqlite, db } = openDb(dbPath);
        const store = new ProviderStore(db);

        const p = store.create({ id: "claudecli", transport: "stdio", authPattern: "none" });

        expect(p.transport).toBe("stdio");
        expect(p.baseUrl).toBeNull();

        sqlite.close();
    });

    it("throws PROVIDER_ALREADY_EXISTS on duplicate", () => {
        const { sqlite, db } = openDb(dbPath);
        const store = new ProviderStore(db);

        store.create({ id: "openai", transport: "HTTP", authPattern: "bearer" });

        let caught: unknown;
        try {
            store.create({ id: "openai", transport: "HTTP", authPattern: "bearer" });
        } catch (e) {
            caught = e;
        }

        expect(caught).toBeInstanceOf(ProviderStoreError);
        expect((caught as ProviderStoreError).code).toBe("PROVIDER_ALREADY_EXISTS");

        sqlite.close();
    });

    it("throws PROVIDER_NOT_FOUND for missing id", () => {
        const { sqlite, db } = openDb(dbPath);
        const store = new ProviderStore(db);

        let caught: unknown;
        try {
            store.read("ghost");
        } catch (e) {
            caught = e;
        }

        expect(caught).toBeInstanceOf(ProviderStoreError);
        expect((caught as ProviderStoreError).code).toBe("PROVIDER_NOT_FOUND");

        sqlite.close();
    });

    it("lists all providers", () => {
        const { sqlite, db } = openDb(dbPath);
        const store = new ProviderStore(db);

        store.create({ id: "anthropic", transport: "HTTP", authPattern: "bearer" });
        store.create({ id: "lmstudio", transport: "HTTP", authPattern: "none", baseUrl: "http://localhost:1234" });

        const all = store.list();
        expect(all).toHaveLength(2);
        expect(all.map(p => p.id).sort()).toEqual(["anthropic", "lmstudio"]);

        sqlite.close();
    });
});
