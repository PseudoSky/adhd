/**
 * Correction bucket B (37f6c511 RV-B3, RV-B5; 9ae6927d AC1, AC2). Real PriceHistoryStore over a real
 * migrated SQLite DB; only fetch, the clock and the timers are faked (ADR-0009).
 */
import { PriceHistoryStore } from '@adhd/agent-store-runtime';
import { afterEach, describe, expect, it } from 'vitest';

import { MAX_BODY_BYTES, runPricePull, type IPullDeps } from '../pricing/pull.js';
import { startPriceScheduler } from '../pricing/scheduler.js';
import { pricingRefresh, pricingRefreshInProcess } from '../pricing/tools.js';
import type { IPricingService } from '../pricing/service.js';
import {
  bulkFeed,
  fakeFetch,
  fakeTimers,
  feedOf,
  HOUR,
  makeClock,
  makeLogger,
  openDb,
  type FetchStep,
  type ITestDb,
} from './pricing-fixtures.js';

const opened: ITestDb[] = [];
afterEach(() => {
  for (const o of opened.splice(0)) o.sqlite.close();
});

function harness(steps: FetchStep[]) {
  const ctx = openDb();
  opened.push(ctx);
  const clock = makeClock();
  const fetched = fakeFetch(...steps);
  const log = makeLogger();
  const store = new PriceHistoryStore(ctx.db);
  const deps: IPullDeps = {
    store,
    fetchImpl: fetched.fetchImpl,
    now: clock.now,
    sleep: async () => undefined,
    logger: log,
    version: '9.9.9',
    baselineModelCount: 0,
  };
  return { ctx, clock, fetched, log, store, deps };
}

const okStep = (): FetchStep => ({ body: feedOf(bulkFeed(3)) });

describe('scheduler re-arm delays', () => {
  async function delayAfter(steps: FetchStep[]): Promise<number> {
    const h = harness(steps);
    const timers = fakeTimers();
    const sc = startPriceScheduler(h.deps, { timers, startDelayMs: 1000 });
    timers.fireNext();
    await sc.idle();
    expect(timers.pending).toHaveLength(1);
    return (timers.pending[0] as { ms: number }).ms;
  }

  it('37f6c511 RV-B3: a failed pull re-arms after 2h', async () => {
    expect(await delayAfter([{ body: 'nope', status: 404 }])).toBe(2 * HOUR);
  });

  it('37f6c511 RV-B3: a claim failure re-arms after 2h', async () => {
    const h = harness([okStep()]);
    h.store.claimPull = () => {
      throw new Error('db locked');
    };
    const timers = fakeTimers();
    const sc = startPriceScheduler(h.deps, { timers, startDelayMs: 1000 });
    timers.fireNext();
    await sc.idle();
    expect((timers.pending[0] as { ms: number }).ms).toBe(2 * HOUR);
  });

  it('37f6c511 RV-B3: an ok pull re-arms after 24h', async () => {
    expect(await delayAfter([okStep()])).toBe(24 * HOUR);
  });

  it('37f6c511 RV-B3: rejected_invalid and rejected_shrink re-arm after 6h', async () => {
    const bad = JSON.stringify({ data: [{ id: 'a/b', pricing: { prompt: 'abc', completion: '1' } }] });
    expect(await delayAfter([{ body: bad }])).toBe(6 * HOUR);
    const h = harness([{ body: feedOf(bulkFeed(1)) }]);
    h.deps.baselineModelCount = 100;
    const timers = fakeTimers();
    const sc = startPriceScheduler(h.deps, { timers, startDelayMs: 1000 });
    timers.fireNext();
    await sc.idle();
    expect((timers.pending[0] as { ms: number }).ms).toBe(6 * HOUR);
  });

  it('37f6c511 RV-B3: the skipped floor is unchanged (running => at least the claim TTL)', async () => {
    const h = harness([okStep()]);
    h.store.claimPull(h.clock.now(), { minIntervalMs: 1, runningTtlMs: 600_000, force: true, sourceUrl: 'x' });
    const timers = fakeTimers();
    const sc = startPriceScheduler(h.deps, { timers, startDelayMs: 1000 });
    timers.fireNext();
    await sc.idle();
    expect((timers.pending[0] as { ms: number }).ms).toBe(600_000);
  });
});

describe('response body cap', () => {
  it('37f6c511 RV-B5: a body over 8 MiB yields a typed failure without reading the whole stream', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 64) return controller.close();
        controller.enqueue(chunk);
      },
    });
    const h = harness([okStep()]);
    h.deps.fetchImpl = (async () => new Response(stream, { status: 200 })) as typeof fetch;
    const r = await runPricePull(h.deps);
    expect(r.status).toBe('failed');
    expect(r.error).toContain(`exceeds ${MAX_BODY_BYTES} bytes`);
    expect(pulled).toBeLessThan(64);
    expect(h.store.lastLedger(h.clock.now()).lastFailed?.error).toContain('exceeds');
  });

  it('37f6c511 RV-B5: a declared Content-Length over the cap fails without reading', async () => {
    const h = harness([{ body: 'x', headers: { 'content-length': String(MAX_BODY_BYTES + 1) } }]);
    const r = await runPricePull(h.deps);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('exceeds');
  });

  it('37f6c511 RV-B5: a normal streamed body still parses', async () => {
    const bytes = new TextEncoder().encode(feedOf(bulkFeed(3)));
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 10));
        c.enqueue(bytes.slice(10));
        c.close();
      },
    });
    const h = harness([okStep()]);
    h.deps.fetchImpl = (async () => new Response(stream, { status: 200 })) as typeof fetch;
    const r = await runPricePull(h.deps);
    expect(r.status).toBe('ok');
    expect(r.models).toBe(3);
  });
});

describe('forced-pull floor and the sub-agent surface', () => {
  it('9ae6927d AC1: two forced pulls within 10 minutes: the second is skipped forced_too_soon and fetches nothing', async () => {
    const h = harness([okStep()]);
    expect((await runPricePull(h.deps, { force: true })).status).toBe('ok');
    h.clock.advance(5 * 60_000);
    const second = await runPricePull(h.deps, { force: true });
    expect(second).toMatchObject({ status: 'skipped', reason: 'forced_too_soon' });
    expect(h.fetched.calls).toHaveLength(1);
    h.clock.advance(6 * 60_000);
    expect((await runPricePull(h.deps, { force: true })).status).toBe('ok');
  });

  it('9ae6927d AC1: a failed attempt also starts the forced floor', async () => {
    const h = harness([{ body: 'x', status: 404 }, okStep()]);
    expect((await runPricePull(h.deps, { force: true })).status).toBe('failed');
    h.clock.advance(60_000);
    expect(await runPricePull(h.deps, { force: true })).toMatchObject({ status: 'skipped', reason: 'forced_too_soon' });
  });

  it('9ae6927d AC4-a: a forced pull HELD an anomaly; an immediate refresh with accept:[model] is not forced_too_soon and applies the held price', async () => {
    const feed = (input: string) => feedOf(bulkFeed(3, { 'held/model': { prompt: input, completion: '0.000002' } }));
    const h = harness([{ body: feed('0.000001') }, { body: feed('0.00002') }, { body: feed('0.00002') }]);
    expect((await runPricePull(h.deps, { force: true })).status).toBe('ok');
    h.clock.advance(11 * 60_000);
    const held = await runPricePull(h.deps, { force: true });
    expect(held.anomalies.find((a) => a.modelId === 'held/model')?.severity).toBe('hold');
    expect(h.store.history('held/model').map((x) => x.inputPerM)).toEqual([1]);

    h.clock.advance(60_000); // well inside the 10-minute forced floor
    const released = await runPricePull(h.deps, { force: true, accept: ['held/model'] });
    expect(released.reason).toBeUndefined();
    expect(released.status).toBe('ok');
    expect(h.store.history('held/model').map((x) => x.inputPerM)).toEqual([1, 20]);
  });

  it('9ae6927d AC4-b: a forced pull with an empty accept list is still floored, and accept never bypasses a live running claim', async () => {
    const h = harness([okStep()]);
    expect((await runPricePull(h.deps, { force: true })).status).toBe('ok');
    h.clock.advance(60_000);
    expect(await runPricePull(h.deps, { force: true, accept: [] })).toMatchObject({ status: 'skipped', reason: 'forced_too_soon' });
    expect(h.fetched.calls).toHaveLength(1);
    // A live `running` claim by another process still blocks an accepting pull.
    const startedAt = h.clock.now();
    h.store.claimPull(startedAt, { minIntervalMs: 0, runningTtlMs: 60 * 60_000, force: true, sourceUrl: 'x' });
    expect(await runPricePull(h.deps, { force: true, accept: ['a/b'] })).toMatchObject({ status: 'skipped', reason: 'running' });
  });

  function recorder(): { service: Pick<IPricingService, 'refresh'>; accepts: Array<string[] | undefined> } {
    const accepts: Array<string[] | undefined> = [];
    return {
      accepts,
      service: {
        refresh: async (accept) => {
          accepts.push(accept);
          return { status: 'ok', models: 0, new: 0, changed: 0, unchanged: 0, anomalies: [], durationMs: 0 };
        },
      },
    };
  }

  it('9ae6927d AC2: the in-process handler rejects accept and never forwards it', async () => {
    const r = recorder();
    await expect(pricingRefreshInProcess({ accept: ['a/b'] }, r.service)).rejects.toThrow();
    expect(r.accepts).toEqual([]);
    await pricingRefreshInProcess({}, r.service);
    await pricingRefreshInProcess(undefined, r.service);
    expect(r.accepts).toEqual([undefined, undefined]);
  });

  it('9ae6927d AC2: the top-level handler honours accept', async () => {
    const r = recorder();
    await pricingRefresh({ accept: ['a/b'] }, r.service);
    expect(r.accepts).toEqual([['a/b']]);
  });
});
