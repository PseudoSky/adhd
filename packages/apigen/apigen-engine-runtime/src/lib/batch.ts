/**
 * `invokeBatch` — F1/F4 (BATCH_0.0.1.md §3): pure orchestration over the
 * existing `createInvoker`/Layer harness (`./invoke.ts`).
 *
 * This is the NON-portable half of the batch design (§5/§F3) — calling
 * `invoke()` N times with a concurrency scheduler is TS-runtime plumbing. The
 * portable half (the `oneOf`/discriminator wire shape, `BatchOptions`/
 * `BatchItemResult` as a JSON-Schema-describable contract) lives in
 * `@adhd/apigen-core-client/src/lib/batch.ts`; this module has no dependency
 * on it and no schema-derivation concerns of its own.
 *
 * Every Layer (auth, logging, sanitize, validate — §8.1) still runs per item,
 * unchanged: `invokeBatch` calls the SAME composed `invoke` function
 * `createInvoker` returns, N times, with concurrency control — never a
 * bypass of the Layer stack.
 */

import { isApiStream, collectWithPhase } from './stream';
import type { Call, InvokeFn, InvokeOptions } from './invoke';
import { ApiError, isApiError } from '@adhd/apigen-base-errors';

// ---------------------------------------------------------------------------
// §3 — BatchOptions / BatchItemResult
// ---------------------------------------------------------------------------

/** Concurrency ceiling used when the caller doesn't request one. */
export const BATCH_DEFAULT_CONCURRENCY = 4;

/**
 * Hard cap on requested concurrency, enforced regardless of what the caller
 * asks for (§3 — "Concurrency ceiling is framework-enforced, not advisory",
 * the direct lesson of `BUG-AGENTMCP-TRIAGE-CONCURRENCY-001`'s unbounded
 * fan-out incident).
 */
export const BATCH_MAX_CONCURRENCY = 32;

/**
 * Options accepted by {@link invokeBatch} (§3).
 *
 * The JSON-Schema-describable wire-contract half of this shape (what a
 * non-TS host implements against) is specified independently in
 * BATCH_0.0.1.md §F3/§5 and `apigen-core-client`'s `buildBatchKindSchema`
 * branch shape — this TS interface is the runtime-only mirror of it.
 */
export interface BatchOptions {
  /**
   * Caller-requested fan-out width. Clamped to `[1, BATCH_MAX_CONCURRENCY]`
   * — never honored above the hard cap, and forced to `1` for
   * `mode: 'serial' | 'chained'`.
   * @default BATCH_DEFAULT_CONCURRENCY
   */
  concurrency?: number;
  /**
   * - `'parallel'` (default) — up to `concurrency` items in flight at once.
   * - `'serial'` — one item at a time, in order; a failure does NOT stop
   *   later items unless `onItemError: 'abort'` is also set.
   * - `'chained'` — one item at a time, in order, and a failure ALWAYS stops
   *   every remaining item (each result: `rejected`, reason: an "upstream
   *   item failed" error) regardless of `onItemError` — the DAG
   *   `depends_on`-style behavior §0's motivating incident hand-built
   *   (`BUG-AGENTMCP-TRIAGE-CONCURRENCY-001`). `calls` carries no explicit
   *   dependency edges in v1; `'chained'` is the single linear-chain case of
   *   that pattern, not a general DAG — a richer per-item dependency graph is
   *   out of scope for v1 (see BATCH_0.0.1.md §7 open-question 3's
   *   `batchId`/interactive-cancel deferral, same rationale).
   * @default 'parallel'
   */
  mode?: 'parallel' | 'serial' | 'chained';
  /**
   * `'continue'` (default) — `Promise.allSettled` semantics: every item
   * runs regardless of earlier failures.
   * `'abort'` — once ANY item rejects, every not-yet-started item resolves
   * as `rejected` without ever being invoked (in-flight items under
   * `'parallel'` are allowed to finish; they are not force-cancelled by this
   * setting alone — see `itemTimeoutMs` / the batch's own `AbortSignal` for
   * that).
   * @default 'continue'
   */
  onItemError?: 'continue' | 'abort';
  /**
   * (F4) Per-item timeout in milliseconds. When set, each item gets its own
   * `AbortSignal` — DERIVED/LINKED from that item's `Call.signal` (the
   * whole-batch/whole-request signal): aborting the batch signal aborts the
   * item immediately, and the item additionally self-aborts after
   * `itemTimeoutMs` if it hasn't settled. This composes rather than bypasses
   * whole-batch cancellation (§3's "two distinct, composable operations").
   */
  itemTimeoutMs?: number;
}

/** Per-item result shape (§3). Mirrors `apigen-core-client`'s `batchItemResultSchema` wire fragment. */
export type BatchItemResult<T = unknown> =
  | { index: number; status: 'fulfilled'; value: T }
  | { index: number; status: 'fulfilled'; chunks: unknown[] }
  | { index: number; status: 'rejected'; reason: unknown; chunksDelivered?: number };

// ---------------------------------------------------------------------------
// BUG-APIGEN-047 — normalize a rejected item's `reason` for the wire
// ---------------------------------------------------------------------------

/**
 * Normalize a rejected item's `reason` into a JSON-serializable shape before
 * it's returned from {@link invokeBatch} (BUG-APIGEN-047).
 *
 * A bare thrown `Error` has no own enumerable properties — `message`,
 * `stack`, and `name` all live on the prototype chain — so `JSON.stringify`
 * (the only thing an HTTP/JSON transport can do to `reason`) silently drops
 * all of them, leaving a consumer with `{}` instead of the real failure
 * reason. This mirrors the EXISTING apigen error-model convention already
 * used by every other transport adapter that has to marshal an unknown throw
 * (`apigen-plugin-api-fastify`'s `toErrorBody`, `apigen-plugin-mcp`'s stream
 * error path): duck-type via `isApiError` (never `instanceof ApiError` — see
 * that guard's own doc comment for why a referential check is unsafe across
 * bundled `@adhd/*` packages), and wrap any other thrown `Error` in a real
 * `ApiError('internal', message)`, which already carries a `toJSON()` that
 * `JSON.stringify` invokes automatically.
 *
 * `reason instanceof Error` also catches `DOMException` — e.g. the
 * `itemTimeoutMs` abort reason fabricated in {@link deriveItemSignal} —
 * because Node's `DOMException` class extends `Error`, and it suffers the
 * identical wire-loss bug (`JSON.stringify(new DOMException(...))` also
 * produces `{}`; `name`/`message` are non-enumerable on it too), so it is
 * normalized the same way. Anything that is NOT an `Error` instance (a plain
 * object, a string, ...) is not this bug's failure mode — it either already
 * serializes fine as-is or is a domain-specific shape the caller built on
 * purpose — and passes through completely unchanged, never re-wrapped.
 */
function normalizeReason(reason: unknown): unknown {
  if (isApiError(reason)) return reason;
  if (reason instanceof Error) {
    return new ApiError('internal', reason.message);
  }
  return reason;
}

// ---------------------------------------------------------------------------
// Concurrency resolution
// ---------------------------------------------------------------------------

function resolveConcurrency(
  mode: NonNullable<BatchOptions['mode']>,
  requested: number | undefined
): number {
  if (mode === 'serial' || mode === 'chained') return 1;
  const n = requested ?? BATCH_DEFAULT_CONCURRENCY;
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), BATCH_MAX_CONCURRENCY);
}

// ---------------------------------------------------------------------------
// F4 — per-item signal derivation (linked to the batch signal + itemTimeoutMs)
// ---------------------------------------------------------------------------

interface DerivedSignal {
  signal: AbortSignal | undefined;
  dispose(): void;
}

/** No-op disposer for the common case (no batch signal, no itemTimeoutMs) — nothing to clean up. */
function NOOP_DISPOSE(): void {
  /* nothing to dispose when no signal/timer was ever created */
}

/**
 * Derive the effective per-item `AbortSignal` (F4).
 *
 * - No `batchSignal` and no `itemTimeoutMs` → pass through `undefined`
 *   (identical to today's single-`invoke()` behavior — no new signal
 *   fabricated when nothing asked for one).
 * - Otherwise → a new `AbortController` whose abort is triggered by
 *   whichever fires first: the batch signal aborting, or the per-item
 *   timeout elapsing. Composes rather than bypasses whole-batch abort.
 */
function deriveItemSignal(
  batchSignal: AbortSignal | undefined,
  itemTimeoutMs: number | undefined
): DerivedSignal {
  if (!batchSignal && !itemTimeoutMs) {
    return { signal: undefined, dispose: NOOP_DISPOSE };
  }

  const ac = new AbortController();
  const onBatchAbort = (): void => {
    ac.abort(batchSignal?.reason);
  };

  if (batchSignal) {
    if (batchSignal.aborted) {
      ac.abort(batchSignal.reason);
    } else {
      batchSignal.addEventListener('abort', onBatchAbort, { once: true });
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (itemTimeoutMs !== undefined && !ac.signal.aborted) {
    timer = setTimeout(() => {
      ac.abort(
        new DOMException(
          `apigen/invokeBatch: item timed out after ${itemTimeoutMs}ms`,
          'TimeoutError'
        )
      );
    }, itemTimeoutMs);
    timer.unref?.();
  }

  return {
    signal: ac.signal,
    dispose(): void {
      if (batchSignal) batchSignal.removeEventListener('abort', onBatchAbort);
      if (timer) clearTimeout(timer);
    },
  };
}

// ---------------------------------------------------------------------------
// Single-item execution (streaming-aware — §4 Tier 1)
// ---------------------------------------------------------------------------

async function runSingleItem(
  invoke: InvokeFn,
  fnName: string,
  index: number,
  call: Call,
  opts: InvokeOptions,
  itemTimeoutMs: number | undefined
): Promise<BatchItemResult> {
  const derived = deriveItemSignal(call.signal, itemTimeoutMs);
  try {
    const itemCall: Call = derived.signal ? { ...call, signal: derived.signal } : call;
    const raw = await invoke(fnName, itemCall, opts);
    if (isApiStream(raw)) {
      const collected = await collectWithPhase(raw);
      if (collected.ok) {
        return { index, status: 'fulfilled', chunks: collected.chunks };
      }
      const carrier = collected.carrier;
      return {
        index,
        status: 'rejected',
        reason: normalizeReason(carrier.error),
        ...(carrier.phase === 'after-first-chunk'
          ? { chunksDelivered: carrier.chunksDelivered }
          : {}),
      };
    }
    return { index, status: 'fulfilled', value: raw };
  } catch (err) {
    return { index, status: 'rejected', reason: normalizeReason(err) };
  } finally {
    derived.dispose();
  }
}

// ---------------------------------------------------------------------------
// invokeBatch — §3
// ---------------------------------------------------------------------------

/**
 * Fan out `calls.length` invocations of `fnName` through the already-composed
 * `invoke` function `createInvoker(layers)` returned — pure orchestration,
 * never a bypass of the Layer stack (§3).
 *
 * @param invoke   - The composed invoke function from `createInvoker(layers)`.
 * @param fnName   - The operation name to invoke for every item.
 * @param calls    - One {@link Call} per item — each carries its own
 *                   `domainArgs`; `signal`/`envelope`/`ctx` are typically the
 *                   same shared batch-level values across all items (F4:
 *                   per-item cancellation is derived from `call.signal`, not
 *                   a second signal the caller must fabricate per item).
 * @param opts     - `InvokeOptions` — same runtime dispatch options passed to
 *                   `invoke` for every item.
 * @param batch    - {@link BatchOptions} — concurrency/mode/onItemError/itemTimeoutMs.
 */
export async function invokeBatch(
  invoke: InvokeFn,
  fnName: string,
  calls: readonly Call[],
  opts: InvokeOptions,
  batch: BatchOptions = {}
): Promise<BatchItemResult[]> {
  const mode = batch.mode ?? 'parallel';
  const onItemError = batch.onItemError ?? 'continue';
  const concurrency = resolveConcurrency(mode, batch.concurrency);
  const results: BatchItemResult[] = new Array(calls.length);

  const notAttempted = (index: number): BatchItemResult => ({
    index,
    status: 'rejected',
    reason: normalizeReason(
      new Error(
        'apigen/invokeBatch: not attempted — an earlier item failed and ' +
          (mode === 'chained' ? 'mode is "chained"' : 'onItemError is "abort"')
      )
    ),
  });

  if (mode === 'serial' || mode === 'chained') {
    let stop = false;
    for (let i = 0; i < calls.length; i++) {
      if (stop) {
        results[i] = notAttempted(i);
        continue;
      }
      const result = await runSingleItem(
        invoke,
        fnName,
        i,
        calls[i],
        opts,
        batch.itemTimeoutMs
      );
      results[i] = result;
      if (result.status === 'rejected' && (mode === 'chained' || onItemError === 'abort')) {
        stop = true;
      }
    }
    return results;
  }

  // parallel, concurrency-limited pool.
  let cursor = 0;
  let stop = false;
  const workerCount = Math.max(1, Math.min(concurrency, calls.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= calls.length) return;
      if (stop) {
        results[i] = notAttempted(i);
        continue;
      }
      const result = await runSingleItem(
        invoke,
        fnName,
        i,
        calls[i],
        opts,
        batch.itemTimeoutMs
      );
      results[i] = result;
      if (result.status === 'rejected' && onItemError === 'abort') {
        stop = true;
      }
    }
  });
  await Promise.all(workers);
  return results;
}
