/**
 * serve-lock.spec.ts — unit coverage for `acquireServeLock`/`ServeLockHeldError`
 * (docs/spec/service-lifecycle.md `[inv:singleton]`, sox-ecosystem). The real
 * multi-process red→green proof (two genuine `backlog serve` subprocesses
 * racing the same store) lives in `../serve.singleton.spec.ts` — this file
 * proves the primitive's own edge cases in-process, fast, without paying for
 * a subprocess spawn per case: live-holder refusal names the correct pid,
 * stale (dead-holder) reclaim, idempotent/non-destructive release, and the
 * `:memory:` exemption.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireServeLock,
  canonicalDbPath,
  forceReleaseServeLock,
  inspectServeLock,
  isLockableDbPath,
  serveLockPath,
  ServeLockHeldError,
} from './serve-lock.js';

describe('isLockableDbPath', () => {
  it('excludes ":memory:" (no filesystem identity, no cross-process concern)', () => {
    expect(isLockableDbPath(':memory:')).toBe(false);
  });
  it('includes a real file path', () => {
    expect(isLockableDbPath('/tmp/whatever/backlog.db')).toBe(true);
  });
});

describe('acquireServeLock', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('a fresh dbPath acquires cleanly and writes this process\' own pid into the lock file', () => {
    dir = mkdtempSync(join(tmpdir(), 'serve-lock-'));
    const dbPath = join(dir, 'backlog.db');
    const handle = acquireServeLock(dbPath);
    try {
      const lockPath = serveLockPath(dbPath);
      expect(existsSync(lockPath)).toBe(true);
      const firstLine = readFileSync(lockPath, 'utf8').split('\n')[0];
      expect(Number(firstLine)).toBe(process.pid);
    } finally {
      handle.release();
    }
  });

  it('a second acquire against the SAME store while a live holder exists throws ServeLockHeldError naming that holder\'s pid (the primitive behind server.ts\'s singleton guard — see serve.singleton.spec.ts for the full two-subprocess red→green proof)', () => {
    dir = mkdtempSync(join(tmpdir(), 'serve-lock-'));
    const dbPath = join(dir, 'backlog.db');
    const first = acquireServeLock(dbPath);
    try {
      let caught: unknown;
      try {
        acquireServeLock(dbPath);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ServeLockHeldError);
      const err = caught as ServeLockHeldError;
      expect(err.holderPid).toBe(process.pid);
      expect(err.message).toContain(String(process.pid));
      expect(err.message).toMatch(/refusing to start/);
    } finally {
      first.release();
    }
  });

  it('release() then a fresh acquire succeeds (lock is not permanently held)', () => {
    dir = mkdtempSync(join(tmpdir(), 'serve-lock-'));
    const dbPath = join(dir, 'backlog.db');
    const first = acquireServeLock(dbPath);
    first.release();
    const second = acquireServeLock(dbPath);
    expect(existsSync(serveLockPath(dbPath))).toBe(true);
    second.release();
    expect(existsSync(serveLockPath(dbPath))).toBe(false);
  });

  it('release() is idempotent — calling it twice does not throw', () => {
    dir = mkdtempSync(join(tmpdir(), 'serve-lock-'));
    const dbPath = join(dir, 'backlog.db');
    const handle = acquireServeLock(dbPath);
    handle.release();
    expect(() => handle.release()).not.toThrow();
  });

  it('a lock file whose recorded pid is dead is reclaimed automatically (crash recovery — no manual intervention needed)', () => {
    dir = mkdtempSync(join(tmpdir(), 'serve-lock-'));
    const dbPath = join(dir, 'backlog.db');
    const lockPath = serveLockPath(dbPath);
    // A pid outside any plausible live range on this machine — deterministic,
    // avoids a real-pid-reuse flake from spawning and waiting on a child.
    const deadPid = 999999;
    writeFileSync(lockPath, `${deadPid}\n${new Date().toISOString()}\n`);

    const handle = acquireServeLock(dbPath); // must NOT throw — stale lock reclaimed
    try {
      const firstLine = readFileSync(lockPath, 'utf8').split('\n')[0];
      expect(Number(firstLine)).toBe(process.pid); // this process now owns it
    } finally {
      handle.release();
    }
  });

  it('a malformed/unparseable lock file is treated as stale and reclaimed', () => {
    dir = mkdtempSync(join(tmpdir(), 'serve-lock-'));
    const dbPath = join(dir, 'backlog.db');
    const lockPath = serveLockPath(dbPath);
    writeFileSync(lockPath, 'not-a-pid\ngarbage\n');
    const handle = acquireServeLock(dbPath);
    handle.release();
  });

  it('release() never deletes a lock now owned by a DIFFERENT process (no cross-process clobber)', () => {
    dir = mkdtempSync(join(tmpdir(), 'serve-lock-'));
    const dbPath = join(dir, 'backlog.db');
    const handle = acquireServeLock(dbPath);
    const lockPath = serveLockPath(dbPath);
    // Simulate another process having legitimately taken over the lock file
    // (e.g. this handle's owner hung past a caller-side timeout and lost
    // ownership before finally calling release()).
    writeFileSync(lockPath, `424242\n${new Date().toISOString()}\n`);
    handle.release();
    expect(existsSync(lockPath)).toBe(true);
    const firstLine = readFileSync(lockPath, 'utf8').split('\n')[0];
    expect(firstLine).toBe('424242');
  });
});

describe('inspectServeLock', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reports exists:false for a dbPath with no lock file at all', () => {
    dir = mkdtempSync(join(tmpdir(), 'serve-lock-status-'));
    const dbPath = join(dir, 'backlog.db');
    const status = inspectServeLock(dbPath);
    expect(status).toEqual({ dbPath, lockPath: serveLockPath(dbPath), exists: false, holderPid: null, alive: false, lockedAt: null, stale: false });
  });

  it('reports a live holder (this process itself) as exists + alive + not stale', () => {
    dir = mkdtempSync(join(tmpdir(), 'serve-lock-status-'));
    const dbPath = join(dir, 'backlog.db');
    const handle = acquireServeLock(dbPath);
    try {
      const status = inspectServeLock(dbPath);
      expect(status.exists).toBe(true);
      expect(status.holderPid).toBe(process.pid);
      expect(status.alive).toBe(true);
      expect(status.stale).toBe(false);
      expect(status.lockedAt).not.toBeNull();
    } finally {
      handle.release();
    }
  });

  it('reports a dead-pid lock file as exists + NOT alive + stale, without reclaiming it (read-only)', () => {
    dir = mkdtempSync(join(tmpdir(), 'serve-lock-status-'));
    const dbPath = join(dir, 'backlog.db');
    const lockPath = serveLockPath(dbPath);
    const deadPid = 999999;
    writeFileSync(lockPath, `${deadPid}\n2020-01-01T00:00:00.000Z\n`);
    const status = inspectServeLock(dbPath);
    expect(status).toEqual({ dbPath, lockPath, exists: true, holderPid: deadPid, alive: false, lockedAt: '2020-01-01T00:00:00.000Z', stale: true });
    // Read-only: the file must still be there afterward.
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe('forceReleaseServeLock', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('no-ops (released:false) when no lock file exists', () => {
    dir = mkdtempSync(join(tmpdir(), 'serve-lock-force-'));
    const dbPath = join(dir, 'backlog.db');
    expect(forceReleaseServeLock(dbPath)).toEqual({ released: false, wasAlive: false, holderPid: null });
  });

  it('removes a dead-holder (stale) lock without needing force:true', () => {
    dir = mkdtempSync(join(tmpdir(), 'serve-lock-force-'));
    const dbPath = join(dir, 'backlog.db');
    const lockPath = serveLockPath(dbPath);
    writeFileSync(lockPath, `999999\n${new Date().toISOString()}\n`);
    const result = forceReleaseServeLock(dbPath);
    expect(result).toEqual({ released: true, wasAlive: false, holderPid: 999999 });
    expect(existsSync(lockPath)).toBe(false);
  });

  it('refuses a genuinely LIVE holder without force:true — throws ServeLockHeldError, lock file untouched', () => {
    dir = mkdtempSync(join(tmpdir(), 'serve-lock-force-'));
    const dbPath = join(dir, 'backlog.db');
    const handle = acquireServeLock(dbPath);
    try {
      let caught: unknown;
      try {
        forceReleaseServeLock(dbPath);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ServeLockHeldError);
      expect((caught as ServeLockHeldError).holderPid).toBe(process.pid);
      expect(existsSync(serveLockPath(dbPath))).toBe(true);
    } finally {
      handle.release();
    }
  });

  it('force:true removes a genuinely LIVE holder\'s lock anyway — the deliberate override', () => {
    dir = mkdtempSync(join(tmpdir(), 'serve-lock-force-'));
    const dbPath = join(dir, 'backlog.db');
    const handle = acquireServeLock(dbPath);
    const result = forceReleaseServeLock(dbPath, { force: true });
    expect(result).toEqual({ released: true, wasAlive: true, holderPid: process.pid });
    expect(existsSync(serveLockPath(dbPath))).toBe(false);
    // Cleanup: the handle no longer owns anything real on disk, but release()
    // must still not throw (idempotent-safe even after an external force-clear).
    expect(() => handle.release()).not.toThrow();
  });
});

describe('canonicalDbPath / serveLockPath', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('a relative and an absolute spelling of the same not-yet-created path collapse to the same lock path', () => {
    dir = mkdtempSync(join(tmpdir(), 'serve-lock-canon-'));
    const dbPath = join(dir, 'backlog.db');
    const relative = join(dir, '.', 'backlog.db');
    expect(serveLockPath(dbPath)).toBe(serveLockPath(relative));
  });

  it('appends ".serve.lock" to the canonical db path', () => {
    dir = mkdtempSync(join(tmpdir(), 'serve-lock-canon-'));
    const dbPath = join(dir, 'backlog.db');
    expect(serveLockPath(dbPath)).toBe(`${canonicalDbPath(dbPath)}.serve.lock`);
  });
});
