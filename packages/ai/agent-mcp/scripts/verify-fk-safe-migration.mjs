#!/usr/bin/env node
/**
 * verify-fk-safe-migration.mjs
 *
 * Regression guard for the 0005 table-recreate cascade-wipe bug.
 *
 * The 0005 migration recreates the `tasks` table (CREATE __new_tasks →
 * INSERT-SELECT → DROP tasks → RENAME) to make `session_id` nullable and add
 * `is_ephemeral`. `task_events.task_id` has `ON DELETE CASCADE`, so the
 * `DROP TABLE tasks` cascade-deletes EVERY pre-existing task_events row when FK
 * enforcement is on — drizzle-kit's in-SQL `PRAGMA foreign_keys=OFF` is a no-op
 * inside the migrator's transaction. `runMigrationsOn` (db/migrate-runner.ts)
 * toggles FK enforcement off on the *connection* (outside any transaction)
 * around migrate(), the only place SQLite honours the pragma.
 *
 * This check seeds a DB at the pre-0005 (0004) schema with a task + a
 * task_events row, applies 0005 via the SHIPPED runMigrationsOn, and asserts
 * the task_events row SURVIVES (the bug deletes it → count 0).
 *
 * WHY A SCRIPT (not a vitest test): a vitest file importing better-sqlite3 +
 * drizzle at this point in the suite trips a vite-node SSR transform-cache
 * failure (`ENOENT .../ssr/...`) that breaks unrelated test files' loading.
 * Running this as a standalone node script (like the plan audit scripts) keeps
 * the vitest suite green while preserving the regression guard.
 *
 * Requires a build first: `npx nx build agent-mcp` (imports the compiled
 * runMigrationsOn from dist). Run from the repo root:
 *   node packages/ai/agent-mcp/scripts/verify-fk-safe-migration.mjs
 *
 * TEETH: revert runMigrationsOn to a bare migrate() (drop the FK toggle) and
 * this script exits non-zero (task_events count → 0).
 *
 * Exit codes: 0 = pass, 1 = regression detected / assertion failed,
 *             2 = setup error (missing build, etc.).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, ".."); // packages/ai/agent-mcp
const REPO_ROOT = path.resolve(PKG_ROOT, "../../.."); // repo root
const REAL_FOLDER = path.join(PKG_ROOT, "drizzle");
const DIST_MIGRATE_RUNNER = path.join(
    REPO_ROOT,
    "dist/packages/ai/agent-mcp/src/db/migrate-runner.js"
);
const TARGET_MIGRATION = "0005_clear_lenny_balinger";

// require() resolves node_modules upward from the repo root (better-sqlite3 is
// a native module; drizzle is ESM imported dynamically below).
const require = createRequire(pathToFileURL(path.join(REPO_ROOT, "noop.js")));

function fail(msg) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

function buildPre0005Folder() {
    const journal = JSON.parse(
        fs.readFileSync(path.join(REAL_FOLDER, "meta", "_journal.json"), "utf8")
    );
    const pre = journal.entries.filter((e) => e.tag !== TARGET_MIGRATION);
    if (pre.length !== journal.entries.length - 1) {
        fail(`expected to exclude exactly one migration (${TARGET_MIGRATION})`);
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mcp-fkmig-"));
    const folder = path.join(root, "drizzle");
    fs.mkdirSync(path.join(folder, "meta"), { recursive: true });
    fs.writeFileSync(
        path.join(folder, "meta", "_journal.json"),
        JSON.stringify({ ...journal, entries: pre })
    );
    for (const e of pre) {
        fs.copyFileSync(
            path.join(REAL_FOLDER, `${e.tag}.sql`),
            path.join(folder, `${e.tag}.sql`)
        );
    }
    return { root, folder };
}

async function main() {
    if (!fs.existsSync(DIST_MIGRATE_RUNNER)) {
        console.error(
            `SETUP ERROR: ${DIST_MIGRATE_RUNNER} not found. Build first: npx nx build agent-mcp`
        );
        process.exit(2);
    }

    let Database, drizzle, runMigrationsOn;
    try {
        Database = require("better-sqlite3");
        ({ drizzle } = await import("drizzle-orm/better-sqlite3"));
        ({ runMigrationsOn } = await import(pathToFileURL(DIST_MIGRATE_RUNNER)));
    } catch (e) {
        console.error(`SETUP ERROR: failed to load deps — ${e.message}`);
        process.exit(2);
    }

    const { root: tmpRoot, folder: pre0005Folder } = buildPre0005Folder();
    const dbPath = path.join(os.tmpdir(), `agent-mcp-fkmig-${crypto.randomUUID()}.db`);
    const conn = new Database(dbPath);
    conn.pragma("journal_mode = WAL");
    conn.pragma("foreign_keys = ON"); // production parity (client.ts)
    const db = drizzle(conn);

    try {
        // 1. Bring DB to the pre-0005 (0004) schema.
        runMigrationsOn(conn, db, pre0005Folder);
        const colsBefore = conn
            .prepare("PRAGMA table_info(tasks)")
            .all()
            .map((c) => c.name);
        if (!colsBefore.includes("depends_on"))
            fail("pre-0005 schema missing depends_on (migration chain wrong)");
        if (colsBefore.includes("is_ephemeral"))
            fail("is_ephemeral present before 0005 (excluded migration leaked)");

        // 2. Seed a task + a task_events row (FK off for the seed only).
        conn.pragma("foreign_keys = OFF");
        const now = new Date(0).toISOString();
        conn.prepare(
            `INSERT INTO tasks (id, session_id, parent_task_id, recursion_depth, status, prompt, created_at, updated_at)
             VALUES ('t-keep', 's-gone', NULL, 0, 'completed', 'seeded', ?, ?)`
        ).run(now, now);
        conn.prepare(
            `INSERT INTO task_events (id, task_id, type, created_at)
             VALUES ('e-keep', 't-keep', 'TASK_COMPLETED', ?)`
        ).run(now);
        conn.pragma("foreign_keys = ON");
        if (conn.prepare("SELECT count(*) c FROM task_events").get().c !== 1)
            fail("seed failed: task_events != 1");

        // 3. Apply 0005 via the SHIPPED FK-safe runner.
        runMigrationsOn(conn, db, REAL_FOLDER);

        // 4a. task_events MUST survive (the bug deletes it → 0).
        const evCount = conn.prepare("SELECT count(*) c FROM task_events").get().c;
        if (evCount !== 1)
            fail(
                `0005 cascade-wiped task_events (count=${evCount}, expected 1) — FK toggle missing in runMigrationsOn`
            );
        const ev = conn
            .prepare("SELECT task_id FROM task_events WHERE id='e-keep'")
            .get();
        if (!ev || ev.task_id !== "t-keep") fail("task_events row corrupted after migration");

        // 4b. 0005 actually applied + data intact.
        const colsAfter = conn.prepare("PRAGMA table_info(tasks)").all();
        if (!colsAfter.some((c) => c.name === "is_ephemeral"))
            fail("0005 did not add is_ephemeral");
        const sid = colsAfter.find((c) => c.name === "session_id");
        if (sid.notnull !== 0) fail("session_id not nullable after 0005");
        const task = conn
            .prepare("SELECT session_id, is_ephemeral FROM tasks WHERE id='t-keep'")
            .get();
        if (task.session_id !== "s-gone") fail("existing session_id not preserved");
        if (task.is_ephemeral !== 0) fail("existing row not backfilled is_ephemeral=0");

        // 4c. FK enforcement restored.
        if (conn.pragma("foreign_keys", { simple: true }) !== 1)
            fail("FK enforcement not restored after migration run");

        // 4d. Cascade FK still works on the recreated table.
        conn.prepare("DELETE FROM tasks WHERE id='t-keep'").run();
        if (conn.prepare("SELECT count(*) c FROM task_events").get().c !== 0)
            fail("cascade FK broken on recreated table");

        console.log(
            "PASS: 0005 migration preserved pre-existing task_events (FK-safe runner verified end-to-end)"
        );
    } finally {
        conn.close();
        try {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch {
            /* best-effort */
        }
        for (const s of ["", "-wal", "-shm"]) {
            try {
                fs.rmSync(`${dbPath}${s}`, { force: true });
            } catch {
                /* best-effort */
            }
        }
    }
}

main().catch((e) => {
    console.error(`ERROR: ${e?.stack || e}`);
    process.exit(2);
});
