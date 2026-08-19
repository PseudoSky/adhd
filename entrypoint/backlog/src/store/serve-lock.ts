/**
 * serve-lock.ts — `[inv:singleton]` for `backlog serve` (sox-ecosystem
 * docs/spec/service-lifecycle.md §5). Mirrors the proven O_EXCL PID-file
 * pattern in that repo's `libs/host-runtime/src/lock.ts` (`acquireStartLock`)
 * — this package cannot import it directly (`backlog` is a standalone
 * `@adhd/backlog` npm package built from a separate repo,
 * `/Users/nix/dev/node/adhd/entrypoint/backlog`; `host-runtime` is
 * sox-ecosystem's own `area:platform` layer and is not published), so the
 * same primitive is reimplemented here, scoped to backlog's own concern:
 * the backing SQLite/turso file, not a sox scope+root.
 *
 * Incident this closes: two concurrently-running `backlog serve --transport
 * mcp` processes writing the SAME store corrupted `~/.adhd/backlog/production/
 * data/backlog.db` (upstream race tursodatabase/turso#7833 / #8348 — open on
 * every released line). `memory-server` never corrupts under the identical
 * substrate/race because it is a supervised OS-unit singleton; `backlog
 * serve` had no supervision at all — any shell could spawn a second instance
 * against the same file, and one did (two stray wrapper shells observed
 * mid-incident). This is the guard that makes that impossible again.
 *
 * The lock is keyed on the CANONICAL (realpath'd, so a symlink/`..`/relative
 * spelling collapses to one identity) absolute db path — the same anchor
 * `docs/spec/service-lifecycle.md`'s `[def:singleton-key]` uses (§4.3): "one
 * writer per backing store", not "one process per scope". `:memory:` (test
 * fixtures never used with `serve`; the turso adapter's multiprocess WAL
 * cannot open it anyway — `graph-backlog-store.spec.ts`'s own doc comment)
 * is exempt: no cross-process concern exists for a path with no filesystem
 * identity.
 *
 * Shutdown-window coverage: the lock is acquired BEFORE the store opens and
 * released ONLY after the store is fully closed (see `server.ts`'s
 * `closeStoreOnce`), not merely on receipt of SIGTERM/SIGINT. A second
 * `serve` attempted while the first is still draining (mid-shutdown, store
 * not yet closed) sees the lock file present with a still-alive holder pid
 * and is refused — exactly the window a start-only guard would miss.
 */
import { openSync, closeSync, writeSync, unlinkSync, readFileSync, realpathSync, existsSync, constants as fsConstants } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Thrown when another live process already holds the serve lock for this
 *  store. Carries the holder's pid and the lock file path so callers can
 *  surface both — refusing SILENTLY (a bare non-zero exit with no reason)
 *  is exactly the failure mode that let this incident go undetected. */
export class ServeLockHeldError extends Error {
  readonly holderPid: number;
  readonly lockPath: string;
  constructor(holderPid: number, lockPath: string) {
    super(
      `backlog serve: refusing to start — another "backlog serve" instance ` +
      `(pid ${holderPid}) already holds the writer lock for this store ` +
      `(${lockPath}). Two concurrent servers against the same store is the ` +
      `exact condition that corrupted this database before (upstream turso ` +
      `race tursodatabase/turso#7833/#8348). Stop the other instance first, ` +
      `or if you are certain pid ${holderPid} is gone, remove the stale lock: ${lockPath}`
    );
    this.name = 'ServeLockHeldError';
    this.holderPid = holderPid;
    this.lockPath = lockPath;
  }
}

export interface ServeLockHandle {
  /** Idempotent. Removes the lock file ONLY if it still names this process
   *  as holder (never deletes a lock a later process legitimately took over
   *  after detecting this one as stale — that would delete a live peer's
   *  lock out from under it). */
  release: () => void;
}

/** `:memory:` has no filesystem identity — no cross-process concern, no lock. */
export function isLockableDbPath(dbPath: string): boolean {
  return dbPath !== ':memory:';
}

/** Canonicalizes to the realpath when the file (or its parent dir) exists,
 *  so two spellings of the same store collapse to one lock identity; falls
 *  back to a plain absolute resolve when nothing on disk exists yet (a
 *  not-yet-created db is still a valid lock anchor — mirrors sox-ecosystem's
 *  `singleton.ts` `canonicalizePath`, reimplemented here for the same reason
 *  noted in this file's header). */
export function canonicalDbPath(dbPath: string): string {
  const abs = resolve(dbPath);
  if (existsSync(abs)) {
    try {
      return realpathSync(abs);
    } catch {
      return abs;
    }
  }
  const dir = dirname(abs);
  if (existsSync(dir)) {
    try {
      return resolve(realpathSync(dir), abs.slice(dir.length + 1));
    } catch {
      return abs;
    }
  }
  return abs;
}

export function serveLockPath(dbPath: string): string {
  return `${canonicalDbPath(dbPath)}.serve.lock`;
}

function readLockPid(lockPath: string): number | null {
  try {
    const firstLine = readFileSync(lockPath, 'utf8').split('\n', 1)[0] ?? '';
    const pid = Number.parseInt(firstLine, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeLockFile(lockPath: string): void {
  const fd = openSync(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
  } finally {
    closeSync(fd);
  }
}

/**
 * Acquire the `backlog serve` writer lock for `dbPath`. Fails LOUD and
 * IMMEDIATELY (no spin-wait/retry-until-timeout — a refused `serve` should
 * say why right now, not silently poll and eventually give up) when a live
 * holder is found: throws {@link ServeLockHeldError} naming the holder's
 * pid. A lock file whose recorded pid is no longer alive (crash, SIGKILL,
 * native panic — the same "can't run cleanup code" cases
 * `signal-cleanup.ts`'s own doc comment is honest about) is detected via a
 * liveness probe on READ, not relied on to have been cleaned up by the dead
 * process, and is reclaimed automatically.
 *
 * Call this BEFORE opening the store; release the returned handle only
 * AFTER the store is fully closed (see this file's header re: the
 * shutdown-window).
 */
export function acquireServeLock(dbPath: string): ServeLockHandle {
  const lockPath = serveLockPath(dbPath);

  const tryCreate = (): 'created' | 'exists' => {
    try {
      writeLockFile(lockPath);
      return 'created';
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
      throw err;
    }
  };

  if (tryCreate() === 'created') {
    return makeHandle(lockPath);
  }

  // A lock file exists — is its holder actually alive?
  const holderPid = readLockPid(lockPath);
  if (holderPid !== null && isAlive(holderPid)) {
    throw new ServeLockHeldError(holderPid, lockPath);
  }

  // Stale (holder dead, or the file was unreadable/malformed) — reclaim it.
  // One retry only: if a concurrent process wins the reclaim race, its
  // holder is alive by construction (it just created the file), so this
  // correctly reports THAT pid rather than looping.
  try {
    unlinkSync(lockPath);
  } catch {
    // Lost the unlink race to a concurrent reclaimer — fall through to retry.
  }
  if (tryCreate() === 'created') {
    return makeHandle(lockPath);
  }
  const raceHolderPid = readLockPid(lockPath);
  throw new ServeLockHeldError(raceHolderPid ?? -1, lockPath);
}

function makeHandle(lockPath: string): ServeLockHandle {
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try {
        // Only remove if this process still owns it — never delete a lock a
        // later process legitimately took over after reclaiming this one as
        // stale (e.g. this process hung past a caller-side timeout and lost
        // ownership before finally calling release()).
        if (readLockPid(lockPath) === process.pid) unlinkSync(lockPath);
      } catch {
        // Best-effort: an unreadable/already-gone lock file is not an error
        // for the releasing side — the invariant it protected already holds
        // (either the file is gone, or it is not this process' own record).
      }
    },
  };
}
