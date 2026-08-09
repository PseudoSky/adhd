/**
 * graph-backlog-store.spec.ts — BUG-BACKLOG-BUSY-TIMEOUT-CLOBBERED-001:
 * `openGraphBacklogStore(dbPath, busyTimeoutMs)`'s `busyTimeoutMs` must
 * actually take effect on the real connection, not just look like it does.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { closeGraphBacklogStore, openGraphBacklogStore, type GraphBacklogStore } from './graph-backlog-store.js';

describe('openGraphBacklogStore — busy_timeout actually takes effect (BUG-BACKLOG-BUSY-TIMEOUT-CLOBBERED-001)', () => {
  let store: GraphBacklogStore | undefined;

  afterEach(async () => {
    if (store) await await closeGraphBacklogStore(store);
    store = undefined;
  });

  it('a custom busyTimeoutMs is reflected by a real PRAGMA busy_timeout read-back, not silently reset to the library default', async () => {
    store = await openGraphBacklogStore(':memory:', 250);
    const timeout = await store.adapter.pragmaGet<number>('busy_timeout');
    expect(timeout).toBe(250);
  });

  it('the default (no busyTimeoutMs argument) is 5000', async () => {
    store = await openGraphBacklogStore(':memory:');
    const timeout = await store.adapter.pragmaGet<number>('busy_timeout');
    expect(timeout).toBe(5000);
  });
});
