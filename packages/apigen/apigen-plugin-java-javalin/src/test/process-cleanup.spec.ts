/**
 * Regression test for BUG-006 (30 orphaned JVM test-server processes found
 * live in prod, one alive 3 days 22 hours) — proves `../lib/plugin.ts`'s
 * process-lifecycle backstop (`installProcessLifecycleHandlers`) actually
 * kills the real JVM child when the PARENT Node process is killed abruptly,
 * independent of (and without relying on) the pre-existing `AbortSignal`
 * path.
 *
 * Drives the REAL `run()` entrypoint via a REAL, separate Node subprocess
 * (`fixtures/spawn-orphan-child.ts`, run via `tsx`) that deliberately never
 * wires an `AbortSignal` — the only thing standing between "parent dies" and
 * "orphaned JVM" in that harness is the SIGTERM/SIGINT handler this fix adds.
 * The test then sends that harness process a REAL `SIGTERM`, finds the real
 * `java`/`ApigenJavalinServer` child PID via `pgrep -P <harness pid>`
 * beforehand, and asserts (bounded deadline poll — no open-ended sleep, per
 * AGENTS.md §7) that the JVM PID is actually gone afterward.
 *
 * Not gated behind an env var — spawning a JVM is not a paid/external
 * third-party service (AGENTS.md §7's sole qualifying exception), so this
 * runs by default like every other live test in this package.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';
import * as path from 'node:path';

const HARNESS = path.resolve(__dirname, 'fixtures/spawn-orphan-child.ts');
const TSX_BIN = path.resolve(__dirname, '../../../../../node_modules/.bin/tsx');

interface HarnessHandle {
  proc: ChildProcessWithoutNullStreams;
  pid: number;
  /** Set once the JVM child is identified, for teardown's direct-kill path. */
  javaPid?: number;
}

/** Direct children of `parentPid` whose command line matches `ApigenJavalinServer`. */
function findJavaChildren(parentPid: number): number[] {
  const result = spawnSync('pgrep', ['-P', String(parentPid)], { encoding: 'utf-8' });
  if (result.status !== 0 || !result.stdout) return [];
  const candidates = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => Number(line));

  return candidates.filter((pid) => {
    const psResult = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], {
      encoding: 'utf-8',
    });
    return (psResult.stdout ?? '').includes('ApigenJavalinServer');
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Bounded deadline poll — no open-ended sleep (AGENTS.md §7). */
async function waitUntilDead(pid: number, deadlineMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return !isAlive(pid);
}

function waitForReadyLine(
  proc: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: proc.stdout });
    const timer = setTimeout(() => {
      rl.close();
      reject(new Error('harness: timed out waiting for READY line'));
    }, timeoutMs);
    rl.on('line', (line: string) => {
      const match = /^READY (\d+)$/.exec(line.trim());
      if (match) {
        clearTimeout(timer);
        rl.close();
        resolve(Number(match[1]));
      }
    });
  });
}

let activeHarness: HarnessHandle | undefined;

async function startHarness(): Promise<HarnessHandle> {
  const proc = spawn(TSX_BIN, [HARNESS], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  if (proc.pid === undefined) {
    throw new Error('startHarness: spawn() did not yield a pid');
  }

  // Register the handle BEFORE awaiting readiness: if waitForReadyLine ever
  // rejects (bounded timeout below), afterEach must still be able to reap
  // this harness (and any JVM it already spawned) — leaving `activeHarness`
  // unset until success would leak exactly the orphan this test exists to
  // catch, on its own failure path.
  activeHarness = { proc, pid: proc.pid };

  // Bounded outer wait — the plugin's own waitForReady is already bounded
  // (30s) and mvn/javac/JVM cold-start can take a while on a loaded box.
  const pid = await waitForReadyLine(proc, 100_000);
  activeHarness.pid = pid;
  return activeHarness;
}

afterEach(async () => {
  if (!activeHarness) return;
  const harness = activeHarness;
  activeHarness = undefined;

  // Graceful first (mirrors a real caller), but the whole point of this
  // suite is that a SIGKILL to the harness must NOT leak the JVM either —
  // so on top of asking the harness to shut down cleanly, always sweep the
  // JVM PID directly as a final, unconditional backstop. A SIGKILL to the
  // harness process bypasses ITS OWN SIGTERM handler entirely (SIGKILL
  // can't be caught), so if teardown only killed the harness, a failed
  // assertion mid-test would itself reproduce BUG-006.
  try {
    harness.proc.kill('SIGTERM');
  } catch {
    /* already dead */
  }
  await waitUntilDead(harness.pid, 5_000);
  try {
    harness.proc.kill('SIGKILL');
  } catch {
    /* already dead */
  }
  if (harness.javaPid !== undefined) {
    try {
      process.kill(harness.javaPid, 'SIGKILL');
    } catch {
      /* already dead */
    }
  }
}, 30_000);

describe('java-javalin plugin — process-lifecycle hygiene (BUG-006 regression)', () => {
  it(
    'SIGTERM to the parent process kills the orphaned JVM child within the grace period',
    async () => {
      const harness = await startHarness();
      const harnessPid = harness.pid;

      const javaChildren = findJavaChildren(harnessPid);
      // Exactly one JVM child during the run — the grooming doc's own
      // "assert exactly one java PID exists via ps/proc.pid bookkeeping
      // during the run" criterion (test-perf-improvements.md #4).
      expect(javaChildren).toHaveLength(1);
      const javaPid = javaChildren[0];
      harness.javaPid = javaPid;

      // Sanity: the JVM is actually alive before we act.
      expect(isAlive(javaPid)).toBe(true);

      // Simulate the exact BUG-006 shape: the PARENT process is sent a
      // signal it never explicitly wired an AbortSignal for.
      process.kill(harnessPid, 'SIGTERM');

      // plugin.ts's SIGTERM handler gives children a 3s SIGTERM grace period
      // before SIGKILL + process.exit — bound the poll comfortably beyond
      // that instead of polling forever.
      const dead = await waitUntilDead(javaPid, 8_000);
      expect(dead).toBe(true);

      // The harness process itself should also be gone (it calls
      // process.exit() once cleanup completes, since it's the sole SIGTERM
      // listener in that process).
      const harnessDead = await waitUntilDead(harnessPid, 2_000);
      expect(harnessDead).toBe(true);
    },
    120_000
  );
});
