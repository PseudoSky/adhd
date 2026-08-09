/**
 * graph-backlog-store.ts — opens the store adapter and hands it to
 * `createGraphBackend()`, keeping the adapter handle for the CAS transaction
 * primitive (DESIGN.md §3). `mode: 'immediate'` (BEGIN IMMEDIATE) is
 * load-bearing — see mutate-metadata.ts / ids.ts for why.
 */
import { createGraphBackend, type GraphBackend } from '@adhd/sox-graph-store';
import { createSqliteAdapter, type StoreAdapter } from '@adhd/sox-store-adapter';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface GraphBacklogStore {
  /** Adapter handle — ONLY for the CAS transaction wrapper (mutate-metadata.ts / ids.ts). */
  readonly adapter: StoreAdapter;
  /** All non-CAS reads/writes go through this. */
  readonly graph: GraphBackend;
}

/**
 * @param busyTimeoutMs SQLite `busy_timeout` (ms) — how long a blocked
 *   `.immediate()` waits for a contended lock before throwing `SQLITE_BUSY`
 *   (DEBT-BACKLOG-CONCURRENCY-BUSY-RETRY-001). Callers reading from
 *   `BacklogConfig` should pass `env.config.db.busyTimeoutMs`; the default
 *   here (5000) matches that config field's own default, for callers (tests,
 *   ad-hoc scripts) that open a store directly without going through
 *   `buildBacklogEnv`.
 */
export async function openGraphBacklogStore(dbPath: string, busyTimeoutMs = 5000): Promise<GraphBacklogStore> {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new RangeError(`openGraphBacklogStore: busyTimeoutMs must be a non-negative integer, got ${busyTimeoutMs}`);
  }

  const adapter = createSqliteAdapter({ dbPath });
  // WAL mode is required, not optional — the global-scope store is, by
  // construction, opened by many concurrent processes/agents/repos. Without
  // WAL a writer blocks all readers; without busy_timeout a blocked
  // `.immediate()` throws SQLITE_BUSY immediately instead of waiting out a
  // brief contention window (DESIGN.md §12).
  await adapter.pragmaSet('journal_mode', 'WAL');

  const graph = createGraphBackend(adapter, { typePolicy: undefined });
  await graph.applySchema();
  await adapter.pragmaSet('busy_timeout', busyTimeoutMs);
  return { adapter, graph };
}

export async function closeGraphBacklogStore(store: GraphBacklogStore): Promise<void> {
  await store.adapter.close();
}
