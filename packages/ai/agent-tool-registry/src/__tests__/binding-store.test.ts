import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMigrationsOn } from "../db/migrate-runner.js";
import * as schema from "../db/schema.js";
import { BindingStore, BindingStoreError } from "../store/binding-store.js";
import type { BindingStoreErrorCode } from "../store/binding-store.js";
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

/** Close the better-sqlite3 handle. Returns the path so callers can reopen. */
function closeDb(sqlite: InstanceType<typeof Database>): void {
    sqlite.close();
}

// ──────────────────────────────────────────────
// Error assertion helper
// ──────────────────────────────────────────────

function expectBindingStoreError(fn: () => unknown, code: BindingStoreErrorCode): void {
    try {
        fn();
        expect.fail(`Expected a BindingStoreError with code '${code}' to be thrown`);
    } catch (err: unknown) {
        expect(err).toBeInstanceOf(BindingStoreError);
        expect((err as BindingStoreError).code).toBe(code);
    }
}

// ──────────────────────────────────────────────
// Test fixtures
// ──────────────────────────────────────────────

const IO_TYPE = { slug: "io", description: "File and stream I/O operations" };

const SHELL_EXEC_TOOL = {
    name: "shell_exec",
    type: "io",
    description: "Execute shell commands",
    requiresApproval: true,
    isDestructive: true,
};

const FILE_READ_TOOL = {
    name: "file_read",
    type: "io",
    description: "Read file contents",
};

const CLAUDE_CODE_PLATFORM = {
    id: "claude_code",
    name: "Claude Code",
    headerFormat: "yaml_frontmatter",
    supportsToolSelection: true,
};

const CLAUDE_API_PLATFORM = {
    id: "claude_api",
    name: "Claude API",
    headerFormat: "json_object",
    supportsToolSelection: true,
};

const OPENAI_PLATFORM = {
    id: "openai",
    name: "OpenAI",
    headerFormat: "none",
    supportsToolSelection: false,
};

// ──────────────────────────────────────────────
// Tests: platforms table
// ──────────────────────────────────────────────

describe("BindingStore — platforms table [platform-and-binding-schema.1]", () => {
    let tmpDir: string;
    let dbPath: string;
    let sqlite: InstanceType<typeof Database>;
    let store: BindingStore;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-binding-test-"));
        dbPath = path.join(tmpDir, "registry.db");
        const { sqlite: s, db } = openDb(dbPath);
        sqlite = s;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        store = new BindingStore(db as any);
    });

    afterEach(() => {
        try { closeDb(sqlite); } catch { /* already closed */ }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("seeds a platform and reads it back", () => {
        store.seedPlatform(CLAUDE_CODE_PLATFORM);
        const platform = store.readPlatform("claude_code");
        expect(platform.id).toBe("claude_code");
        expect(platform.name).toBe("Claude Code");
        expect(platform.headerFormat).toBe("yaml_frontmatter");
        expect(platform.supportsToolSelection).toBe(true);
    });

    it("seeds all three header_format variants", () => {
        store.seedPlatform(CLAUDE_CODE_PLATFORM);   // yaml_frontmatter
        store.seedPlatform(CLAUDE_API_PLATFORM);    // json_object
        store.seedPlatform(OPENAI_PLATFORM);        // none

        const platforms = store.listPlatforms();
        expect(platforms).toHaveLength(3);

        const byId = Object.fromEntries(platforms.map(p => [p.id, p]));
        expect(byId["claude_code"]!.headerFormat).toBe("yaml_frontmatter");
        expect(byId["claude_api"]!.headerFormat).toBe("json_object");
        expect(byId["openai"]!.headerFormat).toBe("none");
    });

    it("seedPlatform is idempotent (onConflictDoNothing)", () => {
        store.seedPlatform(CLAUDE_CODE_PLATFORM);
        // Seeding again must not throw and must not duplicate.
        store.seedPlatform(CLAUDE_CODE_PLATFORM);
        expect(store.listPlatforms()).toHaveLength(1);
    });

    it("readPlatform throws PLATFORM_NOT_FOUND for missing id", () => {
        expectBindingStoreError(
            () => store.readPlatform("nonexistent"),
            "PLATFORM_NOT_FOUND"
        );
    });

    it("supportsToolSelection stores false correctly", () => {
        store.seedPlatform(OPENAI_PLATFORM);
        const platform = store.readPlatform("openai");
        expect(platform.supportsToolSelection).toBe(false);
    });
});

// ──────────────────────────────────────────────
// Tests: tool_platform_bindings table
// ──────────────────────────────────────────────

describe("BindingStore — tool_platform_bindings table [platform-and-binding-schema.2]", () => {
    let tmpDir: string;
    let dbPath: string;
    let sqlite: InstanceType<typeof Database>;
    let store: BindingStore;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-binding-test-"));
        dbPath = path.join(tmpDir, "registry.db");
        const { sqlite: s, db } = openDb(dbPath);
        sqlite = s;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        store = new BindingStore(db as any);
        // Seed prerequisites for FK constraints.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toolStore = new ToolStore(db as any);
        toolStore.seedToolType(IO_TYPE);
        toolStore.create(SHELL_EXEC_TOOL);
        toolStore.create(FILE_READ_TOOL);
        store.seedPlatform(CLAUDE_CODE_PLATFORM);
        store.seedPlatform(CLAUDE_API_PLATFORM);
    });

    afterEach(() => {
        try { closeDb(sqlite); } catch { /* already closed */ }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("creates a binding and reads it back via listForPlatform", () => {
        store.createBinding({
            toolName: "shell_exec",
            platformId: "claude_code",
            platformToolName: "Bash",
            availability: "available",
        });

        const bindings = store.listForPlatform("claude_code");
        expect(bindings).toHaveLength(1);
        expect(bindings[0]!.toolName).toBe("shell_exec");
        expect(bindings[0]!.platformToolName).toBe("Bash");
        expect(bindings[0]!.availability).toBe("available");
        expect(bindings[0]!.requiresMcp).toBe(false);
        expect(bindings[0]!.invocationNote).toBeNull();
    });

    it("creates a binding with all optional fields", () => {
        store.createBinding({
            toolName: "shell_exec",
            platformId: "claude_code",
            platformToolName: "Bash",
            availability: "requires_permission",
            requiresMcp: true,
            invocationNote: "requires --chrome",
        });

        const bindings = store.listForPlatform("claude_code");
        expect(bindings[0]!.requiresMcp).toBe(true);
        expect(bindings[0]!.invocationNote).toBe("requires --chrome");
        expect(bindings[0]!.availability).toBe("requires_permission");
    });

    it("throws BINDING_ALREADY_EXISTS on duplicate (tool_name, platform_id)", () => {
        store.createBinding({
            toolName: "shell_exec",
            platformId: "claude_code",
            platformToolName: "Bash",
            availability: "available",
        });
        expectBindingStoreError(
            () => store.createBinding({
                toolName: "shell_exec",
                platformId: "claude_code",
                platformToolName: "BashDuplicate",
                availability: "available",
            }),
            "BINDING_ALREADY_EXISTS"
        );
    });

    it("listForPlatform returns only bindings for the requested platform", () => {
        store.createBinding({
            toolName: "shell_exec",
            platformId: "claude_code",
            platformToolName: "Bash",
            availability: "available",
        });
        store.createBinding({
            toolName: "shell_exec",
            platformId: "claude_api",
            platformToolName: "bash",
            availability: "available",
        });

        const claudeCodeBindings = store.listForPlatform("claude_code");
        expect(claudeCodeBindings).toHaveLength(1);
        expect(claudeCodeBindings[0]!.platformToolName).toBe("Bash");

        const claudeApiBindings = store.listForPlatform("claude_api");
        expect(claudeApiBindings).toHaveLength(1);
        expect(claudeApiBindings[0]!.platformToolName).toBe("bash");
    });

    it("listForPlatform returns empty array for platform with no bindings", () => {
        const bindings = store.listForPlatform("claude_code");
        expect(bindings).toHaveLength(0);
    });
});

// ──────────────────────────────────────────────
// Tests: BindingStore.resolve — [def:resolve] — [dod.1]
//
// [platform-and-binding-schema.3]
// Keystone primitive: shell_exec/claude_code → "Bash", shell_exec/claude_api → "bash".
// Proves the platform argument is honored, not ignored ([dod.1] negative-control).
// ──────────────────────────────────────────────

describe("BindingStore.resolve — [def:resolve] / [dod.1] [platform-and-binding-schema.3]", () => {
    let tmpDir: string;
    let dbPath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-binding-resolve-"));
        dbPath = path.join(tmpDir, "registry.db");
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("[dod.1][inv:reopen-proves-persistence] resolve returns platform-specific name after close+reopen", () => {
        // ── Write phase ───────────────────────────────────────────────────────
        // Seed tools, platforms, and two bindings for shell_exec.
        const { sqlite: sqlite1, db: db1 } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toolStore1 = new ToolStore(db1 as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bindingStore1 = new BindingStore(db1 as any);

        toolStore1.seedToolType(IO_TYPE);
        toolStore1.create(SHELL_EXEC_TOOL);

        bindingStore1.seedPlatform(CLAUDE_CODE_PLATFORM);
        bindingStore1.seedPlatform(CLAUDE_API_PLATFORM);

        // shell_exec is "Bash" on claude_code
        bindingStore1.createBinding({
            toolName: "shell_exec",
            platformId: "claude_code",
            platformToolName: "Bash",
            availability: "available",
        });
        // shell_exec is "bash" on claude_api
        bindingStore1.createBinding({
            toolName: "shell_exec",
            platformId: "claude_api",
            platformToolName: "bash",
            availability: "available",
        });

        // CLOSE the handle — flushes WAL and releases the file lock.
        closeDb(sqlite1);

        // ── Reopen phase ──────────────────────────────────────────────────────
        // A brand-new connection to the same on-disk path.
        const { sqlite: sqlite2, db: db2 } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bindingStore2 = new BindingStore(db2 as any);

        // Both resolves must return the right alias — proves persistence.
        const bashOnClaudeCode = bindingStore2.resolve("shell_exec", "claude_code");
        const bashOnClaudeApi = bindingStore2.resolve("shell_exec", "claude_api");

        // These two assertions are the [dod.1] proof: same canonical tool, two
        // different platforms, two different aliases.
        expect(bashOnClaudeCode).toBe("Bash");
        expect(bashOnClaudeApi).toBe("bash");

        closeDb(sqlite2);
    });

    it("[dod.1] negative-control: wrong platform returns different alias", () => {
        // This test would FAIL if resolve() ignored the platformId argument
        // and returned the first binding it found for the tool name alone.
        const { sqlite, db } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toolStore = new ToolStore(db as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bindingStore = new BindingStore(db as any);

        toolStore.seedToolType(IO_TYPE);
        toolStore.create(SHELL_EXEC_TOOL);
        bindingStore.seedPlatform(CLAUDE_CODE_PLATFORM);
        bindingStore.seedPlatform(CLAUDE_API_PLATFORM);

        bindingStore.createBinding({
            toolName: "shell_exec",
            platformId: "claude_code",
            platformToolName: "Bash",
            availability: "available",
        });
        bindingStore.createBinding({
            toolName: "shell_exec",
            platformId: "claude_api",
            platformToolName: "bash",
            availability: "available",
        });

        const claudeCodeAlias = bindingStore.resolve("shell_exec", "claude_code");
        const claudeApiAlias = bindingStore.resolve("shell_exec", "claude_api");

        // They must be different — proves the platform filter is applied.
        expect(claudeCodeAlias).not.toBe(claudeApiAlias);
        expect(claudeCodeAlias).toBe("Bash");
        expect(claudeApiAlias).toBe("bash");

        closeDb(sqlite);
    });

    it("resolve throws BINDING_NOT_FOUND for unknown tool", () => {
        const { sqlite, db } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bindingStore = new BindingStore(db as any);

        bindingStore.seedPlatform(CLAUDE_CODE_PLATFORM);

        expectBindingStoreError(
            () => bindingStore.resolve("nonexistent_tool", "claude_code"),
            "BINDING_NOT_FOUND"
        );

        closeDb(sqlite);
    });

    it("resolve throws BINDING_NOT_FOUND for known tool on unknown platform", () => {
        const { sqlite, db } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toolStore = new ToolStore(db as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bindingStore = new BindingStore(db as any);

        toolStore.seedToolType(IO_TYPE);
        toolStore.create(SHELL_EXEC_TOOL);
        bindingStore.seedPlatform(CLAUDE_CODE_PLATFORM);

        bindingStore.createBinding({
            toolName: "shell_exec",
            platformId: "claude_code",
            platformToolName: "Bash",
            availability: "available",
        });

        // The tool exists and has a binding for claude_code, but NOT for claude_api
        expectBindingStoreError(
            () => bindingStore.resolve("shell_exec", "claude_api"),
            "BINDING_NOT_FOUND"
        );

        closeDb(sqlite);
    });

    it("[inv:reopen-proves-persistence] platform rows survive a close+reopen", () => {
        // ── Write phase ───────────────────────────────────────────────────────
        const { sqlite: sqlite1, db: db1 } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bindingStore1 = new BindingStore(db1 as any);

        bindingStore1.seedPlatform(CLAUDE_CODE_PLATFORM);
        bindingStore1.seedPlatform(CLAUDE_API_PLATFORM);
        bindingStore1.seedPlatform(OPENAI_PLATFORM);

        closeDb(sqlite1);

        // ── Reopen phase ──────────────────────────────────────────────────────
        const { sqlite: sqlite2, db: db2 } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bindingStore2 = new BindingStore(db2 as any);

        const platforms = bindingStore2.listPlatforms();
        expect(platforms).toHaveLength(3);

        const byId = Object.fromEntries(platforms.map(p => [p.id, p]));
        expect(byId["claude_code"]!.headerFormat).toBe("yaml_frontmatter");
        expect(byId["claude_code"]!.supportsToolSelection).toBe(true);
        expect(byId["claude_api"]!.headerFormat).toBe("json_object");
        expect(byId["openai"]!.headerFormat).toBe("none");
        expect(byId["openai"]!.supportsToolSelection).toBe(false);

        closeDb(sqlite2);
    });
});
