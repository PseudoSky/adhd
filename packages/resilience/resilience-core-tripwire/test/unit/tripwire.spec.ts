/**
 * guards: the core latch loses its first record, fails open on a bad read, or accepts an invalid key
 * tier: S
 * cites: ticket 8468f7b1; [tripwire-core.1] TW1, [tripwire-core.3] TW3, [tripwire-core.5] TW5, [tripwire-core.8] TW8, [tripwire-core.9] TW9, [tripwire-core.10] TW10, [tripwire-core.23] TW23.
 * Ticket 8468f7b1 - createTripwire core behaviour: retrip keeps the first
 * record, fail-closed reads, key validation, context round-trip, the gate
 * and assertOpen, and the in-memory latch on a persist failure.
 * Criteria: [tripwire-core.1] TW1, [tripwire-core.3] TW3,
 * [tripwire-core.5] TW5, [tripwire-core.8] TW8, [tripwire-core.9] TW9,
 * [tripwire-core.10] TW10, [tripwire-core.23] TW23.
 */
import {
  CONFIRM_TOKEN,
  TripwireTrippedError,
  isTripwireError,
  isTripwireTrippedError,
  type Tripwire,
} from '../../src/index';
import { eventsOf, makeEnv, rejectionOf, T0 } from '../helpers/harness';

describe('[tripwire-core.1] TW1 second trip keeps the first record', () => {
  it('returns created: false and audits tripwire-retripped', async () => {
    const env = makeEnv();
    const first = await env.tw.trip('tinder', {
      reason: 'http-4xx',
      context: {
        lastStatus: 401,
        lastOperationId: 'getMe',
      },
    });
    expect(first.created).toBe(true);
    expect(first.persisted).toBe(true);
    const lockBefore = env.mfs.readText(env.lockPath('tinder'));
    env.clock.advance(60_000);
    const second = await env.tw.trip('tinder', {
      reason: 'http-4xx-again',
      context: { lastStatus: 403 },
    });
    expect(second.created).toBe(false);
    expect(second.persisted).toBe(true);
    expect(second.record.reason).toBe('http-4xx');
    expect(second.record.trippedAt).toBe(new Date(T0).toISOString());
    expect(second.record.context).toEqual({
      lastStatus: 401,
      lastOperationId: 'getMe',
    });
    expect(env.mfs.readText(env.lockPath('tinder'))).toBe(lockBefore);
    const re = eventsOf(env, 'tripwire-retripped');
    expect(re).toHaveLength(1);
    expect(re[0].reason).toBe('http-4xx-again');
    expect(eventsOf(env, 'tripwire-fired')).toHaveLength(1);
  });

  it('a retrip from another process also keeps the first record', async () => {
    const env = makeEnv();
    await env.tw.trip('k', {
      reason: 'captcha',
      context: {},
    });
    const other = env.otherProcess();
    const r = await other.trip('k', {
      reason: 'banned',
      context: {},
    });
    expect(r.created).toBe(false);
    expect(r.record.reason).toBe('captcha');
  });
});

describe('[tripwire-core.3] TW3 fail closed on an unreadable lock', () => {
  it('ENOENT is the only clear state', async () => {
    const env = makeEnv();
    const snap = await env.tw.read('k');
    expect(snap).toEqual({
      status: 'clear',
      record: null,
      expired: false,
    });
    await expect(env.tw.assertOpen('k')).resolves.toBeUndefined();
  });

  for (const code of ['EACCES', 'EIO']) {
    it(`${code} on read is unreadable and assertOpen throws`, async () => {
      const env = makeEnv();
      env.mfs.writeText(env.lockPath('k'), '{}', 0o600);
      env.mfs.failOn({
        op: 'readFile',
        path: env.lockPath('k'),
        code,
      });
      const snap = await env.tw.read('k');
      expect(snap.status).toBe('unreadable');
      expect(snap.record?.reason).toBe('unreadable-lock');
      expect(snap.record?.context['error']).toBe(code);
      const err = await rejectionOf(env.tw.assertOpen('k'));
      expect(err).toBeInstanceOf(TripwireTrippedError);
      expect((err as TripwireTrippedError).reason).toBe('unreadable-lock');
      expect((await env.tw.gate('k')).open).toBe(false);
    });
  }

  const bad: Array<[string, string]> = [
    ['an empty file', ''],
    ['whitespace only', '  \n'],
    ['garbage JSON', '{"reason": "captcha", '],
    ['a JSON array', '[1,2]'],
    ['a wrong schema version', JSON.stringify({
      schema: 2,
      reason: 'x',
      trippedAt: '2026-01-01T00:00:00Z',
    })],
    ['a schema-1 record missing fields', JSON.stringify({
      schema: 1,
      reason: 'x',
      trippedAt: '2026-01-01T00:00:00Z',
    })],
    ['no reason', JSON.stringify({ trippedAt: '2026-01-01T00:00:00Z' })],
    ['an invalid trippedAt', JSON.stringify({
      reason: 'x',
      trippedAt: 'yesterday',
    })],
  ];
  for (const [label, raw] of bad) {
    it(`${label} is unreadable (tripped) and assertOpen throws`, async () => {
      const env = makeEnv();
      env.mfs.writeText(env.lockPath('k'), raw, 0o600);
      const snap = await env.tw.read('k');
      expect(snap.status).toBe('unreadable');
      expect(snap.expired).toBe(false);
      expect(snap.record?.reason).toBe('unreadable-lock');
      await expect(env.tw.assertOpen('k')).rejects.toBeInstanceOf(
        TripwireTrippedError,
      );
      const st = await env.tw.status();
      expect(Object.keys(st)).toEqual(['k']);
    });
  }

  it('an unreadable lock never expires', async () => {
    const env = makeEnv({ expiry: { ttlMs: 1000 } });
    env.mfs.writeText(env.lockPath('k'), 'not json', 0o600);
    env.clock.advance(10 * 365 * 86_400_000);
    expect((await env.tw.gate('k')).open).toBe(false);
    expect(env.mfs.exists(env.lockPath('k'))).toBe(true);
  });

  it('a trip on an unreadable lock keeps it (created: false)', async () => {
    const env = makeEnv();
    env.mfs.writeText(env.lockPath('k'), '???', 0o600);
    const r = await env.tw.trip('k', {
      reason: 'captcha',
      context: {},
    });
    expect(r.created).toBe(false);
    expect(env.mfs.readText(env.lockPath('k'))).toBe('???');
  });
});

describe('[tripwire-core.5] TW5 TRIPWIRE_INVALID_KEY before any fs call', () => {
  const badKeys = ['..', 'a/b', '', 'x'.repeat(65), '.hidden', 'a\\b', ' a'];
  const calls: Array<[string, (tw: Tripwire, k: string) => Promise<unknown>]> =
    [
      ['read', (tw, k) => tw.read(k)],
      ['gate', (tw, k) => tw.gate(k)],
      ['assertOpen', (tw, k) => tw.assertOpen(k)],
      ['trip', (tw, k) => tw.trip(k, {
        reason: 'x',
        context: {},
      })],
      ['clear', (tw, k) => tw.clear(k, {
        method: 'mcp-clear',
        confirm: CONFIRM_TOKEN,
      })],
      ['resolve', (tw, k) => tw.resolve(k)],
      ['status', (tw, k) => tw.status({ keys: [k] })],
    ];
  for (const key of badKeys) {
    for (const [name, call] of calls) {
      it(`${name}(${JSON.stringify(key).slice(0, 20)}) is rejected`, async () => {
        const env = makeEnv();
        const err = await rejectionOf(call(env.tw, key));
        expect(isTripwireError(err)).toBe(true);
        expect((err as { code: string }).code).toBe('TRIPWIRE_INVALID_KEY');
        expect(env.mfs.ops).toEqual([]);
      });
    }
  }

  it('accepts 64-character keys and dotted names', async () => {
    const env = makeEnv();
    for (const key of ['x'.repeat(64), 'a.b-c_d', '9lives']) {
      await expect(env.tw.read(key)).resolves.toMatchObject({
        status: 'clear',
      });
    }
  });
});

describe('[tripwire-core.8] TW8 context round-trip and trippedBy', () => {
  it('carries both consumers\' fields and sessionId()', async () => {
    const env = makeEnv({ sessionId: () => 'sess-123' });
    const reverse = {
      lastStatus: 401,
      lastOperationId: 'getMe',
    };
    const search = {
      query: 'cheap flights',
      pageUrl: 'https://www.google.com/search?q=cheap+flights',
      strategy: 'cdp',
      browserSessionId: 'TARGET-1',
      lastOperation: 'search',
    };
    await env.tw.trip('tinder', {
      reason: 'http-4xx',
      context: reverse,
    });
    await env.tw.trip('google', {
      reason: 'captcha',
      context: search,
    });
    const a = await env.otherProcess().read('tinder');
    const b = await env.otherProcess().read('google');
    expect(a.record?.context).toEqual(reverse);
    expect(b.record?.context).toEqual(search);
    expect(b.record?.trippedBy.sessionId).toBe('sess-123');
    expect(b.record?.trippedBy.actor).toBe('tester');
    expect(typeof b.record?.trippedBy.pid).toBe('number');
    expect(b.record?.namespace).toBe('test-ns');
    const fired = eventsOf(env, 'tripwire-fired');
    expect(fired.map((e) => e.sessionId)).toEqual(['sess-123', 'sess-123']);
  });

  it('a throwing sessionId() is ignored', async () => {
    const env = makeEnv({
      sessionId: () => {
        throw new Error('boom');
      },
    });
    const r = await env.tw.trip('k', {
      reason: 'x',
      context: {},
    });
    expect(r.persisted).toBe(true);
    expect(r.record.trippedBy.sessionId).toBeUndefined();
  });
});

describe('[tripwire-core.9] TW9 gate on a clear key is open', () => {
  it('open with zero writes and zero audit lines', async () => {
    const env = makeEnv();
    const g = await env.tw.gate('k');
    expect(g.open).toBe(true);
    expect(g.snapshot.status).toBe('clear');
    await env.tw.assertOpen('k');
    await env.tw.status();
    await env.tw.read('k');
    expect(env.writes()).toEqual([]);
    expect(env.mfs.exists(env.auditPath)).toBe(false);
    expect(env.mfs.files()).toEqual([]);
  });
});

describe('[tripwire-core.10] TW10 gate on a tripped key is closed', () => {
  it('counts each block and audits tripwire-gate-blocked', async () => {
    const env = makeEnv();
    await env.tw.trip('k', {
      reason: 'captcha',
      context: { pageUrl: 'https://example.com/p?q=private' },
    });
    const g1 = await env.tw.gate('k');
    expect(g1.open).toBe(false);
    expect(g1.snapshot.status).toBe('tripped');
    expect(g1.snapshot.record?.blockedCount).toBe(1);
    const g2 = await env.tw.gate('k');
    expect(g2.snapshot.record?.blockedCount).toBe(2);
    expect((await env.tw.read('k')).record?.blockedCount).toBe(2);
    const blocked = eventsOf(env, 'tripwire-gate-blocked');
    expect(blocked.map((e) => e.blockedCount)).toEqual([1, 2]);
    expect(blocked[0].reason).toBe('captcha');
    expect(blocked[0].pageUrl).toBe('https://example.com/p');
    // counting never rewrites the lock
    const lock = env.lockPath('k');
    const lockWrites = env.writes().filter((o) =>
      o.path === lock || o.path2 === lock);
    expect(lockWrites.map((o) => o.op)).toEqual(['link']);
  });

  it('assertOpen throws TripwireTrippedError with recoveryHint', async () => {
    const env = makeEnv();
    const { record } = await env.tw.trip('k', {
      reason: 'http-4xx',
      context: { lastStatus: 429 },
    });
    const err = await rejectionOf(env.tw.assertOpen('k'));
    expect(err).toBeInstanceOf(TripwireTrippedError);
    expect(isTripwireTrippedError(err)).toBe(true);
    const e = err as TripwireTrippedError;
    expect(e.code).toBe('TRIPWIRE_TRIPPED');
    expect(e.key).toBe('k');
    expect(e.reason).toBe('http-4xx');
    expect(e.trippedAt).toBeInstanceOf(Date);
    expect(e.trippedAt.getTime()).toBe(Date.parse(record.trippedAt));
    expect(e.record?.context).toEqual({ lastStatus: 429 });
    expect(e.recoveryHint).toContain(CONFIRM_TOKEN);
    expect(e.recoveryHint).toContain('programmatic-confirm');
    expect(e.message).toContain('http-4xx');
    expect(eventsOf(env, 'tripwire-gate-blocked')).toHaveLength(1);
  });

  it('the hint names the open policy clear method', async () => {
    const env = makeEnv({ clearPolicy: 'open' });
    await env.tw.trip('k', {
      reason: 'captcha',
      context: {},
    });
    const e = (await rejectionOf(env.tw.assertOpen('k'))) as
      TripwireTrippedError;
    expect(e.recoveryHint).toContain('mcp-clear');
    expect(e.recoveryHint).not.toContain(CONFIRM_TOKEN);
  });

  it('a recoveryHint given to trip wins', async () => {
    const env = makeEnv();
    await env.tw.trip('k', {
      reason: 'x',
      context: {},
      recoveryHint: 'call the on-call',
    });
    const e = (await rejectionOf(env.tw.assertOpen('k'))) as
      TripwireTrippedError;
    expect(e.recoveryHint).toBe('call the on-call');
  });
});

describe('[tripwire-core.23] TW23 persist failure keeps the latch', () => {
  it('persisted: false, a TRIPWIRE_IO warning, gate still closed', async () => {
    const env = makeEnv();
    env.mfs.failOn({
      op: ['openExclusive', 'link'],
      path: /\/tripwire\//,
      code: 'EIO',
    });
    const r = await env.tw.trip('k', {
      reason: 'http-4xx',
      context: {},
    });
    expect(r.persisted).toBe(false);
    expect(r.created).toBe(true);
    expect(env.mfs.exists(env.lockPath('k'))).toBe(false);
    expect(env.warnings.map((w) => w.code)).toContain('TRIPWIRE_IO');
    expect(env.warnings[0].operation).toBe('trip.persist');
    expect(env.warnings[0].key).toBe('k');
    const g = await env.tw.gate('k');
    expect(g.open).toBe(false);
    expect(g.snapshot.record?.reason).toBe('http-4xx');
    expect(g.snapshot.record?.blockedCount).toBe(1);
    await expect(env.tw.assertOpen('k')).rejects.toBeInstanceOf(
      TripwireTrippedError,
    );
    // another instance in the same process sees the latch too
    expect((await env.sameProcess().gate('k')).open).toBe(false);
    expect(Object.keys(await env.tw.status())).toEqual(['k']);
    // the fired event is still audited (the audit path works)
    expect(eventsOf(env, 'tripwire-fired')).toHaveLength(1);
  });

  it('a clear in the same process releases the latch', async () => {
    const env = makeEnv({ clearPolicy: 'open' });
    env.mfs.failOn({
      op: 'link',
      code: 'EIO',
    });
    await env.tw.trip('k', {
      reason: 'x',
      context: {},
    });
    expect((await env.tw.clear('k', { method: 'mcp-clear' })).cleared)
      .toBe(true);
    expect((await env.tw.gate('k')).open).toBe(true);
  });

  it('a throwing onWarning sink never breaks trip', async () => {
    const env = makeEnv({
      onWarning: () => {
        throw new Error('sink down');
      },
    });
    env.mfs.failOn({
      op: 'link',
      code: 'EIO',
    });
    const r = await env.tw.trip('k', {
      reason: 'x',
      context: {},
    });
    expect(r.persisted).toBe(false);
  });

  it('a successful persist releases the latch (break-glass rm works)', async () => {
    const env = makeEnv();
    await env.tw.trip('k', {
      reason: 'x',
      context: {},
    });
    await env.mfs.unlink(env.lockPath('k'));
    expect((await env.tw.gate('k')).open).toBe(true);
  });
});
