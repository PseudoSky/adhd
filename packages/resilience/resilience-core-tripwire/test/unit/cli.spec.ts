/**
 * guards: the unlock CLI exits with the wrong code, or confirms without the token
 * tier: S
 * cites: ticket 8468f7b1; [tripwire-interactive.4] TW27.
 * Ticket 8468f7b1 - runUnlockCli over injected IO: usage (1), no lock (0),
 * the forensic fields with (none) fallbacks, the unparseable-lock warning,
 * the TTY confirm path (unlock-cli-tty), the CONFIRM env path
 * (unlock-cli-env), mismatch (1, lock kept), No TTY without CONFIRM (1),
 * storage errors (2), and the exact strings and stdout/stderr split of the
 * reverse-apis unlock-tripwire bin.
 * Criteria: [tripwire-interactive.4] TW27.
 */
import {
  CONFIRM_TOKEN,
  createTripwire,
  runUnlockCli,
  type Tripwire,
} from '../../src/index';
import { eventsOf, makeEnv, type Env } from '../helpers/harness';
import { fakeIo } from '../helpers/io';

/** The last element (the spec lib predates Array.prototype.at). */
function last<T>(xs: readonly T[]): T | undefined {
  return xs[xs.length - 1];
}

const KEY = 'testclient';

async function trippedEnv(
  context: Record<string, string | number> = {
    lastStatus: 401,
    lastOperationId: 'getProfile',
  },
): Promise<Env> {
  const env = makeEnv();
  await env.tw.trip(KEY, { reason: 'http-4xx', context });
  return env;
}

describe('[tripwire-interactive.4] TW27 runUnlockCli', () => {
  it('no key prints the usage line to stderr and returns 1', async () => {
    const env = makeEnv();
    for (const argv of [[], ['']]) {
      const io = fakeIo();
      expect(await runUnlockCli(argv, io, env.tw)).toBe(1);
      expect(io.errLines).toEqual(['Usage: <unlock-command> <key>']);
      expect(io.outLines).toEqual([]);
    }
    const io = fakeIo();
    expect(await runUnlockCli([], io, env.tw, { usage: 'Usage: x <key>' }))
      .toBe(1);
    expect(io.errLines).toEqual(['Usage: x <key>']);
  });

  it('no lock prints `no tripwire to unlock for X` to stdout and returns 0',
    async () => {
      const env = makeEnv();
      const io = fakeIo();
      expect(await runUnlockCli([KEY], io, env.tw)).toBe(0);
      expect(io.outLines).toEqual([`no tripwire to unlock for ${KEY}`]);
      expect(io.errLines).toEqual([]);
      expect(io.prompts).toEqual([]);
      expect(env.writes()).toEqual([]);
    });

  it('an invalid key returns 1 before any IO', async () => {
    const env = makeEnv();
    const io = fakeIo();
    expect(await runUnlockCli(['../../lib/etc'], io, env.tw)).toBe(1);
    expect(io.errText()).toContain('invalid tripwire key');
    expect(env.mfs.ops).toEqual([]);
  });

  it('prints reason, trippedAt, lastStatus and lastOperationId', async () => {
    const env = await trippedEnv();
    const trippedAt = (await env.tw.read(KEY)).record?.trippedAt;
    const io = fakeIo([CONFIRM_TOKEN]);
    expect(await runUnlockCli([KEY], io, env.tw, {
      lockPath: env.lockPath,
    })).toBe(0);
    expect(io.errLines.slice(0, 5)).toEqual([
      `Tripwire lock for "${KEY}" at ${env.lockPath(KEY)}:`,
      '  reason:          http-4xx',
      `  trippedAt:       ${trippedAt}`,
      '  lastStatus:      401',
      '  lastOperationId: getProfile',
    ]);
    expect(io.outLines).toEqual([
      `unlocked tripwire for ${KEY} (removed ${env.lockPath(KEY)})`,
    ]);
  });

  it('missing fields print (none); without lockPath only the key is named',
    async () => {
      const env = await trippedEnv({});
      const io = fakeIo([CONFIRM_TOKEN]);
      expect(await runUnlockCli([KEY], io, env.tw)).toBe(0);
      expect(io.errLines.slice(0, 5)).toEqual([
        `Tripwire lock for "${KEY}":`,
        '  reason:          http-4xx',
        expect.stringMatching(/^ {2}trippedAt: {7}\d{4}-\d\d-\d\dT/),
        '  lastStatus:      (none)',
        '  lastOperationId: (none)',
      ]);
      expect(io.outLines).toEqual([`unlocked tripwire for ${KEY}`]);
    });

  it('a legacy flat reverse lock is shown field by field', async () => {
    const env = makeEnv();
    env.mfs.writeText(env.lockPath(KEY), JSON.stringify({
      reason: 'http-4xx',
      trippedAt: '2026-01-02T03:04:05.000Z',
      lastStatus: 403,
      lastOperationId: 'swipe',
    }), 0o600);
    const io = fakeIo([], { env: { CONFIRM: CONFIRM_TOKEN } });
    expect(await runUnlockCli([KEY], io, env.tw)).toBe(0);
    expect(io.errLines).toEqual([
      `Tripwire lock for "${KEY}":`,
      '  reason:          http-4xx',
      '  trippedAt:       2026-01-02T03:04:05.000Z',
      '  lastStatus:      403',
      '  lastOperationId: swipe',
    ]);
    expect(env.mfs.exists(env.lockPath(KEY))).toBe(false);
  });

  it('an unparseable lock warns, prints (none) everywhere and proceeds',
    async () => {
      const env = makeEnv();
      env.mfs.writeText(env.lockPath(KEY), '{"reason": "http-4', 0o600);
      const io = fakeIo([], { env: { CONFIRM: CONFIRM_TOKEN } });
      expect(await runUnlockCli([KEY], io, env.tw, {
        lockPath: env.lockPath,
      })).toBe(0);
      expect(io.errLines).toEqual([
        `warning: lock at ${env.lockPath(KEY)} could not be parsed as ` +
          'JSON: corrupt',
        `Tripwire lock for "${KEY}" at ${env.lockPath(KEY)}:`,
        '  reason:          (none)',
        '  trippedAt:       (none)',
        '  lastStatus:      (none)',
        '  lastOperationId: (none)',
      ]);
      expect(env.mfs.exists(env.lockPath(KEY))).toBe(false);
      const empty = makeEnv();
      empty.mfs.writeText(empty.lockPath(KEY), '', 0o600);
      const io2 = fakeIo([], { env: { CONFIRM: CONFIRM_TOKEN } });
      expect(await runUnlockCli([KEY], io2, empty.tw)).toBe(0);
      expect(io2.errLines[0]).toBe(
        `warning: lock for ${KEY} could not be parsed as JSON: empty`,
      );
    });

  it('TTY path: the trimmed answer confirms; audit method unlock-cli-tty',
    async () => {
      const env = await trippedEnv();
      const io = fakeIo([`  ${CONFIRM_TOKEN}  `]);
      expect(await runUnlockCli([KEY], io, env.tw, { actor: 'op' }))
        .toBe(0);
      expect(io.prompts).toEqual([`Type '${CONFIRM_TOKEN}' to confirm: `]);
      expect(env.mfs.exists(env.lockPath(KEY))).toBe(false);
      expect(eventsOf(env, 'tripwire-cleared')).toEqual([
        expect.objectContaining({ method: 'unlock-cli-tty', actor: 'op' }),
      ]);
    });

  it('CONFIRM env path: no prompt even on a TTY; audit method unlock-cli-env',
    async () => {
      for (const isTTY of [false, true]) {
        const env = await trippedEnv();
        const io = fakeIo(['wrong'], {
          isTTY,
          env: { CONFIRM: CONFIRM_TOKEN },
        });
        expect(await runUnlockCli([KEY], io, env.tw)).toBe(0);
        expect(io.prompts).toEqual([]);
        expect(eventsOf(env, 'tripwire-cleared')).toEqual([
          expect.objectContaining({ method: 'unlock-cli-env' }),
        ]);
      }
    });

  it('a mismatch returns 1 and keeps the lock (TTY, env, untrimmed env, ' +
    'empty env)', async () => {
    const cases = [
      fakeIo(['i-understand-the-risk']),
      fakeIo([], { env: { CONFIRM: 'yes' } }),
      fakeIo([], { env: { CONFIRM: ` ${CONFIRM_TOKEN}` } }),
      fakeIo([], { env: { CONFIRM: '' } }),
    ];
    for (const io of cases) {
      const env = await trippedEnv();
      const before = env.mfs.readText(env.lockPath(KEY));
      expect(await runUnlockCli([KEY], io, env.tw)).toBe(1);
      expect(last(io.errLines)).toBe(
        '\nConfirmation mismatch. Lock NOT removed.',
      );
      expect(io.outLines).toEqual([]);
      expect(env.mfs.readText(env.lockPath(KEY))).toBe(before);
      expect(eventsOf(env, 'tripwire-cleared')).toHaveLength(0);
    }
  });

  it('no TTY and no CONFIRM returns 1 with `No TTY`, lock kept', async () => {
    const env = await trippedEnv();
    const io = fakeIo([CONFIRM_TOKEN], { isTTY: false });
    expect(await runUnlockCli([KEY], io, env.tw)).toBe(1);
    expect(io.prompts).toEqual([]);
    expect(last(io.errLines)).toBe(
      '\nNo TTY detected and CONFIRM env var is unset. ' +
        `Re-run interactively or set CONFIRM=${CONFIRM_TOKEN}.`,
    );
    expect(env.mfs.exists(env.lockPath(KEY))).toBe(true);
  });

  it('EOF at the TTY prompt returns 1, lock kept', async () => {
    const env = await trippedEnv();
    const io = fakeIo([null]);
    expect(await runUnlockCli([KEY], io, env.tw)).toBe(1);
    expect(io.errText()).toContain('Lock NOT removed.');
    expect(env.mfs.exists(env.lockPath(KEY))).toBe(true);
  });

  it('a storage error while clearing returns 2, lock kept', async () => {
    const env = await trippedEnv();
    env.mfs.failOn({ op: 'rename', path: /\.lock$/, code: 'EIO' });
    const io = fakeIo([], { env: { CONFIRM: CONFIRM_TOKEN } });
    expect(await runUnlockCli([KEY], io, env.tw)).toBe(2);
    expect(last(io.errLines)).toMatch(
      /^failed to unlock: Tripwire clear failed: /,
    );
    expect(io.outLines).toEqual([]);
    expect(env.mfs.exists(env.lockPath(KEY))).toBe(true);
  });

  it('an unexpected read failure returns 2', async () => {
    const env = makeEnv();
    const tw: Tripwire = {
      ...env.tw,
      read: () => Promise.reject(new Error('disk on fire')),
    };
    const io = fakeIo();
    expect(await runUnlockCli([KEY], io, tw)).toBe(2);
    expect(io.errLines).toEqual(['failed to read tripwire: disk on fire']);
  });

  it('a lock removed by someone else between read and clear: 0, nothing ' +
    'to unlock', async () => {
    const env = await trippedEnv();
    const tw: Tripwire = {
      ...env.tw,
      clear: () => Promise.resolve({ cleared: false }),
    };
    const io = fakeIo([CONFIRM_TOKEN]);
    expect(await runUnlockCli([KEY], io, tw)).toBe(0);
    expect(io.outLines).toEqual([`no tripwire to unlock for ${KEY}`]);
  });

  it('an expired lock is still offered for unlock', async () => {
    const env = makeEnv({ expiry: { ttlMs: 1000 } });
    await env.tw.trip(KEY, { reason: 'http-4xx', context: {} });
    env.clock.advance(5000);
    const io = fakeIo([CONFIRM_TOKEN]);
    expect(await runUnlockCli([KEY], io, env.tw)).toBe(0);
    expect(io.outLines).toEqual([`unlocked tripwire for ${KEY}`]);
    expect(env.mfs.exists(env.lockPath(KEY))).toBe(false);
  });

  it('works on an open-policy instance too', async () => {
    const env = makeEnv();
    const tw = createTripwire({
      namespace: 'n',
      stateDir: '/state',
      fs: env.mfs,
      clearPolicy: 'open',
      actor: 'x',
    });
    await tw.trip(KEY, { reason: 'captcha', context: {} });
    const io = fakeIo([CONFIRM_TOKEN]);
    expect(await runUnlockCli([KEY], io, tw)).toBe(0);
    expect(env.mfs.exists(env.lockPath(KEY))).toBe(false);
  });
});
