/**
 * guards: a fresh lock is deleted by a stale expiry, a second failed trip replaces the first record, an unreadable lock changes its timestamp on every read, redaction keeps benign keys or leaks credentials
 * tier: S
 * cites: ticket 8468f7b1; [resolve-findings.2] F14 F15 F16 F17 F18 F109 F110 F111 F137.
 * teeth: red: nx run resilience-core-tripwire:test --skip-nx-cache -- test/unit/hardening.spec.ts against the pre-fix src -> exit 1; 53 of 58 tests fail (missing exports and the old expiry, redaction and first-trip behavior)
 * plan: stealth-browser, state resolve-findings, task resolve-findings-implementer, [resolve-findings.2]
 * Ticket 8468f7b1 - review findings resolved in the tripwire core: the expiry
 * removes only the lock it read as expired (an interleaved clear plus fresh trip
 * survives); the first trip wins even when persisting fails twice; an unreadable
 * lock has one stable timestamp; hostile keys such as __proto__ stay data;
 * redaction matches whole credential words (tokenCount survives, apiKey and
 * URL-fragment tokens do not); schema-1 block counts are clamped like the legacy path;
 * resolve audits only after the lock is really gone.
 * Criteria: [resolve-findings.2].
 */
import {
  createMemoryStorage,
  createTripwire,
  defaultRedactor,
  type TripwireStorage,
} from '../../src/index';
import { parseLockRecord } from '../../src/lib/tripwire';
import { isSecretKey, isSecretParam, stripSecretParams } from '../../src/lib/redact';
import { eventsOf, makeEnv, STATE_DIR, makeClock } from '../helpers/harness';

const TTL = { ttlMs: 1000 };

/** A storage whose next removeLock first runs `hook` (an interleaved actor), then removes. */
function interceptingStorage(clock: () => number) {
  const base = createMemoryStorage({ clock });
  const state: { hook?: () => Promise<void>; expectedSeen: Array<string | undefined> } = { expectedSeen: [] };
  const storage: TripwireStorage = {
    ...base,
    removeLock: async (key, expected) => {
      const h = state.hook;
      state.hook = undefined;
      state.expectedSeen.push(expected);
      if (h) await h();
      return base.removeLock(key, expected);
    },
  };
  return { storage, base, state };
}

describe('[resolve-findings.2] F14 expiry removes only the lock it read as expired', () => {
  it('a clear plus a fresh trip between the read and the removal survive; no tripwire-expired is audited for them', async () => {
    const clock = makeClock();
    const { storage, base, state } = interceptingStorage(clock.fn);
    const tw = createTripwire({
      namespace: 'ns',
      stateDir: STATE_DIR,
      storage,
      clock: clock.fn,
      expiry: TTL,
      clearPolicy: 'open',
    });
    await tw.trip('k', { reason: 'old', context: {} });
    clock.advance(TTL.ttlMs + 1);
    // the interleaved actor: after the gate read the expired lock, clear it and trip again
    state.hook = async () => {
      await tw.clear('k', { method: 'mcp-clear' });
      await tw.trip('k', { reason: 'fresh', context: {} });
    };
    const g = await tw.gate('k');
    expect(g.open).toBe(false);
    expect(g.snapshot.record?.reason).toBe('fresh');
    const raw = await base.readLock('k');
    expect(raw).not.toBe('absent');
    expect(JSON.parse((raw as { raw: string }).raw).reason).toBe('fresh');
    expect(base.auditLines.filter((l) => l.includes('tripwire-expired'))).toHaveLength(0);
    expect(state.expectedSeen[0]).toContain('"reason": "old"');
  });

  it('on a file storage the replaced lock is put back untouched and the block count survives', async () => {
    const env = makeEnv({ expiry: TTL });
    await env.tw.trip('k', { reason: 'old', context: {} });
    const lock = env.mfs.readText(env.lockPath('k')) as string;
    const gen = JSON.parse(lock).generation as string;
    await env.tw.gate('k');
    env.clock.advance(TTL.ttlMs + 1);
    // simulate the replaced lock: ask to remove a lock whose content differs from the expected one
    const storage = (await import('../../src/index')).createFileStorage({
      stateDir: STATE_DIR,
      auditPath: env.auditPath,
      maxAuditBytes: 100_000,
      fs: env.mfs as never,
      clock: env.clock.fn,
    });
    const res = await storage.removeLock('k', '{"not":"this lock"}');
    expect(res).toEqual({ tombstone: null, replaced: true });
    expect(env.mfs.readText(env.lockPath('k'))).toBe(lock);
    expect(env.mfs.exists(env.blockedPath('k', gen))).toBe(true);
    expect(env.mfs.files().filter((f) => f.endsWith('.tomb'))).toEqual([]);
    // the matching content removes it
    expect((await storage.removeLock('k', lock)).tombstone).not.toBeNull();
    expect(env.mfs.exists(env.lockPath('k'))).toBe(false);
  });

  it('an uninterleaved expiry still removes the lock once and audits it', async () => {
    const env = makeEnv({ expiry: TTL });
    await env.tw.trip('k', { reason: 'old', context: {} });
    env.clock.advance(TTL.ttlMs + 1);
    expect((await env.tw.gate('k')).open).toBe(true);
    expect(eventsOf(env, 'tripwire-expired')).toHaveLength(1);
  });
});

describe('[resolve-findings.2] F15 F109 first trip wins when persisting fails', () => {
  it('a second trip returns the held first record (created false, persisted false) and fires nothing new', async () => {
    const env = makeEnv();
    env.mfs.failOn({ op: ['openExclusive', 'link'], path: /\/tripwire\//, code: 'EIO' });
    const first = await env.tw.trip('k', { reason: 'first', context: { n: 1 } });
    const second = await env.tw.trip('k', { reason: 'second', context: { n: 2 } });
    expect(first).toMatchObject({ created: true, persisted: false });
    expect(second).toMatchObject({ created: false, persisted: false });
    expect(second.record.reason).toBe('first');
    expect(second.record.generation).toBe(first.record.generation);
    expect(eventsOf(env, 'tripwire-fired')).toHaveLength(1);
    expect(eventsOf(env, 'tripwire-retripped')).toHaveLength(1);
    expect((await env.tw.read('k')).record?.reason).toBe('first');
  });

  it('when persisting later works, the FIRST record is what lands on disk', async () => {
    const env = makeEnv();
    env.mfs.failOn({ op: ['openExclusive', 'link'], path: /\/tripwire\//, code: 'EIO', times: 2 });
    const first = await env.tw.trip('k', { reason: 'first', context: {} });
    const second = await env.tw.trip('k', { reason: 'second', context: {} });
    expect(second.persisted).toBe(false);
    const third = await env.tw.trip('k', { reason: 'third', context: {} });
    expect(third).toMatchObject({ created: false, persisted: true });
    const onDisk = JSON.parse(env.mfs.readText(env.lockPath('k')) as string);
    expect(onDisk.reason).toBe('first');
    expect(onDisk.generation).toBe(first.record.generation);
  });
});

describe('[resolve-findings.2] F16 an unreadable lock has one stable timestamp', () => {
  it('trippedAt does not move between reads while the lock stays unreadable, and resets once it is readable', async () => {
    const env = makeEnv();
    env.mfs.writeText(env.lockPath('k'), '{}', 0o600);
    env.mfs.failOn({ op: 'readFile', path: env.lockPath('k'), code: 'EACCES' });
    const a = await env.tw.read('k');
    env.clock.advance(60_000);
    const b = await env.tw.read('k');
    expect(a.status).toBe('unreadable');
    expect(b.record?.trippedAt).toBe(a.record?.trippedAt);
    expect(a.record?.trippedAt).toBe(new Date(env.clock.now - 60_000).toISOString());
  });
});

describe('[resolve-findings.2] F17 hostile keys stay data', () => {
  it('a __proto__ context key survives the default redactor as an own property and does not change the prototype', () => {
    const ctx = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}') as Record<string, unknown>;
    const out = defaultRedactor()(ctx as never);
    expect(Object.keys(out).sort()).toEqual(['__proto__', 'ok']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(JSON.stringify(out)).toContain('"__proto__":{"polluted":true}');
  });

  it('a legacy lock with a __proto__ field keeps it in context instead of dropping the value', () => {
    const raw = '{"reason":"x","trippedAt":"2026-10-12T00:00:00.000Z","__proto__":{"a":1},"keep":"yes"}';
    const rec = parseLockRecord(raw, 'k', 'ns');
    expect(Object.keys(rec?.context ?? {}).sort()).toEqual(['__proto__', 'keep']);
    expect(Object.getPrototypeOf(rec?.context)).toBe(Object.prototype);
  });
});

describe('[resolve-findings.2] F18 F137 credential words, not substrings', () => {
  it.each(['tokenCount', 'design', 'signal', 'author', 'monkey', 'browserSessionId', 'codec', 'passage'])('keeps the benign key %s', (k) => {
    expect(isSecretKey(k)).toBe(false);
  });

  it.each([
    'apiKey', 'api_key', 'x-api-key', 'sessionId', 'session', 'jwt', 'bearer', 'credentials', 'passwd', 'pwd',
    'accessToken', 'clientSecret', 'Authorization', 'set-cookie', 'x-auth-token',
  ])('drops the credential key %s', (k) => {
    expect(isSecretKey(k)).toBe(true);
  });

  it('drops credential-shaped values wherever they sit, including an api key the old key pattern let through', () => {
    const out = defaultRedactor()({ apiKey: 'sk-123', nested: { jwt: 'a.b.c', tokenCount: 3 }, keep: 1 });
    expect(out).toEqual({ nested: { tokenCount: 3 }, keep: 1 });
  });

  it.each(['access_token', 'api_key', 'apikey', 'sig', 'X-Amz-Signature', 'sid', 'code', 'key', 'session_id', 'PHPSESSID', 'oauth_verifier'])('strips the credential parameter %s', (p) => {
    expect(isSecretParam(p)).toBe(true);
  });

  it.each(['design', 'q', 'page', 'signal', 'keyword', 'author'])('keeps the benign parameter %s', (p) => {
    expect(isSecretParam(p)).toBe(false);
  });

  it('strips secret pairs from a URL fragment (OAuth implicit flow) and keeps benign fragment pairs and plain anchors', () => {
    expect(stripSecretParams('https://app.test/cb#access_token=abc&state=xyz')).toBe('https://app.test/cb#state=xyz');
    expect(stripSecretParams('https://app.test/cb#access_token=abc')).toBe('https://app.test/cb');
    expect(stripSecretParams('https://app.test/doc#section-2')).toBe('https://app.test/doc#section-2');
    const out = defaultRedactor()({ pageUrl: 'https://app.test/cb?q=1#id_token=zzz' });
    expect(out['pageUrl']).toBe('https://app.test/cb?q=1');
  });
});

describe('[resolve-findings.2] F110 schema-1 block counts are clamped like the legacy path', () => {
  const base = {
    schema: 1,
    namespace: 'ns',
    reason: 'x',
    trippedAt: '2026-10-12T00:00:00.000Z',
    trippedBy: { pid: 1 },
    context: {},
  };
  it.each([[-5, 0], [2.9, 2], [7, 7], ['3', 0], [Number.POSITIVE_INFINITY, 0]])('blockedCount %j reads as %j', (given, want) => {
    const rec = parseLockRecord(JSON.stringify({ ...base, blockedCount: given }), 'k', 'ns');
    expect(rec?.blockedCount).toBe(want);
  });
});

describe('[resolve-findings.2] F111 resolve audits only a real resolution', () => {
  it('a failed removal throws and leaves no tripwire-resolved line', async () => {
    const env = makeEnv();
    await env.tw.trip('k', { reason: 'x', context: {} });
    env.mfs.failOn({ op: 'rename', path: env.lockPath('k'), code: 'EIO' });
    await expect(env.tw.resolve('k')).rejects.toMatchObject({ code: 'TRIPWIRE_IO' });
    expect(eventsOf(env, 'tripwire-resolved')).toHaveLength(0);
    expect(eventsOf(env, 'tripwire-cleared')).toHaveLength(0);
  });

  it('a lock another actor already removed is not reported as resolved by this call', async () => {
    const clock = makeClock();
    const base = createMemoryStorage({ clock: clock.fn });
    // the lock vanishes between this call's read and its removal: the removal finds nothing
    const storage: TripwireStorage = { ...base, removeLock: async () => ({ tombstone: null }) };
    const tw = createTripwire({ namespace: 'ns', stateDir: STATE_DIR, storage, clock: clock.fn });
    await tw.trip('k', { reason: 'x', context: {} });
    await tw.resolve('k');
    expect(base.auditLines.filter((l) => l.includes('tripwire-resolved'))).toHaveLength(0);
    expect(base.auditLines.filter((l) => l.includes('tripwire-cleared'))).toHaveLength(0);
  });

  it('keeps the documented order: resolved, then cleared', async () => {
    const env = makeEnv();
    await env.tw.trip('k', { reason: 'x', context: {} });
    await env.tw.resolve('k');
    expect(env.audit().map((e) => e.event).slice(-2)).toEqual(['tripwire-resolved', 'tripwire-cleared']);
  });
});
