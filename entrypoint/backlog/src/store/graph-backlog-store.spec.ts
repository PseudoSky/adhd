/**
 * graph-backlog-store.spec.ts — `openGraphBacklogStore(dbPath, busyTimeoutMs)`
 * must actually apply the caller's busy_timeout on the real store, not just
 * look like it does.
 *
 * BUG-SOXGRAPH-002 (upstream): busy_timeout ownership moved OUT of graph-store
 * into the store-adapters — graph-store's `applySchema()` PRAGMAS no longer
 * include `busy_timeout`, and `AdapterConfig` exposes no busy_timeout field
 * (types.ts), so `openGraphBacklogStore` routes the caller's value through
 * the adapter's own `pragmaSet('busy_timeout', N)` surface. The read-back
 * assertion below verifies THAT path: the adapter must report the value the
 * caller asked for (verified against both substrates — turso returns
 * `[{ busy_timeout: N }]`, sqlite returns the bare number).
 *
 * `:memory:` is NOT supported by the turso adapter (its multiprocess WAL
 * cannot open an in-memory path), so these tests open real files under
 * `tmp/backlog/` (the canonical ephemeral-artifact root) instead.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openGraphBacklogStore, closeGraphBacklogStore, type GraphBacklogStore } from './graph-backlog-store.js';
import { TMP_ROOT } from '../test/helpers/tmp-store.js';

/** Normalizes `pragmaGet('busy_timeout')`'s adapter-dependent shape to a bare number. */
function busyTimeoutValue(raw: unknown): number | undefined {
  if (typeof raw === 'number') return raw;
  if (Array.isArray(raw)) {
    const row = raw[0] as { busy_timeout?: unknown } | undefined;
    return typeof row?.busy_timeout === 'number' ? row.busy_timeout : undefined;
  }
  return undefined;
}

describe('openGraphBacklogStore — busy_timeout actually takes effect (BUG-SOXGRAPH-002 adapter-owned)', () => {
  let store: GraphBacklogStore | undefined;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(TMP_ROOT, 'graph-backlog-store-'));
    // `dbPath` is derived inside each test from `dir`; opening the store in
    // beforeEach would create a second connection before the test body runs,
    // so the store opens per-test (with the specific busyTimeoutMs under
    // test) and `dir` is guaranteed set in the body (no non-null assertion).
  });

  afterEach(async () => {
    if (store) await closeGraphBacklogStore(store);
    store = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('a custom busyTimeoutMs is reflected by the adapter pragma read-back, not silently reset', async () => {
    store = await openGraphBacklogStore(join(dir, 'backlog.db'), 250);
    const readBack = busyTimeoutValue(await store.adapter.pragmaGet('busy_timeout'));
    expect(readBack).toBe(250);
  });

  it('the default (no busyTimeoutMs argument) is 5000', async () => {
    store = await openGraphBacklogStore(join(dir, 'backlog.db'));
    const readBack = busyTimeoutValue(await store.adapter.pragmaGet('busy_timeout'));
    expect(readBack).toBe(5000);
  });
});
