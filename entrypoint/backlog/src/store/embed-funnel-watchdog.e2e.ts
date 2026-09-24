/**
 * embed-funnel-watchdog.e2e.ts — teeth for the consumer's SELF-watchdog, the
 * load-bearing half of the embed-funnel process-leak fix.
 *
 * ## The defect this pins
 *
 * `embed-funnel-consumer.ts` HOLDs a persistent funnel UDS client connection
 * (the shared host correctly refuses to reap while any client is attached), and
 * it used to exit ONLY on a parent-delivered SIGTERM/SIGINT. The spec's
 * `afterEach` was the only reaper, so when the test/gate process was killed
 * externally — the observed pre-push-gate SIGPIPE(141)/timeout — `afterEach`
 * never ran, the consumers reparented to PID 1 and lived forever, each pinning
 * a shared embedding host and its ONNX child. Repeated runs produced the ~66
 * leaked processes / ~4.7 GB event.
 *
 * ## What is proven here (bounded wall-clock, no timing flake)
 *
 * The fix that makes a consumer unable to outlive its owner is the watchdog
 * installed INSIDE the consumer (`installSelfWatchdog`), with two arms:
 *
 *   1. an absolute, unref'd lifetime timer — an owner that stays alive but
 *      never signals still cannot strand the consumer; and
 *   2. a parent-lease poll — the owner's pid is passed in the environment and
 *      polled (`kill(pid, 0)`); the consumer exits within ~one poll interval
 *      of it disappearing, which is what bounds the observed
 *      `kill -9 <test process>` mode. (An explicit pid, not `process.ppid`:
 *      that is a cached value, and `tsx` inserts a wrapper process so the
 *      consumer is a grandchild of the test either way.)
 *
 * Each arm is driven through REAL, separate consumer processes (the same
 * `test/helpers/embed-funnel-consumer.ts` the funnel proof uses), never a
 * mock. Neither test sends the consumer a signal: an exit here is the
 * watchdog's doing.
 *
 * ## Teeth
 *
 * Remove either arm of `installSelfWatchdog` and the corresponding test goes
 * RED: the consumer parks in `holdForever()` and the bounded `awaitExit` /
 * `waitForPidGone` deadline elapses without an exit. That is the whole point —
 * a test that stayed green with the watchdog gone would prove nothing.
 *
 * Runs by DEFAULT, unflagged: this is local process bookkeeping (no model load,
 * no network, no paid/external service), so AGENTS.md's env-gate exception does
 * not apply. `bootstrap-only` mode constructs the (inert) production seam and
 * holds — it never loads the model.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { freshTmpDir } from '../test/helpers/tmp-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `src/store/` -> repo root. */
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const RUNNER = join(HERE, '..', 'test', 'helpers', 'embed-funnel-consumer.ts');

/** The consumer's absolute-lifetime knob (mirrors the consumer's own constant). */
const WATCHDOG_ENV = 'SOX_FUNNEL_CONSUMER_WATCHDOG_MS';

/** Consumers spawned by this spec; group-killed in `afterEach`. */
const liveChildren: ChildProcess[] = [];
/** Scratch dirs, removed in `afterEach` after the consumers are reaped. */
const liveSignalDirs: string[] = [];

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** True while `pid` exists (including a not-yet-reaped child). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Bounded wait for a child we spawned to exit (via its own 'exit' event). */
function awaitExit(child: ChildProcess, deadlineMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((res) => {
    const timer = setTimeout(() => res(false), deadlineMs);
    child.once('exit', () => {
      clearTimeout(timer);
      res(true);
    });
  });
}

/** Bounded wait for a NON-child pid (polled — no 'exit' event available). */
async function waitForPidGone(pid: number, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await delay(100);
  }
  return !pidAlive(pid);
}

/** Group-kill a detached consumer (pgid === pid), then fall back to the pid. */
function reap(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
    return;
  } catch {
    /* group already gone */
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* best-effort */
  }
}

afterEach(() => {
  for (const child of liveChildren.splice(0)) reap(child);
  for (const dir of liveSignalDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('embed-funnel-consumer self-watchdog', () => {
  it(
    'a consumer exits on its own when its absolute lifetime bound expires — no parent signal',
    async () => {
      const signalDir = freshTmpDir('funnel-watchdog');
      const soxHome = join(signalDir, 'sox-home');
      liveSignalDirs.push(signalDir);
      const child = spawn(
        process.execPath,
        [TSX_CLI, RUNNER, 'bootstrap-only', signalDir, '0'],
        {
          env: {
            ...process.env,
            SOX_ECOSYSTEM_HOME: soxHome,
            ADHD_BACKLOG_EMBEDDING_ENABLED: 'true',
            // The owner (this test process) stays alive, so the lease arm
            // CANNOT fire — only the absolute timer can explain the exit.
            SOX_FUNNEL_CONSUMER_PARENT_PID: String(process.pid),
            // Short, so the test is fast; the consumer is otherwise inert.
            [WATCHDOG_ENV]: '5000',
          },
          // Detached (own group) exactly as the funnel proof spawns it — and
          // so `reap` in `afterEach` exercises the same group-kill path.
          detached: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        }
      );
      liveChildren.push(child);
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => {
        stderr += String(d);
      });

      // We never signal it. It must exit by itself, within a bound comfortably
      // above (tsx boot + 5 s timer). Reintroduce the bug — drop the absolute
      // timer — and this `true` becomes a hang -> RED.
      const exited = await awaitExit(child, 60_000);
      expect(exited, `consumer did not self-exit; stderr:\n${stderr}`).toBe(true);
      // Attribute the exit to the watchdog, not an early crash.
      expect(stderr, `expected the self-watchdog to explain the exit; got:\n${stderr}`).toContain(
        'self-watchdog'
      );
    },
    120_000
  );

  it(
    'a consumer exits when its owning process dies, long before its lifetime bound',
    async () => {
      const signalDir = freshTmpDir('funnel-orphan');
      const soxHome = join(signalDir, 'sox-home');
      liveSignalDirs.push(signalDir);
      const readyFile = join(signalDir, 'ready-0');
      const pidFile = join(signalDir, 'orphan-child-pid');

      // A throwaway launcher spawns the REAL consumer (detached), passing its
      // OWN pid as the lease, and stays alive just long enough for the consumer
      // to boot — then exits, so the owner the consumer polls disappears.
      const launcher = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        `const signalDir = ${JSON.stringify(signalDir)};`,
        'const child = spawn(process.execPath, [',
        `  ${JSON.stringify(TSX_CLI)}, ${JSON.stringify(RUNNER)},`,
        "  'bootstrap-only', signalDir, '0',",
        '], {',
        '  env: {',
        '    ...process.env,',
        `    SOX_ECOSYSTEM_HOME: ${JSON.stringify(soxHome)},`,
        "    ADHD_BACKLOG_EMBEDDING_ENABLED: 'true',",
        // The lease is THIS launcher's pid, which exits below.
        '    SOX_FUNNEL_CONSUMER_PARENT_PID: String(process.pid),',
        // Long absolute bound: only the lease arm can explain a fast exit.
        `    ${WATCHDOG_ENV}: '600000',`,
        '  },',
        "  stdio: ['ignore', 'ignore', 'ignore'],",
        '  detached: true,',
        '});',
        "fs.writeFileSync(path.join(signalDir, 'orphan-child-pid'), String(child.pid));",
        'child.unref();',
        'const ready = path.join(signalDir, "ready-0");',
        'const deadline = Date.now() + 60000;',
        '(function poll() {',
        '  if (fs.existsSync(ready) || Date.now() > deadline) process.exit(0);',
        '  setTimeout(poll, 50);',
        '})();',
      ].join('\n');

      execFileSync(process.execPath, ['-e', launcher], { timeout: 90_000 });

      const childPid = Number(readFileSync(pidFile, 'utf8'));
      expect(Number.isInteger(childPid) && childPid > 0, 'launcher must record the consumer pid').toBe(
        true
      );
      // The launcher has exited; the consumer's lease pid is gone. It must exit
      // within ~a few seconds — far below its 600 s lifetime bound — which can
      // ONLY be the lease poll. Reintroduce the bug (drop that poll) and this
      // bounded wait elapses -> RED.
      const gone = await waitForPidGone(childPid, 30_000);
      expect(gone, `orphaned consumer pid ${childPid} must self-exit on owner death`).toBe(true);
      // Sanity: it really did reach the hold point first.
      expect(existsSync(readyFile)).toBe(true);
    },
    120_000
  );
});
