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
import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  /**
   * Test seam: called after a stale lock body has been read and before the
   * reclaimer moves the lock file aside. Lets a test interleave a competitor
   * that re-acquires the lock inside the stale-read window.
   */
  onStaleRead?: () => void;
}

/** Pid recorded in a lock body, or `null` when the body is unreadable or malformed. */
function holderPidOf(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { pid?: number };
    return typeof parsed.pid === 'number' ? parsed.pid : null;
  } catch {
    return null; // half-written or corrupt: treated as stale by the caller
  }
}

/**
 * Reclaim a stale lock without deleting a competitor's lock.
 *
 * The lock file is first renamed to a unique side name, which removes it from
 * `lockPath` atomically. The side copy is then compared with the stale body the
 * caller read earlier:
 * - identical: it is the stale file, so it is discarded and the caller retries
 *   the exclusive create;
 * - different: a competitor re-acquired the lock between the stale read and the
 *   rename. The side copy is hard-linked back to `lockPath` (which never
 *   overwrites) and, if that competitor is alive, this reclaim is refused with
 *   `DuplicateDispatchError` naming it.
 *
 * @throws {DuplicateDispatchError} when the moved-aside lock belongs to a live competitor.
 */
function reclaimStaleLock(
  lockPath: string,
  staleBody: string,
  identity: string,
  isAlive: (pid: number) => boolean
): void {
  const aside = `${lockPath}.reclaim.${process.pid}.${randomBytes(6).toString('hex')}`;
  try {
    renameSync(lockPath, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // already gone: caller retries
    throw err;
  }
  let moved = '';
  try {
    moved = readFileSync(aside, 'utf8');
  } catch {
    moved = ''; // unreadable side copy: cannot match the stale body
  }
  if (moved === staleBody) {
    rmSync(aside, { force: true });
    return;
  }
  // Not the stale file: a competitor re-acquired between our read and our rename.
  let restored = false;
  try {
    linkSync(aside, lockPath); // fails with EEXIST rather than overwriting a newer lock
    restored = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const competitor = holderPidOf(moved);
  const liveCompetitor = competitor !== null && isAlive(competitor);
  if (restored || !liveCompetitor) rmSync(aside, { force: true });
  if (liveCompetitor) throw new DuplicateDispatchError(identity, competitor);
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
    let staleBody: string;
    try {
      staleBody = readFileSync(lockPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // released meanwhile: retry the create
      throw err;
    }
    const holder = holderPidOf(staleBody);
    if (holder !== null && isAlive(holder)) throw new DuplicateDispatchError(identity, holder);
    opts.onStaleRead?.();
    reclaimStaleLock(lockPath, staleBody, identity, isAlive); // stale: reclaim, then retry the exclusive create
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
