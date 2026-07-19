/**
 * DoD §7.6 — Multi-instance proof (ARCHITECTURE.md).
 *
 * Two instances get distinct `env.paths.logs` (per-instance share default).
 * `env.lock('singleton')` on the 2nd throws while the 1st holds it —
 * deterministic (an atomic exclusive-create lockfile), never timing-based.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Environment, LockHeldError } from '../environment';
import { cleanupFixtures, mkAdhdRoot, mkCwdFixture } from '../test/fixtures';

type Cfg = Record<string, never>;
const SPEC = { config: {}, dirs: { data: { kind: 'data' as const }, logs: { kind: 'logs' as const } } };

afterEach(() => {
  cleanupFixtures();
});

describe('DoD §7.6 — multi-instance collision policy', () => {
  it('two instances of the SAME spec/root get distinct env.paths.logs (per-instance default)', () => {
    const adhdRoot = mkAdhdRoot();
    const cwd = mkCwdFixture();
    const a = new Environment<Cfg>('t', SPEC, { scope: 'global', adhdRoot, cwd });
    const b = new Environment<Cfg>('t', SPEC, { scope: 'global', adhdRoot, cwd });

    expect(a.instanceId).not.toBe(b.instanceId);
    expect(a.paths.logs).not.toBe(b.paths.logs);
  });

  it('two instances get the SAME env.paths.data (shared default) — the contrast that proves "logs" specifically is per-instance, not everything', () => {
    const adhdRoot = mkAdhdRoot();
    const cwd = mkCwdFixture();
    const a = new Environment<Cfg>('t', SPEC, { scope: 'global', adhdRoot, cwd });
    const b = new Environment<Cfg>('t', SPEC, { scope: 'global', adhdRoot, cwd });

    expect(a.paths.data).toBe(b.paths.data);
  });

  it('env.lock("singleton") on a second instance throws (LockHeldError) while the first holds it — deterministic, no sleep', () => {
    const adhdRoot = mkAdhdRoot();
    const cwd = mkCwdFixture();
    const first = new Environment<Cfg>('t', SPEC, { scope: 'global', adhdRoot, cwd });
    const second = new Environment<Cfg>('t', SPEC, { scope: 'global', adhdRoot, cwd });

    const release = first.lock('singleton');
    try {
      expect(() => second.lock('singleton')).toThrow(LockHeldError);
    } finally {
      release();
    }
  });

  it('after the first instance releases the lock, the second CAN acquire it — proves release() actually unlocks, not just that acquisition is exclusive', () => {
    const adhdRoot = mkAdhdRoot();
    const cwd = mkCwdFixture();
    const first = new Environment<Cfg>('t', SPEC, { scope: 'global', adhdRoot, cwd });
    const second = new Environment<Cfg>('t', SPEC, { scope: 'global', adhdRoot, cwd });

    const release = first.lock('singleton');
    release();
    expect(() => second.lock('singleton')).not.toThrow();
  });

  it('two independently-named locks do not contend with each other', () => {
    const adhdRoot = mkAdhdRoot();
    const cwd = mkCwdFixture();
    const env = new Environment<Cfg>('t', SPEC, { scope: 'global', adhdRoot, cwd });
    const releaseA = env.lock('lock-a');
    expect(() => env.lock('lock-b')).not.toThrow();
    releaseA();
  });

  it('lock() creates a lockfile under the (zero-config, undeclared) run directory fallback, and release() removes it', () => {
    const adhdRoot = mkAdhdRoot();
    const cwd = mkCwdFixture();
    const env = new Environment<Cfg>('t', SPEC, { scope: 'global', adhdRoot, cwd });
    // No `run`-kind dir is declared in SPEC — lock() must still work zero-config,
    // falling back to `<dirname(snapshotPath)>/run/<name>.lock`.
    const expectedLockPath = join(dirname(env.snapshotPath), 'run', 'singleton.lock');

    const release = env.lock('singleton');
    expect(existsSync(expectedLockPath)).toBe(true);

    release();
    expect(existsSync(expectedLockPath)).toBe(false);
  });
});
