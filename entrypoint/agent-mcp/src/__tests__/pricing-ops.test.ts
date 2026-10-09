/**
 * c536ce29 P2-AC-C (unit lane, no sockets) — pricing ops logging is observational only.
 *
 * With inert channels, or a channel that throws on every call, `runPricePull` returns exactly what it
 * returns with a working channel: logging never alters a pull's outcome.
 */
import { PriceHistoryStore } from '@adhd/agent-store-runtime';
import { describe, expect, it } from 'vitest';

import { runPricePull } from '../pricing/pull.js';
import { noopLogChannel } from '../wire/channels.js';
import { bulkFeed, fakeFetch, feedOf, makeClock, makeLogger, openDb } from './pricing-fixtures.js';

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
