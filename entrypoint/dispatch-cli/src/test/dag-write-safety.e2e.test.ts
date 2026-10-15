/**
 * guards: two dispatch run processes write one dag.json at once and one overwrites the other, or a lock/temp file is left behind
 * tier: P
 * cites: 0b80a7b5 AC6
 * gap: This cannot be observed at tier S because an injected isAlive/pid replaces exactly the cross-process liveness and hard-link publish the criterion is about.
 *
 * dag-write-safety.e2e.test.ts — AC6 of the dag write-safety slice as a consumer
 * meets it: two real `dispatch run` OS processes contending for one dag file
 * through the real `bin/cli.ts` and the real `withDagLock`.
 *
 * Failure mode: two `dispatch run` processes write the same dag.json at once and
 * one silently overwrites the other's observation record, or a lock/temp file is
 * left behind.
 * Tier: P (spawns real processes). Fidelity gap: the contention is between
 *   distinct OS pids — the pid-liveness probe, the hard-link publish and the
 *   `DuplicateDispatchError` -> exit status 1 path run across a process
 *   boundary; cannot be observed at tier S because an injected `isAlive`/`pid`
 *   replaces exactly the cross-process liveness the criterion is about.
 *   AC3 and AC4 (tier S, injected runner) live in dag-write-safety.spec.ts.
 * Items: 0b80a7b5 (slice D1-D3), criterion AC6.
 * Red run: `red: pending (user hold)` — authored under a no-run hold. Expected
 *   against the base (21ba12b3) core.ts: AC6 fails waiting for the first dry run's
 *   lock file (`the first dry run never took the dag lock`) because the dry run
 *   takes no lock.
 *
 * Harness assumptions (verified by reading, not by running):
 *   - core.ts `runCycleCore` chooses `MockAgentRunner` for a dry run, but the
 *     orchestrator still executes an allowed `fs.scaffold` tool-call op for real
 *     (dispatch-orchestrator `defaultToolCallExec`, gated by `--allow-fs`), so a
 *     dry run writes `target` — here a FIFO — and blocks on it while holding the lock.
 *   - the CLI child runs under `tsx`; no `--experimental-strip-types` is used.
 *
 * Isolation (ADR-0008:32): every spawned process gets a fake HOME, an isolated
 * cwd and a private TMPDIR (which relocates the lock directory). Concurrency is
 * released by a FIFO latch, awaited with bounded deadlines — never by sleeping.
 * Prerequisites (tsx binary, bin/cli.ts, mkfifo) fail loudly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as core from '../lib/core.js';
import { makeFixtureDag, makeOp } from './helpers/fixtures.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const TSCONFIG_BASE = path.join(REPO_ROOT, 'tsconfig.base.json');
const CLI_PATH = path.join(REPO_ROOT, 'entrypoint', 'dispatch-cli', 'bin', 'cli.ts');
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
  // The lock directory must exist before anything watches it (fs.watch throws
  // ENOENT on a missing path); the product's mkdirSync(recursive) is then a no-op.
  fs.mkdirSync(path.dirname(lockPathOf(c)), { recursive: true });
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

/**
 * Resolves once `target` exists (event-driven via fs.watch on its directory,
 * which must already exist). The existence check after the watcher is armed
 * closes the create-before-watch race.
 */
function appears(target: string, ms: number): Promise<void> {
  let watcher: fs.FSWatcher | undefined;
  return within(
    new Promise<void>((resolve, reject) => {
      try {
        watcher = fs.watch(path.dirname(target), () => {
          if (fs.existsSync(target)) resolve();
        });
      } catch (err) {
        reject(err);
        return;
      }
      watcher.on('error', reject);
      if (fs.existsSync(target)) resolve();
    }),
    ms,
    `${target} never appeared`
  ).finally(() => watcher?.close());
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
    // No temp files anywhere: serializer temps (`.<dag>.<pid>.<hex>.tmp`) beside the dag,
    // lock temps (`<lock>.tmp.<pid>.<hex>`) and reclaim/release side files in the lock dir.
    expect(fs.readdirSync(c.dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(fs.readdirSync(path.dirname(lockPath)).filter((f) => /\.(tmp|reclaim|release)\./.test(f))).toEqual([]);
    expect(fs.readdirSync(c.tmp).filter((f) => /\.tmp\./.test(f))).toEqual([]);
    expect(fs.existsSync(lockPath)).toBe(false);
  }, 240_000);
});
