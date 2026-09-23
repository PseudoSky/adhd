/**
 * embed-drain.ts — the per-adapter in-flight embed registry and its bounded
 * drain-until-empty (RAG-SPEC.md §2.2's durability backstop for a short-lived
 * process).
 *
 * ## Why this module exists
 *
 * `scheduleIssueEmbedding` (`write/embedding-observer.ts`) runs the embed /
 * delete round-trip and its follow-up `embedding_*` audit transaction
 * fire-and-forget by default: a write verb schedules it strictly after its
 * subject transaction commits, then returns. For a long-lived server that is
 * correct — the vector lands milliseconds later. For a one-shot process it is
 * a data-loss defect: the CLI's `finally` calls
 * `closeGraphBacklogStoreSafe` → `adapter.close()` while the embed is still in
 * flight, and the embed's `upsertVector` / audit write then hit a closed
 * connection (`TypeError: The database connection is not open`) that dies as a
 * log line. Nothing tracked those in-flight promises.
 *
 * This module restores the tracking, in the same shape the deleted
 * `store/embed-queue.ts` used (a per-store `WeakMap` of pending promises, with
 * a drain loop that re-snapshots every pass so an embed scheduled *during* the
 * drain is picked up too) — but keyed on the **adapter**, because
 * `scheduleIssueEmbedding` only ever receives an `IWriteStoreHandle`, whose
 * `adapter` is required. Keying on the adapter reaches the producer with zero
 * interface churn, and `closeGraphBacklogStore(store)` reaches the same
 * registry via `store.adapter`.
 *
 * ## Bounded, never hangs
 *
 * The deleted drain was an unbounded `for(;;)` — safe only because nothing in
 * it could generate work forever. This one is bounded by a wall-clock deadline
 * (`DEFAULT_EMBED_DRAIN_TIMEOUT_MS`) so a wedged embed can never hang a process
 * exit; whatever is still unsettled at the bound is handed back to the caller
 * as `stillPending` for it to record durably (see
 * `embedding-observer.ts`'s `recordUnsettledEmbedsAsFailed` and
 * `graph-backlog-store.ts`'s `closeGraphBacklogStore`, which does that while
 * the connection is still open). There is no `sleep`/polling here — every
 * iteration is driven by real promise settlement or the single deadline timer
 * (AGENTS.md §7.3).
 *
 * ## `unrecorded` entries are retained, deliberately
 *
 * A producer whose round-trip failed *and* whose `embedding_failed` audit row
 * could not be written settles as `'unrecorded'`. Its disposer is NOT called:
 * the entry stays in the registry so a later drain/close can observe and report
 * it, rather than it vanishing unannounced. Because the drain only awaits
 * entries still in `'pending'`, retaining settled `'unrecorded'` entries can
 * never make the loop spin.
 */
import type { StoreAdapter } from '@adhd/sox-store-adapter';

/** The round-trip an embed entry represents — mirrors `IScheduleEmbeddingInput.action`. */
export type EmbedAction = 'upsert' | 'delete';

/**
 * `'pending'` until the producer settles the entry; then one of the four
 * terminal outcomes. `'unrecorded'` means the round-trip failed AND its
 * `embedding_failed` audit row could not be written — the outcome is not
 * durably recorded anywhere, which is the loudest signal this module carries.
 */
export type EmbedOutcome =
  | 'pending'
  | 'upserted'
  | 'deleted'
  | 'failed'
  | 'unrecorded';

/** One scheduled embed, as the drain sees it. */
export interface IPendingEmbed {
  /** The graph node's store-adapter `rowid` the vector is keyed on — never `uid`. */
  readonly subjectRowid: number;
  /** The issue's `uid` — carried for diagnostics and the `embedding_failed` audit row. */
  readonly subjectUid: string;
  /** The identity of whoever performed the subject write. */
  readonly actor: string;
  readonly action: EmbedAction;
  /**
   * The promise `scheduleIssueEmbedding` returned. Typed `unknown` rather than
   * the producer's `Promise<EmbedOutcome>` because the drain only ever awaits
   * settlement, never reads the value — the outcome is read off {@link outcome},
   * which the producer sets in a `.then` on this same promise.
   */
  readonly settled: Promise<unknown>;
  /** `'pending'` until the producer settles it. */
  outcome: EmbedOutcome;
}

/** The result of a bounded drain. */
export interface IEmbedDrainResult {
  /** How many entries settled (to any terminal outcome) during the drain. */
  readonly drained: number;
  /** Entries still `'pending'` when the bound elapsed — the close path records these durably. */
  readonly stillPending: readonly IPendingEmbed[];
  /** Of `stillPending`, how many the close path recorded as `embedding_failed` before closing. */
  readonly recordedAsFailed: number;
  /** Entries whose outcome could NOT be durably recorded — a loud, non-zero-exit signal. */
  readonly unrecorded: readonly IPendingEmbed[];
}

export interface IEmbedDrainOptions {
  /** Override the drain bound. A tuning threshold, never a feature gate (ADR-0013 D3). */
  readonly timeoutMs?: number;
}

/** The per-adapter registry surface the producer and the close path share. */
export interface IEmbedDrainRegistry {
  /** Add an entry; returns the disposer the producer calls once `settled` resolves to a recorded outcome. */
  register(entry: IPendingEmbed): () => void;
  /** Number of entries currently tracked (pending or retained-unrecorded). */
  readonly size: number;
  snapshot(): readonly IPendingEmbed[];
  /** Await every in-flight embed, bounded; drain-until-empty. */
  drain(opts?: IEmbedDrainOptions): Promise<IEmbedDrainResult>;
}

/**
 * Tuning constant — a threshold, never a feature gate (ADR-0013 D3).
 *
 * The deleted `store/embed-queue.ts` drain was unbounded (no numeric guard in
 * its history — verified via `git log -p` across every revision of that file),
 * so there is no original value to recover. 30s is deliberately generous: a
 * warm local fastembed ONNX embed is sub-second, and even a cold model load
 * finishes well inside it; the bound exists only to stop a wedged round-trip
 * from hanging process exit forever.
 */
export const DEFAULT_EMBED_DRAIN_TIMEOUT_MS = 30_000;

/**
 * Per-adapter in-flight set, keyed on the `StoreAdapter` object itself via a
 * `WeakMap` — never a field bolted onto an interface — mirroring
 * `write/bootstrap.ts`'s `membersCache` precedent. A closed/discarded adapter
 * (tests open and drop many) is reclaimed automatically.
 */
const registries = new WeakMap<StoreAdapter, Set<IPendingEmbed>>();

function setFor(adapter: StoreAdapter): Set<IPendingEmbed> {
  let set = registries.get(adapter);
  if (!set) {
    set = new Set();
    registries.set(adapter, set);
  }
  return set;
}

/** The registry for `adapter`, creating it on first use. */
export function embedDrainFor(adapter: StoreAdapter): IEmbedDrainRegistry {
  const set = setFor(adapter);
  return {
    register(entry: IPendingEmbed): () => void {
      set.add(entry);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        set.delete(entry);
      };
    },
    get size(): number {
      return set.size;
    },
    snapshot(): readonly IPendingEmbed[] {
      return [...set];
    },
    async drain(opts?: IEmbedDrainOptions): Promise<IEmbedDrainResult> {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_EMBED_DRAIN_TIMEOUT_MS;
      const deadline = Date.now() + timeoutMs;
      let drained = 0;

      // Drain-until-empty, bounded: re-snapshot every pass so an embed
      // scheduled DURING the drain is picked up too. Only entries still
      // `'pending'` are awaited — a settled `'unrecorded'` entry is retained
      // in the set but must never re-enter the wait, or the loop would spin
      // until the deadline.
      for (;;) {
        const pending = [...set].filter((e) => e.outcome === 'pending');
        if (pending.length === 0) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const timedOut = await withDeadline(
          Promise.allSettled(pending.map((e) => e.settled)),
          remaining
        );
        drained += pending.filter((e) => e.outcome !== 'pending').length;
        if (timedOut === 'timeout') break;
      }

      const still = [...set];
      return {
        drained,
        stillPending: still.filter((e) => e.outcome === 'pending'),
        recordedAsFailed: 0, // filled by the close path (graph-backlog-store.ts)
        unrecorded: still.filter((e) => e.outcome === 'unrecorded'),
      };
    },
  };
}

/**
 * Resolves `'timeout'` when `ms` elapses first, otherwise the settled value of
 * `p`. `p` is always a `Promise.allSettled(...)` here, which never rejects, so
 * there is no unhandled-rejection risk. The timer is `.unref()`d (where the
 * runtime supports it) so a drain that resolves early never keeps the process
 * alive on the timer alone.
 */
async function withDeadline<T>(
  p: Promise<T>,
  ms: number
): Promise<'timeout' | T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
