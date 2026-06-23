import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runMigrationsOn } from "../db/migrate-runner.js";
import { ToolFormatStore, ToolFormatStoreError } from "../store/tool-format-store.js";
import * as schema from "../db/schema.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// Migrations live at packages/ai/agent-provider/drizzle/ — two levels up from __tests__
const migrationsFolder = path.resolve(__dirname, "../../drizzle");

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

type TestDb = BetterSQLite3Database<Record<string, never>>;

/** Open a real on-disk SQLite connection and apply all migrations. */
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-provider-tool-format-test-"));
    dbPath = path.join(tmpDir, "test.db");
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────
// ToolFormatStore — persistence (close + reopen)
// ([inv:reopen-proves-persistence])
// ──────────────────────────────────────────────

describe("ToolFormatStore — persistence via close + reopen", () => {
    it("round-trips an Anthropic web_search (server_side) row after store is closed and reopened", () => {
        // ── WRITE ──────────────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            const store = new ToolFormatStore(db);

            store.create({
                providerId: "anthropic",
                canonicalTool: "web_search",
                emitShape: "server_side",
                typeTag: "web_search_20250305",
                note: null,
            });

            // Explicitly close the handle — proves we are not reading cached memory
            sqlite.close();
        }

        // ── REOPEN + READ ──────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            const store = new ToolFormatStore(db);
            const row = store.read("anthropic", "web_search");

            expect(row.providerId).toBe("anthropic");
            expect(row.canonicalTool).toBe("web_search");
            expect(row.emitShape).toBe("server_side");
            // type_tag must survive the round-trip for server_side rows
            expect(row.typeTag).toBe("web_search_20250305");
            // note is null for server_side rows
            expect(row.note).toBeNull();

            sqlite.close();
        }
    });

    it("round-trips an Anthropic bash (unsupported) row with note set and typeTag null", () => {
        // ── WRITE ──────────────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            const store = new ToolFormatStore(db);

            store.create({
                providerId: "anthropic",
                canonicalTool: "bash",
                emitShape: "unsupported",
                typeTag: null,
                note: "Anthropic bash requires a local execution loop; not supported",
            });

            sqlite.close();
        }

        // ── REOPEN + READ ──────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            const store = new ToolFormatStore(db);
            const row = store.read("anthropic", "bash");

            expect(row.providerId).toBe("anthropic");
            expect(row.canonicalTool).toBe("bash");
            expect(row.emitShape).toBe("unsupported");
            // type_tag must be null for unsupported rows
            expect(row.typeTag).toBeNull();
            // note must survive the round-trip for unsupported rows
            expect(row.note).toBe("Anthropic bash requires a local execution loop; not supported");

            sqlite.close();
        }
    });

    it("inserts both web_search and bash rows and asserts each has the right emit_shape after reopen", () => {
        // ── WRITE BOTH ROWS ────────────────────
        {
            const { sqlite, db } = openDb(dbPath);
            const store = new ToolFormatStore(db);

            store.create({
                providerId: "anthropic",
                canonicalTool: "web_search",
                emitShape: "server_side",
                typeTag: "web_search_20250305",
            });

            store.create({
                providerId: "anthropic",
                canonicalTool: "bash",
                emitShape: "unsupported",
                note: "Anthropic bash requires a local execution loop; not supported",
            });

            sqlite.close();
        }

        // ── REOPEN AND ASSERT BOTH ─────────────
        {
            const { sqlite, db } = openDb(dbPath);
            const store = new ToolFormatStore(db);

            const webSearch = store.read("anthropic", "web_search");
            expect(webSearch.emitShape).toBe("server_side");
            // server_side row must have typeTag populated
            expect(webSearch.typeTag).toBe("web_search_20250305");
            expect(webSearch.note).toBeNull();

            const bash = store.read("anthropic", "bash");
            expect(bash.emitShape).toBe("unsupported");
            // unsupported row must NOT have a typeTag
            expect(bash.typeTag).toBeNull();
            expect(bash.note).toBeTruthy();

            sqlite.close();
        }
    });
});

// ──────────────────────────────────────────────
// ToolFormatStore — getShape helper
// ──────────────────────────────────────────────

describe("ToolFormatStore — getShape", () => {
    it("returns the ToolFormat row when one exists", () => {
        const { sqlite, db } = openDb(dbPath);
        const store = new ToolFormatStore(db);

        store.create({
            providerId: "anthropic",
            canonicalTool: "web_search",
            emitShape: "server_side",
            typeTag: "web_search_20250305",
        });

        const shape = store.getShape("anthropic", "web_search");
        expect(shape).not.toBeNull();
        expect(shape!.emitShape).toBe("server_side");
        expect(shape!.typeTag).toBe("web_search_20250305");

        sqlite.close();
    });

    it("returns null for a tool that has no registered format row", () => {
        const { sqlite, db } = openDb(dbPath);
        const store = new ToolFormatStore(db);

        const shape = store.getShape("anthropic", "unknown_tool");
        expect(shape).toBeNull();

        sqlite.close();
    });

    it("returns null for the correct provider but wrong canonical tool", () => {
        const { sqlite, db } = openDb(dbPath);
        const store = new ToolFormatStore(db);

        store.create({
            providerId: "anthropic",
            canonicalTool: "web_search",
            emitShape: "server_side",
            typeTag: "web_search_20250305",
        });

        // Same provider, different tool — must not bleed across
        const shape = store.getShape("anthropic", "bash");
        expect(shape).toBeNull();

        sqlite.close();
    });

    it("returns null for the correct tool but wrong provider", () => {
        const { sqlite, db } = openDb(dbPath);
        const store = new ToolFormatStore(db);

        store.create({
            providerId: "anthropic",
            canonicalTool: "web_search",
            emitShape: "server_side",
            typeTag: "web_search_20250305",
        });

        // Same tool, different provider — must not bleed across
        const shape = store.getShape("openai", "web_search");
        expect(shape).toBeNull();

        sqlite.close();
    });
});

// ──────────────────────────────────────────────
// ToolFormatStore — CRUD contract
// ──────────────────────────────────────────────

describe("ToolFormatStore — CRUD", () => {
    it("throws TOOL_FORMAT_ALREADY_EXISTS on duplicate create", () => {
        const { sqlite, db } = openDb(dbPath);
        const store = new ToolFormatStore(db);

        store.create({
            providerId: "anthropic",
            canonicalTool: "web_search",
            emitShape: "server_side",
            typeTag: "web_search_20250305",
        });

        let caught: unknown;
        try {
            store.create({
                providerId: "anthropic",
                canonicalTool: "web_search",
                emitShape: "server_side",
                typeTag: "web_search_20250305",
            });
        } catch (e) {
            caught = e;
        }

        expect(caught).toBeInstanceOf(ToolFormatStoreError);
        expect((caught as ToolFormatStoreError).code).toBe("TOOL_FORMAT_ALREADY_EXISTS");

        sqlite.close();
    });

    it("throws TOOL_FORMAT_NOT_FOUND for a missing (providerId, canonicalTool) pair", () => {
        const { sqlite, db } = openDb(dbPath);
        const store = new ToolFormatStore(db);

        let caught: unknown;
        try {
            store.read("anthropic", "nonexistent_tool");
        } catch (e) {
            caught = e;
        }

        expect(caught).toBeInstanceOf(ToolFormatStoreError);
        expect((caught as ToolFormatStoreError).code).toBe("TOOL_FORMAT_NOT_FOUND");

        sqlite.close();
    });

    it("allows the same canonical_tool for different providers (PK is (provider_id, canonical_tool))", () => {
        const { sqlite, db } = openDb(dbPath);
        const store = new ToolFormatStore(db);

        // Both providers can have a "web_search" format row independently
        store.create({
            providerId: "anthropic",
            canonicalTool: "web_search",
            emitShape: "server_side",
            typeTag: "web_search_20250305",
        });

        store.create({
            providerId: "openai",
            canonicalTool: "web_search",
            emitShape: "custom",
            typeTag: null,
        });

        const anthropic = store.read("anthropic", "web_search");
        const openai = store.read("openai", "web_search");

        expect(anthropic.emitShape).toBe("server_side");
        expect(openai.emitShape).toBe("custom");

        sqlite.close();
    });

    it("lists all tool format rows for a given provider", () => {
        const { sqlite, db } = openDb(dbPath);
        const store = new ToolFormatStore(db);

        store.create({ providerId: "anthropic", canonicalTool: "web_search", emitShape: "server_side", typeTag: "web_search_20250305" });
        store.create({ providerId: "anthropic", canonicalTool: "bash", emitShape: "unsupported", note: "needs local loop" });
        store.create({ providerId: "anthropic", canonicalTool: "my_custom", emitShape: "custom" });
        // Different provider — must not appear in anthropic list
        store.create({ providerId: "openai", canonicalTool: "web_search", emitShape: "custom" });

        const anthropicFormats = store.listByProvider("anthropic");
        expect(anthropicFormats).toHaveLength(3);
        expect(anthropicFormats.map(f => f.canonicalTool).sort()).toEqual(["bash", "my_custom", "web_search"]);

        const openaiFormats = store.listByProvider("openai");
        expect(openaiFormats).toHaveLength(1);
        expect(openaiFormats[0].canonicalTool).toBe("web_search");

        sqlite.close();
    });

    it("stores a custom tool with both typeTag and note as null", () => {
        const { sqlite, db } = openDb(dbPath);
        const store = new ToolFormatStore(db);

        store.create({
            providerId: "openai",
            canonicalTool: "my_tool",
            emitShape: "custom",
        });

        const row = store.read("openai", "my_tool");
        expect(row.emitShape).toBe("custom");
        expect(row.typeTag).toBeNull();
        expect(row.note).toBeNull();

        sqlite.close();
    });
});
