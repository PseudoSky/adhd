/**
 * Shared test-fixture helpers for `environment-core-node`'s DoD suites.
 *
 * Two distinct kinds of scratch directory are needed, and they are NOT
 * interchangeable:
 *
 *  - `mkAdhdRoot()` — a plain scratch directory used as `EnvironmentOptions
 *    .adhdRoot` / a project root's on-disk contents (config.yaml, written
 *    snapshots, lockfiles, ...). Lives under this repo's canonical `tmp/`
 *    root per AGENTS.md §10 ("one canonical root: tmp/").
 *
 *  - `mkCwdFixture()` — a directory used as `EnvironmentOptions.cwd` for a
 *    test that exercises project-MARKER auto-detection
 *    (`.git`/`.adhd`/`adhd.environment.yaml` — see `resolveScope`/
 *    `findProjectRoot` in `@adhd/environment-builder`). This one MUST live
 *    outside this repo's own working tree: this repo IS a git repo, so any
 *    path under `<repo>/tmp/...` has the monorepo's own `.git` a few
 *    directories up, and a "no marker" test would spuriously find it,
 *    while a "the nearest marker wins" test could accidentally match the
 *    wrong one. `os.tmpdir()` (e.g. macOS `/var/folders/.../T/`) is a
 *    system scratch location with no git ancestor, so it is the only
 *    correct location for a cwd fixture that must genuinely have "no
 *    marker" — this is a deliberate, narrowly-scoped exception to the
 *    tmp/-root convention, made because both constraints cannot be
 *    simultaneously satisfied for this one purpose. Every fixture (both
 *    kinds) is deterministically removed in the calling test's `afterEach`.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_TMP_ROOT = join(__dirname, '..', '..', '..', '..', '..', 'tmp', 'environment');

const cleanupDirs: string[] = [];

/** Scratch directory under this repo's canonical `tmp/environment/` root. */
export function mkAdhdRoot(prefix = 'root-'): string {
  mkdirSync(REPO_TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(REPO_TMP_ROOT, prefix));
  cleanupDirs.push(dir);
  return dir;
}

/** Scratch directory OUTSIDE this repo's git working tree — see the module
 *  header for why this is the one legitimate exception to the tmp/ convention. */
export function mkCwdFixture(prefix = 'cwd-'): string {
  const dir = mkdtempSync(join(tmpdir(), `adhd-env-${prefix}`));
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

/** Snapshots the current value of `name` in `process.env`, returning a
 *  restore function. Use in `beforeEach`/`afterEach` around any test that
 *  sets/deletes a real env var (the live-getter DoD proofs read REAL
 *  `process.env`, not an injectable map — by design, matching production). */
export function withEnvVar(name: string, value: string | undefined): () => void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}
