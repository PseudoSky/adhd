/**
 * guards: an expired lock still blocks, or a lock without a ttl expires
 * tier: S
 * cites: ticket 8468f7b1; [tripwire-core.13] TW13.
 * Ticket 8468f7b1 - optional expiry: an older-than-ttlMs lock is open and
 * lazily removed with exactly one tripwire-expired audit; without expiry a
 * lock never expires; status hides expired locks unless includeExpired
 * (one rule for the CLI and the MCP surface).
 * Criteria: [tripwire-core.13] TW13.
 */
import { exploreExhaustive } from '../helpers/explore';
import { eventsOf, makeEnv } from '../helpers/harness';

const TTL = { ttlMs: 7_200_000 };

describe('[tripwire-core.13] TW13 expiry with ttlMs', () => {
  it('is closed within the TTL and open after it, removed once', async () => {
    const env = makeEnv({ expiry: TTL });
    await env.tw.trip('google', {
      reason: 'captcha',
      context: {},
    });
    env.clock.advance(TTL.ttlMs);
    expect((await env.tw.gate('google')).open).toBe(false);
    env.clock.advance(1);
    const snap = await env.tw.read('google');
    expect(snap.status).toBe('expired');
    expect(snap.expired).toBe(true);
    expect(env.mfs.exists(env.lockPath('google'))).toBe(true);
    const g = await env.tw.gate('google');
    expect(g.open).toBe(true);
    expect(g.snapshot.status).toBe('expired');
    expect(env.mfs.exists(env.lockPath('google'))).toBe(false);
    expect(env.mfs.exists(env.blockedPath('google'))).toBe(false);
    expect((await env.tw.gate('google')).open).toBe(true);
    const ex = eventsOf(env, 'tripwire-expired');
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({
      key: 'google',
      reason: 'ttl-expired',
      blockedCount: 1,
      method: 'expired',
    });
    await expect(env.tw.assertOpen('google')).resolves.toBeUndefined();
  });

  it('without expiry a lock never expires', async () => {
    const env = makeEnv();
    await env.tw.trip('tinder', {
      reason: 'http-4xx',
      context: {},
    });
    env.clock.advance(50 * 365 * 86_400_000);
    expect((await env.tw.read('tinder')).status).toBe('tripped');
    expect((await env.tw.gate('tinder')).open).toBe(false);
    expect(eventsOf(env, 'tripwire-expired')).toHaveLength(0);
  });

  it('status hides expired unless includeExpired', async () => {
    const env = makeEnv({ expiry: TTL });
    await env.tw.trip('old', {
      reason: 'captcha',
      context: {},
    });
    env.clock.advance(TTL.ttlMs + 1);
    await env.tw.trip('fresh', {
      reason: 'banned',
      context: {},
    });
    expect(Object.keys(await env.tw.status())).toEqual(['fresh']);
    const all = await env.tw.status({ includeExpired: true });
    expect(Object.keys(all)).toEqual(['fresh', 'old']);
    expect(all['old'].reason).toBe('captcha');
    expect(Object.keys(await env.tw.status({ keys: ['old'] }))).toEqual([]);
    // status is read-only: the expired lock is still on disk
    expect(env.mfs.exists(env.lockPath('old'))).toBe(true);
  });

  it('a trip over an expired lock replaces it (created: true)', async () => {
    const env = makeEnv({ expiry: TTL });
    await env.tw.trip('k', {
      reason: 'first',
      context: {},
    });
    env.clock.advance(TTL.ttlMs + 1);
    const r = await env.tw.trip('k', {
      reason: 'second',
      context: {},
    });
    expect(r.created).toBe(true);
    expect((await env.tw.read('k')).record?.reason).toBe('second');
    expect(eventsOf(env, 'tripwire-expired')).toHaveLength(1);
  });

  it('two processes racing an expiry audit tripwire-expired once', async () => {
    const res = await exploreExhaustive(async (pick) => {
      const env = makeEnv({ expiry: TTL });
      await env.tw.trip('k', {
        reason: 'x',
        context: {},
      });
      env.clock.advance(TTL.ttlMs + 1);
      const a = env.otherProcess();
      const b = env.otherProcess();
      const out = await env.mfs.schedule([
        () => a.gate('k'),
        () => b.gate('k'),
      ], pick);
      for (const o of out) {
        expect(o.status).toBe('fulfilled');
        expect((o as PromiseFulfilledResult<{ open: boolean }>).value.open)
          .toBe(true);
      }
      expect(eventsOf(env, 'tripwire-expired')).toHaveLength(1);
      expect(env.mfs.exists(env.lockPath('k'))).toBe(false);
    }, 120);
    expect(res.runs).toBeGreaterThan(10);
  });
});
