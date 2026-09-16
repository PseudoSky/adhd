/**
 * immediate-retry.ts — bounded, jittered exponential-backoff retry wrapper
 * around `adapter.transaction(fn, { mode: 'immediate' })` (DEBT-BACKLOG-
 * CONCURRENCY-BUSY-RETRY-001). `mutate-metadata.ts` and
 * `graph-backlog-store.ts`'s schema apply are the write paths that reach the
 * `immediate` mode directly, and both funnel through this wrapper.
 *
 * It retries ONLY busy-shaped errors, and it does not classify them itself:
 * `@adhd/sox-store-adapter`'s `isBusyError`/`isConcurrentConflict` duck-type
 * checks are the single portable definition of "this write lost a lock race"
 * — the same helpers the adapter's own retry loop uses. Keeping the
 * classification behind that seam is the point: every driver-specific error
 * shape lives on the adapter's side of it, and nothing here needs to know
 * which substrate raised the error.
 *
 * Any other thrown error (including `NotFoundError`, `ClaimContentionError`)
 * propagates immediately, unretried — and the semantic `'held'`
 * claim-contention RESULT (claim.ts) is a normal RETURN VALUE, never an
 * exception, so it is never touched by this wrapper either.
 */

import { isBusyError, isConcurrentConflict } from '@adhd/sox-store-adapter';

const DEFAULT_MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 20;
const MAX_DELAY_MS = 500;

export interface ImmediateRetryOpts {
  /** Total attempts (first try + retries). Default 5. */
  maxAttempts?: number;
}

/** True iff `err` is a busy/locked contention error, on whichever substrate the adapter is driving. */
function isBusyContention(err: unknown): boolean {
  return isBusyError(err) || isConcurrentConflict(err);
}

/**
 * Jittered async sleep. The store-adapter API is fully async end-to-end, so
 * the retry wrapper waits via a real `setTimeout` promise — the event loop
 * stays free for the adapter's own async connection/query machinery. The
 * driver underneath does async I/O, so a blocking wait here would starve the
 * very machinery the retry is waiting on.
 */
function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.round(ms))));
}

/**
 * Runs `attempt()` (expected to be
 * `() => adapter.transaction(fn, { mode: 'immediate' })`), retrying up to
 * `maxAttempts` times ONLY when it throws a busy-shaped error, with jittered
 * exponential backoff between attempts (20ms, 40ms, 80ms, 160ms, capped at
 * 500ms). Any other error propagates immediately. After the final attempt
 * still fails, the last busy error is re-thrown (a genuine, sustained pileup
 * is still a real failure — this bounds the wait, it doesn't hide contention
 * forever).
 */
export async function withImmediateRetry<T>(attempt: () => Promise<T>, opts: ImmediateRetryOpts = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (!isBusyContention(err) || i >= maxAttempts - 1) throw err;
      const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** i);
      await sleepAsync(delay * (0.5 + Math.random() * 0.5));
    }
  }
}
