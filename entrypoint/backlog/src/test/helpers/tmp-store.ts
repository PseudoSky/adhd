/**
 * tmp-store.ts — real-DB test fixture helper. Every test opens a real
 * `better-sqlite3` file under `tmp/backlog/<test-name>/` (AGENTS.md §10 — the
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
  cleanup: () => void;
}

/**
 * Opens a real backlog store at a fresh temp path under `tmp/backlog/`.
 * `name` is a human-readable prefix (usually the test file's name) — the
 * actual directory is made unique via `mkdtempSync`.
 */
export function openTmpStore(name: string): TmpStore {
  const dir = mkdtempSync(join(ensureTmpRoot(), `${name}-`));
  const dbPath = join(dir, 'backlog.db');
  const store = openGraphBacklogStore(dbPath);
  return {
    store,
    dbPath,
    dir,
    cleanup: () => {
      closeGraphBacklogStore(store);
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
