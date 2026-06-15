/**
 * migration-fk-cascade.integration.test.ts
 *
 * Regression test for the 0005 table-recreate cascade-wipe bug.
 *
 * The 0005 migration recreates the `tasks` table (CREATE __new_tasks →
 * INSERT-SELECT → DROP tasks → RENAME) to make `session_id` nullable and add
 * `is_ephemeral`. `task_events.task_id` has `ON DELETE CASCADE`. If migrations
 * run with foreign-key enforcement ON (production and the harness both set it
 * ON), the `DROP TABLE tasks` cascades and deletes EVERY pre-existing
 * task_events row — drizzle-kit's in-SQL `PRAGMA foreign_keys=OFF` is a no-op
 * because it runs inside the migrator's transaction.
 *
 * `runMigrationsOn` disables FK enforcement on the connection BEFORE migrate(),
 * which is the only place SQLite honours the pragma. This test proves that:
 *   - seed a DB at the pre-0005 (0004) schema with a task + task_events row,
 *   - apply 0005 via runMigrationsOn,
 *   - assert the task_events row SURVIVES and 0005 actually applied.
 *
 * TEETH: revert runMigrationsOn to a bare `migrate()` and this test goes red
 * (task_events count becomes 0). Verified manually during implementation.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { runMigrationsOn } from "../../db/migrate-runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REAL_FOLDER = path.resolve(__dirname, "../../../drizzle");

const TARGET_MIGRATION = "0005_clear_lenny_balinger";

/**
 * Build a temp migrations folder containing only the migrations BEFORE 0005,
 * so we can bring a DB to the exact pre-0005 schema and then apply 0005 alone.
 */
function buildPre0005Folder(): string {
    const journal = JSON.parse(
        fs.readFileSync(
            path.join(REAL_FOLDER, "meta", "_journal.json"),
            "utf8"
        )
    ) as { entries: { tag: string }[] };

    const pre = journal.entries.filter((e) => e.tag !== TARGET_MIGRATION);
    expect(pre.length).toBe(journal.entries.length - 1); // 0005 must exist & be excluded

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mcp-mig-"));
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
    return folder;
}

describe("T9: 0005 migration preserves pre-existing task_events (no FK cascade wipe)", () => {
    it("a task_events row seeded at the 0004 schema survives the 0005 table-recreate", () => {
        const pre0005Folder = buildPre0005Folder();
        const dbPath = path.join(
            os.tmpdir(),
            `agent-mcp-migtest-${crypto.randomUUID()}.db`
        );
        const conn = new Database(dbPath);
        conn.pragma("journal_mode = WAL");
        conn.pragma("foreign_keys = ON"); // production parity
        const db = drizzle(conn);

        try {
            // 1. Bring the DB to the pre-0005 (0004) schema.
            runMigrationsOn(
                conn,
                db as Parameters<typeof runMigrationsOn>[1],
                pre0005Folder
            );

            // Sanity: tasks has the 0004 DAG columns but NOT is_ephemeral yet.
            const colsBefore = (
                conn.prepare("PRAGMA table_info(tasks)").all() as {
                    name: string;
                }[]
            ).map((c) => c.name);
            expect(colsBefore).toContain("depends_on");
            expect(colsBefore).not.toContain("is_ephemeral");

            // 2. Seed a task + a task_events row. Disable FK for the seed only,
            //    so we don't need to satisfy the (about-to-be-dropped) sessions FK.
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

            expect(
                (
                    conn
                        .prepare("SELECT count(*) c FROM task_events")
                        .get() as { c: number }
                ).c
            ).toBe(1);

            // 3. Apply ONLY 0005 via the FK-safe runner (real folder).
            runMigrationsOn(
                conn,
                db as Parameters<typeof runMigrationsOn>[1],
                REAL_FOLDER
            );

            // 4a. The task_events row MUST survive (the bug deletes it → count 0).
            expect(
                (
                    conn
                        .prepare("SELECT count(*) c FROM task_events")
                        .get() as { c: number }
                ).c
            ).toBe(1);
            const event = conn
                .prepare("SELECT id, task_id FROM task_events WHERE id = 'e-keep'")
                .get() as { id: string; task_id: string } | undefined;
            expect(event).toBeDefined();
            expect(event!.task_id).toBe("t-keep");

            // 4b. 0005 actually applied: is_ephemeral exists, session_id nullable,
            //     the seeded row is backfilled to is_ephemeral=0, data intact.
            const colsAfter = (
                conn.prepare("PRAGMA table_info(tasks)").all() as {
                    name: string;
                    notnull: number;
                }[]
            );
            const colNames = colsAfter.map((c) => c.name);
            expect(colNames).toContain("is_ephemeral");
            const sessionCol = colsAfter.find((c) => c.name === "session_id");
            expect(sessionCol!.notnull).toBe(0); // nullable

            const task = conn
                .prepare(
                    "SELECT id, session_id, is_ephemeral FROM tasks WHERE id = 't-keep'"
                )
                .get() as {
                id: string;
                session_id: string | null;
                is_ephemeral: number;
            };
            expect(task.session_id).toBe("s-gone"); // existing value preserved
            expect(task.is_ephemeral).toBe(0); // backfilled

            // 4c. FK enforcement was restored after the run.
            expect(
                conn.pragma("foreign_keys", { simple: true })
            ).toBe(1);

            // 4d. The cascade FK still works on the recreated table.
            conn.prepare("DELETE FROM tasks WHERE id = 't-keep'").run();
            expect(
                (
                    conn
                        .prepare("SELECT count(*) c FROM task_events")
                        .get() as { c: number }
                ).c
            ).toBe(0); // cascaded now that we actually delete the parent
        } finally {
            conn.close();
            try {
                fs.rmSync(path.dirname(path.dirname(pre0005Folder)), {
                    recursive: true,
                    force: true,
                });
            } catch {
                /* best-effort temp cleanup */
            }
            for (const suffix of ["", "-wal", "-shm"]) {
                try {
                    fs.rmSync(`${dbPath}${suffix}`, { force: true });
                } catch {
                    /* best-effort */
                }
            }
        }
    });
});
