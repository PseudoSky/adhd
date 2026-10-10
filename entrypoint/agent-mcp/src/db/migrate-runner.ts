import { migrate } from "drizzle-orm/better-sqlite3/migrator";

export const MIGRATIONS_FOLDER = new URL(
    "../../drizzle",
    import.meta.url
).pathname;

interface PragmaConn {
    pragma(source: string, options?: { simple: boolean }): unknown;
}

/** Upper bound on migrate() attempts when another opener is migrating the same file at the same moment. */
const MAX_MIGRATE_ATTEMPTS = 8;
/** Backoff before a retry: capped exponential with full jitter, so concurrent losers do not retry in lock-step. */
const BACKOFF_BASE_MS = 10;
const BACKOFF_CAP_MS = 250;

/** The two shapes of lost race, which differ in how far a retry may be trusted. */
export type MigrationRaceKind = "contention" | "already-applied";

/**
 * Classify `err` (or anything in its `cause` chain) as the signature of a CONCURRENT opener:
 *  - `contention`: the file is busy/locked right now. Transient by nature; retried (bounded, with backoff).
 *  - `already-applied`: a statement found its object already present (`duplicate column name`, `table X already
 *    exists`, ...) -- what the loser of the ledger-read/BEGIN race sees when a rival applied the same migration in
 *    between. It is ALSO what schema drift looks like, so it earns exactly one confirming retry per distinct message
 *    (see {@link runMigrationsOn}).
 * Returns undefined for everything else, which must surface immediately.
 */
export function classifyMigrationRace(err: unknown): MigrationRaceKind | undefined {
    for (let e: unknown = err, depth = 0; e !== undefined && e !== null && depth < 5; depth++) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/SQLITE_BUSY|SQLITE_LOCKED|database is (locked|busy)/i.test(msg)) return "contention";
        if (/duplicate column name|\b(table|index|view|trigger) \S+ already exists/i.test(msg)) return "already-applied";
        e = (e as { cause?: unknown }).cause;
    }
    return undefined;
}

/** True when `err` has the signature of a concurrent opener winning a migration race. See {@link classifyMigrationRace}. */
export function isConcurrentMigrationRace(err: unknown): boolean {
    return classifyMigrationRace(err) !== undefined;
}

/** Test seams for {@link runMigrationsOn}; production uses the defaults. */
export interface IMigrateRetryOptions {
    /** Block for `ms` (migrate() is synchronous, so the backoff is too). Defaults to `Atomics.wait`. */
    sleepMs?: (ms: number) => void;
    /** Uniform [0,1) source for the jitter. Defaults to `Math.random`. */
    random?: () => number;
}

function blockingSleep(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Apply the migrations in `migrationsFolder` to `drizzleDb`, tolerating a concurrent opener.
 *
 * The store is parallel-process enabled (ADR-0012): several processes may open and migrate one file at once.
 * Why retrying a lost race is correct: drizzle's SQLite migrator reads the applied-migrations ledger, then runs
 * every pending statement inside ONE `BEGIN ... COMMIT` and issues `ROLLBACK` on any error. A loser therefore
 * leaves no partial schema behind, and re-running `migrate()` re-reads the ledger (now including the rival's
 * work) and applies only what is still pending. That argument rests on the transaction rollback alone -- it does
 * not depend on any migration being additive.
 *
 * Bounds: at most {@link MAX_MIGRATE_ATTEMPTS} attempts with jittered backoff between them. A `contention` error
 * is retried within that bound. An `already-applied` error is retried only when its message differs from the
 * previous failure's: the same message twice, after a ledger re-read, means the object exists without a ledger
 * entry -- drift, not a race -- and it surfaces after that single confirming retry.
 */
export function runMigrationsOn(
    conn: PragmaConn,
    drizzleDb: Parameters<typeof migrate>[0],
    migrationsFolder: string = MIGRATIONS_FOLDER,
    opts: IMigrateRetryOptions = {}
): void {
    const sleepMs = opts.sleepMs ?? blockingSleep;
    const random = opts.random ?? Math.random;
    const fkWasOn =
        conn.pragma("foreign_keys", { simple: true }) === 1;

    if (fkWasOn) {
        conn.pragma("foreign_keys = OFF");
    }

    try {
        let lastAlreadyApplied: string | undefined;
        for (let attempt = 1; ; attempt++) {
            try {
                migrate(drizzleDb, { migrationsFolder });
                break;
            } catch (err) {
                const kind = classifyMigrationRace(err);
                if (attempt >= MAX_MIGRATE_ATTEMPTS || kind === undefined) throw err;
                if (kind === "already-applied") {
                    const message = err instanceof Error ? err.message : String(err);
                    if (message === lastAlreadyApplied) throw err; // confirmed on re-read: drift, not a race
                    lastAlreadyApplied = message;
                }
                sleepMs(Math.floor(random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1))));
            }
        }
    } finally {
        if (fkWasOn) {
            conn.pragma("foreign_keys = ON");
        }
    }
}
