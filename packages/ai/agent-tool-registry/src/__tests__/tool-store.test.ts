import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMigrationsOn } from "../db/migrate-runner.js";
import * as schema from "../db/schema.js";
import { ToolStore } from "../store/tool-store.js";
import type { ToolStoreErrorCode } from "../store/tool-store.js";
import { ToolStoreError } from "../store/tool-store.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// Path to the generated drizzle migrations folder relative to this test file.
const migrationsFolder = path.resolve(__dirname, "../../drizzle");

// ──────────────────────────────────────────────
// Test-db helpers
// ──────────────────────────────────────────────

/** Open a better-sqlite3 handle + drizzle wrapper at the given path and apply migrations. */
function openDb(dbPath: string) {
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite, { schema });
    runMigrationsOn(sqlite, db, migrationsFolder);
    return { sqlite, db };
}

/** Close the better-sqlite3 handle. Returns the path so callers can reopen. */
function closeDb(sqlite: InstanceType<typeof Database>): void {
    sqlite.close();
}

// ──────────────────────────────────────────────
// Error assertion helper
// ──────────────────────────────────────────────

function expectToolStoreError(fn: () => unknown, code: ToolStoreErrorCode): void {
    try {
        fn();
        expect.fail(`Expected a ToolStoreError with code '${code}' to be thrown`);
    } catch (err: unknown) {
        expect(err).toBeInstanceOf(ToolStoreError);
        expect((err as ToolStoreError).code).toBe(code);
    }
}

// ──────────────────────────────────────────────
// Test fixtures
// ──────────────────────────────────────────────

const IO_TYPE = { slug: "io", description: "File and stream I/O operations" };
const COMPUTE_TYPE = { slug: "compute", description: "Computation and processing" };

const SHELL_EXEC_INPUT = {
    name: "shell_exec",
    type: "io",
    description: "Execute shell commands",
    requiresApproval: true,
    isDestructive: true,
    dependencyToolIds: [],
    capabilities: ["exec", "shell"],
};

const FILE_READ_INPUT = {
    name: "file_read",
    type: "io",
    description: "Read file contents",
    requiresApproval: false,
    isDestructive: false,
    dependencyToolIds: [],
    capabilities: ["read", "fs"],
};

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("ToolStore — tool_types (lookup table, never enum)", () => {
    let tmpDir: string;
    let dbPath: string;
    let sqlite: InstanceType<typeof Database>;
    let store: ToolStore;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tool-registry-test-"));
        dbPath = path.join(tmpDir, "registry.db");
        const { sqlite: s, db } = openDb(dbPath);
        sqlite = s;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        store = new ToolStore(db as any);
    });

    afterEach(() => {
        try { closeDb(sqlite); } catch { /* already closed */ }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("seeds a tool type and reads it back", () => {
        store.seedToolType(IO_TYPE);
        const types = store.listToolTypes();
        expect(types).toHaveLength(1);
        expect(types[0]).toEqual(IO_TYPE);
    });

    it("seeds all 8 canonical tool types", () => {
        const allTypes = [
            { slug: "io",       description: "File and stream I/O operations" },
            { slug: "compute",  description: "Computation and processing" },
            { slug: "network",  description: "Network and HTTP operations" },
            { slug: "memory",   description: "Memory and state management" },
            { slug: "ui",       description: "User interface interactions" },
            { slug: "meta",     description: "Meta-level agent operations" },
            { slug: "lsp",      description: "Language server protocol operations" },
            { slug: "notebook", description: "Notebook and REPL operations" },
        ];
        for (const t of allTypes) store.seedToolType(t);
        const listed = store.listToolTypes();
        expect(listed).toHaveLength(8);
        const slugs = listed.map(t => t.slug).sort();
        expect(slugs).toEqual(["compute","io","lsp","memory","meta","network","notebook","ui"]);
    });

    it("seedToolType is idempotent (onConflictDoNothing)", () => {
        store.seedToolType(IO_TYPE);
        // Seeding again must not throw and must not duplicate the row.
        store.seedToolType(IO_TYPE);
        expect(store.listToolTypes()).toHaveLength(1);
    });
});

describe("ToolStore — tools table", () => {
    let tmpDir: string;
    let dbPath: string;
    let sqlite: InstanceType<typeof Database>;
    let store: ToolStore;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tool-registry-test-"));
        dbPath = path.join(tmpDir, "registry.db");
        const { sqlite: s, db } = openDb(dbPath);
        sqlite = s;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        store = new ToolStore(db as any);
        // Seed the lookup table so FK constraints are satisfied.
        store.seedToolType(IO_TYPE);
        store.seedToolType(COMPUTE_TYPE);
    });

    afterEach(() => {
        try { closeDb(sqlite); } catch { /* already closed */ }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("creates a tool with defaults and reads it back in-session", () => {
        // Use "io" which is seeded in beforeEach.
        const tool = store.create({ name: "file_stat", type: "io", description: "Stat a file path" });
        expect(tool.name).toBe("file_stat");
        expect(tool.version).toBe(1);
        expect(tool.requiresApproval).toBe(false);
        expect(tool.isDestructive).toBe(false);
        expect(tool.dependencyToolIds).toEqual([]);
        expect(tool.capabilities).toEqual([]);
    });

    it("creates a tool with all fields and reads it back in-session", () => {
        const tool = store.create(SHELL_EXEC_INPUT);
        expect(tool).toMatchObject({
            name: "shell_exec",
            type: "io",
            description: "Execute shell commands",
            version: 1,
            requiresApproval: true,
            isDestructive: true,
            dependencyToolIds: [],
            capabilities: ["exec", "shell"],
        });
    });

    it("throws TOOL_ALREADY_EXISTS on duplicate create", () => {
        store.create(SHELL_EXEC_INPUT);
        expectToolStoreError(
            () => store.create(SHELL_EXEC_INPUT),
            "TOOL_ALREADY_EXISTS"
        );
    });

    it("throws TOOL_NOT_FOUND when reading a missing tool", () => {
        expectToolStoreError(
            () => store.read("nonexistent"),
            "TOOL_NOT_FOUND"
        );
    });

    it("list() returns all created tools", () => {
        store.create(SHELL_EXEC_INPUT);
        store.create(FILE_READ_INPUT);
        const all = store.list();
        expect(all).toHaveLength(2);
        const names = all.map(t => t.name).sort();
        expect(names).toEqual(["file_read", "shell_exec"]);
    });

    it("preserves boolean false values (not coerced to truthy)", () => {
        store.create(FILE_READ_INPUT);
        const tool = store.read("file_read");
        // SQLite stores booleans as 0/1; drizzle mode:'boolean' must return JS false
        expect(tool.requiresApproval).toBe(false);
        expect(tool.isDestructive).toBe(false);
    });

    it("preserves boolean true values", () => {
        store.create(SHELL_EXEC_INPUT);
        const tool = store.read("shell_exec");
        expect(tool.requiresApproval).toBe(true);
        expect(tool.isDestructive).toBe(true);
    });
});

// ──────────────────────────────────────────────
// [inv:reopen-proves-persistence] — THE critical test
//
// Creates a tool, CLOSES the better-sqlite3 handle, REOPENS from the same
// on-disk path, and asserts the full row round-trips correctly — including
// JSON arrays and boolean flags. This proves the store writes to disk, not
// just in-memory state.
// ──────────────────────────────────────────────
describe("ToolStore — persistence (close + reopen proves disk write)", () => {
    let tmpDir: string;
    let dbPath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tool-registry-persist-"));
        dbPath = path.join(tmpDir, "registry.db");
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("[inv:reopen-proves-persistence] shell_exec round-trips through a close+reopen", () => {
        // ── Write phase ──────────────────────────────────────────────────────
        const { sqlite: sqlite1, db: db1 } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store1 = new ToolStore(db1 as any);
        store1.seedToolType(IO_TYPE);
        const written = store1.create(SHELL_EXEC_INPUT);

        // Close the handle — this flushes WAL and releases the file lock.
        closeDb(sqlite1);

        // ── Reopen phase ─────────────────────────────────────────────────────
        // A brand-new connection to the same on-disk path.
        const { sqlite: sqlite2, db: db2 } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store2 = new ToolStore(db2 as any);

        const readBack = store2.read("shell_exec");

        // The row must match the written record exactly.
        expect(readBack).toEqual(written);

        // Each field individually for maximum failure signal if one regresses:
        expect(readBack.name).toBe("shell_exec");
        expect(readBack.type).toBe("io");
        expect(readBack.description).toBe("Execute shell commands");
        expect(readBack.version).toBe(1);
        expect(readBack.requiresApproval).toBe(true);
        expect(readBack.isDestructive).toBe(true);
        // JSON arrays must survive the round-trip as JS arrays, not strings.
        expect(readBack.dependencyToolIds).toEqual([]);
        expect(readBack.capabilities).toEqual(["exec", "shell"]);

        closeDb(sqlite2);
    });

    it("[inv:reopen-proves-persistence] tool_types rows survive a close+reopen", () => {
        // ── Write phase ──────────────────────────────────────────────────────
        const { sqlite: sqlite1, db: db1 } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store1 = new ToolStore(db1 as any);
        store1.seedToolType(IO_TYPE);
        store1.seedToolType(COMPUTE_TYPE);
        closeDb(sqlite1);

        // ── Reopen phase ─────────────────────────────────────────────────────
        const { sqlite: sqlite2, db: db2 } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store2 = new ToolStore(db2 as any);
        const types = store2.listToolTypes();

        expect(types).toHaveLength(2);
        const slugs = types.map(t => t.slug).sort();
        expect(slugs).toEqual(["compute", "io"]);

        closeDb(sqlite2);
    });

    it("[inv:reopen-proves-persistence] list() after reopen returns all created tools", () => {
        // ── Write phase ──────────────────────────────────────────────────────
        const { sqlite: sqlite1, db: db1 } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store1 = new ToolStore(db1 as any);
        store1.seedToolType(IO_TYPE);
        store1.create(SHELL_EXEC_INPUT);
        store1.create(FILE_READ_INPUT);
        closeDb(sqlite1);

        // ── Reopen phase ─────────────────────────────────────────────────────
        const { sqlite: sqlite2, db: db2 } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store2 = new ToolStore(db2 as any);
        const all = store2.list();

        expect(all).toHaveLength(2);
        const byName = Object.fromEntries(all.map(t => [t.name, t]));

        expect(byName["shell_exec"]!.requiresApproval).toBe(true);
        expect(byName["shell_exec"]!.capabilities).toEqual(["exec", "shell"]);
        expect(byName["file_read"]!.requiresApproval).toBe(false);

        closeDb(sqlite2);
    });
});
