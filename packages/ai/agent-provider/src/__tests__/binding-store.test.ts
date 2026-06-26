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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-provider-binding-test-"));
    dbPath = path.join(tmpDir, "test.db");
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────
// [model-platform-bindings.3] Persistence via close + reopen
// Proves [inv:reopen-proves-persistence]: reads back both per-platform bindings
// after the store is CLOSED and REOPENED from the same file.
// Seed values match SEED_DATA.md §7 verbatim.
// ──────────────────────────────────────────────

describe("ModelStore.resolveModelId — persistence via close + reopen", () => {
    it("resolves claude_opus_4_8 to claude-opus-4-8 on claude_api after reopen", () => {
        // ── WRITE ──────────────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            const store = new ModelStore(db);

            // Seed the canonical model row first (logical FK target)
            store.create({
                id: "claude_opus_4_8",
                contextWindow: 200_000,
                outputLimit: 32_000,
                vision: true,
                promptCaching: true,
                pricingTier: "premium",
            });

            // Seed both platform bindings (SEED_DATA.md §7)
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

            // Explicitly close — proves we're not reading cached memory
            sqlite.close();
        }

        // ── REOPEN + READ ──────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            const store = new ModelStore(db);

            const claudeApiId = store.resolveModelId("claude_opus_4_8", "claude_api");
            expect(claudeApiId).toBe("claude-opus-4-8");

            sqlite.close();
        }
    });

    it("resolves claude_opus_4_8 to opus on claude_code after reopen", () => {
        // ── WRITE ──────────────────────────────
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

        // ── REOPEN + READ ──────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            const store = new ModelStore(db);

            const claudeCodeId = store.resolveModelId("claude_opus_4_8", "claude_code");
            expect(claudeCodeId).toBe("opus");

            sqlite.close();
        }
    });

    it("resolves BOTH platforms correctly in the same reopen session", () => {
        // Combined: both assertions in one reopen — primary positive control.
        // SEED_DATA.md §7 verbatim values.

        // ── WRITE ──────────────────────────────
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
            store.createBinding({ modelId: "claude_opus_4_8", platform: "claude_api", platformModelId: "claude-opus-4-8" });
            store.createBinding({ modelId: "claude_opus_4_8", platform: "claude_code", platformModelId: "opus" });

            sqlite.close();
        }

        // ── REOPEN + READ — both platforms ──────
        {
            const { sqlite, db } = openDb(dbPath);
            const store = new ModelStore(db);

            expect(store.resolveModelId("claude_opus_4_8", "claude_api")).toBe("claude-opus-4-8");
            expect(store.resolveModelId("claude_opus_4_8", "claude_code")).toBe("opus");

            sqlite.close();
        }
    });
});

// ──────────────────────────────────────────────
// [model-platform-bindings.4] Negative control — assertions have TEETH
// Proves the WHERE platform = ? filter gates correctly. Without it, both
// platforms would collapse to the first inserted binding — this test must
// FAIL if that filter is dropped.
// ──────────────────────────────────────────────

describe("ModelStore.resolveModelId — negative control (assertions have teeth)", () => {
    it("does NOT return the claude_api id when queried for claude_code", () => {
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
        store.createBinding({ modelId: "claude_opus_4_8", platform: "claude_api", platformModelId: "claude-opus-4-8" });
        store.createBinding({ modelId: "claude_opus_4_8", platform: "claude_code", platformModelId: "opus" });

        // Platform filter must return the correct per-platform value —
        // NOT the first inserted row ("claude-opus-4-8") for the wrong platform.
        const claudeCodeId = store.resolveModelId("claude_opus_4_8", "claude_code");
        expect(claudeCodeId).not.toBe("claude-opus-4-8");
        expect(claudeCodeId).toBe("opus");

        sqlite.close();
    });

    it("does NOT return the claude_code alias when queried for claude_api", () => {
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
        // Seed claude_code first to ensure ordering doesn't hide a missing filter
        store.createBinding({ modelId: "claude_opus_4_8", platform: "claude_code", platformModelId: "opus" });
        store.createBinding({ modelId: "claude_opus_4_8", platform: "claude_api", platformModelId: "claude-opus-4-8" });

        const claudeApiId = store.resolveModelId("claude_opus_4_8", "claude_api");
        expect(claudeApiId).not.toBe("opus");
        expect(claudeApiId).toBe("claude-opus-4-8");

        sqlite.close();
    });

    it("throws MODEL_BINDING_NOT_FOUND for an unknown platform", () => {
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
        store.createBinding({ modelId: "claude_opus_4_8", platform: "claude_api", platformModelId: "claude-opus-4-8" });

        let caught: unknown;
        try {
            store.resolveModelId("claude_opus_4_8", "bedrock");
        } catch (e) {
            caught = e;
        }

        expect(caught).toBeInstanceOf(ModelStoreError);
        expect((caught as ModelStoreError).code).toBe("MODEL_BINDING_NOT_FOUND");

        sqlite.close();
    });

    it("throws MODEL_BINDING_NOT_FOUND for an unknown model id", () => {
        const { sqlite, db } = openDb(dbPath);
        const store = new ModelStore(db);

        let caught: unknown;
        try {
            store.resolveModelId("nonexistent_model", "claude_api");
        } catch (e) {
            caught = e;
        }

        expect(caught).toBeInstanceOf(ModelStoreError);
        expect((caught as ModelStoreError).code).toBe("MODEL_BINDING_NOT_FOUND");

        sqlite.close();
    });
});

// ──────────────────────────────────────────────
// [model-platform-bindings.1] Schema — table is present and queryable
// ──────────────────────────────────────────────

describe("model_platform_bindings table — schema presence", () => {
    it("creates binding rows and lists them back without a reopen", () => {
        const { sqlite, db } = openDb(dbPath);
        const store = new ModelStore(db);

        store.create({
            id: "claude_sonnet_4_6",
            contextWindow: 200_000,
            outputLimit: 8_192,
            vision: true,
            promptCaching: true,
            pricingTier: "standard",
        });

        const b = store.createBinding({
            modelId: "claude_sonnet_4_6",
            platform: "claude_api",
            platformModelId: "claude-sonnet-4-6",
        });

        expect(b.modelId).toBe("claude_sonnet_4_6");
        expect(b.platform).toBe("claude_api");
        expect(b.platformModelId).toBe("claude-sonnet-4-6");

        sqlite.close();
    });
});
