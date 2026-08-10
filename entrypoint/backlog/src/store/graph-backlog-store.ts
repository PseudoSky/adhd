/**
 * graph-backlog-store.ts — opens the store through `@adhd/sox-store-adapter`'s
 * `createStoreAdapter()` (fully async; turso substrate by default, sqlite via
 * the test-only `STORE_ADAPTER` env) and hands the `StoreAdapter` to
 * `createGraphBackend()`, keeping the adapter handle for the CAS transaction
 * primitive (DESIGN.md §3). `.transaction(fn, { mode: 'immediate' })` (BEGIN
 * IMMEDIATE) is load-bearing — see mutate-metadata.ts / ids.ts for why.
 *
 * Auto-migration on adapter-type change is owned by the factory:
 * `createStoreAdapter({ dbPath }, { migrateOnAdapterChange: true })` copies a
 * store stamped with a DIFFERENT adapter type (e.g. the pre-migration
 * better-sqlite3-backed `~/.adhd/.../backlog.db`) into a fresh turso store
 * via an atomic temp-file swap. The gate below (`dbPath !== ':memory:'` and
 * the file already exists) matches the factory's own constraint: it requires
 * a local file db, and a fresh test file has no prior adapter stamp to
 * migrate from.
 */
import { createStoreAdapter, type StoreAdapter } from '@adhd/sox-store-adapter';
import { createGraphBackend, type GraphBackend } from '@adhd/sox-graph-store';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface GraphBacklogStore {
  /** Store-adapter handle — ONLY for the CAS transaction wrapper (mutate-metadata.ts / ids.ts). */
  readonly adapter: StoreAdapter;
  /** All non-CAS reads/writes go through this. */
  readonly graph: GraphBackend;
}

/**
 * @param busyTimeoutMs SQLite `busy_timeout` (ms) — how long a blocked
 *   `.transaction(fn, { mode: 'immediate' })` waits for a contended lock
 *   before throwing `SQLITE_BUSY` (DEBT-BACKLOG-CONCURRENCY-BUSY-RETRY-001).
 *   BUG-SOXGRAPH-002 moved busy_timeout ownership OUT of graph-store into the
 *   adapters (SqliteAdapter hardcodes 3000 at connect; graph-store's
 *   `PRAGMAS` no longer touches it), and `AdapterConfig` exposes no
 *   busy_timeout field — so the caller's value is routed through the
 *   adapter's own `pragmaSet('busy_timeout', N)` surface, which both
 *   adapters honor (verified: read-back works on turso and sqlite). Callers
 *   reading from `BacklogConfig` should pass `env.config.db.busyTimeoutMs`;
 *   the default here (5000) matches that config field's own default, for
 *   callers (tests, ad-hoc scripts) that open a store directly without going
 *   through `buildBacklogEnv`.
 */
export async function openGraphBacklogStore(dbPath: string, busyTimeoutMs = 5000): Promise<GraphBacklogStore> {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  // PRAGMA statements don't accept bound `?` params — `busyTimeoutMs` is
  // validated (`type: 'integer'`, backlogEnvironmentSpec) before it ever
  // reaches here, but this guards any direct caller too (e.g. a test opening
  // a store without going through `buildBacklogEnv`).
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new RangeError(`openGraphBacklogStore: busyTimeoutMs must be a non-negative integer, got ${busyTimeoutMs}`);
  }
  // Turso is the substrate (`createStoreAdapter` defaults to it; `STORE_ADAPTER`
  // env is test-only). `migrateOnAdapterChange` requires a local file db — a
  // `:memory:` path, or a fresh (not-yet-created) test file, has no prior
  // adapter stamp to migrate, so the flag is gated on both.
  const adapter = await createStoreAdapter(
    { dbPath },
    { migrateOnAdapterChange: dbPath !== ':memory:' && existsSync(dbPath) },
  );
  // BUG-SOXGRAPH-002: the write-contention contract is adapter-owned —
  // graph-store's applySchema() no longer sets busy_timeout, so applying the
  // caller's value here (after the factory's init) is never clobbered and is
  // the one place it sticks. `pragmaSet` is the adapter surface for it
  // (AdapterConfig has no busy_timeout field — types.ts).
  await adapter.pragmaSet('busy_timeout', busyTimeoutMs);
  const graph = createGraphBackend(adapter);
  await graph.applySchema();
  return { adapter, graph };
}

export async function closeGraphBacklogStore(store: GraphBacklogStore): Promise<void> {
  await store.adapter.close();
}
