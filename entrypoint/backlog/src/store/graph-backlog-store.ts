/**
 * graph-backlog-store.ts — opens the raw `better-sqlite3` handle AND hands it
 * to `createGraphBackend()`, keeping the raw handle for the CAS transaction
 * primitive (DESIGN.md §3). `.immediate()` (BEGIN IMMEDIATE) is load-bearing —
 * see mutate-metadata.ts / ids.ts for why.
 */
import Database from 'better-sqlite3';
import { createGraphBackend, type GraphBackend } from '@adhd/sox-graph-store';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface GraphBacklogStore {
  /** Raw handle — ONLY for the CAS transaction wrapper (mutate-metadata.ts / ids.ts). */
  readonly db: Database.Database;
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
export function openGraphBacklogStore(dbPath: string, busyTimeoutMs = 5000): GraphBacklogStore {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  // WAL mode is required, not optional — the global-scope store is, by
  // construction, opened by many concurrent processes/agents/repos. Without
  // WAL a writer blocks all readers; without busy_timeout a blocked
  // `.immediate()` throws SQLITE_BUSY immediately instead of waiting out a
  // brief contention window (DESIGN.md §12).
  db.pragma('journal_mode = WAL');
  // PRAGMA statements don't accept bound `?` params — `busyTimeoutMs` is
  // validated (`type: 'integer'`, backlogEnvironmentSpec) before it ever
  // reaches here, but this guards any direct caller too (e.g. a test opening
  // a store without going through `buildBacklogEnv`).
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new RangeError(`openGraphBacklogStore: busyTimeoutMs must be a non-negative integer, got ${busyTimeoutMs}`);
  }
  // `createGraphBackend(db)`'s OWN constructor unconditionally calls
  // `applySchema()`, which re-runs `@adhd/sox-graph-store`'s `PRAGMAS`
  // (including a HARDCODED `busy_timeout = 5000`) — setting `busy_timeout`
  // BEFORE this line, as a prior version of this function did, is silently
  // clobbered right back to 5000 (confirmed empirically: `db.pragma
  // ('busy_timeout')` read back 5000 regardless of the value passed in here).
  // Setting it AFTER construction is the only place it actually sticks.
  const graph = createGraphBackend(db);
  graph.applySchema();
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  return { db, graph };
}

export function closeGraphBacklogStore(store: GraphBacklogStore): void {
  store.db.close();
}
