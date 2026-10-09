/**
 * c536ce29 P2-AC-C (unit lane, no sockets) — pricing ops logging is observational only.
 *
 * With inert channels, or a channel that throws on every call, `runPricePull` returns exactly what it
 * returns with a working channel: logging never alters a pull's outcome.
 */
import type { LogChannel } from '@adhd/agent-plugin-tracing';
import { PriceHistoryStore } from '@adhd/agent-store-runtime';
import { describe, expect, it } from 'vitest';

import { FORCED_MIN_INTERVAL_MS, runPricePull } from '../pricing/pull.js';
import { noopLogChannel } from '../wire/channels.js';
import { bulkFeed, fakeFetch, feedOf, HOUR, makeClock, makeLogger, openDb } from './pricing-fixtures.js';

const body = feedOf({ 'a/one': { prompt: '0.0000003', completion: '0.0000012' }, ...bulkFeed(3) });

async function pull(ops?: Parameters<typeof runPricePull>[0]['ops']) {
  const o = openDb();
  try {
    const clock = makeClock();
    const r = await runPricePull({
      store: new PriceHistoryStore(o.db),
      fetchImpl: fakeFetch({ body }).fetchImpl,
      now: clock.now,
      sleep: async () => undefined,
      logger: makeLogger(),
      version: '1.0.0',
      baselineModelCount: 0,
      ...(ops === undefined ? {} : { ops }),
    });
    return { ...r, ledgerId: undefined };
  } finally {
    o.sqlite.close();
  }
}

describe('c536ce29 P2-AC-C pricing logging never changes behaviour', () => {
  it('c536ce29 P2-AC-C: default (no channel installed), noop channel and a throwing channel yield the same pull result', async () => {
    const throwing = (): never => {
      throw new Error('channel exploded');
    };
    const baseline = await pull();
    expect(baseline.status).toBe('ok');
    expect(await pull(noopLogChannel())).toEqual(baseline);
    expect(await pull(throwing)).toEqual(baseline);
  });
});

type Rec = { event: string; fields: Record<string, unknown>; level?: string };

/** An in-memory ops channel recording every event (no files, no sockets). */
function recordingChannel(): { channel: LogChannel; recs: Rec[] } {
  const recs: Rec[] = [];
  const channel = {
    logEvent: (event: string, fields: Record<string, unknown>, level?: string) => void recs.push({ event, fields, level }),
  } as unknown as LogChannel;
  return { channel, recs };
}

describe('c536ce29 F1-AC-C forced-pull floor is visible in the ops log', () => {
  const baseModels = (input: string) => ({
    'held/model': { prompt: input, completion: '0.000002' },
    ...bulkFeed(3),
  });

  it('c536ce29 F1-AC-C: a forced pull inside the floor is refused with reason forced_too_soon; an accept-carrying pull bypasses it and logs accepted:true', async () => {
    const o = openDb();
    try {
      const clock = makeClock();
      const { channel, recs } = recordingChannel();
      const fetcher = fakeFetch(
        { body: feedOf(baseModels('0.000001')) },
        { body: feedOf(baseModels('0.00002')) }, // 20x jump -> held
        { body: feedOf(baseModels('0.00002')) } // released by accept
      );
      const deps = {
        store: new PriceHistoryStore(o.db),
        fetchImpl: fetcher.fetchImpl,
        now: clock.now,
        sleep: async () => undefined,
        logger: makeLogger(),
        version: '1.0.0',
        baselineModelCount: 0,
        ops: channel,
      };

      expect((await runPricePull(deps)).status).toBe('ok');
      clock.advance(25 * HOUR);
      const held = await runPricePull(deps);
      expect(held.anomalies.find((a) => a.modelId === 'held/model')?.severity).toBe('hold');
      expect(recs.find((r) => r.event === 'pricing.anomaly')?.fields).toMatchObject({ model_id: 'held/model', accepted: false });

      // Inside the 10-minute floor: a plain forced pull is refused, and the ops record says why.
      clock.advance(FORCED_MIN_INTERVAL_MS / 10);
      const before = recs.length;
      const refused = await runPricePull(deps, { force: true });
      expect(refused).toMatchObject({ status: 'skipped', reason: 'forced_too_soon' });
      const skipped = recs.slice(before).filter((r) => r.event === 'pricing.pull.skipped');
      expect(skipped).toHaveLength(1);
      expect(skipped[0]?.fields).toMatchObject({ component: 'pricing', reason: 'forced_too_soon', forced: true, accept: [] });
      expect(recs.slice(before).some((r) => r.event === 'pricing.pull.start')).toBe(false);

      // Still inside the floor: an accept-carrying pull bypasses it, starts, and logs accepted:true.
      const mark = recs.length;
      const released = await runPricePull(deps, { force: true, accept: ['held/model'] });
      expect(released.status).toBe('ok');
      const after = recs.slice(mark);
      expect(after.find((r) => r.event === 'pricing.pull.start')?.fields).toMatchObject({ forced: true, accept: ['held/model'] });
      expect(after.some((r) => r.event === 'pricing.pull.skipped')).toBe(false);
      expect(after.find((r) => r.event === 'pricing.anomaly')?.fields).toMatchObject({ model_id: 'held/model', accepted: true });
    } finally {
      o.sqlite.close();
    }
  });
});
