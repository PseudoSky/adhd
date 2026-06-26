import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMigrationsOn } from "../db/migrate-runner.js";
import * as schema from "../db/schema.js";
import { AgentToolStore, AgentToolStoreError } from "../store/agent-tool-store.js";
import type { AgentToolStoreErrorCode, PermissionLevel } from "../store/agent-tool-store.js";
import { ToolStore } from "../store/tool-store.js";

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

function expectAgentToolStoreError(fn: () => unknown, code: AgentToolStoreErrorCode): void {
    try {
        fn();
        expect.fail(`Expected an AgentToolStoreError with code '${code}' to be thrown`);
    } catch (err: unknown) {
        expect(err).toBeInstanceOf(AgentToolStoreError);
        expect((err as AgentToolStoreError).code).toBe(code);
    }
}

// ──────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────

// Seed a tool_type and a tool so that within-package FK on tool_name passes.
function seedToolAndType(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: any,
    toolName = "file_read"
): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolStore = new ToolStore(db as any);
    toolStore.seedToolType({ slug: "io", description: "IO tools" });
    toolStore.create({
        name: toolName,
        type: "io",
        description: "Read a file from disk",
    });
}

// ──────────────────────────────────────────────
// Basic grant / listForAgent / revoke tests
// ──────────────────────────────────────────────

describe("AgentToolStore — grant / listForAgent / revoke", () => {
    let tmpDir: string;
    let dbPath: string;
    let sqlite: InstanceType<typeof Database>;
    let store: AgentToolStore;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tool-registry-junction-"));
        dbPath = path.join(tmpDir, "registry.db");
        const { sqlite: s, db } = openDb(dbPath);
        sqlite = s;
        seedToolAndType(db);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        store = new AgentToolStore(db as any);
    });

    afterEach(() => {
        try { closeDb(sqlite); } catch { /* already closed */ }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("grants a tool and reads it back in-session", () => {
        const grant = store.grant({
            agentSlug: "code-reviewer",
            toolName: "file_read",
            permission: "read_only",
        });

        expect(grant.agentSlug).toBe("code-reviewer");
        expect(grant.toolName).toBe("file_read");
        expect(grant.permission).toBe("read_only");
        expect(grant.contextCondition).toBeNull();
    });

    it("all three permission levels are accepted and stored verbatim", () => {
        // Need two more tools for the other grants
        const { sqlite: s2, db: db2 } = openDb(dbPath);
        closeDb(sqlite);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toolStore2 = new ToolStore(db2 as any);
        toolStore2.create({ name: "shell_exec", type: "io", description: "Execute shell command" });
        toolStore2.create({ name: "web_fetch", type: "io", description: "Fetch a URL" });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store2 = new AgentToolStore(db2 as any);
        sqlite = s2;
        store = store2;

        store.grant({ agentSlug: "agent-a", toolName: "file_read",  permission: "full"       });
        store.grant({ agentSlug: "agent-a", toolName: "shell_exec", permission: "read_only"  });
        store.grant({ agentSlug: "agent-a", toolName: "web_fetch",  permission: "restricted" });

        const grants = store.listForAgent("agent-a");
        const byTool = Object.fromEntries(grants.map(g => [g.toolName, g.permission]));
        expect(byTool["file_read"]).toBe("full");
        expect(byTool["shell_exec"]).toBe("read_only");
        expect(byTool["web_fetch"]).toBe("restricted");
    });

    it("stores context_condition as JSON and reads it back as an object", () => {
        const condition = { scope: "repo", paths: ["src/**"] };
        const grant = store.grant({
            agentSlug: "security-bot",
            toolName: "file_read",
            permission: "restricted",
            contextCondition: condition,
        });

        expect(grant.contextCondition).toEqual(condition);

        const listed = store.listForAgent("security-bot");
        expect(listed[0]!.contextCondition).toEqual(condition);
        expect(typeof listed[0]!.contextCondition).toBe("object");
    });

    it("listForAgent returns empty array for an unknown agent slug", () => {
        // No grants for this slug — proves the column is not FK-constrained
        expect(store.listForAgent("no-such-agent")).toEqual([]);
    });

    it("throws GRANT_ALREADY_EXISTS on duplicate (agent_slug, tool_name)", () => {
        store.grant({ agentSlug: "agent-x", toolName: "file_read", permission: "full" });
        expectAgentToolStoreError(
            () => store.grant({ agentSlug: "agent-x", toolName: "file_read", permission: "read_only" }),
            "GRANT_ALREADY_EXISTS"
        );
    });

    it("revoke removes the grant; subsequent listForAgent returns empty array", () => {
        store.grant({ agentSlug: "agent-y", toolName: "file_read", permission: "full" });
        store.revoke("agent-y", "file_read");
        expect(store.listForAgent("agent-y")).toEqual([]);
    });

    it("throws GRANT_NOT_FOUND when revoking a non-existent grant", () => {
        expectAgentToolStoreError(
            () => store.revoke("ghost-agent", "file_read"),
            "GRANT_NOT_FOUND"
        );
    });
});

// ──────────────────────────────────────────────
// [inv:reopen-proves-persistence] — THE critical persistence test
//
// Grants 'file_read' to 'code-reviewer' at permission 'read_only', CLOSES
// the better-sqlite3 handle, REOPENS from the same path, calls listForAgent,
// and asserts the grant comes back at EXACTLY 'read_only' — not 'full' or
// any other default. This breaks if grant() hardcodes a permission value.
// ──────────────────────────────────────────────
describe("AgentToolStore — persistence (close + reopen proves disk write)", () => {
    let tmpDir: string;
    let dbPath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tool-registry-junction-persist-"));
        dbPath = path.join(tmpDir, "registry.db");
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("[inv:reopen-proves-persistence] read_only grant survives close+reopen — permission NOT coerced to 'full'", () => {
        // ── Write phase ──────────────────────────────────────────────────────
        const { sqlite: sqlite1, db: db1 } = openDb(dbPath);
        seedToolAndType(db1);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store1 = new AgentToolStore(db1 as any);

        store1.grant({
            agentSlug: "code-reviewer",
            toolName: "file_read",
            permission: "read_only",
        });

        // Flush WAL and release the file lock.
        closeDb(sqlite1);

        // ── Reopen phase ─────────────────────────────────────────────────────
        // Brand-new connection to the same on-disk path.
        const { sqlite: sqlite2, db: db2 } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store2 = new AgentToolStore(db2 as any);

        const grants = store2.listForAgent("code-reviewer");

        // Exactly one grant must be returned.
        expect(grants).toHaveLength(1);

        const grant = grants[0]!;
        expect(grant.agentSlug).toBe("code-reviewer");
        expect(grant.toolName).toBe("file_read");

        // THE KEY ASSERTION — must be 'read_only', not 'full'
        // This test fails if grant() hardcodes any permission value.
        const expectedPermission: PermissionLevel = "read_only";
        expect(grant.permission).toBe(expectedPermission);
        expect(grant.permission).not.toBe("full");
        expect(grant.permission).not.toBe("restricted");

        expect(grant.contextCondition).toBeNull();

        closeDb(sqlite2);
    });

    it("[inv:reopen-proves-persistence] context_condition JSON survives close+reopen", () => {
        const condition = { env: "production", requiredRole: "reviewer" };

        // ── Write phase ──────────────────────────────────────────────────────
        const { sqlite: sqlite1, db: db1 } = openDb(dbPath);
        seedToolAndType(db1);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store1 = new AgentToolStore(db1 as any);
        store1.grant({
            agentSlug: "sec-agent",
            toolName: "file_read",
            permission: "restricted",
            contextCondition: condition,
        });
        closeDb(sqlite1);

        // ── Reopen phase ─────────────────────────────────────────────────────
        const { sqlite: sqlite2, db: db2 } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store2 = new AgentToolStore(db2 as any);
        const grants = store2.listForAgent("sec-agent");

        expect(grants).toHaveLength(1);
        // JSON must survive as a JS object, not a raw string
        expect(typeof grants[0]!.contextCondition).toBe("object");
        expect(grants[0]!.contextCondition).toEqual(condition);

        closeDb(sqlite2);
    });
});

// ──────────────────────────────────────────────
// [inv:no-cross-pkg-fk] — agent_slug is NOT FK-constrained
//
// Proves that agent_slug is a purely logical reference. The test grants a tool
// to a slug that has NO corresponding row in any agents table (there is no such
// table in this package). If a FK were present, the insert would throw a
// SQLITE_CONSTRAINT_FOREIGNKEY error.
// ──────────────────────────────────────────────
describe("AgentToolStore — [inv:no-cross-pkg-fk] agent_slug is a logical reference", () => {
    let tmpDir: string;
    let dbPath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tool-registry-junction-nofk-"));
        dbPath = path.join(tmpDir, "registry.db");
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("agent_slug with no matching agents-table row is accepted (no FK constraint)", () => {
        const { sqlite, db } = openDb(dbPath);
        // Enable FK enforcement — this is the strictest setting, so any FK
        // violation on agent_slug would throw.
        sqlite.pragma("foreign_keys = ON");
        seedToolAndType(db);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = new AgentToolStore(db as any);

        // This slug does NOT exist in any agents table (there is none in this
        // package). A real FK would cause a SQLITE_CONSTRAINT_FOREIGNKEY error.
        // It must NOT throw.
        let threw = false;
        try {
            store.grant({
                agentSlug: "ghost-agent-that-does-not-exist-anywhere",
                toolName: "file_read",
                permission: "full",
            });
        } catch {
            threw = true;
        }

        expect(threw).toBe(false);

        // The grant is readable.
        const grants = store.listForAgent("ghost-agent-that-does-not-exist-anywhere");
        expect(grants).toHaveLength(1);
        expect(grants[0]!.agentSlug).toBe("ghost-agent-that-does-not-exist-anywhere");

        closeDb(sqlite);
    });
});
