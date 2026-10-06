/**
 * d794287f D-AC3 — duplicate-dispatch refusal and runaway-child reaping, proven
 * with REAL processes: a second OS process contends for the lock, and reaped
 * children are verified gone with a pid probe (`kill -0`), never by trusting the
 * reaper's own report.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  acquireDispatchLock,
  ChildReaper,
  DuplicateDispatchError,
  pidAlive,
  psRssBytes,
} from '../lib/process-guard.js';

const spawned: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const c of spawned.splice(0)) {
    try { c.kill('SIGKILL'); } catch { /* gone */ }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'process-guard-'));
  dirs.push(d);
  return d;
};
function sleeper(): ChildProcess {
  const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  spawned.push(c);
  return c;
}
const exited = (c: ChildProcess) => new Promise<void>((res) => (c.exitCode !== null || c.signalCode !== null ? res() : c.once('exit', () => res())));

describe('d794287f D-AC3 duplicate-dispatch guard', () => {
  it('d794287f D-AC3: the same identity submitted twice while the first is live is refused; after release it is accepted', () => {
    const lockPath = join(scratch(), 'plan.lock');
    const first = acquireDispatchLock(lockPath, 'plan-a');
    expect(() => acquireDispatchLock(lockPath, 'plan-a')).toThrow(DuplicateDispatchError);
    first.release();
    const again = acquireDispatchLock(lockPath, 'plan-a');
    again.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('d794287f D-AC3: the guard holds ACROSS PROCESSES — a second real process is refused while this one holds the lock', async () => {
    const lockPath = join(scratch(), 'xproc.lock');
    const mine = acquireDispatchLock(lockPath, 'plan-x');
    try {
      // The child is a REAL second process running the REAL guard module (type-stripped, no build step).
      const guardUrl = pathToFileURL(join(__dirname, '../lib/process-guard.ts')).href;
      const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', `
        const { acquireDispatchLock, DuplicateDispatchError } = await import(${JSON.stringify(guardUrl)});
        try { acquireDispatchLock(${JSON.stringify(lockPath)}, 'plan-x'); process.exit(0); }
        catch (e) { process.exit(e instanceof DuplicateDispatchError ? 3 : 4); }
      `], { stdio: 'inherit' });
      spawned.push(child);
      const code = await new Promise<number | null>((res) => child.once('exit', res));
      expect(code).toBe(3); // DuplicateDispatchError raised in the OTHER process
    } finally {
      mine.release();
    }
  });

  it('d794287f D-AC3 NEGATIVE CONTROL: a lock whose owner pid is dead is stale and is reclaimed, not treated as live', async () => {
    const lockPath = join(scratch(), 'stale.lock');
    const dead = sleeper();
    const deadPid = dead.pid as number;
    writeFileSync(lockPath, JSON.stringify({ identity: 'plan-s', pid: deadPid }));
    dead.kill('SIGKILL');
    await exited(dead);
    expect(pidAlive(deadPid)).toBe(false);
    const lock = acquireDispatchLock(lockPath, 'plan-s');
    lock.release();
  });

  it('d794287f D-AC3: release() never removes a lock another owner has since taken', () => {
    const lockPath = join(scratch(), 'owner.lock');
    const a = acquireDispatchLock(lockPath, 'p', { pid: process.pid });
    rmSync(lockPath);
    const b = acquireDispatchLock(lockPath, 'p', { pid: process.pid + 1_000_000, isAlive: () => true });
    a.release();
    expect(existsSync(lockPath)).toBe(true);
    b.release();
  });
});

describe('d794287f D-AC3 child reaper', () => {
  it('d794287f D-AC3: a child over the memory ceiling is reaped and a pid probe finds no orphan', async () => {
    const child = sleeper();
    const pid = child.pid as number;
    await new Promise((r) => setTimeout(r, 0)); // let the spawn settle; ps needs the pid registered
    expect(psRssBytes(pid)).not.toBeNull();
    const reaper = new ChildReaper({ maxRssBytes: 1024 }); // real ps probe: any node process exceeds 1 KiB
    reaper.track(pid);
    const reaped = reaper.sweep();
    expect(reaped).toEqual([{ pid, reason: 'memory-ceiling' }]);
    await exited(child);
    expect(pidAlive(pid)).toBe(false);
    expect(reaper.tracked()).toEqual([]);
  });

  it('d794287f D-AC3: a child idle past its reap deadline (injected clock) is reaped; activity restarts the deadline', async () => {
    let now = 0;
    const idleChild = sleeper();
    const busyChild = sleeper();
    const reaper = new ChildReaper({ idleMs: 100, nowMs: () => now });
    reaper.track(idleChild.pid as number);
    reaper.track(busyChild.pid as number);
    now = 80;
    reaper.touch(busyChild.pid as number);
    now = 150; // idle: 150 > 100; busy: 70 <= 100
    const reaped = reaper.sweep();
    expect(reaped).toEqual([{ pid: idleChild.pid, reason: 'idle-deadline' }]);
    await exited(idleChild);
    expect(pidAlive(idleChild.pid as number)).toBe(false);
    expect(pidAlive(busyChild.pid as number)).toBe(true); // NEGATIVE CONTROL: the healthy child is untouched
  });

  it('d794287f D-AC3 NEGATIVE CONTROL: under the ceiling and within the deadline nothing is reaped; an already-exited child is dropped quietly', async () => {
    const child = sleeper();
    const reaper = new ChildReaper({ maxRssBytes: 64 * 1024 * 1024 * 1024, idleMs: 60_000 });
    reaper.track(child.pid as number);
    expect(reaper.sweep()).toEqual([]);
    expect(pidAlive(child.pid as number)).toBe(true);
    child.kill('SIGKILL');
    await exited(child);
    expect(reaper.sweep()).toEqual([]);
    expect(reaper.tracked()).toEqual([]);
  });
});
