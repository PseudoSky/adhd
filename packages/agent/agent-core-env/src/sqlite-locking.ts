/**
 * `sqlite-locking.ts` — the explicit parallel-process locking contract for
 * the agent-* SQLite clients.
 *
 * The repo invariant (AGENTS.md hard rule; ADR-0012, superseding ADR-0007) is
 * that every store is parallel-process enabled: multiple processes may hold
 * concurrent write connections to the same SQLite file. This module makes the
 * connect-time half of that contract EXPLICIT, CONFIGURABLE and TYPED (never
 * an env-var toggle — ADR-0013):
 *
 *   1. `journal_mode = WAL`     — readers do not block the writer.
 *   2. `foreign_keys = ON`.
 *   3. `busy_timeout = N` (ms)  — a writer that loses the lock race waits a
 *      bounded time for the holder before surfacing an error.
 *
 * SCOPE NOTE (backlog 331508ac): the original report claimed these clients
 * surfaced an *immediate* `SQLITE_BUSY` because they "never set busy_timeout".
 * That specific symptom does NOT reproduce — `better-sqlite3` installs a
 * 5000ms busy handler by default (`new Database(path).pragma('busy_timeout')`
 * reads back `5000`). What was genuinely missing is an explicit, configurable,
 * single-sourced contract; relying on an undocumented driver default is not a
 * guarantee. The read-modify-write `BEGIN IMMEDIATE` obligation (so a
 * check-then-write cannot race) and a bounded BUSY-only retry for sustained
 * contention remain open — see the backlog item.
 */

/** Default `busy_timeout` budget in milliseconds. Long enough to absorb a
 *  sibling process's short write transaction, short enough that a genuinely
 *  wedged holder still surfaces as an error rather than an infinite hang. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/** Minimal structural type for a better-sqlite3 connection — avoids importing
 *  the runtime class merely to type the pragma call. */
export interface ISqliteConn {
  pragma(source: string, options?: { simple: boolean }): unknown;
}

export interface LockingPragmaOpts {
  /** `busy_timeout` budget in ms. Defaults to {@link DEFAULT_BUSY_TIMEOUT_MS}. */
  busyTimeoutMs?: number;
}

/**
 * Applies the connect-time locking pragmas to a raw SQLite connection:
 * `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = N`. Safe to call
 * more than once. This is the ONE place the pragma trio is defined so every
 * agent-* client stays in sync.
 */
export function applyLockingPragmas(
  sqlite: ISqliteConn,
  opts: LockingPragmaOpts = {}
): void {
  const busyTimeoutMs = Math.max(
    0,
    Math.trunc(opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS)
  );
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma(`busy_timeout = ${busyTimeoutMs}`);
}
