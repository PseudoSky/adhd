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

export function openGraphBacklogStore(dbPath: string): GraphBacklogStore {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  // WAL mode is required, not optional — the global-scope store is, by
  // construction, opened by many concurrent processes/agents/repos. Without
  // WAL a writer blocks all readers; without busy_timeout a blocked
  // `.immediate()` throws SQLITE_BUSY immediately instead of waiting out a
  // brief contention window (DESIGN.md §12).
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  const graph = createGraphBackend(db);
  graph.applySchema();
  return { db, graph };
}

export function closeGraphBacklogStore(store: GraphBacklogStore): void {
  store.db.close();
}
