/**
 * graph-backlog-store.ts — opens the store through `@adhd/sox-store-adapter`'s
 * `createStoreAdapter()` (fully async) and hands the `StoreAdapter` to
 * `createGraphBackend()`, keeping the adapter handle for the CAS transaction
 * primitive (DESIGN.md §3). `.transaction(fn, { mode: 'immediate' })` (BEGIN
 * IMMEDIATE) is load-bearing — see mutate-metadata.ts for why.
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
import { flushEmbeds as flushEmbedsFor } from './embed-queue.js';
import { assertRecognizedStoreVocabulary } from './vocabulary-guard.js';

export interface GraphBacklogStore {
  /** Store-adapter handle — ONLY for the CAS transaction wrapper (mutate-metadata.ts). */
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
   * RAG-SPEC.md §2.2 — durability backstop for a short-lived process. Every
   * `scheduleEmbed` (embed-queue.ts) call fired by `createItem`/`updateItem`
   * is fire-and-forget by default; a CLI process that exits before those
   * promises settle would otherwise lose the vector permanently even though
   * the item itself is already durably committed. `flushEmbeds()` awaits
   * every embed currently in flight for THIS store — bounded, deterministic,
   * no sleeps — including one scheduled while the drain is already running.
   * `closeGraphBacklogStore` calls this automatically before closing the
   * adapter, so a caller that does nothing but `await
   * closeGraphBacklogStore(store)` already gets the durability guarantee;
   * this method exists for a caller that wants to keep the store open
   * afterward (e.g. a long batch of writes wanting a checkpoint partway
   * through) or wants the guarantee without a close.
   */
  flushEmbeds(): Promise<void>;
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
  // (mutate-metadata.ts). Without it, opening a store while another process
  // holds the write lock could fail outright: measured with 20 concurrent
  // opens at busy_timeout=150 on a loaded box, `applySchema` threw
  // "database is locked".
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
    flushEmbeds: () => flushEmbedsFor(store),
  };
  return store;
}

/**
 * Async (RAG-SPEC.md §2.2) — drains every embed still in flight for `store`
 * BEFORE closing the adapter, so a one-shot process that does nothing more
 * than `await closeGraphBacklogStore(store)` still gets the durability
 * guarantee without having to remember to call `flushEmbeds()` itself. This
 * is the belt-and-suspenders backstop `scheduleEmbed`'s doc comment
 * describes: `awaitEmbed: true` on individual writes and an explicit
 * `flushEmbeds()` mid-batch are the other two ways to get the same
 * guarantee, but a caller that does none of them still cannot lose a vector
 * as long as they close the store before the process exits.
 */
export async function closeGraphBacklogStore(
  store: GraphBacklogStore
): Promise<void> {
  await store.flushEmbeds();
  await store.adapter.close();
}

/**
 * Best-effort close for teardown finally-paths (cli.ts / server.ts).
 * closeGraphBacklogStore may throw only in the extreme edge where the
 * driver's own db.close() fails (every checkpoint/verify failure is already
 * caught and logged inside the adapter — turso-adapter close()). On that edge
 * this logs and returns so a close failure can never mask a command/transport
 * error or turn a successful command into a failed exit. The adapter's own
 * logs are the durable record; the client never rethrows here.
 */
export async function closeGraphBacklogStoreSafe(
  store: GraphBacklogStore | undefined
): Promise<void> {
  if (!store) return;
  try {
    await closeGraphBacklogStore(store);
  } catch (err) {
    console.error(
      `backlog: store close failed (data is durable; WAL checkpoint may be pending): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}
