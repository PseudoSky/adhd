/**
 * guards: a dry run passes a live run's dag lock, or a multi-cycle caller drops or leaks the lock
 * tier: S
 * cites: 0b80a7b5 AC3, AC4
 *
 * dag-write-safety.spec.ts — AC3 and AC4 of the dag write-safety slice, driven
 * through dispatch-cli's real `runCycleCore` / `withDagLock` with an injected
 * `MockAgentRunner`.
 *
 * Failure mode: a dry run sails past a live run's dag lock and rewrites dag.json
 * under it (AC3); a multi-cycle caller drops the lock between cycles or leaks it
 * when its loop throws (AC4).
 * Tier: S (real fs under <repo>/tmp, a private TMPDIR relocating the lock file,
 *   injected runner; no process is spawned). The "live other holder" is this
 *   test's parent process (`process.ppid`), whose liveness is probed for real.
 *   "A second process" for AC4 is an acquire that presents a different pid than
 *   the holder's, which is exactly how the guard distinguishes processes.
 * Items: 0b80a7b5 (slice D1-D3), criteria AC3, AC4. The cross-process proof of the
 *   same lock (AC6) is in dag-write-safety.e2e.test.ts.
 * Red run: `red: pending (user hold)` — authored under a no-run hold. Expected
 *   against the base (21ba12b3) core.ts: AC3 fails on `expected resolved to be
 *   rejected` (the dry run returns before any lock); AC4 fails on
 *   `expected 'undefined' to be 'function'` (no `withDagLock` export).
 *
 * Assumption stated: `runCycleCore` executes an allowed `fs.scaffold` tool-call
 * op for real in dry-run mode too (core.ts picks `MockAgentRunner` for the agent
 * dispatches only; `defaultToolCallExec` in dispatch-orchestrator performs the fs
 * op, gated by `allowedFsActions`). The scaffolded file is therefore the
 * observable that "the cycle ran".
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { acquireDispatchLock, DuplicateDispatchError, MockAgentRunner } from '@adhd/dispatch-orchestrator';

import * as core from '../../src/lib/core.js';
import { makeFixtureDag, makeOp } from '../../src/test/helpers/fixtures.js';

const TMP_ROOT = path.join(process.cwd(), 'tmp', 'dispatch-cli', 'dag-write-safety-spec');
const OTHER_PROCESS_PID = 2_147_000_000; // a pid that is not this process (never probed: only the holder is)

let savedTmpdir: string | undefined;
let caseN = 0;
const runners: MockAgentRunner[] = [];

interface Case {
  dir: string;
  tmp: string;
  toolsRoot: string;
  dagPath: string;
  lockPath: string;
}

/** A fresh case whose lock file lives under its private TMPDIR. */
function newCase(): Case {
  const dir = path.join(TMP_ROOT, `case-${caseN++}`);
  const c = {
    dir,
    tmp: path.join(dir, 'tmp'),
    toolsRoot: path.join(dir, 'tools'),
    dagPath: path.join(dir, 'dag.json'),
  };
  for (const d of [c.tmp, c.toolsRoot]) fs.mkdirSync(d, { recursive: true });
  process.env['TMPDIR'] = c.tmp; // os.tmpdir() reads this at call time
  fs.writeFileSync(
    c.dagPath,
    JSON.stringify(
      makeFixtureDag({
        operations: [
          makeOp({
            id: 'a.1',
            milestone: 'a',
            depends_on: [],
            type: 'tool-call',
            action: 'fs.scaffold',
            args: { path: 'target.txt', content: 'go' },
            shape: null,
          }),
          makeOp({ id: 'b.1', milestone: 'b', depends_on: ['a.1'] }),
          makeOp({ id: 'c.1', milestone: 'c', depends_on: ['b.1'] }),
        ],
      }),
      null,
      2
    ),
    'utf8'
  );
  return { ...c, lockPath: core.dispatchLockPath(c.dagPath) };
}

function newRunner(c: Case): MockAgentRunner {
  const r = new MockAgentRunner({ debugDir: path.join(c.dir, 'mock-debug') });
  runners.push(r);
  return r;
}

beforeAll(() => {
  savedTmpdir = process.env['TMPDIR'];
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TMP_ROOT, { recursive: true });
});
afterEach(() => {
  for (const r of runners.splice(0)) r.cleanup();
});
afterAll(() => {
  if (savedTmpdir === undefined) delete process.env['TMPDIR'];
  else process.env['TMPDIR'] = savedTmpdir;
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('0b80a7b5 AC3 dry run takes the dag lock', () => {
  it('0b80a7b5 AC3: a dry-run cycle is refused while a live pid holds the dag lock, writes nothing, and proceeds once the lock is gone', async () => {
    const c = newCase();
    const before = fs.readFileSync(c.dagPath);
    const holderPid = process.ppid; // a real, live process that is not this one
    fs.mkdirSync(path.dirname(c.lockPath), { recursive: true });
    fs.writeFileSync(c.lockPath, JSON.stringify({ identity: path.resolve(c.dagPath), pid: holderPid, token: 'other' }));

    const err = await core.runCycleCore(c.dagPath, true, newRunner(c), ['fs.scaffold'], c.toolsRoot).then(
      () => null,
      (e: unknown) => e
    );

    expect(err, 'the dry run was not refused').toBeInstanceOf(DuplicateDispatchError);
    expect((err as DuplicateDispatchError).holderPid).toBe(holderPid);
    expect((err as DuplicateDispatchError).heldBySelf).toBe(false);
    expect(fs.readFileSync(c.dagPath).equals(before), 'the refused dry run rewrote the dag').toBe(true);
    expect(fs.existsSync(path.join(c.toolsRoot, 'target.txt')), 'the refused dry run executed an op').toBe(false);
    expect(fs.existsSync(c.lockPath), "the refused run removed the holder's lock").toBe(true);

    // NEGATIVE CONTROL: with the lock gone the same dry run proceeds and releases its own lock.
    fs.rmSync(c.lockPath);
    await core.runCycleCore(c.dagPath, true, newRunner(c), ['fs.scaffold'], c.toolsRoot);
    expect(fs.readFileSync(path.join(c.toolsRoot, 'target.txt'), 'utf8')).toBe('go');
    expect(fs.existsSync(c.lockPath)).toBe(false);
  });
});

describe('0b80a7b5 AC4 withDagLock spans a multi-cycle loop', () => {
  const CYCLES = 3;

  /** What a second process does: present a pid that is not the holder's. Returns the refusal, or null if it acquired. */
  function otherProcessAcquire(c: Case): DuplicateDispatchError | null {
    try {
      acquireDispatchLock(c.lockPath, path.resolve(c.dagPath), { pid: OTHER_PROCESS_PID }).release();
      return null;
    } catch (e) {
      if (e instanceof DuplicateDispatchError) return e;
      throw e;
    }
  }

  it('0b80a7b5 AC4: withDagLock is exported, refuses another process before, between and after every cycle of the loop, and releases when the loop ends', async () => {
    expect(typeof core.withDagLock).toBe('function');
    const c = newCase();
    const refusals: (DuplicateDispatchError | null)[] = [];

    const result = await core.withDagLock(c.dagPath, async () => {
      expect(fs.existsSync(c.lockPath)).toBe(true);
      refusals.push(otherProcessAcquire(c)); // before the first cycle
      for (let cycle = 0; cycle < CYCLES; cycle++) {
        await Promise.resolve(); // a cycle boundary
        refusals.push(otherProcessAcquire(c)); // after each cycle
      }
      return 'looped';
    });

    expect(result).toBe('looped');
    expect(refusals).toHaveLength(CYCLES + 1);
    for (const r of refusals) {
      expect(r).toBeInstanceOf(DuplicateDispatchError);
      expect(r?.holderPid).toBe(process.pid);
      expect(r?.heldBySelf).toBe(false);
    }
    expect(fs.existsSync(c.lockPath)).toBe(false);
    expect(otherProcessAcquire(c), 'the lock must be free after the loop').toBeNull();
  });

  it('0b80a7b5 AC4: withDagLock releases the lock when the loop throws, and the error propagates unchanged', async () => {
    const c = newCase();
    const boom = new Error('cycle 2 exploded');

    await expect(
      core.withDagLock(c.dagPath, async () => {
        expect(otherProcessAcquire(c)).toBeInstanceOf(DuplicateDispatchError);
        throw boom;
      })
    ).rejects.toBe(boom);

    expect(fs.existsSync(c.lockPath)).toBe(false);
    expect(otherProcessAcquire(c)).toBeNull();
  });

  it('0b80a7b5 AC4: nesting runCycleCore (which takes the lock itself) inside withDagLock is refused as heldBySelf and the outer lock is still released', async () => {
    const c = newCase();

    const err = await core
      .withDagLock(c.dagPath, () => core.runCycleCore(c.dagPath, true, newRunner(c), ['fs.scaffold'], c.toolsRoot))
      .then(
        () => null,
        (e: unknown) => e
      );

    expect(err).toBeInstanceOf(DuplicateDispatchError);
    expect((err as DuplicateDispatchError).heldBySelf).toBe(true);
    expect(fs.existsSync(path.join(c.toolsRoot, 'target.txt'))).toBe(false); // refused before any op ran
    expect(fs.existsSync(c.lockPath)).toBe(false);
  });
});
