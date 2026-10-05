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

/** Default total attempts (first try + retries) for {@link withBusyRetry}. */
export const DEFAULT_BUSY_MAX_ATTEMPTS = 5;

/** Default base backoff in ms for {@link withBusyRetry} (doubles per attempt). */
export const DEFAULT_BUSY_RETRY_BASE_DELAY_MS = 20;

/** Upper bound on a single {@link withBusyRetry} backoff sleep, in ms. */
export const DEFAULT_BUSY_RETRY_MAX_DELAY_MS = 500;

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

/**
 * True iff `err` is a SQLite lock-contention error — i.e. the connection lost
 * a writer race and should be retried. This is the ONE classifier for the
 * agent-* SQLite clients (mirroring `@adhd/sox-store-adapter`'s `isBusyError`
 * seam that `entrypoint/backlog`'s retry wrapper keys on).
 *
 * Both `SQLITE_BUSY*` (the database file is locked by another connection, or a
 * deferred reader could not upgrade to a writer) and `SQLITE_LOCKED*` (a
 * conflicting lock within the same connection / shared-cache) are contention
 * shapes; every OTHER error (`SQLITE_CONSTRAINT`, a `ToolError`, a plain
 * `Error`) is a real failure and must NOT be retried.
 */
export function isSqliteBusyError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  return code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED');
}

/** Synchronous sleep via `Atomics.wait` — a deterministic wait that neither
 *  busy-spins the CPU nor yields to the (irrelevant) event loop. */
function sleepSyncMs(ms: number): void {
  const clamped = Math.max(0, Math.round(ms));
  if (clamped === 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, clamped);
}

export interface BusyRetryOpts {
  /** Total attempts (first try + retries). Default
   *  {@link DEFAULT_BUSY_MAX_ATTEMPTS}. A value < 1 is clamped to 1, which
   *  disables retry (the first busy error propagates). */
  maxAttempts?: number;
  /** Base backoff in ms. Default {@link DEFAULT_BUSY_RETRY_BASE_DELAY_MS}. */
  baseDelayMs?: number;
  /** Per-sleep cap in ms. Default {@link DEFAULT_BUSY_RETRY_MAX_DELAY_MS}. */
  maxDelayMs?: number;
}

/**
 * Runs `attempt()` — expected to open a `BEGIN IMMEDIATE` write transaction
 * (drizzle's `.transaction(fn, { behavior: 'immediate' })`, or better-sqlite3's
 * `tx.immediate()`) — and retries it a BOUNDED number of times ONLY when it
 * throws a SQLite lock-contention error (see {@link isSqliteBusyError}).
 *
 * Why both halves are required (backlog 331508ac):
 *   - `busy_timeout` (see {@link applyLockingPragmas}) makes a contending
 *     writer WAIT up to its budget before failing — but a sustained held lock
 *     still eventually fails, and a lost write should be retried, not dropped.
 *   - `BEGIN IMMEDIATE` removes the deferred-read → write-upgrade race, so the
 *     retry only ever replays a transaction that never observed a partial
 *     state (the safety invariant the read-modify-write paths need).
 *
 * Any non-busy error propagates immediately, unretried. After the final attempt
 * still fails busy, the last busy error is re-thrown: a genuine, sustained
 * pileup is still a real failure — this bounds the wait, it does not hide
 * contention forever.
 */
export function withBusyRetry<T>(
  attempt: () => T,
  opts: BusyRetryOpts = {}
): T {
  const maxAttempts = Math.max(1, Math.trunc(opts.maxAttempts ?? DEFAULT_BUSY_MAX_ATTEMPTS));
  if (maxAttempts === 1) return attempt();

  const baseDelay = Math.max(0, opts.baseDelayMs ?? DEFAULT_BUSY_RETRY_BASE_DELAY_MS);
  const maxDelay = Math.max(baseDelay, opts.maxDelayMs ?? DEFAULT_BUSY_RETRY_MAX_DELAY_MS);

  for (let i = 0; ; i++) {
    try {
      return attempt();
    } catch (err) {
      if (!isSqliteBusyError(err) || i >= maxAttempts - 1) throw err;
      sleepSyncMs(Math.min(maxDelay, baseDelay * 2 ** i));
    }
  }
}
