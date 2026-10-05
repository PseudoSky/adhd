/**
 * `store-transaction.ts` — the ONE read-modify-write locking/retry contract for
 * the adhd agent stores, expressed ON TOP of `@adhd/sox-store-adapter` (ADR-0001
 * D3; backlog 331508ac AC4/AC5).
 *
 * ADR-0001 retires `better-sqlite3`-as-the-store and rejects a second,
 * better-sqlite3-specific locking implementation (Alternatives §A). The
 * substrate is the sox store adapter (Turso); the contract that survives on top
 * of it is:
 *
 *   1. `busy_timeout` on every connection — see `openRegistryStore`.
 *   2. `adapter.transaction(fn, { mode: 'immediate' })` (BEGIN IMMEDIATE) for
 *      every read-modify-write — {@link withImmediateRetry} always uses it.
 *   3. Bounded retry of **busy-shaped errors ONLY**, with exponential backoff +
 *      jitter — {@link withImmediateRetry}, classified by the adapter's own
 *      portable `isBusyError`/`isConcurrentConflict` (never `SQLITE_LOCKED`,
 *      never a same-connection statements-in-progress fault).
 *   4. ONE retry implementation for the whole store — this module.
 *
 * The contract is typed config + retry, never an env-var toggle (sox ADR-0013).
 * The value of `busy_timeout` is typed config; whether the contract applies is
 * not a switch.
 *
 * This mirrors `entrypoint/backlog`'s proven `withImmediateRetry`
 * (5 attempts, 20 ms → 500 ms cap, jitter, busy-only) — the in-repo precedent.
 */
import {
  isBusyError,
  isConcurrentConflict,
  type AdapterTransaction,
  type StoreAdapter,
} from '@adhd/sox-store-adapter';

/** Total attempts (first try + retries). Default 5 — the backlog precedent. */
export const DEFAULT_BUSY_MAX_ATTEMPTS = 5;
/** Base backoff in ms (doubles per attempt, then jittered). Default 20. */
export const DEFAULT_BUSY_RETRY_BASE_DELAY_MS = 20;
/** Per-sleep cap in ms. Default 500. */
export const DEFAULT_BUSY_RETRY_MAX_DELAY_MS = 500;
/** Default `busy_timeout` (ms) applied to every migrated registry connection. */
export const DEFAULT_REGISTRY_BUSY_TIMEOUT_MS = 5_000;

export interface BusyRetryConfig {
  /** Total attempts. Default {@link DEFAULT_BUSY_MAX_ATTEMPTS}; clamped to ≥1. */
  maxAttempts?: number;
  /** Base backoff in ms. Default {@link DEFAULT_BUSY_RETRY_BASE_DELAY_MS}. */
  baseDelayMs?: number;
  /** Per-sleep cap in ms. Default {@link DEFAULT_BUSY_RETRY_MAX_DELAY_MS}. */
  maxDelayMs?: number;
}

/**
 * True iff `err` is a busy/locked contention shape worth retrying — the
 * adapter's portable classification (`isBusyError` / `isConcurrentConflict`),
 * so the taxonomy stays driver-agnostic and single-sourced.
 */
export function isBusyContention(err: unknown): boolean {
  return isBusyError(err) || isConcurrentConflict(err);
}

/** Jittered async sleep (full-jitter in [0.5, 1.0] × delay). */
function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, Math.round(ms)))
  );
}

/**
 * Run `fn` inside `adapter.transaction(fn, { mode: 'immediate' })`, retrying the
 * WHOLE transaction a bounded number of times ONLY when it throws a busy-shaped
 * error (see {@link isBusyContention}). Any other error propagates immediately,
 * unretried; after the final attempt still fails busy, the last busy error is
 * re-thrown (a sustained pileup is a real failure — this bounds the wait, it
 * does not hide contention forever).
 *
 * `adapter` is narrowed to the one method this needs, so a test double can
 * supply a minimal `{ transaction }` shape.
 */
export async function withImmediateRetry<T>(
  adapter: Pick<StoreAdapter, 'transaction'>,
  fn: (tx: AdapterTransaction) => T | Promise<T>,
  opts: BusyRetryConfig = {}
): Promise<T> {
  const maxAttempts = Math.max(
    1,
    Math.trunc(opts.maxAttempts ?? DEFAULT_BUSY_MAX_ATTEMPTS)
  );
  const baseDelay = Math.max(
    0,
    opts.baseDelayMs ?? DEFAULT_BUSY_RETRY_BASE_DELAY_MS
  );
  const maxDelay = Math.max(
    baseDelay,
    opts.maxDelayMs ?? DEFAULT_BUSY_RETRY_MAX_DELAY_MS
  );

  for (let attempt = 0; ; attempt++) {
    try {
      return await adapter.transaction(fn, { mode: 'immediate' });
    } catch (err) {
      if (!isBusyContention(err) || attempt >= maxAttempts - 1) throw err;
      const delay = Math.min(maxDelay, baseDelay * 2 ** attempt);
      await sleepAsync(delay * (0.5 + Math.random() * 0.5));
    }
  }
}
