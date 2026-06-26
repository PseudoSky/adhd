/**
 * End-to-end round-trip suite for the tool catalog seeder.
 *
 * Proves [dod.1] and [dod.2] per the seed-and-roundtrip context:
 *
 * 1. "binding round-trips after reopen" — seed(), CLOSE handle, REOPEN from
 *    same path, assert BindingStore.resolve() returns the correct alias.
 *    [inv:reopen-proves-persistence]
 *
 * 2. "seed is idempotent on re-run" — count rows after one seed(), seed()
 *    again, counts must be identical. [dod.2]
 *
 * 3. Negative-control (teeth) — a deliberately-wrong binding alias in the
 *    persisted DB causes the resolve assertion to fail, proving the test would
 *    go RED if the seed data were corrupted. [seed-and-roundtrip.3]
 *
 * All tests run against a real on-disk SQLite file (tmp path). [inv:real-db-tests]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMigrationsOn } from "../db/migrate-runner.js";
import * as schema from "../db/schema.js";
import { seed } from "../seed/index.js";
import { TOOL_SEEDS } from "../seed/tools.js";
import { BindingStore } from "../store/binding-store.js";
import { ToolStore } from "../store/tool-store.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../drizzle");

// ──────────────────────────────────────────────
// DB helpers — identical pattern to other tests in this package
// ──────────────────────────────────────────────

/** Open a better-sqlite3 handle + drizzle wrapper and apply migrations. */
function openDb(dbPath: string) {
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = drizzle(sqlite, { schema }) as any;
    runMigrationsOn(sqlite, db, migrationsFolder);
    return { sqlite, db };
}

function closeDb(sqlite: InstanceType<typeof Database>): void {
    sqlite.close();
}

/** Count all rows in a table using the raw better-sqlite3 connection. */
function rowCount(sqlite: InstanceType<typeof Database>, table: string): number {
    return (sqlite.prepare(`SELECT COUNT(*) as cnt FROM "${table}"`).get() as { cnt: number }).cnt;
}

// ──────────────────────────────────────────────
// Test suite
// ──────────────────────────────────────────────

describe("seed-and-roundtrip [seed-and-roundtrip.1]", () => {
    let tmpDir: string;
    let dbPath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tool-roundtrip-"));
        dbPath = path.join(tmpDir, "registry.db");
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ── Test 1: persistence via reopen ───────────────────────────────────────

    it("[inv:reopen-proves-persistence] binding round-trips after close+reopen", () => {
        // ── Write phase: seed the full catalog ───────────────────────────────
        const { sqlite: sqlite1, db: db1 } = openDb(dbPath);
        seed(db1);
        // CLOSE the handle — flushes WAL and releases the file lock
        closeDb(sqlite1);

        // ── Reopen phase: brand-new connection to the same on-disk path ──────
        const { sqlite: sqlite2, db: db2 } = openDb(dbPath);
        const bindingStore = new BindingStore(db2);

        // [dod.1] proof: canonical tool resolves to its platform alias after reopen
        const shellExecOnClaudeCode = bindingStore.resolve("shell_exec", "claude_code");
        const shellExecOnClaudeApi  = bindingStore.resolve("shell_exec", "claude_api");
        const fileReadOnClaudeCode  = bindingStore.resolve("file_read",  "claude_code");
        const webFetchOnClaudeCode  = bindingStore.resolve("web_fetch",  "claude_code");

        expect(shellExecOnClaudeCode).toBe("Bash");
        expect(shellExecOnClaudeApi).toBe("bash");
        expect(fileReadOnClaudeCode).toBe("Read");
        expect(webFetchOnClaudeCode).toBe("WebFetch");

        closeDb(sqlite2);
    });

    // ── Test 2: idempotency ───────────────────────────────────────────────────

    it("[dod.2] seed is idempotent on re-run — row counts unchanged after double seed", () => {
        const { sqlite, db } = openDb(dbPath);

        // First seed
        seed(db);

        const typesAfterFirst    = rowCount(sqlite, "tool_types");
        const platformsAfterFirst = rowCount(sqlite, "platforms");
        const toolsAfterFirst    = rowCount(sqlite, "tools");
        const bindingsAfterFirst = rowCount(sqlite, "tool_platform_bindings");

        // Second seed — must be a no-op
        seed(db);

        expect(rowCount(sqlite, "tool_types")).toBe(typesAfterFirst);
        expect(rowCount(sqlite, "platforms")).toBe(platformsAfterFirst);
        expect(rowCount(sqlite, "tools")).toBe(toolsAfterFirst);
        expect(rowCount(sqlite, "tool_platform_bindings")).toBe(bindingsAfterFirst);

        // Sanity: we seeded non-zero rows
        expect(typesAfterFirst).toBeGreaterThan(0);
        expect(platformsAfterFirst).toBeGreaterThan(0);
        expect(toolsAfterFirst).toBeGreaterThan(0);
        expect(bindingsAfterFirst).toBeGreaterThan(0);

        closeDb(sqlite);
    });

    // ── Test 3: canonical tools present [seed-and-roundtrip.2] ──────────────

    it("[seed-and-roundtrip.2] seed contains the required canonical tools", () => {
        const { sqlite, db } = openDb(dbPath);
        seed(db);

        const toolStore = new ToolStore(db);
        const allTools = toolStore.list();
        const toolNames = new Set(allTools.map(t => t.name));

        // The three tools specifically called out in the state spec
        expect(toolNames).toContain("shell_exec");
        expect(toolNames).toContain("file_read");
        expect(toolNames).toContain("web_fetch");

        // All 15 SEED_DATA §6 tools must be present
        for (const row of TOOL_SEEDS) {
            expect(toolNames).toContain(row.name);
        }
        expect(allTools).toHaveLength(TOOL_SEEDS.length);

        closeDb(sqlite);
    });

    // ── Test 4: negative-control / teeth [seed-and-roundtrip.3] ─────────────
    //
    // Corrupts the persisted alias for shell_exec/claude_code directly via
    // raw SQL, proves the resolve assertion returns the wrong value, then
    // restores the correct alias and proves the round-trip passes again.
    //
    // This is the [seed-and-roundtrip.3] "teeth" proof: if the binding were
    // wrong in the DB, the round-trip test would fail.

    it("[seed-and-roundtrip.3] negative-control: corrupted alias causes resolve to return wrong value", () => {
        // Phase 1: seed correct data
        const { sqlite: s1, db: db1 } = openDb(dbPath);
        seed(db1);
        closeDb(s1);

        // Phase 2: corrupt the binding alias (nc_mutate semantics)
        const { sqlite: s2, db: db2 } = openDb(dbPath);
        s2.prepare(
            `UPDATE tool_platform_bindings
             SET platform_tool_name = 'WRONG_ALIAS'
             WHERE tool_name = 'shell_exec' AND platform_id = 'claude_code'`
        ).run();

        const corruptedStore = new BindingStore(db2);
        const corruptedAlias = corruptedStore.resolve("shell_exec", "claude_code");
        // Proves the test WOULD fail: the alias is wrong
        expect(corruptedAlias).toBe("WRONG_ALIAS");
        expect(corruptedAlias).not.toBe("Bash");
        closeDb(s2);

        // Phase 3: restore correct alias (nc_restore semantics)
        const { sqlite: s3, db: db3 } = openDb(dbPath);
        s3.prepare(
            `UPDATE tool_platform_bindings
             SET platform_tool_name = 'Bash'
             WHERE tool_name = 'shell_exec' AND platform_id = 'claude_code'`
        ).run();

        const restoredStore = new BindingStore(db3);
        const restoredAlias = restoredStore.resolve("shell_exec", "claude_code");
        // After restore, the round-trip passes
        expect(restoredAlias).toBe("Bash");
        closeDb(s3);
    });

    // ── Test 5: all 6 platforms seeded ───────────────────────────────────────

    it("all 6 canonical platforms are seeded", () => {
        const { sqlite, db } = openDb(dbPath);
        seed(db);

        const bindingStore = new BindingStore(db);
        const platforms = bindingStore.listPlatforms();
        const platformIds = new Set(platforms.map(p => p.id));

        expect(platformIds).toContain("claude_code");
        expect(platformIds).toContain("claude_api");
        expect(platformIds).toContain("openai");
        expect(platformIds).toContain("bedrock");
        expect(platformIds).toContain("cursor");
        expect(platformIds).toContain("vscode");
        expect(platforms).toHaveLength(6);

        closeDb(sqlite);
    });

    // ── Test 6: all 8 tool types seeded ──────────────────────────────────────

    it("all 8 canonical tool types are seeded", () => {
        const { sqlite, db } = openDb(dbPath);
        seed(db);

        const toolStore = new ToolStore(db);
        const toolTypes = toolStore.listToolTypes();
        const slugs = new Set(toolTypes.map(t => t.slug));

        expect(slugs).toContain("io");
        expect(slugs).toContain("compute");
        expect(slugs).toContain("network");
        expect(slugs).toContain("memory");
        expect(slugs).toContain("ui");
        expect(slugs).toContain("meta");
        expect(slugs).toContain("lsp");
        expect(slugs).toContain("notebook");
        expect(toolTypes).toHaveLength(8);

        closeDb(sqlite);
    });

    // ── Test 7: claude_code bindings resolve correctly ────────────────────────

    it("all claude_code bindings resolve to their PascalCase platform names", () => {
        const { sqlite, db } = openDb(dbPath);
        seed(db);

        const bindingStore = new BindingStore(db);
        const claudeCodeBindings = bindingStore.listForPlatform("claude_code");

        const byTool = Object.fromEntries(
            claudeCodeBindings.map(b => [b.toolName, b.platformToolName])
        );

        // Spot-check the key bindings from SEED_DATA §6
        expect(byTool["file_read"]).toBe("Read");
        expect(byTool["file_write"]).toBe("Write");
        expect(byTool["file_edit"]).toBe("Edit");
        expect(byTool["file_glob"]).toBe("Glob");
        expect(byTool["file_grep"]).toBe("Grep");
        expect(byTool["shell_exec"]).toBe("Bash");
        expect(byTool["web_fetch"]).toBe("WebFetch");
        expect(byTool["web_search"]).toBe("WebSearch");
        expect(byTool["human_input"]).toBe("AskUserQuestion");
        expect(byTool["process_monitor"]).toBe("Monitor");
        expect(byTool["notebook_edit"]).toBe("NotebookEdit");

        closeDb(sqlite);
    });
});
