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
 * `[{ busy_timeout: N }]`, the store adapter's other substrate returns the bare number).
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

  /**
   * TEST-GAP-BACKLOG-BUSY-TIMEOUT-UNPROVEN-001.
   *
   * The two tests above assert the adapter REPORTS the value it was given.
   * That is 'looks like it does' — precisely what this file's own docstring
   * disclaims. Neither exercises the behaviour the pragma exists for: that a
   * contended `BEGIN IMMEDIATE` actually WAITS. If the adapter regressed to
   * accepting-and-ignoring busy_timeout, both would stay green.
   *
   * This one holds a real `.immediate()` transaction open on a second
   * connection and measures how long a third connection waits before giving
   * up. The assertion is a RATIO, not a wall-clock threshold: the observed
   * elapsed time is a multiple of the nominal timeout (the adapter also
   * retries internally), and absolute timings are not stable on a loaded CI
   * box — but "a large timeout waits substantially longer than a zero
   * timeout" is a property no accepting-and-ignoring implementation can fake.
   */
  it('busy_timeout genuinely BLOCKS a contended BEGIN IMMEDIATE — a large value waits much longer than zero', async () => {
    const dbPath = join(dir, 'backlog.db');

    /** Elapsed ms until a contended `.immediate()` gives up, at `timeoutMs`. */
    async function elapsedUntilBounce(timeoutMs: number): Promise<number> {
      const holder = await openGraphBacklogStore(dbPath, 5000);
      const waiter = await openGraphBacklogStore(dbPath, timeoutMs);
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      const holding = holder.adapter.transaction(async () => {
        await held;
      }, { mode: 'immediate' });
      // Let the holder genuinely acquire the write lock before racing it.
      await new Promise((r) => setTimeout(r, 250));

      const startedAt = Date.now();
      let threw: unknown;
      try {
        // The body is irrelevant — acquiring the write lock is what is being
        // timed, so the transaction does the smallest real thing it can.
        await waiter.adapter.transaction(async () => Promise.resolve(), { mode: 'immediate' });
      } catch (err) {
        threw = err;
      }
      const elapsed = Date.now() - startedAt;

      release();
      await holding;
      await closeGraphBacklogStore(waiter);
      await closeGraphBacklogStore(holder);

      expect(threw, `expected the contended BEGIN IMMEDIATE at busy_timeout=${timeoutMs} to bounce`).toBeDefined();
      return elapsed;
    }

    const atZero = await elapsedUntilBounce(0);
    const atLarge = await elapsedUntilBounce(1500);

    // The property under test. Measured locally: 0ms -> ~74ms, 1500ms -> ~6091ms.
    // A 5x floor is far below that margin but far above any plausible noise,
    // and would fail outright if the pragma were being ignored (both values
    // would collapse to the same near-instant bounce).
    expect(
      atLarge,
      `busy_timeout appears ignored: waited ${atLarge}ms at 1500ms vs ${atZero}ms at 0ms`,
    ).toBeGreaterThan(Math.max(atZero * 5, 500));
  }, 30000);
});
