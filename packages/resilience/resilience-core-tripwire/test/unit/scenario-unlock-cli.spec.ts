/**
 * guards: the unlock bin mishandles an exit code or prompt path end to end
 * tier: S
 * cites: ticket 8468f7b1; [tripwire-interactive.4] TW27.
 * teeth: red: nx run resilience-core-tripwire:test --skip-nx-cache -- test/unit/scenario-unlock-cli.spec.ts -> exit 1; 1 failed | 9 passed; AssertionError: expected +0 to be 1 (mutation: src/lib/cli.ts 'Confirmation mismatch' branch returns 0 instead of 1)
 * plan: stealth-browser, state resolve-findings, task resolve-findings-implementer, [resolve-findings.2] F56 F57
 * Ticket 8468f7b1 - scenario: the reverse-apis unlock bin, end to end on
 * the memory fs. The bin is the five-line recipe (state dir from
 * TRIPWIRE_DIR or adhdDataDir, a confirm-token tripwire, runUnlockCli)
 * driven through nodeTripwireIo over in-memory streams, so the real
 * prompt, stdout/stderr and EOF handling run; every exit code is covered
 * (0 nothing to do, 0 unlocked by TTY or CONFIRM, 1 usage, 1 mismatch,
 * 1 No TTY, 2 storage error).
 * Criteria: [tripwire-interactive.4] TW27.
 */
import { PassThrough } from 'node:stream';
import {
  CONFIRM_TOKEN,
  adhdDataDir,
  createMemoryFs,
  createTripwire,
  nodeTripwireIo,
  runUnlockCli,
  type AuditEvent,
  type MemoryFs,
  type UnlockExitCode,
} from '../../src/index';

/** The last element (the spec lib predates Array.prototype.at). */
function last<T>(xs: readonly T[]): T | undefined {
  return xs[xs.length - 1];
}

const DIR = '/home/op/.adhd/reverse/data';

interface Run {
  code: UnlockExitCode;
  stdout: string;
  stderr: string;
}

function collect(s: PassThrough): () => string {
  const chunks: Buffer[] = [];
  s.on('data', (c: Buffer) => chunks.push(c));
  return () => Buffer.concat(chunks).toString('utf8');
}

/** The unlock bin: what a consumer writes, over injected streams. */
async function unlockBin(
  mfs: MemoryFs,
  argv: string[],
  o: { stdin?: string | null; isTTY?: boolean; env?: Record<string, string> },
): Promise<Run> {
  const input = new PassThrough();
  if (o.stdin !== undefined && o.stdin !== null) input.write(o.stdin);
  if (o.stdin !== undefined) input.end();
  const out = new PassThrough();
  const err = new PassThrough();
  const stdout = collect(out);
  const stderr = collect(err);
  const io = nodeTripwireIo({
    input,
    output: out,
    errorOutput: err,
    env: { ADHD_HOME: '/home/op/.adhd', ...o.env },
    isTTY: o.isTTY ?? false,
  });
  // --- the five lines of a real bin ---
  const stateDir =
    io.env['TRIPWIRE_DIR'] ?? adhdDataDir(['reverse', 'data'], io.env);
  const tw = createTripwire({ namespace: 'request-builder', stateDir, fs: mfs });
  const code = await runUnlockCli(argv, io, tw, {
    lockPath: (k) => `${stateDir}/tripwire/${k}.lock`,
  });
  // -------------------------------------
  input.destroy();
  await new Promise((r) => setImmediate(r));
  return { code, stdout: stdout(), stderr: stderr() };
}

async function trippedFs(): Promise<MemoryFs> {
  const mfs = createMemoryFs();
  const tw = createTripwire({
    namespace: 'request-builder',
    stateDir: DIR,
    fs: mfs,
    actor: 'sender',
  });
  await tw.trip('testclient', {
    reason: 'http-4xx',
    context: { lastStatus: 401, lastOperationId: 'getProfile' },
  });
  return mfs;
}

const LOCK = `${DIR}/tripwire/testclient.lock`;

function audit(mfs: MemoryFs): AuditEvent[] {
  return (mfs.readText(`${DIR}/audit.log`) ?? '')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as AuditEvent);
}

describe('[tripwire-interactive.4] TW27 the unlock bin end to end', () => {
  it('exit 1: no client prints the usage line', async () => {
    const r = await unlockBin(createMemoryFs(), [], {});
    expect(r).toEqual({
      code: 1,
      stdout: '',
      stderr: 'Usage: <unlock-command> <key>\n',
    });
  });

  it('exit 0: no lock, nothing to do', async () => {
    const r = await unlockBin(createMemoryFs(), ['testclient'], {});
    expect(r).toEqual({
      code: 0,
      stdout: 'no tripwire to unlock for testclient\n',
      stderr: '',
    });
  });

  it('exit 0: the TTY prompt confirms (unlock-cli-tty)', async () => {
    const mfs = await trippedFs();
    const r = await unlockBin(mfs, ['testclient'], {
      stdin: `${CONFIRM_TOKEN}\n`,
      isTTY: true,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      `unlocked tripwire for testclient (removed ${LOCK})\n`,
    );
    expect(r.stderr).toContain(`Tripwire lock for "testclient" at ${LOCK}:`);
    expect(r.stderr).toContain('  lastStatus:      401');
    expect(r.stderr).toContain(`Type '${CONFIRM_TOKEN}' to confirm: `);
    expect(mfs.exists(LOCK)).toBe(false);
    expect(last(audit(mfs))).toMatchObject({
      event: 'tripwire-cleared',
      method: 'unlock-cli-tty',
    });
  });

  it('exit 0: CONFIRM in the environment (unlock-cli-env), no TTY needed',
    async () => {
      const mfs = await trippedFs();
      const r = await unlockBin(mfs, ['testclient'], {
        env: { CONFIRM: CONFIRM_TOKEN },
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/^unlocked tripwire for testclient/);
      expect(mfs.exists(LOCK)).toBe(false);
      expect(last(audit(mfs))).toMatchObject({ method: 'unlock-cli-env' });
    });

  it('exit 0: TRIPWIRE_DIR points the bin at another state dir', async () => {
    const mfs = createMemoryFs();
    const tw = createTripwire({ namespace: 'n', stateDir: '/tmp/t', fs: mfs });
    await tw.trip('testclient', { reason: 'http-4xx', context: {} });
    const r = await unlockBin(mfs, ['testclient'], {
      env: { TRIPWIRE_DIR: '/tmp/t', CONFIRM: CONFIRM_TOKEN },
    });
    expect(r.code).toBe(0);
    expect(mfs.exists('/tmp/t/tripwire/testclient.lock')).toBe(false);
  });

  it('exit 1: a mismatch at the prompt keeps the lock', async () => {
    const mfs = await trippedFs();
    const r = await unlockBin(mfs, ['testclient'], {
      stdin: 'yes\n',
      isTTY: true,
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Confirmation mismatch. Lock NOT removed.');
    expect(r.stdout).toBe('');
    expect(mfs.exists(LOCK)).toBe(true);
  });

  it('exit 1: No TTY and no CONFIRM keeps the lock', async () => {
    const mfs = await trippedFs();
    const r = await unlockBin(mfs, ['testclient'], { stdin: CONFIRM_TOKEN });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No TTY detected and CONFIRM env var is unset.');
    expect(mfs.exists(LOCK)).toBe(true);
  });

  it('exit 1: stdin closed at the prompt (EOF) never hangs', async () => {
    const mfs = await trippedFs();
    const r = await unlockBin(mfs, ['testclient'], {
      stdin: null,
      isTTY: true,
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Lock NOT removed.');
    expect(mfs.exists(LOCK)).toBe(true);
  });

  it('exit 0 with a warning: an unparseable lock still unlocks', async () => {
    const mfs = createMemoryFs();
    mfs.writeText(LOCK, 'not json', 0o600);
    const r = await unlockBin(mfs, ['testclient'], {
      env: { CONFIRM: CONFIRM_TOKEN },
    });
    expect(r.code).toBe(0);
    const first = r.stderr.split('\n')[0] ?? '';
    // the parser's own message text is not part of the contract
    expect(first.startsWith(`warning: lock at ${LOCK} could not be parsed as JSON: `)).toBe(true);
    expect(first.length).toBeGreaterThan(
      `warning: lock at ${LOCK} could not be parsed as JSON: `.length,
    );
    expect(r.stderr).toContain('  reason:          (none)');
    expect(mfs.exists(LOCK)).toBe(false);
  });

  it('exit 2: a storage error while removing the lock', async () => {
    const mfs = await trippedFs();
    mfs.failOn({ op: 'rename', path: LOCK, code: 'EIO' });
    const r = await unlockBin(mfs, ['testclient'], {
      env: { CONFIRM: CONFIRM_TOKEN },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/failed to unlock: Tripwire clear failed: /);
    expect(r.stdout).toBe('');
    expect(mfs.exists(LOCK)).toBe(true);
  });
});
