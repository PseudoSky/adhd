/**
 * 515a2b50 SEC-F2 (BK7, plan 9ed453c1) — a sandboxed shell that can write the store's data directory
 * may plant sidecar symlinks/hard links; the unsandboxed store open must never operate through them.
 *
 * Real-component proof: `openGraphBacklogStore` against a real on-disk store with planted links to a
 * victim file. Negative control: without {@link quarantineUnsafeSidecars} the planted `-wal` symlink
 * lets the open truncate the victim (reproduced during development: 7 bytes -> 0).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeGraphBacklogStore, openGraphBacklogStore } from './graph-backlog-store.js';
import { quarantineUnsafeSidecars } from './sidecar-hardening.js';
import { TMP_ROOT } from '../test/helpers/tmp-store.js';

describe('515a2b50 SEC-F2 sidecar hardening', () => {
  let dir = '';
  let dbPath = '';
  let victim = '';
  let victimDir = '';

  beforeEach(() => {
    mkdirSync(TMP_ROOT, { recursive: true });
    dir = mkdtempSync(join(TMP_ROOT, 'sidecar-hardening-'));
    dbPath = join(dir, 'data', 'backlog.db');
    mkdirSync(join(dir, 'data'), { recursive: true });
    victim = join(dir, 'victim.txt');
    victimDir = join(dir, 'victim-dir');
    mkdirSync(victimDir);
    writeFileSync(victim, 'SECRET\n');
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('unlinks symlink sidecars (the link, never the target) and hard-linked ones', () => {
    symlinkSync(victim, `${dbPath}-wal`);
    symlinkSync(victimDir, `${dbPath}.sox-lease.d`);
    writeFileSync(`${dbPath}-journal`, 'x');
    linkSync(`${dbPath}-journal`, join(dir, 'journal-alias'));
    symlinkSync(victim, `${dbPath}-tshm.stale-2026-01-01-0000-1-p1`);
    const removed = quarantineUnsafeSidecars(dbPath);
    expect(removed.map((r) => r.reason).sort()).toEqual(['hardlink', 'symlink', 'symlink', 'symlink']);
    for (const suffix of ['-wal', '.sox-lease.d', '-journal', '-tshm.stale-2026-01-01-0000-1-p1']) {
      expect(() => lstatSync(`${dbPath}${suffix}`)).toThrow();
    }
    expect(readFileSync(victim, 'utf8')).toBe('SECRET\n'); // target untouched
    expect(readFileSync(join(dir, 'journal-alias'), 'utf8')).toBe('x');
  });

  it('leaves real files, real dirs, a symlinked main DB and a missing dir alone', () => {
    writeFileSync(`${dbPath}-wal`, 'real wal');
    mkdirSync(`${dbPath}.sox-lease.d`);
    symlinkSync(victim, dbPath);
    expect(quarantineUnsafeSidecars(dbPath)).toEqual([]);
    expect(readFileSync(`${dbPath}-wal`, 'utf8')).toBe('real wal');
    expect(lstatSync(dbPath).isSymbolicLink()).toBe(true);
    expect(quarantineUnsafeSidecars(join(dir, 'nope', 'x.db'))).toEqual([]);
    expect(quarantineUnsafeSidecars(':memory:')).toEqual([]);
  });

  it('opening the REAL store with a planted -wal symlink leaves the victim file untouched', async () => {
    // Create a real store first so a WAL-bearing DB exists, then plant the symlink in its place.
    await closeGraphBacklogStore(await openGraphBacklogStore(dbPath));
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}.sox-lease.d`, { recursive: true, force: true });
    symlinkSync(victim, `${dbPath}-wal`);
    symlinkSync(victimDir, `${dbPath}.sox-lease.d`);
    const store = await openGraphBacklogStore(dbPath);
    try {
      expect(readFileSync(victim, 'utf8')).toBe('SECRET\n');
      expect(readFileSync(victim).length).toBe(7);
    } finally {
      await closeGraphBacklogStore(store);
    }
    expect(lstatSync(victimDir).isDirectory()).toBe(true);
  });
});
