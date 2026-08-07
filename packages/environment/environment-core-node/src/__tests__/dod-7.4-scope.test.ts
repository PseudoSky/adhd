/**
 * DoD §7.4 — Scope proof (ARCHITECTURE.md).
 *
 * `ADHD_ENV_SCOPE=project` + a temp project root → `env.paths.data` is
 * under `<projectRoot>/.adhd/...`; unset + no marker → under `~/.adhd/...`.
 *
 * The "no marker" case below sandboxes the `global`-scope root via
 * `EnvironmentOptions.adhdRoot` — the mechanism ARCHITECTURE.md §3.1
 * explicitly documents for this ("primarily for test isolation") — rather
 * than mutating `process.env.HOME`: Node's `os.homedir()` is backed by a
 * libuv/native call that, under Vitest's default worker-`threads` pool,
 * does NOT observe a JS-side `process.env.HOME` mutation (worker threads
 * get a virtualized `process.env` that isn't propagated to native env
 * lookups) — so a `HOME`-mutation-based test would be flaky/host-dependent
 * by construction, not a deterministic proof. The real "os.homedir() is the
 * zero-config global root, and it honors $HOME" behavior is proven directly
 * (main-thread, no worker-pool concern) in
 * `environment-builder/src/__tests__/roots.test.ts`.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Environment } from '../environment';
import { cleanupFixtures, mkAdhdRoot, mkCwdFixture, withEnvVar } from '../test/fixtures';

type Cfg = { a: { port: number } };
const SPEC = { config: { 'a.port': { type: 'integer' as const, default: 1 } }, dirs: { data: { kind: 'data' as const } } };

afterEach(() => {
  cleanupFixtures();
});

describe('DoD §7.4 — scope resolution controls the paths root', () => {
  it('ADHD_ENV_SCOPE=project + a discovered project root → env.paths.data is under <projectRoot>/.adhd/...', () => {
    const projectRoot = mkCwdFixture();
    mkdirSync(join(projectRoot, '.git')); // project marker
    const restoreScope = withEnvVar('ADHD_ENV_SCOPE', 'project');
    try {
      const env = new Environment<Cfg>('t', SPEC, { cwd: projectRoot });
      expect(env.scope).toBe('project');
      expect(env.paths.data).toBe(join(projectRoot, '.adhd', 't', 'default', 'data'));
      expect(env.paths.data.startsWith(projectRoot)).toBe(true);
    } finally {
      restoreScope();
    }
  });

  it('no ADHD_ENV_SCOPE and no marker at cwd → resolves to global scope, rooted under the (sandboxed) home root', () => {
    const sandboxedHome = mkAdhdRoot('home-'); // stands in for `~/.adhd`'s base via the sanctioned adhdRoot override
    const bareCwd = mkCwdFixture('cwd-'); // genuinely marker-free cwd — auto-detection must find nothing
    const restoreScope = withEnvVar('ADHD_ENV_SCOPE', undefined);
    try {
      const env = new Environment<Cfg>('t', SPEC, { cwd: bareCwd, adhdRoot: sandboxedHome });
      expect(env.scope).toBe('global');
      expect(env.paths.data).toBe(join(sandboxedHome, 't', 'default', 'data'));
    } finally {
      restoreScope();
    }
  });

  it('negative control: without ADHD_ENV_SCOPE=project, the very same cwd with a marker resolves to project ONLY via auto-detection — proves scope truly drives the root, not the marker directory alone', () => {
    const projectRoot = mkCwdFixture();
    mkdirSync(join(projectRoot, '.adhd'));
    const restoreScope = withEnvVar('ADHD_ENV_SCOPE', undefined);
    try {
      // No explicit scope, no env var — auto-detection still finds the marker and resolves 'project'.
      const env = new Environment<Cfg>('t', SPEC, { cwd: projectRoot });
      expect(env.scope).toBe('project');
      expect(env.paths.data).toBe(join(projectRoot, '.adhd', 't', 'default', 'data'));
    } finally {
      restoreScope();
    }
  });

  it('explicit options.scope="system" overrides auto-detection even when a project marker is present', () => {
    const projectRoot = mkCwdFixture();
    mkdirSync(join(projectRoot, '.git'));
    const env = new Environment<Cfg>('t', SPEC, { cwd: projectRoot, scope: 'system' });
    expect(env.scope).toBe('system');
    expect(env.paths.data.startsWith(projectRoot)).toBe(false);
  });
});
