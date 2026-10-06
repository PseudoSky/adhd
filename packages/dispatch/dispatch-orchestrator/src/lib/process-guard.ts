/**
 * process-guard.ts — duplicate-dispatch guard + runaway-child reaper
 * (backlog d794287f D-AC3).
 *
 * 1. `acquireDispatchLock` — a dispatch IDENTITY may be live at most once, across
 *    PROCESSES (this ecosystem is parallel-process enabled: ADR-0012, so an
 *    in-memory Set would be a false guard). The lock is a file created with the
 *    exclusive `wx` flag holding the owner pid; a lock whose pid is no longer
 *    alive is stale and is reclaimed. A second submission while the first is
 *    live is refused with `DuplicateDispatchError`.
 * 2. `ChildReaper` — tracks spawned children and reaps one that exceeds the
 *    configured resident-memory ceiling or has been idle past its deadline.
 *    Time, RSS and the kill primitive are injectable so the policy is provable
 *    deterministically; the defaults are real (`Date.now`, `ps`, `process.kill`).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// ── duplicate-dispatch guard ────────────────────────────────────────────────

/** Thrown when a dispatch identity is already live. */
export class DuplicateDispatchError extends Error {
  readonly code = 'duplicate_dispatch';
  readonly identity: string;
  readonly holderPid: number;
  constructor(identity: string, holderPid: number) {
    super(`dispatch '${identity}' is already live (held by pid ${holderPid}) — refusing a duplicate submission`);
    this.name = 'DuplicateDispatchError';
    this.identity = identity;
    this.holderPid = holderPid;
  }
}

/** True when `pid` names a live process (signal 0 probe). EPERM means alive but not ours. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface DispatchLock {
  readonly path: string;
  /** Release the lock. Idempotent; only removes a lock this handle still owns. */
  release(): void;
}

export interface AcquireOptions {
  /** Pid recorded as the owner. Default: `process.pid`. */
  pid?: number;
  /** Liveness probe, injectable for tests. Default: {@link pidAlive}. */
  isAlive?: (pid: number) => boolean;
}

/**
 * Acquire the live-dispatch lock at `lockPath` for `identity`.
 * @throws {DuplicateDispatchError} when a live process already holds it.
 */
export function acquireDispatchLock(lockPath: string, identity: string, opts: AcquireOptions = {}): DispatchLock {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? pidAlive;
  mkdirSync(dirname(lockPath), { recursive: true });
  const body = JSON.stringify({ identity, pid, acquiredAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(lockPath, body, { flag: 'wx' });
      let released = false;
      return {
        path: lockPath,
        release() {
          if (released) return;
          released = true;
          try {
            const held = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number };
            if (held.pid === pid) rmSync(lockPath, { force: true });
          } catch {
            /* already gone */
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let holder: number | null = null;
    try {
      const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number };
      holder = typeof parsed.pid === 'number' ? parsed.pid : null;
    } catch {
      holder = null; // unreadable / half-written: treat as stale
    }
    if (holder !== null && isAlive(holder)) throw new DuplicateDispatchError(identity, holder);
    rmSync(lockPath, { force: true }); // stale: reclaim, then retry the exclusive create
  }
  throw new Error(`acquireDispatchLock: could not acquire ${lockPath} after reclaiming a stale lock`);
}

// ── runaway-child reaper ─────────────────────────────────────────────────────

export type ReapReason = 'memory-ceiling' | 'idle-deadline';

export interface ReapedChild {
  pid: number;
  reason: ReapReason;
}

export interface ReaperConfig {
  /** Reap a child whose resident set exceeds this many bytes. Omit for no memory ceiling. */
  maxRssBytes?: number;
  /** Reap a child with no recorded activity for longer than this many ms. Omit for no idle reaping. */
  idleMs?: number;
  /** Default: `Date.now`. */
  nowMs?: () => number;
  /** Resident set size in bytes, or `null` if the process is gone. Default: `ps -o rss= -p <pid>`. */
  rssBytesOf?: (pid: number) => number | null;
  /** Terminate `pid`. Default: SIGKILL via `process.kill`. */
  kill?: (pid: number) => void;
}

/** Real RSS probe via `ps` (kilobytes -> bytes); `null` when the pid is not running. */
export function psRssBytes(pid: number): number | null {
  const r = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const kb = Number.parseInt(r.stdout.trim(), 10);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

/** Tracks child pids and reaps runaway / idle ones on `sweep()`. */
export class ChildReaper {
  private readonly lastActive = new Map<number, number>();
  private readonly nowMs: () => number;
  private readonly rssBytesOf: (pid: number) => number | null;
  private readonly kill: (pid: number) => void;

  private readonly config: ReaperConfig;

  constructor(config: ReaperConfig) {
    this.config = config;
    this.nowMs = config.nowMs ?? Date.now;
    this.rssBytesOf = config.rssBytesOf ?? psRssBytes;
    this.kill = config.kill ?? ((pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } });
  }

  /** Begin tracking `pid` (counts as activity). */
  track(pid: number): void {
    this.lastActive.set(pid, this.nowMs());
  }

  /** Record activity (output, a tool call) so the idle deadline restarts. */
  touch(pid: number): void {
    if (this.lastActive.has(pid)) this.lastActive.set(pid, this.nowMs());
  }

  /** Stop tracking `pid` (it exited on its own). */
  untrack(pid: number): void {
    this.lastActive.delete(pid);
  }

  tracked(): number[] {
    return [...this.lastActive.keys()];
  }

  /** Reap every tracked child over the memory ceiling or past the idle deadline. */
  sweep(): ReapedChild[] {
    const now = this.nowMs();
    const reaped: ReapedChild[] = [];
    for (const [pid, last] of [...this.lastActive]) {
      const rss = this.rssBytesOf(pid);
      if (rss === null) {
        this.lastActive.delete(pid); // already gone
        continue;
      }
      let reason: ReapReason | null = null;
      if (this.config.maxRssBytes !== undefined && rss > this.config.maxRssBytes) reason = 'memory-ceiling';
      else if (this.config.idleMs !== undefined && now - last > this.config.idleMs) reason = 'idle-deadline';
      if (reason) {
        this.kill(pid);
        this.lastActive.delete(pid);
        reaped.push({ pid, reason });
      }
    }
    return reaped;
  }
}
