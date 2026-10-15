/**
 * process-guard.ts — duplicate-dispatch guard + runaway-child reaper
 * (backlog d794287f D-AC3).
 *
 * 1. `acquireDispatchLock` — a dispatch IDENTITY may be live at most once, across
 *    PROCESSES (this ecosystem is parallel-process enabled: ADR-0012, so an
 *    in-memory Set would be a false guard). The lock is a file whose complete
 *    body (owner pid + token) is written to a unique temp file and then published
 *    at the lock path with a hard link, which fails with EEXIST rather than
 *    overwriting, so a reader never observes a partial body; a lock whose pid is
 *    no longer alive is stale and is reclaimed. A second submission while the first is
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
  /** True when the live holder is the calling process itself (a non-reentrant re-acquire). */
  readonly heldBySelf: boolean;
  constructor(identity: string, holderPid: number, heldBySelf = false) {
    super(
      heldBySelf
        ? `dispatch '${identity}' is already held by this process (pid ${holderPid}) — the dispatch lock is not reentrant; refusing a nested acquisition`
        : `dispatch '${identity}' is already live (held by pid ${holderPid}) — refusing a duplicate submission`
    );
    this.name = 'DuplicateDispatchError';
    this.identity = identity;
    this.holderPid = holderPid;
    this.heldBySelf = heldBySelf;
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
  /** Release the lock. Idempotent; only removes a lock whose body is still the one this handle published. */
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
    return null; // corrupt: treated as stale by the caller
  }
}

const errCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

/**
 * Publish `body` at `lockPath` with its full content already present: the body
 * is written to a unique temp file in the same directory and hard-linked to
 * `lockPath`. `linkSync` never overwrites, so EEXIST means another holder owns
 * the path. A concurrent reader therefore never sees an empty or half-written
 * lock. The temp file is always removed (a hard crash between the write and the
 * removal can leave one `<lock>.tmp.*` file behind).
 * @returns true when this call created the lock, false when the path already exists.
 */
function publishLock(lockPath: string, body: string): boolean {
  const temp = `${lockPath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(temp, body, { flag: 'wx' });
    try {
      linkSync(temp, lockPath);
      return true;
    } catch (err) {
      if (errCode(err) === 'EEXIST') return false;
      throw err;
    }
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * Put a moved-aside lock file back at `lockPath` without overwriting.
 * @returns true when restored, false when `lockPath` already exists (EEXIST).
 * @throws the underlying error for any other failure, after a best-effort
 *   recreate from `content` so the lock content is not lost.
 */
function restoreAside(aside: string, lockPath: string, content: string | null): boolean {
  try {
    linkSync(aside, lockPath);
    return true;
  } catch (err) {
    if (errCode(err) === 'EEXIST') return false;
    if (content !== null) {
      try {
        writeFileSync(lockPath, content, { flag: 'wx' });
      } catch {
        /* best effort: the original error below is the one reported */
      }
    }
    throw err;
  }
}

/** Read `path` as utf8, or `null` when it cannot be read. */
function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Reclaim a stale lock without deleting a competitor's lock.
 *
 * The lock file is first renamed to a unique side name, which removes it from
 * `lockPath` atomically. The side copy is then compared with the stale body the
 * caller read earlier:
 * - identical: it is the stale file, so it is discarded and the caller retries
 *   the create;
 * - different or unreadable: a competitor re-acquired the lock between the stale
 *   read and the rename (an unverified file is never treated as the stale one).
 *   The side copy is hard-linked back to `lockPath` (which never overwrites):
 *   - restored and the competitor is alive: refused with `DuplicateDispatchError`
 *     naming it;
 *   - `lockPath` was re-created by a third process in the rename window (EEXIST):
 *     the CURRENT holder read from `lockPath` is reported when alive; the
 *     displaced competitor is reported only when `lockPath` is unreadable.
 *
 * The side copy is removed on every path (including errors).
 *
 * @throws {DuplicateDispatchError} when the lock belongs to a live holder other than the stale one.
 */
function reclaimStaleLock(
  lockPath: string,
  staleBody: string,
  identity: string,
  selfPid: number,
  isAlive: (pid: number) => boolean
): void {
  const aside = `${lockPath}.reclaim.${process.pid}.${randomBytes(6).toString('hex')}`;
  try {
    renameSync(lockPath, aside);
  } catch (err) {
    if (errCode(err) === 'ENOENT') return; // already gone: caller retries
    throw err;
  }
  try {
    const moved = readOrNull(aside);
    if (moved !== null && moved === staleBody) return; // the stale file: discarded in finally
    const displaced = moved === null ? null : holderPidOf(moved);
    const restored = restoreAside(aside, lockPath, moved);
    if (restored) {
      if (displaced !== null && isAlive(displaced)) throw new DuplicateDispatchError(identity, displaced, displaced === selfPid);
      return;
    }
    // A third process created the lock in the rename window; it owns the path now.
    const currentBody = readOrNull(lockPath);
    const current = currentBody === null ? null : holderPidOf(currentBody);
    if (current !== null) {
      if (isAlive(current)) throw new DuplicateDispatchError(identity, current, current === selfPid);
      return; // current holder is itself stale: caller retries and reclaims it
    }
    if (displaced !== null && isAlive(displaced)) throw new DuplicateDispatchError(identity, displaced, displaced === selfPid);
  } finally {
    rmSync(aside, { force: true });
  }
}

/**
 * Release the lock at `lockPath` only if its body is still exactly `body`.
 * The file is renamed aside first so the compare-and-delete is not a
 * read-then-remove-by-path race: whichever file was moved is the one inspected,
 * and a lock that is not ours is hard-linked back (never overwriting).
 * Errors are swallowed: release runs in `finally` blocks and must not mask the
 * primary error.
 */
function releaseOwned(lockPath: string, body: string): void {
  const aside = `${lockPath}.release.${process.pid}.${randomBytes(6).toString('hex')}`;
  try {
    renameSync(lockPath, aside);
  } catch {
    return; // already gone (or unreachable): nothing to release
  }
  try {
    const moved = readOrNull(aside);
    if (moved === body) return; // ours: discarded in finally
    restoreAside(aside, lockPath, moved); // not ours (we were reclaimed): give it back; EEXIST => its owner was displaced already
  } catch {
    /* best effort: see JSDoc */
  } finally {
    rmSync(aside, { force: true });
  }
}

/**
 * Acquire the live-dispatch lock at `lockPath` for `identity`.
 * The lock is not reentrant: acquiring a lock this same process already holds
 * is refused with a `DuplicateDispatchError` whose `heldBySelf` is true.
 * @throws {DuplicateDispatchError} when a live process already holds it.
 */
export function acquireDispatchLock(lockPath: string, identity: string, opts: AcquireOptions = {}): DispatchLock {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? pidAlive;
  mkdirSync(dirname(lockPath), { recursive: true });
  const body = JSON.stringify({ identity, pid, token: randomBytes(8).toString('hex'), acquiredAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (publishLock(lockPath, body)) {
      let released = false;
      return {
        path: lockPath,
        release() {
          if (released) return;
          released = true;
          releaseOwned(lockPath, body);
        },
      };
    }
    let staleBody: string;
    try {
      staleBody = readFileSync(lockPath, 'utf8');
    } catch (err) {
      if (errCode(err) === 'ENOENT') continue; // released meanwhile: retry the create
      throw err;
    }
    const holder = holderPidOf(staleBody);
    if (holder !== null && isAlive(holder)) throw new DuplicateDispatchError(identity, holder, holder === pid);
    opts.onStaleRead?.();
    reclaimStaleLock(lockPath, staleBody, identity, pid, isAlive); // stale: reclaim, then retry the create
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
