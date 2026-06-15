import { migrate } from "drizzle-orm/better-sqlite3/migrator";

/**
 * Folder holding the drizzle-kit generated migrations (../../drizzle relative
 * to this compiled module). Kept here — with no `client.js` import — so test
 * harnesses can reuse the FK-safe runner without dragging in the production
 * singleton connection (which opens a DB file at import time).
 */
export const MIGRATIONS_FOLDER = new URL(
    "../../drizzle",
    import.meta.url
).pathname;

/**
 * Minimal structural type for the bits of a better-sqlite3 connection we need.
 * Avoids importing the better-sqlite3 type just to call `pragma`.
 */
interface PragmaConn {
    pragma(source: string, options?: { simple: boolean }): unknown;
}

/**
 * Run Drizzle migrations against an explicit connection with foreign-key
 * enforcement disabled for the duration of the run.
 *
 * WHY THIS WRAPPER EXISTS: SQLite silently ignores `PRAGMA foreign_keys`
 * **inside a transaction**, and drizzle's migrator wraps each migration file in
 * one. SQLite's only way to alter table constraints is the table-recreate dance
 * (CREATE `__new_x` → INSERT-SELECT → DROP `x` → RENAME). When such a migration
 * runs with FK enforcement ON (which both production `client.ts` and the test
 * harness set), the `DROP TABLE` cascade-deletes every child row — e.g. all of
 * `task_events`, which has `task_id … ON DELETE CASCADE` — even though
 * drizzle-kit emits `PRAGMA foreign_keys=OFF` as the migration's first
 * statement (that statement is the no-op described above). The 0005 migration
 * recreates `tasks`, so without this wrapper a real upgrade wipes a user's
 * entire task-event history. Disabling enforcement on the connection *before*
 * migrate() — while no transaction is open — is the only way to make it hold
 * for the whole run; we restore the prior setting afterwards.
 */
export function runMigrationsOn(
    conn: PragmaConn,
    drizzleDb: Parameters<typeof migrate>[0],
    migrationsFolder: string = MIGRATIONS_FOLDER
): void {
    const fkWasOn =
        conn.pragma("foreign_keys", { simple: true }) === 1;

    if (fkWasOn) {
        conn.pragma("foreign_keys = OFF");
    }

    try {
        migrate(drizzleDb, { migrationsFolder });
    } finally {
        if (fkWasOn) {
            conn.pragma("foreign_keys = ON");
        }
    }
}
