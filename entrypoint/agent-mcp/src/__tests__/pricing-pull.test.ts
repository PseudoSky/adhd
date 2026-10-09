/**
 * 37f6c511 (FS2 / G3): the live OpenRouter price pull, scheduler and tools, driven through the
 * REAL PriceHistoryStore over a REAL migrated SQLite DB. Only fetch, the clock and the timers are
 * faked (ADR-0009: no sockets in the unit lane; the real-socket and real-feed proofs are the
 * `*.e2e.test.ts` siblings).
 */
import { estimateCost, estimateCostUsd } from '@adhd/agent-core-provider';
import { createPriceSource, PriceHistoryStore } from '@adhd/agent-store-runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FETCH_TIMEOUT_MS,
  MAX_RETRY_WAIT_MS,
  parseRetryAfterMs,
  PRICE_ANOMALY_THRESHOLDS,
  PULL_INTERVAL_MS,
  RUNNING_TTL_MS,
  runPricePull,
  type IPullDeps,
} from '../pricing/pull.js';
import { startPriceScheduler } from '../pricing/scheduler.js';
import { createPricingService } from '../pricing/service.js';
import { pricingHistory, pricingRefresh } from '../pricing/tools.js';
import {
  assertNoCredentials,
  bulkFeed,
  fakeFetch,
  fakeTimers,
  feedOf,
  HOUR,
  latch,
  makeClock,
  makeLogger,
  openDb,
  scratchDir,
  T0,
  type FetchStep,
  type ITestDb,
} from './pricing-fixtures.js';

const USAGE = { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 1_000_000 };

let opened: ITestDb[] = [];
let scratch: Array<{ dispose(): void }> = [];
beforeEach(() => {
  opened = [];
  scratch = [];
});
afterEach(() => {
  for (const o of opened) o.sqlite.close();
  for (const s of scratch) s.dispose();
});

function mem(): ITestDb {
  const o = openDb();
  opened.push(o);
  return o;
}

interface IHarness {
  store: PriceHistoryStore;
  deps: IPullDeps;
  clock: ReturnType<typeof makeClock>;
  log: ReturnType<typeof makeLogger>;
  sleeps: number[];
  fetched: ReturnType<typeof fakeFetch>;
  ctx: ITestDb;
}

function harness(steps: FetchStep[], over: { ctx?: ITestDb; clock?: ReturnType<typeof makeClock> } = {}): IHarness {
  const ctx = over.ctx ?? mem();
  const clock = over.clock ?? makeClock();
  const log = makeLogger();
  const sleeps: number[] = [];
  const fetched = fakeFetch(...steps);
  const store = new PriceHistoryStore(ctx.db);
  return {
    store,
    clock,
    log,
    sleeps,
    fetched,
    ctx,
    deps: {
      store,
      fetchImpl: fetched.fetchImpl,
      now: clock.now,
      sleep: async (ms) => void sleeps.push(ms),
      logger: log,
      version: '9.9.9',
      baselineModelCount: 0,
    },
  };
}

const ok = (models: Parameters<typeof feedOf>[0]): FetchStep => ({ body: feedOf(models) });
const row = (store: PriceHistoryStore, id: string, at = '9999-01-01T00:00:00.000Z') => store.priceAt(id, at);

describe('runPricePull: parsing, storage, idempotence', () => {
  it('37f6c511 FS2-AC1: a per-token "0.0000003" is stored as 0.3 $/M, one row per priced model', async () => {
    const h = harness([ok({ 'a/one': { prompt: '0.0000003', completion: '0.0000012', cacheRead: '0.000000006' }, 'b/two': { prompt: '0', completion: '0' } })]);
    const r = await runPricePull(h.deps);
    expect(r.status).toBe('ok');
    expect(r.new).toBe(2);
    const a = row(h.store, 'a/one');
    expect(a?.inputPerM).toBe(0.3);
    expect(a?.outputPerM).toBe(1.2);
    expect(a?.cacheReadPerM).toBe(0.006);
    expect(a?.source).toBe('openrouter-live');
    // 0 is a real free price, distinct from null.
    expect(row(h.store, 'b/two')?.inputPerM).toBe(0);
  });

  it('37f6c511 FS2-AC2: an identical feed appends zero history rows and one ledger row ok with changed=0', async () => {
    const h = harness([ok(bulkFeed(5))]);
    expect((await runPricePull(h.deps)).status).toBe('ok');
    h.clock.advance(25 * HOUR);
    const second = await runPricePull(h.deps);
    expect(second).toMatchObject({ status: 'ok', new: 0, changed: 0, unchanged: 5 });
    expect(h.store.history('vendor/m0')).toHaveLength(1);
    expect(h.store.lastLedger(h.clock.now()).lastOk?.id).toBe(second.ledgerId);
  });

  it('37f6c511 FS2-AC3: one changed model appends exactly one row at the injected observed_at; prior rows are untouched', async () => {
    const feed = bulkFeed(4);
    const h = harness([ok(feed), ok({ ...feed, 'vendor/m2': { prompt: '0.000002', completion: '0.000002' } })]);
    await runPricePull(h.deps);
    const firstObserved = h.clock.now();
    h.clock.advance(25 * HOUR);
    const r = await runPricePull(h.deps);
    expect(r).toMatchObject({ status: 'ok', new: 0, changed: 1, unchanged: 3, fetchedAt: h.clock.now() });
    const hist = h.store.history('vendor/m2');
    expect(hist.map((x) => [x.observedAt, x.inputPerM])).toEqual([
      [firstObserved, 1],
      [h.clock.now(), 2],
    ]);
    expect(h.store.history('vendor/m1')).toHaveLength(1);
  });

  it('37f6c511 FS2-AC6: router "-1" is stored kind=router with null rates and prices as unpriced, never a number', async () => {
    const h = harness([ok({ 'openrouter/auto': { prompt: '-1', completion: '-1' }, ...bulkFeed(2) })]);
    expect((await runPricePull(h.deps)).status).toBe('ok');
    const rec = row(h.store, 'openrouter/auto');
    expect(rec).toMatchObject({ kind: 'router', inputPerM: null, outputPerM: null });
    const est = estimateCost('openrouter/auto', USAGE, { asOf: h.clock.now(), source: createPriceSource(h.ctx.db) });
    expect(est.costUsd).toBeNull();
    expect(est.status).toBe('unpriced_model');
  });

  it('37f6c511 FS2-AC14: 100 good models plus one negative-priced model write ZERO rows (rejected_invalid)', async () => {
    const h = harness([ok(bulkFeed(100, { 'bad/neg': { prompt: '-0.5', completion: '0.000001' } }))]);
    const r = await runPricePull(h.deps);
    expect(r.status).toBe('rejected_invalid');
    expect(r.error).toContain('bad/neg');
    expect(h.store.history('vendor/m0')).toHaveLength(0);
    expect(h.store.lastLedger(h.clock.now()).lastFailed?.status).toBe('rejected_invalid');
    expect(h.log.errors.length).toBeGreaterThan(0);
  });

  it('37f6c511 FS2-AC14: a malformed feed shape is rejected_invalid, not failed', async () => {
    const h = harness([{ body: JSON.stringify({ unexpected: true }) }]);
    expect((await runPricePull(h.deps)).status).toBe('rejected_invalid');
  });

  it('37f6c511 FS2-AC15: pricing.overrides are stored verbatim and the base price row is unaffected', async () => {
    const overrides = [{ min_prompt_tokens: 100000, prompt: '0.00001', completion: '0.00002' }];
    const h = harness([ok({ 'tier/model': { prompt: '0.000001', completion: '0.000002', overrides }, ...bulkFeed(2) })]);
    await runPricePull(h.deps);
    const rec = row(h.store, 'tier/model');
    expect(rec?.overridesJson).toBe(JSON.stringify(overrides));
    expect(rec?.inputPerM).toBe(1);
    expect(rec?.outputPerM).toBe(2);
    // Applied to nothing: the cost is the base rate even for a long-context turn.
    const est = estimateCost('tier/model', { ...USAGE, uncachedInputTokens: 200_000, outputTokens: 0 }, { asOf: h.clock.now(), source: createPriceSource(h.ctx.db) });
    expect(est.costUsd).toBeCloseTo(0.2, 12);
  });
});

describe('runPricePull: failure is loud and never degrades prices', () => {
  const html = '<!doctype html><html><body>Service unavailable</body></html>';
  const cases: Array<[string, FetchStep[], number, string]> = [
    ['HTTP 500 twice (one retry)', [{ body: 'oops', status: 500 }], 2, 'HTTP 500'],
    ['rejected fetch twice (connection refused)', [{ reject: new Error('ECONNREFUSED') }], 2, 'ECONNREFUSED'],
    ['truncated body twice', [{ truncated: true }], 2, 'truncated'],
    ['HTTP 404 (not retried)', [{ body: 'nope', status: 404 }], 1, 'HTTP 404'],
    ['HTML body with 200 (not retried)', [{ body: html }], 1, 'not valid JSON'],
    ['invalid JSON (not retried)', [{ body: '{"data": [' }], 1, 'not valid JSON'],
  ];
  it.each(cases)('37f6c511 FS2-AC4: %s => ledger failed, ERROR log, history and priceAt unchanged', async (_n, steps, calls, cause) => {
    const h = harness([ok(bulkFeed(3)), ...steps]);
    await runPricePull(h.deps);
    const before = row(h.store, 'vendor/m0');
    const beforeRows = h.store.history('vendor/m0');
    h.clock.advance(25 * HOUR);
    const callsBefore = h.fetched.calls.length;
    const errorsBefore = h.log.errors.length;

    const r = await runPricePull(h.deps);

    expect(h.fetched.calls.length - callsBefore).toBe(calls);
    expect(r.status).toBe('failed');
    expect(r.error).toContain(cause);
    expect(h.log.errors.length).toBeGreaterThan(errorsBefore);
    expect(h.store.lastLedger(h.clock.now()).lastFailed).toMatchObject({ status: 'failed', id: r.ledgerId });
    expect(h.store.history('vendor/m0')).toEqual(beforeRows);
    expect(row(h.store, 'vendor/m0')).toEqual(before);
  });

  it('37f6c511 FS2-AC5: an empty feed is rejected_shrink', async () => {
    const h = harness([ok(bulkFeed(10)), { body: JSON.stringify({ data: [] }) }]);
    await runPricePull(h.deps);
    h.clock.advance(25 * HOUR);
    const r = await runPricePull(h.deps);
    expect(r.status).toBe('rejected_shrink');
    expect(h.store.history('vendor/m0')).toHaveLength(1);
  });

  it('37f6c511 FS2-AC5: a feed under 50% of the previous model count is rejected_shrink; exactly 50% passes', async () => {
    const h = harness([ok(bulkFeed(10)), ok(bulkFeed(4)), ok(bulkFeed(5))]);
    await runPricePull(h.deps);
    h.clock.advance(25 * HOUR);
    const small = await runPricePull(h.deps);
    expect(small).toMatchObject({ status: 'rejected_shrink', models: 4 });
    h.clock.advance(25 * HOUR);
    expect((await runPricePull(h.deps)).status).toBe('ok');
  });

  it('37f6c511 FS2-AC5: with no prior pull the baseline is the bundled snapshot count, so a tiny first feed is rejected', async () => {
    const h = harness([ok(bulkFeed(3))]);
    const { baselineModelCount: _drop, ...noBaseline } = h.deps;
    void _drop;
    expect((await runPricePull(noBaseline)).status).toBe('rejected_shrink');
    expect(h.store.history('vendor/m0')).toHaveLength(0);
  });

  it('37f6c511 FS2-AC16: the last good prices keep serving after a failed pull (priceAt unchanged, value identical)', async () => {
    const h = harness([ok({ 'deepseek/deepseek-v4.1-flash': { prompt: '0.0000003', completion: '0.0000012' }, ...bulkFeed(3) }), { body: 'x', status: 503 }]);
    await runPricePull(h.deps);
    const src = createPriceSource(h.ctx.db);
    const priced = () => estimateCost('deepseek-flash', USAGE, { asOf: h.clock.now(), source: src }).costUsd;
    const before = priced();
    h.clock.advance(25 * HOUR);
    expect((await runPricePull(h.deps)).status).toBe('failed');
    expect(priced()).toBe(before);
    expect(before).toBeCloseTo(0.3 + 1.2, 12);
  });
});

describe('runPricePull: etiquette and retry', () => {
  it('37f6c511 FS2-AC11: 429 with Retry-After:1 then 200 => exactly one retry after 1000 ms, status ok', async () => {
    const h = harness([{ body: '', status: 429, headers: { 'Retry-After': '1' } }, ok(bulkFeed(2))]);
    const r = await runPricePull(h.deps);
    expect(r.status).toBe('ok');
    expect(h.fetched.calls).toHaveLength(2);
    expect(h.sleeps).toEqual([1000]);
  });

  it('37f6c511 FS2-AC11: two consecutive 429s => failed after exactly 2 requests', async () => {
    const h = harness([{ body: '', status: 429, headers: { 'Retry-After': '1' } }]);
    const r = await runPricePull(h.deps);
    expect(r.status).toBe('failed');
    expect(r.httpStatus).toBe(429);
    expect(h.fetched.calls).toHaveLength(2);
    expect(h.sleeps).toEqual([1000]);
  });

  it('37f6c511 FS2-AC11: no Retry-After waits the 60s default; a huge Retry-After is capped', async () => {
    const a = harness([{ body: '', status: 503 }, ok(bulkFeed(2))]);
    await runPricePull(a.deps);
    expect(a.sleeps).toEqual([60_000]);
    const b = harness([{ body: '', status: 429, headers: { 'Retry-After': '99999' } }, ok(bulkFeed(2))]);
    await runPricePull(b.deps);
    expect(b.sleeps).toEqual([MAX_RETRY_WAIT_MS]);
    // The worst-case single pull stays under the running-claim TTL so a live pull is never superseded.
    expect(2 * FETCH_TIMEOUT_MS + MAX_RETRY_WAIT_MS).toBeLessThan(RUNNING_TTL_MS);
  });

  it('37f6c511 FS2-AC11: Retry-After as an HTTP-date is measured against the injected clock', () => {
    expect(parseRetryAfterMs('Sat, 10 Oct 2026 00:00:07 GMT', T0)).toBe(7000);
    expect(parseRetryAfterMs('garbage', T0)).toBeUndefined();
    expect(parseRetryAfterMs(null, T0)).toBeUndefined();
  });

  it('37f6c511 FS2-AC13: requests carry no credential header, a User-Agent starting agent-mcp/, and need no env var', async () => {
    const saved = { ...process.env };
    delete process.env['OPENROUTER_API_KEY'];
    delete process.env['ADHD_AGENT_OPENAI_SECRET'];
    try {
      const h = harness([ok(bulkFeed(2))]);
      expect((await runPricePull(h.deps)).status).toBe('ok');
      const init = h.fetched.calls[0]?.init ?? {};
      expect(() => assertNoCredentials(init)).not.toThrow();
      const headers = new Headers(init.headers as HeadersInit);
      expect(headers.get('user-agent')).toBe('agent-mcp/9.9.9 (price-sync)');
      expect(h.fetched.calls[0]?.url).toBe('https://openrouter.ai/api/v1/models');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      process.env = saved;
    }
  });

  it('37f6c511 FS2-AC13 negative control: the credential assertion fails on a request that carries Authorization or a cookie', () => {
    expect(() => assertNoCredentials({ headers: { Authorization: 'Bearer sk-x' } })).toThrow(/authorization/);
    expect(() => assertNoCredentials({ headers: { Cookie: 'a=b' } })).toThrow(/cookie/);
  });
});

describe('runPricePull: anomaly hold, warn and accept', () => {
  const base = (input: string, output = '0.000002') => ({ 'held/model': { prompt: input, completion: output }, 'warn/model': { prompt: '0.000001', completion: '0.000001' }, ...bulkFeed(3) });

  it('37f6c511 FS2-AC8: a 20x jump is HELD with an ERROR (price unchanged); a 10x move is applied with a WARN; accept releases the hold on the next pull', async () => {
    expect(PRICE_ANOMALY_THRESHOLDS).toMatchObject({ holdFactor: 20, warnFactor: 10, maxInputPerM: 1000 });
    const jump = { ...base('0.00002'), 'warn/model': { prompt: '0.00001', completion: '0.000001' } };
    const h = harness([ok(base('0.000001')), ok(jump), ok(jump)]);
    await runPricePull(h.deps);
    h.clock.advance(25 * HOUR);
    const errorsBefore = h.log.errors.length;
    const warnsBefore = h.log.warns.length;

    const held = await runPricePull(h.deps);

    expect(held.anomalies.find((a) => a.modelId === 'held/model')?.severity).toBe('hold');
    expect(row(h.store, 'held/model')?.inputPerM).toBe(1); // unchanged: previous price keeps serving
    expect(h.log.errors.length).toBeGreaterThan(errorsBefore);
    expect(h.log.errors.some((e) => String(e.msg).includes('held/model'))).toBe(true);
    expect(row(h.store, 'warn/model')?.inputPerM).toBe(10); // 10x applied
    expect(held.anomalies.find((a) => a.modelId === 'warn/model')?.severity).toBe('warn');
    expect(h.log.warns.length).toBeGreaterThan(warnsBefore);

    // Without accept the hold persists on the next pull.
    h.clock.advance(25 * HOUR);
    const again = await runPricePull(h.deps);
    expect(again.anomalies.some((a) => a.modelId === 'held/model' && a.severity === 'hold')).toBe(true);
    expect(row(h.store, 'held/model')?.inputPerM).toBe(1);

    // accept:[id] on the next pull applies it, as a real second observation.
    h.clock.advance(25 * HOUR);
    const released = await runPricePull(h.deps, { accept: ['held/model'] });
    expect(released.changed).toBe(1);
    expect(row(h.store, 'held/model')?.inputPerM).toBe(20);
    expect(h.store.history('held/model').map((x) => x.inputPerM)).toEqual([1, 20]);
  });

  it('37f6c511 FS2-AC8 negative control: with the accept set dropped the held model never changes', async () => {
    const h = harness([ok(base('0.000001')), ok(base('0.00005'))]);
    await runPricePull(h.deps);
    h.clock.advance(25 * HOUR);
    await runPricePull(h.deps, { accept: [] });
    expect(row(h.store, 'held/model')?.inputPerM).toBe(1);
  });
});

describe('claim: multi-process safety and manual refresh', () => {
  it('37f6c511 FS2-AC9: a pull within 24h of a successful one is skipped(fresh); force bypasses the gate', async () => {
    const h = harness([ok(bulkFeed(3))]);
    expect((await runPricePull(h.deps)).status).toBe('ok');
    h.clock.advance(HOUR);
    expect(await runPricePull(h.deps)).toMatchObject({ status: 'skipped', reason: 'fresh' });
    expect((await runPricePull(h.deps, { force: true })).status).toBe('ok');
    expect(h.fetched.calls).toHaveLength(2);
  });

  it('37f6c511 FS2-AC9: two connections to one DB file pulling at once produce exactly one pull (latch-driven, no sleeps)', async () => {
    const s = scratchDir();
    scratch.push(s);
    const file = `${s.dir}/shared.db`;
    const a = openDb(file);
    const b = openDb(file);
    opened.push(a, b);
    const gate = latch();
    const clock = makeClock();
    const mk = (ctx: ITestDb, steps: FetchStep[]) => harness(steps, { ctx, clock });
    const first = mk(a, [{ gate: gate.gate, then: ok(bulkFeed(3)) }]);
    const second = mk(b, [ok(bulkFeed(3))]);

    const inFlight = runPricePull(first.deps);
    // The first process holds a live `running` claim; the second must not fetch.
    const loser = await runPricePull(second.deps);
    expect(loser).toMatchObject({ status: 'skipped', reason: 'running' });
    expect(second.fetched.calls).toHaveLength(0);
    gate.open();
    expect((await inFlight).status).toBe('ok');
    expect(first.fetched.calls).toHaveLength(1);
    // Once settled, the next claim sees a fresh `ok` row written by the OTHER connection.
    expect(await runPricePull(second.deps)).toMatchObject({ status: 'skipped', reason: 'fresh' });
  });

  it('37f6c511 FS2-AC9: a crashed `running` row is superseded by the next claim after the TTL', async () => {
    const h = harness([ok(bulkFeed(3))]);
    const crashed = h.store.claimPull(h.clock.now(), { minIntervalMs: 1, runningTtlMs: RUNNING_TTL_MS, force: true, sourceUrl: 'x' });
    expect(crashed.claimed).toBe(true);
    expect(await runPricePull(h.deps)).toMatchObject({ status: 'skipped', reason: 'running' });
    h.clock.advance(RUNNING_TTL_MS + 1);
    expect((await runPricePull(h.deps)).status).toBe('ok');
  });

  it('37f6c511 FS2-AC10: pricing_refresh forces past the 24h gate and its result equals the DB contents', async () => {
    const feed = bulkFeed(6);
    const fetched = fakeFetch(ok(feed));
    const ctx = mem();
    const clock = makeClock();
    const svc = createPricingService({ db: ctx.db, logger: makeLogger(), version: '1.0.0', fetchImpl: fetched.fetchImpl, now: clock.now, sleep: async () => undefined, baselineModelCount: 0 });
    const first = await pricingRefresh({}, svc);
    clock.advance(HOUR); // well inside the 24h gate
    const again = await pricingRefresh({}, svc);
    expect(first).toMatchObject({ status: 'ok', models: 6, new: 6 });
    expect(again).toMatchObject({ status: 'ok', models: 6, new: 0, unchanged: 6 });
    const hist = pricingHistory({ model: 'vendor/m3' }, svc) as { rows: Array<{ ledger_id: string; source: string }>; status: { last_ok: { ledger_id: string } } };
    expect(hist.rows).toHaveLength(1);
    expect(hist.rows[0]?.ledger_id).toBe(first['ledger_id']);
    expect(hist.status.last_ok.ledger_id).toBe(again['ledger_id']);
  });

  it('37f6c511 FS2-AC18: pricing_history reports last ok/failed and price_age_hours, which a failed pull does not reset', async () => {
    const ctx = mem();
    const clock = makeClock();
    const fetched = fakeFetch(ok(bulkFeed(4)), { body: 'x', status: 500 });
    const svc = createPricingService({ db: ctx.db, logger: makeLogger(), version: '1.0.0', fetchImpl: fetched.fetchImpl, now: clock.now, sleep: async () => undefined, baselineModelCount: 0 });
    await pricingRefresh({}, svc);
    clock.advance(3 * HOUR);
    const failed = await pricingRefresh({}, svc);
    expect(failed['status']).toBe('failed');
    clock.advance(2 * HOUR);
    const h = pricingHistory({ model: 'vendor/m0' }, svc) as { status: { price_age_hours: number; last_failed: { status: string }; last_ok: unknown; anomaly_thresholds: unknown } };
    expect(h.status.price_age_hours).toBeCloseTo(5, 6);
    expect(h.status.last_failed.status).toBe('failed');
    expect(h.status.last_ok).not.toBeNull();
    expect(h.status.anomaly_thresholds).toEqual(PRICE_ANOMALY_THRESHOLDS);
  });

  it('37f6c511 FS5-AC2: pricing_history returns the series in observed_at order with source and ledger_id, and honours from/to', async () => {
    const ctx = mem();
    const clock = makeClock();
    const fetched = fakeFetch(ok({ 'a/b': { prompt: '0.000001', completion: '0.000001' }, ...bulkFeed(2) }), ok({ 'a/b': { prompt: '0.000002', completion: '0.000001' }, ...bulkFeed(2) }));
    const svc = createPricingService({ db: ctx.db, logger: makeLogger(), version: '1.0.0', fetchImpl: fetched.fetchImpl, now: clock.now, sleep: async () => undefined, baselineModelCount: 0 });
    await pricingRefresh({}, svc);
    clock.advance(30 * HOUR);
    await pricingRefresh({}, svc);
    const all = pricingHistory({ model: 'A/B' }, svc) as { model: string; rows: Array<{ observed_at: string; input_per_m: number; source: string; ledger_id: string | null }> };
    expect(all.model).toBe('a/b');
    expect(all.rows.map((r) => r.input_per_m)).toEqual([1, 2]);
    expect(all.rows.map((r) => r.observed_at)).toEqual([...all.rows.map((r) => r.observed_at)].sort());
    expect(all.rows.every((r) => r.source === 'openrouter-live' && r.ledger_id !== null)).toBe(true);
    const win = pricingHistory({ model: 'a/b', from: '2026-10-11T00:00:00.000Z' }, svc) as { rows: unknown[] };
    expect(win.rows).toHaveLength(1);
  });
});

describe('scheduler', () => {
  function sched(opts: { ctx?: ITestDb; clock?: ReturnType<typeof makeClock>; steps?: FetchStep[] } = {}) {
    const h = harness(opts.steps ?? [ok(bulkFeed(3))], { ctx: opts.ctx, clock: opts.clock });
    const timers = fakeTimers();
    return { h, timers, start: (o = {}) => startPriceScheduler(h.deps, { timers, ...o }) };
  }
  const seedOk = (s: ReturnType<typeof sched>, ageMs: number) => {
    const startedAt = new Date(Date.parse(s.h.clock.now()) - ageMs).toISOString();
    const c = s.h.store.claimPull(startedAt, { minIntervalMs: 1, runningTtlMs: RUNNING_TTL_MS, force: true, sourceUrl: 'x' });
    if (!c.claimed) throw new Error('seed claim failed');
    s.h.store.finishPull(c.ledgerId, { status: 'ok', finishedAt: startedAt, modelsSeen: 3 });
  };

  it('37f6c511 FS2-AC9: no prior success => one pull after the start delay', async () => {
    const s = sched();
    const sc = s.start({ startDelayMs: 5000 });
    expect(s.timers.pending.map((p) => p.ms)).toEqual([5000]);
    expect(s.h.fetched.calls).toHaveLength(0);
    s.timers.fireNext();
    await sc.idle();
    expect(s.h.fetched.calls).toHaveLength(1);
    expect(s.h.store.lastLedger(s.h.clock.now()).lastOk).toBeDefined();
    // Re-armed for the next cycle at 24h.
    expect(s.timers.pending.map((p) => p.ms)).toEqual([PULL_INTERVAL_MS]);
    sc.stop();
  });

  it('37f6c511 FS2-AC9: last ok 25h old => a pull is scheduled at start; 1h old => none now, next at last_ok + 24h', async () => {
    const stale = sched();
    seedOk(stale, 25 * HOUR);
    const a = stale.start({ startDelayMs: 1000 });
    expect(stale.timers.pending.map((p) => p.ms)).toEqual([1000]);
    stale.timers.fireNext();
    await a.idle();
    expect(stale.h.fetched.calls).toHaveLength(1);
    a.stop();

    const fresh = sched();
    seedOk(fresh, HOUR);
    const b = fresh.start({ startDelayMs: 1000 });
    expect(fresh.h.fetched.calls).toHaveLength(0);
    expect(fresh.timers.pending.map((p) => p.ms)).toEqual([23 * HOUR]);
    expect(b.nextRunAt()).toBe(new Date(Date.parse(T0) + 23 * HOUR).toISOString());
    b.stop();
  });

  it('37f6c511 FS2-AC9: two servers on one DB both due at start produce exactly one pull', async () => {
    const f = scratchDir();
    scratch.push(f);
    const file = `${f.dir}/two-servers.db`;
    const a = openDb(file);
    const b = openDb(file);
    opened.push(a, b);
    const clock = makeClock();
    const gate = latch();
    const one = sched({ ctx: a, clock, steps: [{ gate: gate.gate, then: ok(bulkFeed(3)) }] });
    const two = sched({ ctx: b, clock, steps: [ok(bulkFeed(3))] });
    const s1 = one.start();
    const s2 = two.start();
    one.timers.fireNext();
    two.timers.fireNext();
    await s2.idle(); // loser resolves while the winner is still mid-fetch
    expect(two.h.fetched.calls).toHaveLength(0);
    gate.open();
    await s1.idle();
    expect(one.h.fetched.calls).toHaveLength(1);
    expect(two.h.fetched.calls.length + one.h.fetched.calls.length).toBe(1);
    s1.stop();
    s2.stop();
  });

  it('37f6c511 FS2-AC17: every timer is unref()d and stop() clears the armed timer (no pending pull handle)', () => {
    const s = sched();
    const sc = s.start();
    expect(s.timers.pending).toHaveLength(1);
    expect(s.timers.pending.every((p) => p.unrefCalled)).toBe(true);
    sc.stop();
    expect(s.timers.pending).toHaveLength(0);
    expect(sc.nextRunAt()).toBeNull();
    sc.stop(); // idempotent
  });

  it('37f6c511 FS2-AC17 negative control: a scheduler that is never stopped still holds an armed timer', () => {
    const s = sched();
    s.start();
    expect(s.timers.pending).toHaveLength(1);
  });

  it('37f6c511 FS2-AC17: stop() during an in-flight pull aborts it, closes the ledger row failed, and arms no new timer', async () => {
    const gate = latch(); // never opened: only abort can release the fetch
    const s = sched({ steps: [{ gate: gate.gate, then: ok(bulkFeed(3)) }] });
    const sc = s.start();
    s.timers.fireNext();
    expect(s.timers.pending).toHaveLength(0);
    sc.stop();
    await sc.idle();
    expect(s.timers.pending).toHaveLength(0); // not re-armed after stop
    const ledger = s.h.store.lastLedger(s.h.clock.now());
    expect(ledger.lastFailed).toMatchObject({ status: 'failed', error: 'aborted: shutdown' });
    expect(ledger.lastFailed?.status).not.toBe('running');
    expect(s.h.fetched.calls).toHaveLength(1); // no retry after shutdown
  });

  it('37f6c511 FS2-AC9 / RV-B3: a failed scheduled pull re-arms at the 2h transient backoff (no hot loop, not a full day)', async () => {
    const s = sched({ steps: [{ body: 'x', status: 500 }] });
    const sc = s.start({ startDelayMs: 10 });
    s.timers.fireNext();
    await sc.idle();
    expect(s.timers.pending.map((p) => p.ms)).toEqual([2 * HOUR]);
    sc.stop();
  });
});

describe('pricing service: seeding and the offline start', () => {
  it('37f6c511 FS2-AC16: offline first start with an empty store seeds the bundled snapshot, warns once, and costs stay byte-identical', async () => {
    const ctx = mem();
    const log = makeLogger();
    const timers = fakeTimers();
    const offline = fakeFetch({ reject: new Error('ENOTFOUND') });
    const svc = createPricingService({ db: ctx.db, logger: log, version: '1.0.0', fetchImpl: offline.fetchImpl, scheduler: { timers }, sleep: async () => undefined, baselineModelCount: 0 });

    const withoutSource = estimateCostUsd('deepseek-flash', USAGE);
    expect(estimateCostUsd('deepseek-flash', USAGE, { source: createPriceSource(ctx.db) })).toBe(withoutSource); // empty store
    svc.start();
    const warns = log.warns.filter((w) => String(w.msg).includes('no successful live price pull'));
    expect(warns).toHaveLength(1);
    expect(svc.store.history('deepseek/deepseek-v4.1-flash')[0]?.source).toBe('bundled');
    expect(estimateCostUsd('deepseek-flash', USAGE, { source: svc.priceSource })).toBe(withoutSource);
    expect(withoutSource).not.toBeNull();
    expect(svc.nextScheduled()).not.toBeNull();
    svc.stop();
    expect(timers.pending).toHaveLength(0);
  });

  it('37f6c511 FS2-AC16: seeding is idempotent across restarts', () => {
    const ctx = mem();
    const mk = () => createPricingService({ db: ctx.db, logger: makeLogger(), version: '1.0.0', scheduler: { timers: fakeTimers() } });
    const a = mk();
    a.start();
    const n = a.store.history('deepseek/deepseek-v4.1-flash').length;
    a.stop();
    const b = mk();
    b.start();
    expect(b.store.history('deepseek/deepseek-v4.1-flash')).toHaveLength(n);
    b.stop();
  });
});
