/**
 * dag-write-safety.e2e.test.ts — the dag lock as a consumer meets it: real OS
 * processes contending for one dag file through the real `bin/cli.ts` and the
 * real `withDagLock`.
 *
 * Failure mode: two `dispatch run` processes (dry or wet) write the same dag.json
 * at once and one silently overwrites the other's observation record; a dry run
 * sails past a live run's lock; a multi-cycle caller drops the lock between
 * cycles or leaks it on throw.
 * Tier: P (spawns real processes). Fidelity gap: the contention is between
 *   distinct OS pids — the pid-liveness probe, the hard-link publish and the
 *   `DuplicateDispatchError` -> exit status 1 path run across a process
 *   boundary; cannot be observed at tier S because an injected `isAlive`/`pid`
 *   replaces exactly the cross-process liveness the criterion is about.
 *   Placement note: AC3 and AC4 are in this file because the write scope for the
 *   slice allowed no new unit spec in dispatch-cli; the dispatching agent may
 *   move them to dispatch-guards.spec.ts (tier S, injected pid) if it prefers.
 * Items: 0b80a7b5 (slice D1-D3), criteria AC3, AC4, AC6.
 * Red run: pending — authored under a no-run hold. Expected against the base
 *   (21ba12b3) core.ts: AC3 fails on `expected 0 to be 1` (the dry run returns
 *   before any lock and exits 0); AC6 fails waiting for the first dry run's lock
 *   file (`dry run never took the dag lock`); AC4 fails on
 *   `expected 'undefined' to be 'function'` (no `withDagLock` export).
 *
 * Isolation (ADR-0008:32): every spawned process gets a fake HOME, an isolated
 * cwd and a private TMPDIR (which relocates the lock directory). Concurrency is
 * released by a FIFO latch and by stdin EOF, awaited with bounded deadlines —
 * never by sleeping. Prerequisites (tsx binary, bin/cli.ts, process-guard.ts, mkfifo) fail loudly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DuplicateDispatchError, MockAgentRunner } from '@adhd/dispatch-orchestrator';

import * as core from '../lib/core.js';
import { makeFixtureDag, makeOp } from './helpers/fixtures.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const TSCONFIG_BASE = path.join(REPO_ROOT, 'tsconfig.base.json');
const CLI_PATH = path.join(REPO_ROOT, 'entrypoint', 'dispatch-cli', 'bin', 'cli.ts');
const GUARD_TS = path.join(REPO_ROOT, 'packages', 'dispatch', 'dispatch-orchestrator', 'src', 'lib', 'process-guard.ts');
const TMP_ROOT = path.join(REPO_ROOT, 'tmp', 'dispatch-cli', 'dag-write-safety');
const DEADLINE_MS = 60_000;

// --- harness ---------------------------------------------------------------

const spawned: ChildProcess[] = [];
let caseN = 0;
let savedTmpdirEnv: string | undefined;

interface Case {
  dir: string;
  home: string;
  tmp: string;
  toolsRoot: string;
  dagPath: string;
}

/** A fresh isolated case dir; lock files for it live under its private TMPDIR. */
function newCase(): Case {
  const dir = path.join(TMP_ROOT, `case-${caseN++}`);
  const c: Case = {
    dir,
    home: path.join(dir, 'home'),
    tmp: path.join(dir, 'tmp'),
    toolsRoot: path.join(dir, 'tools'),
    dagPath: path.join(dir, 'dag.json'),
  };
  for (const d of [c.home, c.tmp, c.toolsRoot]) fs.mkdirSync(d, { recursive: true });
  return c;
}

/** The lock path the product derives for `dagPath`, under the process TMPDIR in force. */
function lockPathOf(c: Case): string {
  process.env['TMPDIR'] = c.tmp; // os.tmpdir() reads this at call time
  return core.dispatchLockPath(c.dagPath);
}

function childEnv(c: Case): NodeJS.ProcessEnv {
  return { PATH: process.env['PATH'], HOME: c.home, USERPROFILE: c.home, TMPDIR: c.tmp };
}

interface Running {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
}

function track(child: ChildProcess): Running {
  spawned.push(child);
  let out = '';
  let err = '';
  child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')));
  child.stderr?.on('data', (b: Buffer) => (err += b.toString('utf8')));
  const exited = new Promise<number | null>((resolve) =>
    child.exitCode !== null || child.signalCode !== null ? resolve(child.exitCode) : child.once('exit', (code) => resolve(code))
  );
  return { child, stdout: () => out, stderr: () => err, exited };
}

/** Reject if `p` does not settle within `ms` (a bounded deadline, not a pause). */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`deadline exceeded (${ms} ms): ${what}`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/** The real `dispatch` CLI (bin/cli.ts) as a child process. */
function spawnCli(c: Case, args: string[]): Running {
  return track(
    spawn(TSX_BIN, ['--tsconfig', TSCONFIG_BASE, CLI_PATH, ...args], {
      cwd: c.dir,
      env: childEnv(c),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
}

/** Resolves once `target` exists (event-driven via fs.watch on its directory). */
function appears(target: string, ms: number): Promise<void> {
  return within(
    new Promise<void>((resolve, reject) => {
      const watcher = fs.watch(path.dirname(target), () => {
        if (fs.existsSync(target)) {
          watcher.close();
          resolve();
        }
      });
      watcher.on('error', reject);
      if (fs.existsSync(target)) {
        watcher.close();
        resolve();
      }
    }),
    ms,
    `${target} never appeared`
  );
}

/**
 * A real second process that holds the dag lock through the real process-guard
 * until its stdin closes. Resolves once the lock is held.
 */
async function holdLockInOtherProcess(c: Case): Promise<{ run: Running; release: () => Promise<void> }> {
  const script = `
    const { acquireDispatchLock } = await import(${JSON.stringify(pathToFileURL(GUARD_TS).href)});
    const lock = acquireDispatchLock(${JSON.stringify(lockPathOf(c))}, 'held-by-test');
    process.stdout.write('held\\n');
    process.stdin.resume();
    process.stdin.on('end', () => { lock.release(); process.exit(0); });
  `;
  const run = track(
    spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], {
      env: childEnv(c),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  );
  await within(
    new Promise<void>((resolve, reject) => {
      run.child.stdout?.on('data', () => {
        if (run.stdout().includes('held')) resolve();
      });
      void run.exited.then((code) => reject(new Error(`lock holder exited early (${code}): ${run.stderr()}`)));
    }),
    DEADLINE_MS,
    'lock holder never reported held'
  );
  return {
    run,
    release: async () => {
      run.child.stdin?.end();
      await within(run.exited, DEADLINE_MS, 'lock holder never exited');
    },
  };
}

/** Exit code of a real process that tries to take the dag lock: 0 acquired, 3 duplicate, 4 other. */
async function probeLock(c: Case): Promise<number | null> {
  const script = `
    const { acquireDispatchLock, DuplicateDispatchError } = await import(${JSON.stringify(pathToFileURL(GUARD_TS).href)});
    try { acquireDispatchLock(${JSON.stringify(lockPathOf(c))}, 'probe').release(); process.exit(0); }
    catch (e) { process.exit(e instanceof DuplicateDispatchError ? 3 : 4); }
  `;
  const run = track(
    spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], {
      env: childEnv(c),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
  return within(run.exited, DEADLINE_MS, 'lock probe never exited');
}

const dagWith = (targetRel: string) =>
  makeFixtureDag({
    operations: [
      makeOp({
        id: 'a.1',
        milestone: 'a',
        depends_on: [],
        type: 'tool-call',
        action: 'fs.scaffold',
        args: { path: targetRel, content: 'go' },
        shape: null,
      }),
      makeOp({ id: 'b.1', milestone: 'b', depends_on: ['a.1'] }),
      makeOp({ id: 'c.1', milestone: 'c', depends_on: ['b.1'] }),
    ],
  });

const writeDagFile = (c: Case, targetRel = 'target.txt') =>
  fs.writeFileSync(c.dagPath, JSON.stringify(dagWith(targetRel), null, 2), 'utf8');

const logLength = (dagPath: string) => (JSON.parse(fs.readFileSync(dagPath, 'utf8')) as { dispatch_log: unknown[] }).dispatch_log.length;

beforeAll(() => {
  for (const [what, p] of [
    ['tsx binary', TSX_BIN],
    ['dispatch-cli bin/cli.ts', CLI_PATH],
    ['process-guard.ts', GUARD_TS],
  ] as const) {
    if (!fs.existsSync(p)) throw new Error(`dag-write-safety e2e: ${what} not found at ${p} — run pnpm install / check the checkout`);
  }
  savedTmpdirEnv = process.env['TMPDIR'];
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TMP_ROOT, { recursive: true });
});

afterAll(() => {
  for (const c of spawned.splice(0)) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  if (savedTmpdirEnv === undefined) delete process.env['TMPDIR'];
  else process.env['TMPDIR'] = savedTmpdirEnv;
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

// --- AC3 -------------------------------------------------------------------

describe('0b80a7b5 AC3 dry run takes the dag lock', () => {
  it('0b80a7b5 AC3: `dispatch run` (dry-run, the default) is refused while a live pid holds the dag lock, writes nothing, and proceeds once the holder releases', async () => {
    const c = newCase();
    writeDagFile(c);
    const before = fs.readFileSync(c.dagPath);
    const holder = await holdLockInOtherProcess(c);
    const holderPid = holder.run.child.pid as number;

    const refused = spawnCli(c, ['run', '--dag-path', c.dagPath, '--allow-fs', 'fs.scaffold', '--tools-root', c.toolsRoot]);
    const refusedCode = await within(refused.exited, DEADLINE_MS, 'refused dry run never exited');

    expect(refusedCode, `stdout:\n${refused.stdout()}\nstderr:\n${refused.stderr()}`).toBe(1);
    expect(refused.stderr()).toMatch(new RegExp(`already live \\(held by pid ${holderPid}\\)`));
    expect(fs.readFileSync(c.dagPath).equals(before), 'the refused dry run rewrote the dag').toBe(true);
    expect(fs.existsSync(path.join(c.toolsRoot, 'target.txt')), 'the refused dry run executed an op').toBe(false);

    await holder.release();
    // NEGATIVE CONTROL: with the lock free the same dry run proceeds.
    const ok = spawnCli(c, ['run', '--dag-path', c.dagPath, '--allow-fs', 'fs.scaffold', '--tools-root', c.toolsRoot]);
    const okCode = await within(ok.exited, DEADLINE_MS, 'dry run after release never exited');
    expect(okCode, `stdout:\n${ok.stdout()}\nstderr:\n${ok.stderr()}`).toBe(0);
    expect(fs.readFileSync(path.join(c.toolsRoot, 'target.txt'), 'utf8')).toBe('go');
    expect(fs.existsSync(lockPathOf(c))).toBe(false);
  }, 180_000);
});

// --- AC4 -------------------------------------------------------------------

describe('0b80a7b5 AC4 withDagLock spans a multi-cycle loop', () => {
  const CYCLES = 3;

  it('0b80a7b5 AC4: withDagLock is exported, refuses a real second process before, between and after every cycle of the loop, and releases when the loop ends', async () => {
    expect(typeof core.withDagLock).toBe('function');
    const c = newCase();
    writeDagFile(c);
    const lockPath = lockPathOf(c);
    const probes: (number | null)[] = [];

    const result = await core.withDagLock(c.dagPath, async () => {
      expect(fs.existsSync(lockPath)).toBe(true);
      for (let cycle = 0; cycle < CYCLES; cycle++) {
        probes.push(await probeLock(c)); // a real second process, once per cycle
      }
      return 'looped';
    });

    expect(result).toBe('looped');
    expect(probes).toEqual(Array(CYCLES).fill(3)); // 3 = DuplicateDispatchError in the OTHER process, every cycle
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(await probeLock(c)).toBe(0); // free again: the other process now acquires
  }, 120_000);

  it('0b80a7b5 AC4: withDagLock releases the lock when the loop throws, and the error propagates unchanged', async () => {
    expect(typeof core.withDagLock).toBe('function');
    const c = newCase();
    writeDagFile(c);
    const lockPath = lockPathOf(c);
    const boom = new Error('cycle 2 exploded');

    await expect(
      core.withDagLock(c.dagPath, async () => {
        expect(await probeLock(c)).toBe(3);
        throw boom;
      })
    ).rejects.toBe(boom);

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(await probeLock(c)).toBe(0);
  }, 120_000);

  it('0b80a7b5 AC4: nesting runCycleCore (which takes the lock itself) inside withDagLock is refused as heldBySelf and the outer lock is still released', async () => {
    expect(typeof core.withDagLock).toBe('function');
    const c = newCase();
    writeDagFile(c);
    const lockPath = lockPathOf(c);
    const runner = new MockAgentRunner({ debugDir: path.join(c.dir, 'mock-debug') });

    const err = await core
      .withDagLock(c.dagPath, () => core.runCycleCore(c.dagPath, true, runner, ['fs.scaffold'], c.toolsRoot))
      .then(
        () => null,
        (e: unknown) => e
      );
    runner.cleanup();

    expect(err).toBeInstanceOf(DuplicateDispatchError);
    expect((err as InstanceType<typeof DuplicateDispatchError>).heldBySelf).toBe(true);
    expect(fs.existsSync(path.join(c.toolsRoot, 'target.txt'))).toBe(false); // refused before any op ran
    expect(fs.existsSync(lockPath)).toBe(false);
  }, 120_000);
});

// --- AC6 -------------------------------------------------------------------

describe('0b80a7b5 AC6 two real `dispatch run` processes on one dag', () => {
  it('0b80a7b5 AC6: exactly one proceeds; the other exits non-zero with the duplicate-dispatch error; the survivor persists its full record and no temp file remains', async () => {
    // CONTROL: the same dag run alone, to learn how many dispatch_log entries one run produces.
    const control = newCase();
    writeDagFile(control, 'control-target.txt');
    const controlRun = spawnCli(control, ['run', '--dag-path', control.dagPath, '--allow-fs', 'fs.scaffold', '--tools-root', control.toolsRoot]);
    expect(await within(controlRun.exited, DEADLINE_MS, 'control run never exited'), controlRun.stderr()).toBe(0);
    const expectedLog = logLength(control.dagPath);

    // CONTENTION: the first run blocks inside its fs.scaffold op on a FIFO (it has no
    // reader), so it holds the lock for exactly as long as the test decides.
    const c = newCase();
    const fifo = path.join(c.toolsRoot, 'gate.fifo');
    execFileSync('mkfifo', [fifo]);
    writeDagFile(c, 'gate.fifo');
    const args = ['run', '--dag-path', c.dagPath, '--allow-fs', 'fs.scaffold', '--tools-root', c.toolsRoot];
    const lockPath = lockPathOf(c);

    const first = spawnCli(c, args);
    await Promise.race([
      appears(lockPath, DEADLINE_MS).catch((err: Error) => {
        throw new Error(`the first dry run never took the dag lock (${err.message}); stderr:\n${first.stderr()}`);
      }),
      first.exited.then((code) => {
        throw new Error(`the first run exited (${code}) before taking the lock:\n${first.stderr()}`);
      }),
    ]);

    const second = spawnCli(c, args);
    const secondCode = await within(second.exited, DEADLINE_MS, 'second run never exited');
    expect(secondCode, `stdout:\n${second.stdout()}\nstderr:\n${second.stderr()}`).not.toBe(0);
    expect(second.stderr()).toMatch(/already live \(held by pid \d+\)/);
    expect(first.child.exitCode, 'the first run must still be running, blocked on the latch').toBeNull();

    // Release the latch: reading the FIFO lets the first run's write complete.
    expect(await within(fs.promises.readFile(fifo, 'utf8'), DEADLINE_MS, 'latch read never completed')).toBe('go');
    const firstCode = await within(first.exited, DEADLINE_MS, 'first run never exited');
    expect(firstCode, `stdout:\n${first.stdout()}\nstderr:\n${first.stderr()}`).toBe(0);

    // The survivor's record is intact and equals what one solo run produces.
    expect(logLength(c.dagPath)).toBe(expectedLog);
    expect(fs.readdirSync(c.dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(fs.existsSync(lockPath)).toBe(false);
  }, 240_000);
});
