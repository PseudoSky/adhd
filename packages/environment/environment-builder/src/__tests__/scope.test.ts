import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { findProjectRoot, resolveScope } from '../scope';

// `findProjectRoot` walks upward looking for `.git`/`.adhd`/`adhd.environment.yaml`.
// Fixture directories MUST live outside this repo's own working tree
// (which is itself a git repo) — otherwise "no marker" cases would
// spuriously find the monorepo's own `.git` a few levels up. Cleaned up
// deterministically in `afterEach` (bounded, no sleeps).
const cleanupDirs: string[] = [];
function mkFixtureDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('findProjectRoot', () => {
  it('returns undefined when no marker exists between cwd and the filesystem root', () => {
    const bare = mkFixtureDir('adhd-env-scope-nomarker-');
    expect(findProjectRoot(bare)).toBeUndefined();
  });

  it('finds a `.git` marker at the exact cwd', () => {
    const root = mkFixtureDir('adhd-env-scope-git-');
    mkdirSync(join(root, '.git'));
    expect(findProjectRoot(root)).toBe(root);
  });

  it('finds a `.adhd` marker at an ancestor of a nested cwd', () => {
    const root = mkFixtureDir('adhd-env-scope-adhd-');
    mkdirSync(join(root, '.adhd'));
    const nested = join(root, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(root);
  });

  it('finds an `adhd.environment.yaml` marker file (not just directories)', () => {
    const root = mkFixtureDir('adhd-env-scope-yaml-');
    writeFileSync(join(root, 'adhd.environment.yaml'), 'project: {}\n');
    expect(findProjectRoot(root)).toBe(root);
  });

  it('a marker at a deeper cwd wins over one further up (closest match)', () => {
    const outer = mkFixtureDir('adhd-env-scope-nested-');
    mkdirSync(join(outer, '.git'));
    const inner = join(outer, 'inner');
    mkdirSync(inner);
    mkdirSync(join(inner, '.adhd'));
    expect(findProjectRoot(inner)).toBe(inner);
  });
});

describe('resolveScope', () => {
  it('step 1: explicit options.scope short-circuits auto-detection entirely', () => {
    const bare = mkFixtureDir('adhd-env-scope-explicit-');
    const result = resolveScope({ scope: 'global', cwd: bare }, {});
    expect(result.scope).toBe('global');
    expect(result.projectRoot).toBeUndefined();
  });

  it('step 1 (project): explicit scope with no marker falls back to cwd as the project root', () => {
    const bare = mkFixtureDir('adhd-env-scope-explicit-project-');
    const result = resolveScope({ scope: 'project', cwd: bare }, {});
    expect(result.scope).toBe('project');
    expect(result.projectRoot).toBe(bare);
  });

  it('step 2: ADHD_ENV_SCOPE env var wins over auto-detection when options.scope is absent', () => {
    const root = mkFixtureDir('adhd-env-scope-envvar-');
    mkdirSync(join(root, '.git'));
    const result = resolveScope({ cwd: root }, { ADHD_ENV_SCOPE: 'global' });
    expect(result.scope).toBe('global');
  });

  it('step 2: ADHD_ENV_SCOPE=project uses the discovered marker root', () => {
    const root = mkFixtureDir('adhd-env-scope-envvar-project-');
    mkdirSync(join(root, '.git'));
    const nested = join(root, 'sub');
    mkdirSync(nested);
    const result = resolveScope({ cwd: nested }, { ADHD_ENV_SCOPE: 'project' });
    expect(result.scope).toBe('project');
    expect(result.projectRoot).toBe(root);
  });

  it('an invalid ADHD_ENV_SCOPE value is ignored, falling through to auto-detection', () => {
    const bare = mkFixtureDir('adhd-env-scope-invalidenv-');
    const result = resolveScope({ cwd: bare }, { ADHD_ENV_SCOPE: 'not-a-real-scope' });
    expect(result.scope).toBe('global');
  });

  it('step 3 auto: a project marker found at/above cwd resolves to project scope', () => {
    const root = mkFixtureDir('adhd-env-scope-auto-project-');
    mkdirSync(join(root, '.adhd'));
    const result = resolveScope({ cwd: root }, {});
    expect(result.scope).toBe('project');
    expect(result.projectRoot).toBe(root);
  });

  it('step 3 auto: no marker anywhere resolves to global scope — this is the zero-config default', () => {
    const bare = mkFixtureDir('adhd-env-scope-auto-global-');
    const result = resolveScope({ cwd: bare }, {});
    expect(result.scope).toBe('global');
    expect(result.projectRoot).toBeUndefined();
  });
});
