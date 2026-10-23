/**
 * Shared test-fixture helpers for `agent-core-env`'s test suite.
 *
 * `mkAdhdRoot()` sandboxes `EnvironmentOptions.adhdRoot` (the documented
 * test-isolation escape hatch — see `@adhd/environment`'s own
 * `test/fixtures.ts`) so a scope-pin/canonical-default test never touches
 * the real machine's `~/.adhd`. Lives under this repo's canonical `tmp/`
 * root per AGENTS.md §10 ("one canonical root: tmp/").
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const REPO_TMP_ROOT = join(__dirname, '..', '..', '..', '..', '..', 'tmp', 'agent-core-env');

const cleanupDirs: string[] = [];

/** Scratch directory under this repo's canonical `tmp/agent-core-env/` root. */
export function mkAdhdRoot(prefix = 'root-'): string {
  mkdirSync(REPO_TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(REPO_TMP_ROOT, prefix));
  cleanupDirs.push(dir);
  return dir;
}

/** Removes every fixture directory created via this module since the last
 *  call — deterministic, bounded, no sleeps. Call from `afterEach`. */
export function cleanupFixtures(): void {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

const LEGACY_ENV_VARS = [
  'ADHD_AGENT_REGISTRY_DB_PATH',
  'REGISTRY_DATABASE_PATH',
  'DATABASE_PATH',
  'ADHD_ENV_SCOPE',
] as const;

/** Snapshot + clear every env var this test suite touches, returning a
 *  restore function. Prevents cross-test / cross-file pollution without
 *  relying on vitest's env-var reset (which doesn't apply to `process.env`
 *  mutated mid-test). */
export function snapshotRegistryEnvVars(): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const name of LEGACY_ENV_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  return () => {
    for (const name of LEGACY_ENV_VARS) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
