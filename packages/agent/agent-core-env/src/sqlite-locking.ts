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
 * SCOPE NOTE (ADR-0001, backlog 331508ac): `better-sqlite3`-as-the-store is
 * RETIRED. The sanctioned substrate is the sox store adapter (Turso) — see
 * `open-registry-store.ts` (the adapter-backed open, applying the same
 * `busy_timeout` via `adapter.pragmaSet`) and `store-transaction.ts` (the
 * `BEGIN IMMEDIATE` + bounded busy-only retry contract, on top of the adapter).
 *
 * This module remains ONLY for the `better-sqlite3` consumers the ADR's D4
 * sequence has not yet migrated (Drizzle-based stores still receive a
 * better-sqlite3 handle). It is not a second locking implementation: it is the
 * connect-time pragma trio applied to the not-yet-migrated substrate. New
 * stores MUST start on the adapter (ADR-0001 D1).
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
