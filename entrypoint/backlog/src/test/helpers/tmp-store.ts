/**
 * tmp-store.ts — real-DB test fixture helper. Every test opens a real
 * SQLite file under `tmp/backlog/<test-name>/` (AGENTS.md §10 — the
 * one canonical ephemeral-artifact root), never `:memory:` (a CAS/multi-
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
