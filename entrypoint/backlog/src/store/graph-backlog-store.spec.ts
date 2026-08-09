/**
 * graph-backlog-store.spec.ts — BUG-BACKLOG-BUSY-TIMEOUT-CLOBBERED-001:
 * `openGraphBacklogStore(dbPath, busyTimeoutMs)`'s `busyTimeoutMs` must
 * actually take effect on the real connection, not just look like it does.
 *
 * Uses temp files (not :memory:) because the turso adapter enables
 * multiprocess_wal by default, which is not supported for in-memory databases.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { closeGraphBacklogStore, openGraphBacklogStore, type GraphBacklogStore } from './graph-backlog-store.js';

describe('openGraphBacklogStore — busy_timeout actually takes effect (BUG-BACKLOG-BUSY-TIMEOUT-CLOBBERED-001)', () => {
  let store: GraphBacklogStore | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (store) await closeGraphBacklogStore(store);
    store = undefined;
    if (tmpDir) { rmSync(tmpDir, { recursive: true, force: true }); tmpDir = undefined; }
  });

  function tmpDbPath(): string {
    tmpDir = mkdtempSync(join(tmpdir(), 'backlog-busy-timeout-'));
    return join(tmpDir, 'backlog.db');
  }

  /**
   * The turso adapter returns PRAGMA values as arrays like
   * `[{ busy_timeout: 250 }]`. Normalise to the scalar value.
   */
  async function getBusyTimeout(store: GraphBacklogStore): Promise<number> {
    const raw = await store.adapter.pragmaGet<Array<{ busy_timeout: number }> | number>('busy_timeout');
    if (typeof raw === 'number') return raw;
    if (Array.isArray(raw) && raw.length > 0) return raw[0]?.busy_timeout ?? 0;
    if (typeof raw === 'object' && raw !== null) {
      const obj = raw as { busy_timeout?: number };
      return obj.busy_timeout ?? 0;
    }
    return 0;
  }

  it('a custom busyTimeoutMs is reflected by a real PRAGMA busy_timeout read-back, not silently reset to the library default', async () => {
    store = await openGraphBacklogStore(tmpDbPath(), 250);
    const timeout = await getBusyTimeout(store);
    expect(timeout).toBe(250);
  });

  it('the default (no busyTimeoutMs argument) is 5000', async () => {
    store = await openGraphBacklogStore(tmpDbPath());
    const timeout = await getBusyTimeout(store);
    expect(timeout).toBe(5000);
  });
});
