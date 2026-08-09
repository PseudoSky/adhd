/**
 * immediate-retry.ts — bounded, jittered exponential-backoff retry wrapper
 * around an `adapter.transaction(fn, { mode: 'immediate' })` call
 * (DEBT-BACKLOG-CONCURRENCY-BUSY-RETRY-001). `mutate-metadata.ts` / `ids.ts`
 * are the ONLY two write paths that use `mode: 'immediate'` directly
 * (DESIGN.md §3/§4.3) and both funnel through this wrapper — retrying ONLY
 * the specific `SQLITE_BUSY`/`SQLITE_BUSY_TIMEOUT`/`SQLITE_BUSY_SNAPSHOT`
 * error the adapter throws when a `BEGIN IMMEDIATE`'s wait exceeds
 * `busy_timeout`. Any other thrown error (including `NotFoundError`,
 * `ClaimContentionError`) propagates immediately, unretried — and the
 * semantic `'held'` claim-contention RESULT (claim.ts) is a normal RETURN
 * VALUE, never an exception, so it is never touched by this wrapper either.
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

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `attempt()` (expected to be
 * `() => store.adapter.transaction(fn, { mode: 'immediate' })`),
 * retrying up to `maxAttempts` times ONLY when it throws a SQLITE_BUSY-shaped
 * error, with jittered exponential backoff between attempts (20ms, 40ms,
 * 80ms, 160ms, capped at 500ms). Any other error propagates immediately.
 * After the final attempt still fails, the last SQLITE_BUSY error is
 * re-thrown (a genuine, sustained pileup is still a real failure — this
 * bounds the wait, it doesn't hide contention forever).
 */
export async function withImmediateRetry<T>(attempt: () => Promise<T>, opts: ImmediateRetryOpts = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (!isSqliteBusyError(err) || i >= maxAttempts - 1) throw err;
      const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** i);
      await sleepMs(delay * (0.5 + Math.random() * 0.5));
    }
  }
}
