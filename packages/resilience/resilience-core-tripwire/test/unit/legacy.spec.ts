/**
 * guards: a previous implementation lock record is not honoured, or its counts are dropped
 * tier: S
 * cites: ticket 8468f7b1; [tripwire-core.4] TW4.
 * Ticket 8468f7b1 - legacy flat lock shapes written by the two previous
 * implementations are read and honoured: the reverse request-builder
 * `{reason, trippedAt, lastStatus, lastOperationId}` and the agent-search
 * record with its in-record blockedCount and reverifiedAt. Extra fields
 * land in `context`; the in-record count adds to the sidecar count.
 * Criteria: [tripwire-core.4] TW4.
 */
import { CONFIRM_TOKEN, TripwireTrippedError } from '../../src/index';
import { makeEnv } from '../helpers/harness';

const REVERSE_LOCK = {
  reason: 'http-4xx',
  trippedAt: '2026-10-01T10:00:00.000Z',
  lastStatus: 401,
  lastOperationId: 'getMe',
};

const SEARCH_LOCK = {
  reason: 'captcha',
  provider: 'google',
  query: 'some query',
  searchSessionId: 'f1f2',
  browserSessionId: 'TARGET-9',
  pageUrl: 'https://www.google.com/sorry/index',
  strategy: 'cdp',
  trippedAt: '2026-10-01T11:00:00.000Z',
  reverifiedAt: '2026-10-01T11:05:00.000Z',
  blockedCount: 4,
  lastOperation: 'search',
};

describe('[tripwire-core.4] TW4 legacy locks are honoured', () => {
  it('reads a reverse-shaped lock: lastStatus, lastOperationId', async () => {
    const env = makeEnv({ namespace: 'request-builder' });
    env.mfs.writeText(env.lockPath('tinder'), JSON.stringify(REVERSE_LOCK));
    const snap = await env.tw.read('tinder');
    expect(snap.status).toBe('tripped');
    expect(snap.record).toMatchObject({
      schema: 1,
      key: 'tinder',
      namespace: 'request-builder',
      reason: 'http-4xx',
      trippedAt: REVERSE_LOCK.trippedAt,
      blockedCount: 0,
      context: {
        lastStatus: 401,
        lastOperationId: 'getMe',
      },
    });
    const err = await env.tw.assertOpen('tinder').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TripwireTrippedError);
    expect((err as TripwireTrippedError).record?.context['lastStatus'])
      .toBe(401);
  });

  it('reads a search-shaped lock; blockedCount adds to the sidecar',
    async () => {
      const env = makeEnv({ namespace: 'agent-search' });
      env.mfs.writeText(env.lockPath('google'), JSON.stringify(SEARCH_LOCK));
      const snap = await env.tw.read('google');
      expect(snap.status).toBe('tripped');
      expect(snap.record?.blockedCount).toBe(4);
      expect(snap.record?.context).toEqual({
        provider: 'google',
        query: 'some query',
        searchSessionId: 'f1f2',
        browserSessionId: 'TARGET-9',
        pageUrl: 'https://www.google.com/sorry/index',
        strategy: 'cdp',
        reverifiedAt: '2026-10-01T11:05:00.000Z',
        lastOperation: 'search',
      });
      const g = await env.tw.gate('google');
      expect(g.open).toBe(false);
      expect(g.snapshot.record?.blockedCount).toBe(5);
      await env.tw.gate('google');
      expect((await env.tw.read('google')).record?.blockedCount).toBe(6);
      // the legacy lock itself is never rewritten by counting
      expect(JSON.parse(env.mfs.readText(env.lockPath('google')) as string))
        .toEqual(SEARCH_LOCK);
      expect(Object.keys(await env.tw.status())).toEqual(['google']);
    });

  it('a legacy lock blocks a retrip and can be cleared', async () => {
    const env = makeEnv();
    env.mfs.writeText(env.lockPath('tinder'), JSON.stringify(REVERSE_LOCK));
    const r = await env.tw.trip('tinder', {
      reason: 'http-4xx',
      context: { lastStatus: 403 },
    });
    expect(r.created).toBe(false);
    expect(r.record.context['lastStatus']).toBe(401);
    expect(await env.tw.clear('tinder', {
      method: 'programmatic-confirm',
      confirm: CONFIRM_TOKEN,
    })).toEqual({ cleared: true });
    expect(env.mfs.exists(env.lockPath('tinder'))).toBe(false);
  });

  it('a legacy search lock expires by its trippedAt under a TTL', async () => {
    const env = makeEnv({ expiry: { ttlMs: 7_200_000 } });
    env.clock.now = Date.parse(SEARCH_LOCK.trippedAt) + 7_200_001;
    env.mfs.writeText(env.lockPath('google'), JSON.stringify(SEARCH_LOCK));
    expect((await env.tw.read('google')).status).toBe('expired');
    expect((await env.tw.gate('google')).open).toBe(true);
    expect(env.mfs.exists(env.lockPath('google'))).toBe(false);
  });

  it('non-JSON-safe legacy fields are dropped, never fatal', async () => {
    const env = makeEnv();
    env.mfs.writeText(
      env.lockPath('k'),
      '{"reason":"banned","trippedAt":"2026-10-01T00:00:00Z",' +
        '"nested":{"a":[1,"b",null]},"blockedCount":"x"}',
    );
    const snap = await env.tw.read('k');
    expect(snap.status).toBe('tripped');
    expect(snap.record?.blockedCount).toBe(0);
    expect(snap.record?.context).toEqual({ nested: { a: [1, 'b', null] } });
  });
});
