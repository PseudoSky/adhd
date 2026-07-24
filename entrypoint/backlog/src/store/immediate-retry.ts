/**
 * immediate-retry.ts — bounded, jittered exponential-backoff retry wrapper
 * around a `db.transaction(fn).immediate()` call (DEBT-BACKLOG-CONCURRENCY-
 * BUSY-RETRY-001). `mutate-metadata.ts` / `ids.ts` are the ONLY two write
 * paths that call `.immediate()` directly (DESIGN.md §3/§4.3) and both funnel
 * through this wrapper — retrying ONLY the specific `SQLITE_BUSY`/
 * `SQLITE_BUSY_TIMEOUT`/`SQLITE_BUSY_SNAPSHOT` error `better-sqlite3` throws
 * when a `BEGIN IMMEDIATE`'s wait exceeds `busy_timeout`. Any other thrown
 * error (including `NotFoundError`, `ClaimContentionError`) propagates
 * immediately, unretried — and the semantic `'held'` claim-contention RESULT
 * (claim.ts) is a normal RETURN VALUE, never an exception, so it is never
 * touched by this wrapper either.
 */

const DEFAULT_MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 20;
const MAX_DELAY_MS = 500;

export interface ImmediateRetryOpts {
  /** Total attempts (first try + retries). Default 5. */
  maxAttempts?: number;
}

function isSqliteBusyError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_TIMEOUT' || code === 'SQLITE_BUSY_SNAPSHOT';
}

/**
 * Synchronous jittered sleep. `better-sqlite3` is synchronous end-to-end (no
 * `await` anywhere in the write path), so an async backoff would force every
 * caller of `mutateMetadata`/`allocateHumanId` onto a Promise chain for no
 * benefit. `Atomics.wait` blocks only the CURRENT thread/process — exactly
 * the "one-shot CLI process" unit this store is designed around (DESIGN.md
 * §12) — never anything else concurrently running elsewhere.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Math.round(ms)));
}

/**
 * Runs `attempt()` (expected to be `() => db.transaction(fn).immediate()`),
 * retrying up to `maxAttempts` times ONLY when it throws a SQLITE_BUSY-shaped
 * error, with jittered exponential backoff between attempts (20ms, 40ms,
 * 80ms, 160ms, capped at 500ms). Any other error propagates immediately.
 * After the final attempt still fails, the last SQLITE_BUSY error is
 * re-thrown (a genuine, sustained pileup is still a real failure — this
 * bounds the wait, it doesn't hide contention forever).
 */
export function withImmediateRetry<T>(attempt: () => T, opts: ImmediateRetryOpts = {}): T {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  for (let i = 0; ; i++) {
    try {
      return attempt();
    } catch (err) {
      if (!isSqliteBusyError(err) || i >= maxAttempts - 1) throw err;
      const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** i);
      sleepSync(delay * (0.5 + Math.random() * 0.5));
    }
  }
}
