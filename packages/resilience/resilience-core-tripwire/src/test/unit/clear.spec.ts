/**
 * Ticket 8468f7b1 - clearing: the confirm-token policy (TripwireConfirmError
 * without CONFIRM_TOKEN, no state change), the open policy (mcp-clear),
 * clearing an absent lock, the cleared marker feeding priorClear on the
 * next trip, and resolve (tripwire-resolved, then a reverified-aware
 * cleared event).
 * Criteria: [tripwire-core.14] TW14, [tripwire-core.15] TW15,
 * [tripwire-core.16] TW16, [tripwire-core.17] TW17, [tripwire-core.18] TW18.
 */
import {
  CONFIRM_TOKEN,
  TripwireConfirmError,
  isTripwireError,
} from '../../index';
import { eventsOf, makeEnv, rejectionOf } from '../support/harness';

describe('[tripwire-core.14] TW14 confirm-token policy', () => {
  it('a missing or wrong token throws TripwireConfirmError, no change',
    async () => {
      const env = makeEnv();
      await env.tw.trip('tinder', {
        reason: 'http-4xx',
        context: {},
      });
      const before = env.mfs.readText(env.lockPath('tinder'));
      const opsBefore = env.mfs.ops.length;
      for (const confirm of [undefined, '', 'i-understand-the-risk', 'yes']) {
        const err = await rejectionOf(env.tw.clear('tinder', {
          method: 'programmatic-confirm',
          confirm,
        }));
        expect(err).toBeInstanceOf(TripwireConfirmError);
        expect(isTripwireError(err)).toBe(true);
        expect((err as TripwireConfirmError).code)
          .toBe('TRIPWIRE_CONFIRM_REQUIRED');
      }
      // no fs operation at all, lock intact, nothing audited
      expect(env.mfs.ops.length).toBe(opsBefore);
      expect(env.mfs.readText(env.lockPath('tinder'))).toBe(before);
      expect(eventsOf(env, 'tripwire-cleared')).toHaveLength(0);
      expect((await env.tw.gate('tinder')).open).toBe(false);
    });

  it('CONFIRM_TOKEN clears; the audit has method and actor', async () => {
    const env = makeEnv();
    await env.tw.trip('tinder', {
      reason: 'http-4xx',
      context: {},
    });
    await env.tw.gate('tinder');
    expect(CONFIRM_TOKEN).toBe('I-UNDERSTAND-THE-RISK');
    const r = await env.tw.clear('tinder', {
      method: 'programmatic-confirm',
      confirm: CONFIRM_TOKEN,
      actor: 'reverse-auth',
    });
    expect(r).toEqual({ cleared: true });
    expect(env.mfs.exists(env.lockPath('tinder'))).toBe(false);
    expect(env.mfs.exists(env.blockedPath('tinder'))).toBe(false);
    const c = eventsOf(env, 'tripwire-cleared');
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({
      key: 'tinder',
      method: 'programmatic-confirm',
      actor: 'reverse-auth',
      reason: 'http-4xx',
      blockedCount: 1,
      reverified: false,
    });
    expect((await env.tw.gate('tinder')).open).toBe(true);
  });

  it('the default actor is the instance actor', async () => {
    const env = makeEnv();
    await env.tw.trip('k', {
      reason: 'x',
      context: {},
    });
    await env.tw.clear('k', {
      method: 'unlock-cli-env',
      confirm: CONFIRM_TOKEN,
    });
    expect(eventsOf(env, 'tripwire-cleared')[0].actor).toBe('tester');
  });
});

describe('[tripwire-core.15] TW15 open policy', () => {
  it('clears without a token and audits method mcp-clear', async () => {
    const env = makeEnv({ clearPolicy: 'open' });
    await env.tw.trip('google', {
      reason: 'captcha',
      context: {},
    });
    expect(await env.tw.clear('google', { method: 'mcp-clear' }))
      .toEqual({ cleared: true });
    expect(eventsOf(env, 'tripwire-cleared')[0].method).toBe('mcp-clear');
    expect((await env.tw.gate('google')).open).toBe(true);
  });
});

describe('[tripwire-core.16] TW16 clear on an absent lock', () => {
  it('returns { cleared: false }, never throws, audits nothing', async () => {
    const env = makeEnv({ clearPolicy: 'open' });
    expect(await env.tw.clear('none', { method: 'mcp-clear' }))
      .toEqual({ cleared: false });
    const tokenEnv = makeEnv();
    expect(await tokenEnv.tw.clear('none', {
      method: 'programmatic-confirm',
      confirm: CONFIRM_TOKEN,
    })).toEqual({ cleared: false });
    expect(env.auditText()).toBe('');
    expect(tokenEnv.auditText()).toBe('');
    expect(env.writes()).toEqual([]);
  });

  it('a second clear reports cleared: false', async () => {
    const env = makeEnv({ clearPolicy: 'open' });
    await env.tw.trip('k', {
      reason: 'x',
      context: {},
    });
    expect((await env.tw.clear('k', { method: 'mcp-clear' })).cleared)
      .toBe(true);
    expect((await env.tw.clear('k', { method: 'mcp-clear' })).cleared)
      .toBe(false);
    expect(eventsOf(env, 'tripwire-cleared')).toHaveLength(1);
  });
});

describe('[tripwire-core.17] TW17 cleared marker and priorClear', () => {
  it('the next trip carries priorClear; the marker is consumed once',
    async () => {
      const env = makeEnv({ clearPolicy: 'open' });
      await env.tw.trip('k', {
        reason: 'captcha',
        context: {},
      });
      env.clock.advance(1000);
      await env.tw.clear('k', {
        method: 'hitl-clear',
        actor: 'nix',
      });
      const clearedAt = new Date(env.clock.now).toISOString();
      expect(env.mfs.exists(env.markerPath('k'))).toBe(true);
      env.clock.advance(1000);
      const r = await env.tw.trip('k', {
        reason: 'captcha',
        context: {},
      });
      const prior = {
        clearedAt,
        method: 'hitl-clear',
        actor: 'nix',
      };
      expect(r.record.priorClear).toEqual(prior);
      expect(JSON.parse(env.mfs.readText(env.lockPath('k')) as string)
        .priorClear).toEqual(prior);
      expect((await env.tw.read('k')).record?.priorClear).toEqual(prior);
      expect(eventsOf(env, 'tripwire-fired')[1].priorClear).toEqual(prior);
      expect(env.mfs.exists(env.markerPath('k'))).toBe(false);
      // a retrip does not consume anything; a break-glass rm leaves no
      // marker, so the trip after it carries no priorClear
      await env.mfs.unlink(env.lockPath('k'));
      const again = await env.tw.trip('k', {
        reason: 'captcha',
        context: {},
      });
      expect(again.record.priorClear).toBeUndefined();
    });

  it('a lost create race puts the marker back', async () => {
    const env = makeEnv({ clearPolicy: 'open' });
    await env.tw.trip('k', {
      reason: 'x',
      context: {},
    });
    await env.tw.clear('k', { method: 'mcp-clear' });
    // another process creates the lock between our check and our link
    let injected = false;
    env.mfs.observe((rec) => {
      if (!injected && rec.op === 'openExclusive' &&
        rec.path.includes('k.lock.')) {
        injected = true;
        env.mfs.writeText(env.lockPath('k'), JSON.stringify({
          reason: 'other',
          trippedAt: '2026-10-12T00:00:00Z',
        }));
      }
    });
    const r = await env.tw.trip('k', {
      reason: 'mine',
      context: {},
    });
    env.mfs.observe(undefined);
    expect(r.created).toBe(false);
    expect(r.record.reason).toBe('other');
    expect(env.mfs.exists(env.markerPath('k'))).toBe(true);
  });
});

describe('[tripwire-core.18] TW18 resolve', () => {
  it('audits tripwire-resolved with durationMs and blockedCount, then clears',
    async () => {
      const env = makeEnv();
      const { record } = await env.tw.trip('google', {
        reason: 'captcha',
        context: {},
      });
      await env.tw.gate('google');
      await env.tw.gate('google');
      env.clock.advance(5000);
      // resolve needs no token, even under confirm-token
      await env.tw.resolve('google', { actor: 'agent-search' });
      expect(env.mfs.exists(env.lockPath('google'))).toBe(false);
      const events = env.audit().map((e) => e.event);
      expect(events.slice(-2)).toEqual(['tripwire-resolved',
        'tripwire-cleared']);
      const resolved = eventsOf(env, 'tripwire-resolved')[0];
      expect(resolved).toMatchObject({
        key: 'google',
        reason: 'captcha',
        trippedAt: record.trippedAt,
        durationMs: 5000,
        blockedCount: 2,
        actor: 'agent-search',
      });
      expect(eventsOf(env, 'tripwire-cleared')[0]).toMatchObject({
        method: 'resolved',
        reverified: false,
      });
    });

  it('resolve on a clear key does nothing', async () => {
    const env = makeEnv();
    await env.tw.resolve('k');
    expect(env.writes()).toEqual([]);
  });

  it('the reverified flag appears on the cleared audit event', async () => {
    const env = makeEnv({ clearPolicy: 'open' });
    await env.tw.trip('k', {
      reason: 'captcha',
      context: {},
    });
    await env.tw.clear('k', {
      method: 'hitl-retry',
      reverified: true,
    });
    expect(eventsOf(env, 'tripwire-cleared')[0]).toMatchObject({
      method: 'hitl-retry',
      reverified: true,
    });
  });

  it('a storage failure on clear is a TRIPWIRE_IO error', async () => {
    const env = makeEnv({ clearPolicy: 'open' });
    await env.tw.trip('k', {
      reason: 'x',
      context: {},
    });
    env.mfs.failOn({
      op: 'rename',
      code: 'EACCES',
    });
    const err = await rejectionOf(env.tw.clear('k', { method: 'mcp-clear' }));
    expect((err as { code: string }).code).toBe('TRIPWIRE_IO');
    expect(env.mfs.exists(env.lockPath('k'))).toBe(true);
  });
});
