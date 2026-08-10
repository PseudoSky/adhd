/**
 * tmp-store.ts — real-DB test fixture helper. Every test opens a real store
 * via `openGraphBacklogStore` (turso substrate by default —
 * `createStoreAdapter({ dbPath })` defaults to turso) under
 * `tmp/backlog/<test-name>/` (AGENTS.md §10 — the one canonical
 * ephemeral-artifact root), never `:memory:` (the turso adapter's
 * multiprocess WAL cannot open an in-memory path, and a CAS/multi-
 * connection test needs a REAL shared file two connections can both open),
 * and removes it on teardown.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGraphBacklogStore, closeGraphBacklogStore, type GraphBacklogStore } from '../../store/graph-backlog-store.js';

const TMP_ROOT = join(process.cwd(), 'tmp', 'backlog');

export interface TmpStore {
  store: GraphBacklogStore;
  dbPath: string;
  dir: string;
  cleanup: () => Promise<void>;
}

/**
 * Opens a real backlog store at a fresh temp path under `tmp/backlog/`.
 * `name` is a human-readable prefix (usually the test file's name) — the
 * actual directory is made unique via `mkdtempSync`. `busyTimeoutMs` defaults
 * to `openGraphBacklogStore`'s own default (5000); tests exercising
 * DEBT-BACKLOG-CONCURRENCY-BUSY-RETRY-001 pass a short override.
 * Async — `openGraphBacklogStore` is async (createStoreAdapter + applySchema).
 */
export async function openTmpStore(name: string, busyTimeoutMs?: number): Promise<TmpStore> {
  const dir = mkdtempSync(join(ensureTmpRoot(), `${name}-`));
  const dbPath = join(dir, 'backlog.db');
  const store = busyTimeoutMs === undefined ? await openGraphBacklogStore(dbPath) : await openGraphBacklogStore(dbPath, busyTimeoutMs);
  return {
    store,
    dbPath,
    dir,
    cleanup: async () => {
      await closeGraphBacklogStore(store);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function ensureTmpRoot(): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return TMP_ROOT;
}

export { TMP_ROOT };
export function freshTmpDir(name: string): string {
  return mkdtempSync(join(ensureTmpRoot(), `${name}-`));
}

export function osTmpDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `${name}-`));
}
