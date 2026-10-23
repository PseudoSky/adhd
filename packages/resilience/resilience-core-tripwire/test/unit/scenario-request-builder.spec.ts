/**
 * guards: a tripped client key still lets a send reach the network, or the confirm-token unlock does not reopen it
 * tier: S
 * cites: ticket 8468f7b1; [tripwire-interactive.6] (TW1, TW3, TW10, TW14, TW27).
 * Ticket 8468f7b1 - scenario: the reverse-apis request-builder consumer,
 * end to end on the memory fs. A miniature `send` mirrors the real
 * pipeline order: the tripwire gate (assertOpen) runs BEFORE pacing and
 * the network; any 4xx trips the client key (5xx never does) and throws
 * TripwireTrippedError carrying the in-memory response. Flow: a 4xx trips,
 * three following sends are blocked and counted with zero network calls,
 * the confirm-token unlock clears it, the next send is open; a corrupt
 * lock blocks; a second 4xx keeps the first record.
 * Criteria: [tripwire-interactive.6] (TW1, TW3, TW10, TW14, TW27).
 */
import {
  CONFIRM_TOKEN,
  TripwireConfirmError,
  TripwireTrippedError,
  isTripwireTrippedError,
  runUnlockCli,
  type Tripwire,
} from '../../src/index';
import { eventsOf, makeEnv, rejectionOf, type Env } from '../helpers/harness';
import { fakeIo } from '../helpers/io';

interface Response {
  status: number;
  body: unknown;
}

type Network = (op: string) => Promise<Response>;

/** The request-builder consumer in miniature. */
function requestBuilder(tw: Tripwire, network: Network) {
  const calls: string[] = [];
  const paced: string[] = [];
  return {
    calls,
    paced,
    async send(client: string, op: string): Promise<Response> {
      // 1. tripwire gate, before sequencing / pacing / the network
      await tw.assertOpen(client);
      // 2. pacing floor is recorded only after the gate passed
      paced.push(op);
      calls.push(op);
      const res = await network(op);
      if (res.status >= 400 && res.status <= 499) {
        const t = await tw.trip(client, {
          reason: 'http-4xx',
          context: { lastStatus: res.status, lastOperationId: op },
        });
        throw TripwireTrippedError.fromRecord(t.record, {
          responseStatus: res.status,
          responseBody: res.body,
        });
      }
      return res;
    },
  };
}

const ok: Network = () => Promise.resolve({ status: 200, body: { ok: true } });

function scripted(statuses: number[]): Network {
  const left = [...statuses];
  return () => Promise.resolve({
    status: left.shift() ?? 200,
    body: { error: 'nope' },
  });
}

async function tripped(): Promise<{
  env: Env;
  rb: ReturnType<typeof requestBuilder>;
}> {
  const env = makeEnv({ namespace: 'request-builder' });
  const rb = requestBuilder(env.tw, scripted([401]));
  const err = await rejectionOf(rb.send('tinder', 'getProfile'));
  expect(err).toBeInstanceOf(TripwireTrippedError);
  return { env, rb };
}

describe('[tripwire-interactive.6] request-builder: 4xx trips, sends are ' +
  'blocked and counted, the confirm-token unlock reopens', () => {
  it('a 4xx trips the key and the error carries the response in memory',
    async () => {
      const env = makeEnv({ namespace: 'request-builder' });
      const rb = requestBuilder(env.tw, scripted([401]));
      const err = await rejectionOf(rb.send('tinder', 'getProfile'));
      expect(isTripwireTrippedError(err)).toBe(true);
      const e = err as TripwireTrippedError;
      expect(e.key).toBe('tinder');
      expect(e.reason).toBe('http-4xx');
      expect(e.responseStatus).toBe(401);
      expect(e.responseBody).toEqual({ error: 'nope' });
      const lock = JSON.parse(env.mfs.readText(env.lockPath('tinder')) ?? '');
      expect(lock).toMatchObject({
        key: 'tinder',
        namespace: 'request-builder',
        reason: 'http-4xx',
        context: { lastStatus: 401, lastOperationId: 'getProfile' },
      });
      // the response body is never persisted
      expect(env.mfs.readText(env.lockPath('tinder'))).not.toContain('nope');
      expect(env.auditText()).not.toContain('nope');
      expect(eventsOf(env, 'tripwire-fired')).toHaveLength(1);
    });

  it('every 4xx trips (400 and 499 inclusive); 5xx never trips', async () => {
    for (const status of [400, 403, 429, 499]) {
      const env = makeEnv();
      const rb = requestBuilder(env.tw, scripted([status]));
      await rejectionOf(rb.send('c1', 'op'));
      expect((await env.tw.read('c1')).status).toBe('tripped');
    }
    for (const status of [500, 502, 503]) {
      const env = makeEnv();
      const rb = requestBuilder(env.tw, scripted([status]));
      expect((await rb.send('c1', 'op')).status).toBe(status);
      expect((await env.tw.read('c1')).status).toBe('clear');
    }
  });

  it('three following sends are blocked before pacing and the network, ' +
    'and blockedCount is 3', async () => {
    const { env, rb } = await tripped();
    for (const op of ['a', 'b', 'c']) {
      const err = await rejectionOf(rb.send('tinder', op));
      expect(err).toBeInstanceOf(TripwireTrippedError);
      const e = err as TripwireTrippedError;
      expect(e.recoveryHint).toContain(CONFIRM_TOKEN);
      expect(e.responseStatus).toBeUndefined();
    }
    expect(rb.calls).toEqual(['getProfile']);
    expect(rb.paced).toEqual(['getProfile']);
    const snap = await env.tw.read('tinder');
    expect(snap.record?.blockedCount).toBe(3);
    expect(eventsOf(env, 'tripwire-gate-blocked').map((e) => e.blockedCount))
      .toEqual([1, 2, 3]);
    // another process on the same disk is blocked too
    const other = requestBuilder(env.otherProcess(), ok);
    await rejectionOf(other.send('tinder', 'd'));
    expect(other.calls).toEqual([]);
    expect((await env.tw.read('tinder')).record?.blockedCount).toBe(4);
    // other keys are unaffected
    expect((await rb.send('bumble', 'x')).status).toBe(200);
  });

  it('programmatic unlock needs CONFIRM_TOKEN; then the next send is open',
    async () => {
      const { env, rb } = await tripped();
      await rejectionOf(rb.send('tinder', 'a'));
      const wrong = await rejectionOf(env.tw.clear('tinder', {
        method: 'programmatic-confirm',
      }));
      expect(wrong).toBeInstanceOf(TripwireConfirmError);
      expect((await env.tw.read('tinder')).status).toBe('tripped');
      expect(await env.tw.clear('tinder', {
        method: 'programmatic-confirm',
        confirm: CONFIRM_TOKEN,
        actor: 'reverse-auth',
      })).toEqual({ cleared: true });
      const ok2 = requestBuilder(env.tw, ok);
      expect((await ok2.send('tinder', 'next')).status).toBe(200);
      expect(ok2.calls).toEqual(['next']);
      expect(eventsOf(env, 'tripwire-cleared')).toEqual([
        expect.objectContaining({
          method: 'programmatic-confirm',
          actor: 'reverse-auth',
          blockedCount: 1,
        }),
      ]);
      // the next trip carries the prior clear
      const again = requestBuilder(env.tw, scripted([403]));
      await rejectionOf(again.send('tinder', 'later'));
      expect((await env.tw.read('tinder')).record?.priorClear?.method)
        .toBe('programmatic-confirm');
    });

  it('the unlock bin (CONFIRM env) clears it; the next send is open',
    async () => {
      const { env, rb } = await tripped();
      for (const op of ['a', 'b', 'c']) await rejectionOf(rb.send('tinder', op));
      const io = fakeIo([], { isTTY: false, env: { CONFIRM: CONFIRM_TOKEN } });
      expect(await runUnlockCli(['tinder'], io, env.tw)).toBe(0);
      expect(io.outLines).toEqual(['unlocked tripwire for tinder']);
      const next = requestBuilder(env.tw, ok);
      expect((await next.send('tinder', 'next')).status).toBe(200);
      expect(eventsOf(env, 'tripwire-cleared')).toEqual([
        expect.objectContaining({ method: 'unlock-cli-env', blockedCount: 3 }),
      ]);
    });
});

describe('[tripwire-interactive.6] request-builder: a corrupt lock blocks',
  () => {
    it.each([
      ['garbage', '{"reason": "http-'],
      ['empty', ''],
      ['wrong schema', '[1,2,3]'],
    ])('a %s lock fails closed: no network call', async (_name, raw) => {
      const env = makeEnv();
      env.mfs.writeText(env.lockPath('tinder'), raw, 0o600);
      const rb = requestBuilder(env.tw, ok);
      const err = await rejectionOf(rb.send('tinder', 'op'));
      expect(err).toBeInstanceOf(TripwireTrippedError);
      expect((err as TripwireTrippedError).reason).toBe('unreadable-lock');
      expect(rb.calls).toEqual([]);
    });

    it('an unreadable (EACCES) lock fails closed', async () => {
      const env = makeEnv();
      env.mfs.writeText(env.lockPath('tinder'), '{}', 0o600);
      env.mfs.failOn({ op: 'readFile', path: /tinder\.lock$/, code: 'EACCES' });
      const rb = requestBuilder(env.tw, ok);
      const err = await rejectionOf(rb.send('tinder', 'op'));
      expect((err as TripwireTrippedError).reason).toBe('unreadable-lock');
      expect(rb.calls).toEqual([]);
    });
  });

describe('[tripwire-interactive.6] request-builder: a second 4xx keeps the ' +
  'first record', () => {
  it('two in-flight sends both 4xx: the first trip wins, the second is ' +
    'audited as retripped', async () => {
    const env = makeEnv({ namespace: 'request-builder' });
    const pending: Array<(r: Response) => void> = [];
    const network: Network = () =>
      new Promise((res) => {
        pending.push(res);
      });
    const rb = requestBuilder(env.tw, network);
    const first = rejectionOf(rb.send('tinder', 'first'));
    const second = rejectionOf(rb.send('tinder', 'second'));
    // both passed the gate before either response arrived
    await new Promise((r) => setTimeout(r, 0));
    expect(rb.calls).toEqual(['first', 'second']);
    pending[0]?.({ status: 401, body: 'a' });
    const e1 = (await first) as TripwireTrippedError;
    pending[1]?.({ status: 403, body: 'b' });
    const e2 = (await second) as TripwireTrippedError;
    expect(e1.responseStatus).toBe(401);
    // the second error carries its own response but the FIRST record
    expect(e2.responseStatus).toBe(403);
    expect(e2.record?.context).toEqual({
      lastStatus: 401,
      lastOperationId: 'first',
    });
    const lock = JSON.parse(env.mfs.readText(env.lockPath('tinder')) ?? '');
    expect(lock.context).toEqual({ lastStatus: 401, lastOperationId: 'first' });
    expect(eventsOf(env, 'tripwire-fired')).toHaveLength(1);
    expect(eventsOf(env, 'tripwire-retripped')).toEqual([
      expect.objectContaining({ reason: 'http-4xx', trippedAt: lock.trippedAt }),
    ]);
  });

  it('a 4xx in another process keeps the first record too', async () => {
    const { env } = await tripped();
    const before = env.mfs.readText(env.lockPath('tinder'));
    const r = await env.otherProcess().trip('tinder', {
      reason: 'http-4xx',
      context: { lastStatus: 404, lastOperationId: 'other' },
    });
    expect(r.created).toBe(false);
    expect(r.record.context).toMatchObject({ lastOperationId: 'getProfile' });
    expect(env.mfs.readText(env.lockPath('tinder'))).toBe(before);
  });
});
