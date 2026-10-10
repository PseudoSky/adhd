import { migrate } from "drizzle-orm/better-sqlite3/migrator";

export const MIGRATIONS_FOLDER = new URL(
    "../../drizzle",
    import.meta.url
).pathname;

interface PragmaConn {
    pragma(source: string, options?: { simple: boolean }): unknown;
}

/** Bounded re-attempts when another opener migrates the same file at the same moment. */
const MAX_MIGRATE_ATTEMPTS = 8;

/**
 * True when `err` (or anything in its `cause` chain) is the signature of a CONCURRENT opener winning the
 * migration race: drizzle's migrator reads the applied-migrations ledger and then writes, in a deferred
 * transaction, so two processes opening one database file can both decide to apply `ALTER TABLE ... ADD`
 * and the loser fails with `duplicate column name` (or a busy/locked error). The loser's transaction rolls
 * back whole, so re-running `migrate()` is exactly right: it re-reads the ledger and applies only what remains.
 */
export function isConcurrentMigrationRace(err: unknown): boolean {
    for (let e: unknown = err, depth = 0; e !== undefined && e !== null && depth < 5; depth++) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/duplicate column name|already exists|SQLITE_BUSY|database is locked/i.test(msg)) return true;
        e = (e as { cause?: unknown }).cause;
    }
    return false;
}

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
        // The store is parallel-process enabled (ADR-0012): several processes may open and migrate the same
        // file concurrently, so a lost race is retried rather than surfaced (every migration is additive).
        for (let attempt = 1; ; attempt++) {
            try {
                migrate(drizzleDb, { migrationsFolder });
                break;
            } catch (err) {
                if (attempt >= MAX_MIGRATE_ATTEMPTS || !isConcurrentMigrationRace(err)) throw err;
            }
        }
    } finally {
        if (fkWasOn) {
            conn.pragma("foreign_keys = ON");
        }
    }
}
