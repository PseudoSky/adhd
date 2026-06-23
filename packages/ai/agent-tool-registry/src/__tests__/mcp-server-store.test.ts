import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMigrationsOn } from "../db/migrate-runner.js";
import * as schema from "../db/schema.js";
import { McpServerStore, McpServerStoreError } from "../store/mcp-server-store.js";
import type { McpServerStoreErrorCode } from "../store/mcp-server-store.js";

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

/** Close the better-sqlite3 handle. */
function closeDb(sqlite: InstanceType<typeof Database>): void {
    sqlite.close();
}

// ──────────────────────────────────────────────
// Error assertion helper
// ──────────────────────────────────────────────

function expectMcpServerStoreError(fn: () => unknown, code: McpServerStoreErrorCode): void {
    try {
        fn();
        expect.fail(`Expected a McpServerStoreError with code '${code}' to be thrown`);
    } catch (err: unknown) {
        expect(err).toBeInstanceOf(McpServerStoreError);
        expect((err as McpServerStoreError).code).toBe(code);
    }
}

// ──────────────────────────────────────────────
// Test fixtures
// ──────────────────────────────────────────────

// A non-trivial config_schema (JSON-Schema) to prove round-trip fidelity.
const FILESYSTEM_CONFIG_SCHEMA = {
    type: "object",
    required: ["roots"],
    properties: {
        roots: {
            type: "array",
            items: { type: "string" },
            description: "Allowed root directories",
        },
        readOnly: {
            type: "boolean",
            default: false,
        },
    },
    additionalProperties: false,
} as const;

const FS_SERVER_INPUT = {
    id: "@modelcontextprotocol/server-filesystem",
    transport: "stdio",
    name: "Filesystem MCP Server",
    providedToolIds: ["file_read", "file_write", "file_list"],
    configSchema: FILESYSTEM_CONFIG_SCHEMA as Record<string, unknown>,
};

const WEB_SERVER_INPUT = {
    id: "@modelcontextprotocol/server-fetch",
    transport: "SSE",
    name: "Web Fetch MCP Server",
    providedToolIds: ["web_fetch", "web_search"],
    configSchema: {
        type: "object",
        properties: {
            baseUrl: { type: "string", format: "uri" },
            timeout: { type: "integer", minimum: 1000 },
        },
    } as Record<string, unknown>,
};

// ──────────────────────────────────────────────
// Basic CRUD tests
// ──────────────────────────────────────────────

describe("McpServerStore — create / read / list", () => {
    let tmpDir: string;
    let dbPath: string;
    let sqlite: InstanceType<typeof Database>;
    let store: McpServerStore;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tool-registry-mcp-"));
        dbPath = path.join(tmpDir, "registry.db");
        const { sqlite: s, db } = openDb(dbPath);
        sqlite = s;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        store = new McpServerStore(db as any);
    });

    afterEach(() => {
        try { closeDb(sqlite); } catch { /* already closed */ }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("creates a server with all fields and reads it back in-session", () => {
        const server = store.create(FS_SERVER_INPUT);
        expect(server.id).toBe("@modelcontextprotocol/server-filesystem");
        expect(server.transport).toBe("stdio");
        expect(server.name).toBe("Filesystem MCP Server");
        expect(server.providedToolIds).toEqual(["file_read", "file_write", "file_list"]);
        expect(server.configSchema).toEqual(FILESYSTEM_CONFIG_SCHEMA);
    });

    it("creates a server with defaults (empty arrays/object) and reads it back", () => {
        const server = store.create({
            id: "minimal-server",
            transport: "HTTP",
            name: "Minimal Server",
        });
        expect(server.providedToolIds).toEqual([]);
        expect(server.configSchema).toEqual({});
    });

    it("all three transport values are accepted: stdio | SSE | HTTP", () => {
        store.create({ id: "s1", transport: "stdio", name: "Stdio Server" });
        store.create({ id: "s2", transport: "SSE",   name: "SSE Server" });
        store.create({ id: "s3", transport: "HTTP",  name: "HTTP Server" });
        const servers = store.list();
        const transports = servers.map(s => s.transport).sort();
        expect(transports).toEqual(["HTTP", "SSE", "stdio"]);
    });

    it("throws MCP_SERVER_ALREADY_EXISTS on duplicate id", () => {
        store.create(FS_SERVER_INPUT);
        expectMcpServerStoreError(
            () => store.create(FS_SERVER_INPUT),
            "MCP_SERVER_ALREADY_EXISTS"
        );
    });

    it("throws MCP_SERVER_NOT_FOUND when reading a missing server", () => {
        expectMcpServerStoreError(
            () => store.read("nonexistent"),
            "MCP_SERVER_NOT_FOUND"
        );
    });

    it("list() returns all created servers", () => {
        store.create(FS_SERVER_INPUT);
        store.create(WEB_SERVER_INPUT);
        const all = store.list();
        expect(all).toHaveLength(2);
        const ids = all.map(s => s.id).sort();
        expect(ids).toEqual([
            "@modelcontextprotocol/server-fetch",
            "@modelcontextprotocol/server-filesystem",
        ]);
    });

    it("list() returns empty array when no servers registered", () => {
        expect(store.list()).toEqual([]);
    });

    it("providedToolIds is a JS array, not a string", () => {
        store.create(FS_SERVER_INPUT);
        const server = store.read("@modelcontextprotocol/server-filesystem");
        expect(Array.isArray(server.providedToolIds)).toBe(true);
        expect(typeof server.providedToolIds).not.toBe("string");
    });

    it("configSchema is a JS object, not a string", () => {
        store.create(FS_SERVER_INPUT);
        const server = store.read("@modelcontextprotocol/server-filesystem");
        expect(typeof server.configSchema).toBe("object");
        expect(typeof server.configSchema).not.toBe("string");
    });
});

// ──────────────────────────────────────────────
// [inv:reopen-proves-persistence] — THE critical test
//
// Creates an MCP server with a non-trivial JSON config_schema and a
// provided_tool_ids array, CLOSES the better-sqlite3 handle, REOPENS
// from the same on-disk path, and asserts the full row round-trips correctly —
// including JSON columns. This proves the store writes to disk, not just
// in-memory state, and that drizzle's {mode:'json'} survives reopen.
// ──────────────────────────────────────────────
describe("McpServerStore — persistence (close + reopen proves disk write)", () => {
    let tmpDir: string;
    let dbPath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tool-registry-mcp-persist-"));
        dbPath = path.join(tmpDir, "registry.db");
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("[inv:reopen-proves-persistence] server round-trips through a close+reopen — JSON columns survive", () => {
        // ── Write phase ──────────────────────────────────────────────────────
        const { sqlite: sqlite1, db: db1 } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store1 = new McpServerStore(db1 as any);
        const written = store1.create(FS_SERVER_INPUT);

        // Close the handle — flushes WAL and releases the file lock.
        closeDb(sqlite1);

        // ── Reopen phase ─────────────────────────────────────────────────────
        // A brand-new connection to the same on-disk path.
        const { sqlite: sqlite2, db: db2 } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store2 = new McpServerStore(db2 as any);

        const readBack = store2.read("@modelcontextprotocol/server-filesystem");

        // The full row must deep-equal the written record.
        expect(readBack).toEqual(written);

        // Each field individually for maximum failure signal if one regresses:
        expect(readBack.id).toBe("@modelcontextprotocol/server-filesystem");
        expect(readBack.transport).toBe("stdio");
        expect(readBack.name).toBe("Filesystem MCP Server");

        // [inv:reopen-proves-persistence]: JSON array must survive as a JS array.
        expect(Array.isArray(readBack.providedToolIds)).toBe(true);
        expect(readBack.providedToolIds).toEqual(["file_read", "file_write", "file_list"]);

        // [inv:reopen-proves-persistence]: JSON object must survive as a deep-equal object.
        // This proves drizzle's {mode:'json'} does NOT return a raw string after reopen.
        expect(typeof readBack.configSchema).toBe("object");
        expect(readBack.configSchema).toEqual(FILESYSTEM_CONFIG_SCHEMA);

        // Assert nested structure (additionalProperties, required array) survives.
        expect((readBack.configSchema as typeof FILESYSTEM_CONFIG_SCHEMA).type).toBe("object");
        expect((readBack.configSchema as typeof FILESYSTEM_CONFIG_SCHEMA).required).toEqual(["roots"]);
        expect(
            (readBack.configSchema as typeof FILESYSTEM_CONFIG_SCHEMA).properties.roots.type
        ).toBe("array");

        closeDb(sqlite2);
    });

    it("[inv:reopen-proves-persistence] list() returns all servers after close+reopen", () => {
        // ── Write phase ──────────────────────────────────────────────────────
        const { sqlite: sqlite1, db: db1 } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store1 = new McpServerStore(db1 as any);
        store1.create(FS_SERVER_INPUT);
        store1.create(WEB_SERVER_INPUT);
        closeDb(sqlite1);

        // ── Reopen phase ─────────────────────────────────────────────────────
        const { sqlite: sqlite2, db: db2 } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store2 = new McpServerStore(db2 as any);
        const all = store2.list();

        expect(all).toHaveLength(2);
        const byId = Object.fromEntries(all.map(s => [s.id, s]));

        // Filesystem server assertions
        expect(byId["@modelcontextprotocol/server-filesystem"]!.transport).toBe("stdio");
        expect(byId["@modelcontextprotocol/server-filesystem"]!.providedToolIds).toEqual(
            ["file_read", "file_write", "file_list"]
        );
        expect(byId["@modelcontextprotocol/server-filesystem"]!.configSchema).toEqual(
            FILESYSTEM_CONFIG_SCHEMA
        );

        // Web server assertions
        expect(byId["@modelcontextprotocol/server-fetch"]!.transport).toBe("SSE");
        expect(byId["@modelcontextprotocol/server-fetch"]!.providedToolIds).toEqual(
            ["web_fetch", "web_search"]
        );
        expect(
            (byId["@modelcontextprotocol/server-fetch"]!.configSchema as Record<string, unknown>).type
        ).toBe("object");

        closeDb(sqlite2);
    });

    it("[inv:reopen-proves-persistence] empty providedToolIds and configSchema survive reopen as arrays/objects", () => {
        // ── Write phase ──────────────────────────────────────────────────────
        const { sqlite: sqlite1, db: db1 } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store1 = new McpServerStore(db1 as any);
        store1.create({
            id: "minimal-server",
            transport: "HTTP",
            name: "Minimal Server",
            // providedToolIds and configSchema omitted — default to [] and {}
        });
        closeDb(sqlite1);

        // ── Reopen phase ─────────────────────────────────────────────────────
        const { sqlite: sqlite2, db: db2 } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store2 = new McpServerStore(db2 as any);
        const server = store2.read("minimal-server");

        expect(Array.isArray(server.providedToolIds)).toBe(true);
        expect(server.providedToolIds).toEqual([]);
        expect(typeof server.configSchema).toBe("object");
        expect(server.configSchema).toEqual({});

        closeDb(sqlite2);
    });
});
