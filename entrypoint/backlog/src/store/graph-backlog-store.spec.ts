/**
 * graph-backlog-store.spec.ts — BUG-BACKLOG-BUSY-TIMEOUT-CLOBBERED-001:
 * `openGraphBacklogStore(dbPath, busyTimeoutMs)`'s `busyTimeoutMs` must
 * actually take effect on the real connection, not just look like it does.
 *
 * Discovered while writing busy-retry.spec.ts (DEBT-BACKLOG-CONCURRENCY-
 * BUSY-RETRY-001): `@adhd/sox-graph-store`'s `createGraphBackend(db)`
 * constructor unconditionally calls `applySchema()`, which re-runs the
 * library's OWN `PRAGMAS` array — including a hardcoded `busy_timeout =
 * 5000` — silently clobbering any `busy_timeout` set BEFORE constructing the
 * graph backend. A prior version of `openGraphBacklogStore` set it before,
 * so every caller's custom `busyTimeoutMs` (including `db.config.
 * busyTimeoutMs` from `buildBacklogEnv`) was silently discarded and the
 * store always ran at the hardcoded 5000ms regardless of what was passed in
 * — no error, no warning, `busy_timeout` pragma just quietly wrong.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { closeGraphBacklogStore, openGraphBacklogStore, type GraphBacklogStore } from './graph-backlog-store.js';

describe('openGraphBacklogStore — busy_timeout actually takes effect (BUG-BACKLOG-BUSY-TIMEOUT-CLOBBERED-001)', () => {
  let store: GraphBacklogStore | undefined;

  afterEach(() => {
    if (store) closeGraphBacklogStore(store);
    store = undefined;
  });

  it('a custom busyTimeoutMs is reflected by a real PRAGMA busy_timeout read-back, not silently reset to the library default', () => {
    store = openGraphBacklogStore(':memory:', 250);
    const row = store.db.pragma('busy_timeout') as Array<{ timeout: number }>;
    expect(row[0]?.timeout).toBe(250);
  });

  it('the default (no busyTimeoutMs argument) is 5000', () => {
    store = openGraphBacklogStore(':memory:');
    const row = store.db.pragma('busy_timeout') as Array<{ timeout: number }>;
    expect(row[0]?.timeout).toBe(5000);
  });
});
