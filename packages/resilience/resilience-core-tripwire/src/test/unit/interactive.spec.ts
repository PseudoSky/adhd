/**
 * Ticket 8468f7b1 - the human-in-the-loop gates over injected IO:
 * interactiveGate (banner, retry/Enter/other => hitl-retry + reverified,
 * clear => hitl-clear, abort => TripwireAbortedError with the lock kept,
 * one counted block per loop iteration), the fail-closed paths (non-TTY,
 * a question resolving null at EOF, never a hang) and confirmSolved
 * (Enter => reverified + cleared, abort => 'HITL aborted by user').
 * Criteria: [tripwire-interactive.1] TW24, [tripwire-interactive.2] TW25,
 * [tripwire-interactive.3] TW26.
 */
import { PassThrough } from 'node:stream';
import {
  CONFIRM_TOKEN,
  TripwireAbortedError,
  TripwireConfirmError,
  confirmSolved,
  interactiveGate,
  isTripwireError,
  nodeTripwireIo,
  type HitlInfo,
  type Tripwire,
} from '../../index';
import { fakeIo } from '../support/io';
import { eventsOf, makeEnv, rejectionOf, type Env } from '../support/harness';

const KEY = 'google';
const PAGE = 'https://www.google.com/sorry/index';

async function tripped(over: Parameters<typeof makeEnv>[0] = {}): Promise<Env> {
  const env = makeEnv({ clearPolicy: 'open', ...over });
  await env.tw.trip(KEY, {
    reason: 'captcha',
    context: { query: 'tripwire latch', pageUrl: PAGE, strategy: 'serp' },
  });
  return env;
}

function expectAborted(err: unknown): TripwireAbortedError {
  expect(err).toBeInstanceOf(TripwireAbortedError);
  expect(isTripwireError(err)).toBe(true);
  expect((err as TripwireAbortedError).code).toBe('TRIPWIRE_ABORTED');
  return err as TripwireAbortedError;
}

describe('[tripwire-interactive.1] TW24 interactiveGate', () => {
  it('prints the banner: key, reason, tripped at, blocked-by count, page',
    async () => {
      const env = await tripped();
      const trippedAt = (await env.tw.read(KEY)).record?.trippedAt;
      const io = fakeIo(['retry']);
      await interactiveGate(env.tw, KEY, io);
      const text = io.errText();
      expect(text).toContain('⛔  TRIPWIRE TRIPPED');
      expect(text).toContain(`  Key:         ${KEY}`);
      expect(text).toContain('  Reason:      captcha');
      expect(text).toContain(`  Tripped at:  ${trippedAt}`);
      expect(text).toContain('  Blocked by:  1 gate(s)');
      expect(text).toContain(`  Page:        ${PAGE}`);
      expect(text).toContain('"abort"');
      expect(text).toContain('"clear"');
      expect(io.prompts).toEqual(['  [retry/clear/abort] > ']);
      expect(io.outLines).toEqual([]);
    });

  it('omits the page line when the record has no pageUrl; keyLabel relabels',
    async () => {
      const env = makeEnv({ clearPolicy: 'open' });
      await env.tw.trip(KEY, { reason: 'banned', context: {} });
      const io = fakeIo(['']);
      await interactiveGate(env.tw, KEY, io, { keyLabel: 'Provider' });
      expect(io.errText()).toContain(`  Provider:    ${KEY}`);
      expect(io.errText()).not.toContain('Page:');
    });

  it.each([
    ['retry'],
    [''],
    ['RETRY  '],
    ['yes please'],
    ['continue'],
  ])('input %j means retry: reverified + clear (hitl-retry), then returns',
    async (answer) => {
      const env = await tripped();
      const io = fakeIo([answer]);
      await interactiveGate(env.tw, KEY, io, { actor: 'human' });
      expect(env.mfs.exists(env.lockPath(KEY))).toBe(false);
      const cleared = eventsOf(env, 'tripwire-cleared');
      expect(cleared).toHaveLength(1);
      expect(cleared[0]).toMatchObject({
        method: 'hitl-retry',
        reverified: true,
        actor: 'human',
        reason: 'captcha',
      });
      expect(io.errText()).toContain('Tripwire acknowledged. Retrying.');
      expect((await env.tw.gate(KEY)).open).toBe(true);
    });

  it('`clear` clears with method hitl-clear (not reverified)', async () => {
    const env = await tripped();
    const io = fakeIo([' Clear ']);
    await interactiveGate(env.tw, KEY, io);
    expect(env.mfs.exists(env.lockPath(KEY))).toBe(false);
    const cleared = eventsOf(env, 'tripwire-cleared');
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({
      method: 'hitl-clear',
      reverified: false,
    });
    expect(io.errText()).toContain('Tripwire cleared. Starting fresh.');
    // the cleared marker records the method for the next trip
    const next = await env.tw.trip(KEY, { reason: 'captcha', context: {} });
    expect(next.record.priorClear?.method).toBe('hitl-clear');
  });

  it('`abort` throws TripwireAbortedError and keeps the lock', async () => {
    const env = await tripped();
    const before = env.mfs.readText(env.lockPath(KEY));
    const io = fakeIo(['ABORT']);
    const err = expectAborted(await rejectionOf(
      interactiveGate(env.tw, KEY, io),
    ));
    expect(err.message).toBe(`Tripwire gate blocked ${KEY} (user abort)`);
    expect(err.key).toBe(KEY);
    expect(env.mfs.readText(env.lockPath(KEY))).toBe(before);
    expect(eventsOf(env, 'tripwire-cleared')).toHaveLength(0);
    expect((await env.tw.read(KEY)).status).toBe('tripped');
  });

  it('each loop iteration counts one block; a trip that races the clear ' +
    'is shown again', async () => {
    const env = await tripped();
    const other = env.otherProcess();
    let raced = false;
    // A wrapper whose first clear is followed by a trip from another
    // process, before the loop gates again.
    const tw: Tripwire = {
      ...env.tw,
      clear: async (k, o) => {
        const r = await env.tw.clear(k, o);
        if (!raced) {
          raced = true;
          await other.trip(k, { reason: 'banned', context: {} });
        }
        return r;
      },
    };
    const io = fakeIo(['retry', 'clear']);
    await interactiveGate(tw, KEY, io);
    expect(io.prompts).toHaveLength(2);
    const banners = io.errLines.filter((l) => l.includes('TRIPWIRE TRIPPED'));
    expect(banners).toHaveLength(2);
    expect(io.errLines).toContain('  Reason:      captcha');
    expect(io.errLines).toContain('  Reason:      banned');
    const blocked = eventsOf(env, 'tripwire-gate-blocked');
    expect(blocked.map((e) => e.reason)).toEqual(['captcha', 'banned']);
    expect(eventsOf(env, 'tripwire-cleared').map((e) => e.method))
      .toEqual(['hitl-retry', 'hitl-clear']);
    expect((await env.tw.gate(KEY)).open).toBe(true);
  });

  it('a clear that fails surfaces TRIPWIRE_IO with the lock kept and one ' +
    'counted block', async () => {
      const env = await tripped();
      // the clear fails once (EACCES on the lock rename) => the gate loops
      env.mfs.failOn({
        op: 'rename',
        path: /\.lock$/,
        code: 'EACCES',
        times: 1,
      });
      const io = fakeIo(['clear']);
      const err = await rejectionOf(interactiveGate(env.tw, KEY, io));
      expect(isTripwireError(err)).toBe(true);
      expect((err as { code: string }).code).toBe('TRIPWIRE_IO');
      expect(eventsOf(env, 'tripwire-gate-blocked')).toHaveLength(1);
      expect(env.mfs.exists(env.lockPath(KEY))).toBe(true);
    });

  it('an open key passes straight through: no banner, no prompt, no write',
    async () => {
      const env = makeEnv({ clearPolicy: 'open' });
      const io = fakeIo(['abort']);
      await interactiveGate(env.tw, KEY, io);
      expect(io.prompts).toEqual([]);
      expect(io.errLines).toEqual([]);
      expect(env.writes()).toEqual([]);
    });

  it('a confirm-token instance needs an explicit confirm option to clear ' +
    '(a TTY is never the token)', async () => {
    const env = await tripped({ clearPolicy: 'confirm-token' });
    const err = await rejectionOf(
      interactiveGate(env.tw, KEY, fakeIo(['retry'])),
    );
    expect(err).toBeInstanceOf(TripwireConfirmError);
    expect(env.mfs.exists(env.lockPath(KEY))).toBe(true);
    await interactiveGate(env.tw, KEY, fakeIo(['retry']), {
      confirm: CONFIRM_TOKEN,
    });
    expect(env.mfs.exists(env.lockPath(KEY))).toBe(false);
    expect(eventsOf(env, 'tripwire-cleared')[0]).toMatchObject({
      method: 'hitl-retry',
      reverified: true,
    });
  });
});

describe('[tripwire-interactive.2] TW25 fail closed without a human', () => {
  it('a non-TTY io aborts without prompting; the lock is kept', async () => {
    const env = await tripped();
    const io = fakeIo(['retry'], { isTTY: false });
    const err = expectAborted(await rejectionOf(
      interactiveGate(env.tw, KEY, io),
    ));
    expect(err.message).toBe(`Tripwire gate blocked ${KEY} (no TTY)`);
    expect(io.prompts).toEqual([]);
    expect(io.errText()).toContain('No TTY');
    expect(env.mfs.exists(env.lockPath(KEY))).toBe(true);
    // the attempt itself was counted as a block
    expect(eventsOf(env, 'tripwire-gate-blocked')).toHaveLength(1);
  });

  it('a question that resolves null (EOF) aborts; the lock is kept',
    async () => {
      const env = await tripped();
      const io = fakeIo([null]);
      const err = expectAborted(await rejectionOf(
        interactiveGate(env.tw, KEY, io),
      ));
      expect(err.message).toBe(`Tripwire gate blocked ${KEY} (input closed)`);
      expect(io.prompts).toHaveLength(1);
      expect(env.mfs.exists(env.lockPath(KEY))).toBe(true);
      expect(eventsOf(env, 'tripwire-cleared')).toHaveLength(0);
    });

  it('never hangs on a closed stdin: the Node io over an ended stream ' +
    'answers null and the gate aborts', async () => {
    const env = await tripped();
    const input = new PassThrough();
    input.end();
    const sink = new PassThrough();
    const io = nodeTripwireIo({
      input,
      output: sink,
      errorOutput: sink,
      env: {},
      isTTY: true,
    });
    expectAborted(await rejectionOf(interactiveGate(env.tw, KEY, io)));
    expect(env.mfs.exists(env.lockPath(KEY))).toBe(true);
  });

  it('confirmSolved fails closed the same way (non-TTY and null)',
    async () => {
      const info: HitlInfo = { reason: 'captcha' };
      const env = await tripped();
      const noTty = fakeIo([''], { isTTY: false });
      const e1 = expectAborted(await rejectionOf(
        confirmSolved(env.tw, KEY, info, noTty),
      ));
      expect(e1.message).toBe('HITL aborted by user');
      expect(noTty.prompts).toEqual([]);
      const eof = fakeIo([null]);
      const e2 = expectAborted(await rejectionOf(
        confirmSolved(env.tw, KEY, info, eof),
      ));
      expect(e2.message).toBe('HITL aborted by user');
      expect(env.mfs.exists(env.lockPath(KEY))).toBe(true);
    });
});

describe('[tripwire-interactive.3] TW26 confirmSolved', () => {
  const info: HitlInfo = {
    reason: 'captcha',
    query: 'tripwire latch',
    strategy: 'serp',
    pageUrl: PAGE,
    sessionId: 'sess-1',
  };

  it('prints the banner: key, query, reason, strategy, page, session id',
    async () => {
      const env = await tripped();
      const io = fakeIo(['']);
      await confirmSolved(env.tw, KEY, info, io);
      const text = io.errText();
      expect(text).toContain('HUMAN-IN-THE-LOOP INTERRUPT');
      expect(text).toContain(`  Key:          ${KEY}`);
      expect(text).toContain('  Query:        tripwire latch');
      expect(text).toContain('  Reason:       captcha');
      expect(text).toContain('  Strategy:     serp');
      expect(text).toContain(`  Page:         ${PAGE}`);
      expect(text).toContain('  Session:      sess-1');
      expect(text).toContain('press ENTER');
      expect(io.prompts).toEqual(['  Press ENTER to retry (or "abort") > ']);
    });

  it('missing optional details print (none)', async () => {
    const env = await tripped();
    const io = fakeIo(['']);
    await confirmSolved(env.tw, KEY, { reason: 'banned' }, io);
    expect(io.errText()).toContain('  Query:        (none)');
    expect(io.errText()).toContain('  Session:      (none)');
  });

  it('Enter marks reverified and clears (hitl-retry)', async () => {
    const env = await tripped();
    await confirmSolved(env.tw, KEY, info, fakeIo(['']));
    expect(env.mfs.exists(env.lockPath(KEY))).toBe(false);
    expect(eventsOf(env, 'tripwire-cleared')).toEqual([
      expect.objectContaining({ method: 'hitl-retry', reverified: true }),
    ]);
  });

  it("`abort` throws TripwireAbortedError('HITL aborted by user'); the " +
    'lock stays for the next invocation', async () => {
    const env = await tripped();
    const before = env.mfs.readText(env.lockPath(KEY));
    const err = expectAborted(await rejectionOf(
      confirmSolved(env.tw, KEY, info, fakeIo([' abort'])),
    ));
    expect(err.message).toBe('HITL aborted by user');
    expect(env.mfs.readText(env.lockPath(KEY))).toBe(before);
    // next invocation: a fresh instance is still gated closed
    expect((await env.otherProcess().gate(KEY)).open).toBe(false);
  });
});
