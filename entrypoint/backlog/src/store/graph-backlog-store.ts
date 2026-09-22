/**
 * graph-backlog-store.ts — opens the store through `@adhd/sox-store-adapter`'s
 * `createStoreAdapter()` (fully async) and hands the `StoreAdapter` to
 * `createGraphBackend()`, keeping the adapter handle for the CAS transaction
 * primitive (DESIGN.md §3). `.transaction(fn, { mode: 'immediate' })` (BEGIN
 * IMMEDIATE) is load-bearing — see `write/tx.ts`'s `executeWriteTransaction`
 * for why.
 *
 * The adapter substrate is whatever `createStoreAdapter` selects; nothing in
 * this package names or depends on a particular one. That seam is the only
 * place a driver is known, which is what lets every write path above it stay
 * substrate-agnostic.
 */
import { createStoreAdapter, type StoreAdapter } from '@adhd/sox-store-adapter';
import {
  createGraphBackend,
  type GraphBackend,
  type TypePolicy,
} from '@adhd/sox-graph-store';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { OPEN_TYPE_POLICY } from './type-policy.js';
import { withImmediateRetry } from './immediate-retry.js';
import { assertRecognizedStoreVocabulary } from './vocabulary-guard.js';
import {
  embedDrainFor,
  type IEmbedDrainOptions,
  type IEmbedDrainResult,
} from '../write/embed-drain.js';
import { recordUnsettledEmbedsAsFailed } from '../write/embedding-observer.js';

export interface GraphBacklogStore {
  /**
   * Store-adapter handle — reached directly by the write layer's CAS
   * transaction wrapper (`write/tx.ts`'s `executeWriteTransaction`), the
   * vocabulary guard, and close. All other reads/writes go through `graph`.
   */
  readonly adapter: StoreAdapter;
  /** All non-CAS reads/writes go through this. */
  readonly graph: GraphBackend;
  /**
   * The SAME `TypePolicy` instance `graph` was constructed with. The write
   * layer's `IWriteStoreHandle` (write/tx.ts) requires one, and it must be
   * the store's own — importing a second copy at the call site is exactly how
   * the production/ETL/test divergence documented in store/type-policy.ts
   * came about.
   *
   * `OPEN_TYPE_POLICY` — the single policy, installed on the graph backend and
   * reported here as one value, so a caller and the backend can never disagree
   * about what is permitted. The application layer's own node kinds
   * (`project`/`component`/`issue`/`citation`/`audit`/…) and rels
   * (`owns_project`/`has_status`/`has_citation`/…) are outside
   * `@adhd/sox-graph-store`'s closed default vocabulary, so a closed policy
   * rejects every write this package makes.
   */
  readonly typePolicy: TypePolicy;
  /**
   * Await every embed the write layer scheduled against this store's adapter
   * (`write/embed-drain.ts`'s per-adapter registry), bounded — RAG-SPEC.md
   * §2.2's durability backstop for a short-lived process. `closeGraphBacklogStore`
   * calls this BEFORE closing the adapter, so a fire-and-forget embed that has
   * not yet settled gets its chance to land rather than dying on a closed
   * connection. Exposed on the store (rather than only inside close) so a host
   * that wants to drain without closing can, and so tests can override the bound.
   */
  flushEmbeds(opts?: IEmbedDrainOptions): Promise<IEmbedDrainResult>;
}

/**
 * @param busyTimeoutMs `busy_timeout` (ms) — how long a blocked
 *   `.transaction(fn, { mode: 'immediate' })` waits for a contended lock
 *   before it gives up (DEBT-BACKLOG-CONCURRENCY-BUSY-RETRY-001).
 *   BUG-SOXGRAPH-002 puts busy_timeout ownership in the adapter layer, and
 *   `AdapterConfig` exposes no busy_timeout field — so the caller's value is
 *   routed through the adapter's own `pragmaSet('busy_timeout', N)` surface,
 *   which every adapter honors (verified by read-back). Callers
 *   reading from `BacklogConfig` should pass `env.config.db.busyTimeoutMs`;
 *   the default here (5000) matches that config field's own default, for
 *   callers (tests, ad-hoc scripts) that open a store directly without going
 *   through `buildBacklogEnv`.
 */
export async function openGraphBacklogStore(
  dbPath: string,
  busyTimeoutMs = 5000
): Promise<GraphBacklogStore> {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  // PRAGMA statements don't accept bound `?` params — `busyTimeoutMs` is
  // validated (`type: 'integer'`, backlogEnvironmentSpec) before it ever
  // reaches here, but this guards any direct caller too (e.g. a test opening
  // a store without going through `buildBacklogEnv`).
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new RangeError(
      `openGraphBacklogStore: busyTimeoutMs must be a non-negative integer, got ${busyTimeoutMs}`
    );
  }
  const adapter = await createStoreAdapter({ dbPath });
  // BUG-SOXGRAPH-002: the write-contention contract is adapter-owned —
  // graph-store's applySchema() no longer sets busy_timeout, so applying the
  // caller's value here (after the factory's init) is never clobbered and is
  // the one place it sticks. `pragmaSet` is the adapter surface for it
  // (AdapterConfig has no busy_timeout field — types.ts).
  await adapter.pragmaSet('busy_timeout', busyTimeoutMs);
  const graph = createGraphBackend(adapter, { typePolicy: OPEN_TYPE_POLICY });
  // DEBT-BACKLOG-APPLYSCHEMA-UNRETRIED-AT-OPEN-001. `applySchema()` issues DDL,
  // which takes the same write lock as every other write in this package — so
  // it gets the same bounded busy-retry every other write path gets
  // (`withImmediateRetry`, immediate-retry.ts). Without it, opening a store
  // while another process holds the write lock could fail outright: measured
  // with 20 concurrent opens at busy_timeout=150 on a loaded box,
  // `applySchema` threw "database is locked".
  // Production's 5000ms default left ample headroom, so this closes the gap
  // before it becomes an incident rather than after.
  await withImmediateRetry(() => graph.applySchema());
  // Vocabulary guard (store/vocabulary-guard.ts): a store that holds live
  // nodes but NONE of a kind this build recognizes would read as empty
  // (`{ok:true, total:0}`) for every consumer. Refuse it at open rather than
  // serve that emptiness. Runs AFTER `applySchema` so the `node` table
  // exists, and is a pure read. The `catch` closes the adapter the guard's
  // throw would otherwise leak — an open store that failed its own open must
  // not leave a live connection behind.
  try {
    await assertRecognizedStoreVocabulary(adapter);
  } catch (err) {
    await adapter.close().catch(() => undefined);
    throw err;
  }
  const store: GraphBacklogStore = {
    adapter,
    graph,
    typePolicy: OPEN_TYPE_POLICY,
    flushEmbeds: (opts?: IEmbedDrainOptions) =>
      embedDrainFor(adapter).drain(opts),
  };
  return store;
}

/**
 * Async — drains the adapter's in-flight embeds, records any that are still
 * unsettled as durable `embedding_failed` audit rows, THEN closes the adapter.
 *
 * This is RAG-SPEC.md §2.2's durability backstop for a short-lived process: a
 * write verb schedules its embed fire-and-forget by default, and without this
 * drain a CLI that exits immediately after `create` would close the adapter
 * out from under that embed — its `upsertVector`/audit write would hit a
 * closed connection and die as a log line. The drain runs BEFORE `close()`, so
 * the post-close state is never exercised on the normal path; anything the
 * drain cannot settle within its bound is recorded as `embedding_failed`
 * WHILE THE CONNECTION IS STILL OPEN, so the loss is durable rather than
 * silent.
 *
 * `adapter.close()` runs unconditionally (in a `finally`): a failed drain, or
 * a failed recording, must still close the adapter — a leaked connection is
 * never an acceptable outcome of a close call. `opts` is the drain bound
 * (default `DEFAULT_EMBED_DRAIN_TIMEOUT_MS`); it exists so a caller can tune
 * the wait and so tests can bound it deterministically.
 *
 * Return type widened from `Promise<void>` to `Promise<IEmbedDrainResult>` —
 * non-breaking, since `Promise<T>` is assignable where `Promise<void>` is
 * expected and every existing caller `await`s or ignores the result.
 */
export async function closeGraphBacklogStore(
  store: GraphBacklogStore,
  opts?: IEmbedDrainOptions
): Promise<IEmbedDrainResult> {
  const drained = await store.flushEmbeds(opts);
  let recordedAsFailed = 0;
  let unrecorded = [...drained.unrecorded];
  try {
    if (drained.stillPending.length > 0) {
      const rec = await recordUnsettledEmbedsAsFailed(store, drained.stillPending);
      recordedAsFailed = rec.recorded.length;
      unrecorded = [...unrecorded, ...rec.unrecorded];
    }
  } finally {
    await store.adapter.close();
  }
  return {
    drained: drained.drained,
    stillPending: drained.stillPending,
    recordedAsFailed,
    unrecorded,
  };
}

/**
 * Best-effort close for teardown finally-paths (cli.ts / server.ts).
 *
 * Unlike the pre-drain version, this is no longer a silent discard: a store
 * close can now carry an embed-durability outcome, and swallowing it would
 * recreate exactly the "died unrecorded" defect this wave fixes. So:
 *
 * - `closeGraphBacklogStore` throwing (the extreme edge where the driver's own
 *   `db.close()` fails) still logs and returns — a close failure must never
 *   mask a command/transport error or turn a successful command into a failed
 *   exit.
 * - An **unrecorded** embed death (its `embedding_failed` audit row could not
 *   be written, so the outcome is not durably recorded anywhere) logs loudly
 *   AND sets `process.exitCode = 1`: the subject write is durable but the
 *   vector is missing and nothing recorded why. Only this case changes the
 *   exit code — a **recorded** failure (the `embedding_failed` row IS durable)
 *   warns but exits 0, because the subject write genuinely succeeded and the
 *   failure is recorded. Filing must never depend on RAG succeeding.
 */
export async function closeGraphBacklogStoreSafe(
  store: GraphBacklogStore | undefined
): Promise<void> {
  if (!store) return;
  let result: IEmbedDrainResult;
  try {
    result = await closeGraphBacklogStore(store);
  } catch (err) {
    console.error(
      `backlog: store close failed (data is durable; WAL checkpoint may be pending): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return;
  }

  if (result.unrecorded.length > 0) {
    console.error(
      `backlog: ${result.unrecorded.length} scheduled embed(s) died UNRECORDED — the store closed ` +
        `before they settled and the embedding_failed audit row could not be written. The subject ` +
        `write(s) are durable; the vector(s) are missing. Re-run the embedding backfill.`
    );
    if (!process.exitCode) process.exitCode = 1; // data-integrity defect ⇒ non-zero exit
  } else if (result.stillPending.length > 0) {
    console.error(
      `backlog: ${result.stillPending.length} scheduled embed(s) did not settle before close — ` +
        `recorded as embedding_failed. The subject write(s) are durable.`
    );
  }
}
