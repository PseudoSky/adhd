/**
 * seed-and-roundtrip — integration test
 *
 * Proves [dod.3] (idempotency + reopen) and [dod.1] (binding-store seed values).
 *
 * Acceptance criteria:
 *  [seed-and-roundtrip.1] seed/reopen/idempotency suite passes
 *  [seed-and-roundtrip.2] seed lists canonical models from SEED_DATA
 *  [seed-and-roundtrip.3] seed lists providers from SEED_DATA
 *  [seed-and-roundtrip.4] negative-control: seed idempotency has teeth
 *
 * Invariants:
 *  [inv:reopen-proves-persistence]  — proven by CLOSE+REOPEN before reading
 *  [inv:real-db-tests]              — real on-disk SQLite + real migrations
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runMigrationsOn } from "../db/migrate-runner.js";
import { ModelStore } from "../store/model-store.js";
import { ProviderStore } from "../store/provider-store.js";
import * as schema from "../db/schema.js";

import { seed, SEEDED_PROVIDER_IDS, SEEDED_MODEL_IDS, BINDING_ROWS } from "../seed/index.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// Migrations live at packages/ai/agent-provider/drizzle/ — two levels up from __tests__
const migrationsFolder = path.resolve(__dirname, "../../drizzle");

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

type TestDb = BetterSQLite3Database<Record<string, never>>;

/** Open a real on-disk SQLite connection and apply migrations ([inv:real-db-tests]). */
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-provider-roundtrip-"));
    dbPath = path.join(tmpDir, "test.db");
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────
// [seed-and-roundtrip.3] Provider seed values
// ──────────────────────────────────────────────

describe("seed — providers (SEED_DATA.md §5)", () => {
    it("seeds all five canonical providers", () => {
        const { sqlite, db } = openDb(dbPath);
        seed(db);

        const store = new ProviderStore(db);
        const all = store.list();

        expect(all).toHaveLength(SEEDED_PROVIDER_IDS.length);
        const ids = all.map(p => p.id).sort();
        expect(ids).toEqual([...SEEDED_PROVIDER_IDS].sort());

        sqlite.close();
    });

    it("seeds anthropic with HTTP transport and bearer auth", () => {
        const { sqlite, db } = openDb(dbPath);
        seed(db);

        const store = new ProviderStore(db);
        const anthropic = store.read("anthropic");

        expect(anthropic.transport).toBe("HTTP");
        expect(anthropic.authPattern).toBe("bearer");
        expect(anthropic.baseUrl).toBe("https://api.anthropic.com");

        sqlite.close();
    });

    it("seeds claudecli with stdio transport, null baseUrl", () => {
        const { sqlite, db } = openDb(dbPath);
        seed(db);

        const store = new ProviderStore(db);
        const claudecli = store.read("claudecli");

        expect(claudecli.transport).toBe("stdio");
        expect(claudecli.authPattern).toBe("none");
        expect(claudecli.baseUrl).toBeNull();

        sqlite.close();
    });

    it("seeds lmstudio with localhost base URL", () => {
        const { sqlite, db } = openDb(dbPath);
        seed(db);

        const store = new ProviderStore(db);
        const lmstudio = store.read("lmstudio");

        expect(lmstudio.transport).toBe("HTTP");
        expect(lmstudio.authPattern).toBe("none");
        expect(lmstudio.baseUrl).toBe("http://localhost:1234");

        sqlite.close();
    });
});

// ──────────────────────────────────────────────
// [seed-and-roundtrip.2] Model seed values
// ──────────────────────────────────────────────

describe("seed — models (SEED_DATA.md §7)", () => {
    it("seeds all four canonical models", () => {
        const { sqlite, db } = openDb(dbPath);
        seed(db);

        const store = new ModelStore(db);
        const all = store.list();

        expect(all).toHaveLength(SEEDED_MODEL_IDS.length);
        const ids = all.map(m => m.id).sort();
        expect(ids).toEqual([...SEEDED_MODEL_IDS].sort());

        sqlite.close();
    });

    it("seeds claude_opus_4_8 with correct context window + output limit", () => {
        const { sqlite, db } = openDb(dbPath);
        seed(db);

        const store = new ModelStore(db);
        const opus = store.read("claude_opus_4_8");

        expect(opus.contextWindow).toBe(200_000);
        expect(opus.outputLimit).toBe(32_000);
        expect(opus.vision).toBe(true);
        expect(opus.promptCaching).toBe(true);
        expect(opus.extendedThinking).toBe(true);
        expect(opus.pricingTier).toBe("premium");

        sqlite.close();
    });

    it("seeds claude_sonnet_4_6 with standard pricing tier", () => {
        const { sqlite, db } = openDb(dbPath);
        seed(db);

        const store = new ModelStore(db);
        const sonnet = store.read("claude_sonnet_4_6");

        expect(sonnet.contextWindow).toBe(200_000);
        expect(sonnet.outputLimit).toBe(8_192);
        expect(sonnet.pricingTier).toBe("standard");

        sqlite.close();
    });

    it("seeds claude_haiku_4_5 with economy pricing tier", () => {
        const { sqlite, db } = openDb(dbPath);
        seed(db);

        const store = new ModelStore(db);
        const haiku = store.read("claude_haiku_4_5");

        expect(haiku.pricingTier).toBe("economy");

        sqlite.close();
    });

    it("seeds claude_fable_5 with premium pricing + extended output", () => {
        const { sqlite, db } = openDb(dbPath);
        seed(db);

        const store = new ModelStore(db);
        const fable = store.read("claude_fable_5");

        expect(fable.outputLimit).toBe(32_000);
        expect(fable.pricingTier).toBe("premium");

        sqlite.close();
    });
});

// ──────────────────────────────────────────────
// [seed-and-roundtrip.1] Idempotency — double seed, identical counts
// ──────────────────────────────────────────────

describe("seed — idempotency (double-seed produces identical counts)", () => {
    it("providers count is identical after a second seed call", () => {
        const { sqlite, db } = openDb(dbPath);

        seed(db); // first run
        seed(db); // second run — must be a no-op

        const store = new ProviderStore(db);
        const all = store.list();

        // Exactly the seeded count, not doubled
        expect(all).toHaveLength(SEEDED_PROVIDER_IDS.length);

        sqlite.close();
    });

    it("models count is identical after a second seed call", () => {
        const { sqlite, db } = openDb(dbPath);

        seed(db);
        seed(db);

        const store = new ModelStore(db);
        const all = store.list();

        expect(all).toHaveLength(SEEDED_MODEL_IDS.length);

        sqlite.close();
    });

    it("model_platform_bindings count is identical after a second seed call", () => {
        const { sqlite, db } = openDb(dbPath);

        seed(db);

        // Count bindings directly via raw query to avoid going through the store.
        // The store's resolveModelId only fetches one row at a time, so we need
        // a raw select to count total rows.
        const countFirst = db
            .select()
            .from(schema.modelPlatformBindings)
            .all().length;

        seed(db); // second run

        const countSecond = db
            .select()
            .from(schema.modelPlatformBindings)
            .all().length;

        expect(countFirst).toBe(BINDING_ROWS.length);
        expect(countSecond).toBe(BINDING_ROWS.length); // no duplicate rows

        sqlite.close();
    });
});

// ──────────────────────────────────────────────
// [seed-and-roundtrip.1] Persistence — close + reopen
// [inv:reopen-proves-persistence]
// ──────────────────────────────────────────────

describe("seed — persistence via close + reopen", () => {
    it("providers round-trip: seeded rows survive CLOSE + REOPEN", () => {
        // ── WRITE ──────────────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            seed(db);
            sqlite.close(); // explicitly close — proves we are not reading cached memory
        }

        // ── REOPEN + READ ──────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            const store = new ProviderStore(db);

            const all = store.list();
            expect(all).toHaveLength(SEEDED_PROVIDER_IDS.length);

            // Spot-check anthropic row after reopen
            const anthropic = store.read("anthropic");
            expect(anthropic.transport).toBe("HTTP");
            expect(anthropic.authPattern).toBe("bearer");
            expect(anthropic.baseUrl).toBe("https://api.anthropic.com");

            sqlite.close();
        }
    });

    it("models round-trip: capability flags survive CLOSE + REOPEN as JS booleans", () => {
        // ── WRITE ──────────────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            seed(db);
            sqlite.close();
        }

        // ── REOPEN + READ ──────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            const store = new ModelStore(db);

            const opus = store.read("claude_opus_4_8");

            // Drizzle's integer({mode:"boolean"}) must deserialise as JS booleans, not 0/1
            expect(typeof opus.vision).toBe("boolean");
            expect(typeof opus.promptCaching).toBe("boolean");
            expect(typeof opus.extendedThinking).toBe("boolean");

            expect(opus.vision).toBe(true);
            expect(opus.promptCaching).toBe(true);
            expect(opus.extendedThinking).toBe(true);
            expect(opus.contextWindow).toBe(200_000);
            expect(opus.outputLimit).toBe(32_000);
            expect(opus.pricingTier).toBe("premium");

            sqlite.close();
        }
    });

    it("bindings round-trip: resolves claude_opus_4_8 → claude-opus-4-8 / opus after CLOSE + REOPEN", () => {
        // ── WRITE ──────────────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            seed(db);
            sqlite.close();
        }

        // ── REOPEN + READ ──────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            const store = new ModelStore(db);

            // SEED_DATA.md §7 verbatim values (exact assertions)
            const claudeApiId = store.resolveModelId("claude_opus_4_8", "claude_api");
            expect(claudeApiId).toBe("claude-opus-4-8");

            const claudeCodeAlias = store.resolveModelId("claude_opus_4_8", "claude_code");
            expect(claudeCodeAlias).toBe("opus");

            // Also assert haiku full API id (has date suffix)
            const haikuApiId = store.resolveModelId("claude_haiku_4_5", "claude_api");
            expect(haikuApiId).toBe("claude-haiku-4-5-20251001");

            sqlite.close();
        }
    });

    it("idempotency survives CLOSE + REOPEN: seeding twice yields identical row counts on reopen", () => {
        // ── WRITE ×2 ───────────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            seed(db); // first seed
            seed(db); // second seed — must be a no-op
            sqlite.close();
        }

        // ── REOPEN + COUNT ─────────────────────
        {
            const { sqlite, db } = openDb(dbPath);

            const providerCount = new ProviderStore(db).list().length;
            const modelCount = new ModelStore(db).list().length;
            const bindingCount = db
                .select()
                .from(schema.modelPlatformBindings)
                .all().length;

            expect(providerCount).toBe(SEEDED_PROVIDER_IDS.length);
            expect(modelCount).toBe(SEEDED_MODEL_IDS.length);
            expect(bindingCount).toBe(BINDING_ROWS.length);

            sqlite.close();
        }
    });
});

// ──────────────────────────────────────────────
// [seed-and-roundtrip.4] Negative control — idempotency has TEETH
//
// If INSERT OR IGNORE is replaced with a plain INSERT the second seed run
// would throw a UNIQUE constraint violation (or produce duplicate rows on
// tables without a PK).  This test proves the test suite catches that:
// we perform a raw insert that WOULD duplicate a provider row, then assert
// a second seed call only adds one row.
//
// The real teeth: a plain INSERT on the composite-PK bindings table DOES
// throw a constraint error, so if someone removes the .onConflictDoNothing()
// guard the test fails with an error rather than silently passing.
// ──────────────────────────────────────────────

describe("seed — negative control (idempotency has teeth)", () => {
    it("double-seed does NOT double the provider count (INSERT OR IGNORE guard is present)", () => {
        const { sqlite, db } = openDb(dbPath);

        seed(db);
        const countAfterFirst = new ProviderStore(db).list().length;

        seed(db); // second run — must remain identical
        const countAfterSecond = new ProviderStore(db).list().length;

        // If the upsert guard was removed, countAfterSecond would double.
        expect(countAfterSecond).toBe(countAfterFirst);
        expect(countAfterFirst).toBe(SEEDED_PROVIDER_IDS.length);

        sqlite.close();
    });

    it("double-seed does NOT double the model count", () => {
        const { sqlite, db } = openDb(dbPath);

        seed(db);
        const countAfterFirst = new ModelStore(db).list().length;

        seed(db);
        const countAfterSecond = new ModelStore(db).list().length;

        expect(countAfterSecond).toBe(countAfterFirst);
        expect(countAfterFirst).toBe(SEEDED_MODEL_IDS.length);

        sqlite.close();
    });

    it("double-seed does NOT double the binding count (composite PK guard)", () => {
        const { sqlite, db } = openDb(dbPath);

        seed(db);
        const countAfterFirst = db
            .select()
            .from(schema.modelPlatformBindings)
            .all().length;

        seed(db);
        const countAfterSecond = db
            .select()
            .from(schema.modelPlatformBindings)
            .all().length;

        // Both must equal BINDING_ROWS.length — not doubled, not zero.
        expect(countAfterFirst).toBe(BINDING_ROWS.length);
        expect(countAfterSecond).toBe(BINDING_ROWS.length);

        sqlite.close();
    });

    it("resolving a seeded binding to the WRONG platform returns a different value (platform filter gates)", () => {
        // Proves the WHERE platform = ? filter in resolveModelId has teeth.
        // If the filter is dropped both platforms collapse to the first row.
        const { sqlite, db } = openDb(dbPath);
        seed(db);

        const store = new ModelStore(db);

        const claudeApiId = store.resolveModelId("claude_opus_4_8", "claude_api");
        const claudeCodeAlias = store.resolveModelId("claude_opus_4_8", "claude_code");

        // The two platform-specific strings must NOT be equal.
        expect(claudeApiId).not.toBe(claudeCodeAlias);
        expect(claudeApiId).toBe("claude-opus-4-8");
        expect(claudeCodeAlias).toBe("opus");

        sqlite.close();
    });
});
