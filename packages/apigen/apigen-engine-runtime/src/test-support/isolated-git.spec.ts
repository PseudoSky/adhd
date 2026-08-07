/**
 * isolated-git self-test (BUG-APIGEN-052).
 *
 * Proves, with teeth, the git-hook environment-variable-leak escape that let
 * `parity-harness.spec.ts`'s scratch git repo mutate the ENCLOSING real
 * repository — and proves the fix (`runGit` / `assertIsolatedRepoRoot` /
 * `createIsolatedScratchRepo` in `parity-harness.ts`) closes it.
 *
 * PROVEN MECHANISM (reproduced below, not assumed): git exports `GIT_DIR`,
 * `GIT_WORK_TREE`, and `GIT_INDEX_FILE` into every hook invocation
 * (`.githooks/pre-commit` -> `nx affected -t test` -> vitest -> a spawned
 * `git` subprocess). Node's `child_process.execFileSync` inherits
 * `process.env` by default, so those variables ride along silently. They
 * take priority over a bare `cwd` option — `cwd` alone does NOT make git
 * operate on the directory you passed once `GIT_DIR` is set in the
 * environment. The old (pre-fix) harness code was exactly this pattern:
 * `execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' })`.
 *
 * Every test in this file drives REAL `git` subprocesses against REAL,
 * disposable repositories under `os.tmpdir()` — nothing here is mocked.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertIsolatedRepoRoot, createIsolatedScratchRepo, runGit } from './parity-harness';

/** The three variables git sets on hook invocations — the proven leak vector. */
const LEAK_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'] as const;

/**
 * The OLD (pre-BUG-APIGEN-052-fix) unsafe pattern: a bare `cwd` option, full
 * `process.env` inheritance, no `-C`, no env sanitization. Reproduced here
 * ONLY to drive the negative control — production code no longer contains
 * this pattern (see `parity-harness.ts`'s `runGit`).
 */
function unsafeGit(args: readonly string[], cwd: string): string {
  return execFileSync('git', args as string[], { cwd, stdio: 'pipe' }).toString();
}

describe('BUG-APIGEN-052: isolated-git escape mechanism + fix', () => {
  let victimDir: string;

  // Sanitized (GIT_* stripped, -C scoped) — this fixture's OWN setup/teardown
  // must be immune to the SAME leaked-env hazard the test file exists to
  // prove, because it runs for real inside the actual pre-commit hook
  // (`.githooks/pre-commit` -> `nx affected -t test` -> vitest -> this file),
  // which leaks a REAL ambient GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE into the
  // whole test process for the file's entire lifetime — not just during the
  // tests that deliberately simulate a leak. A bare-cwd `execFileSync` here
  // (BUG-APIGEN-ISOLATED-GIT-SELFTEST-001) would let that ambient leak
  // redirect `beforeAll`'s `git init`/`commit` at the ENCLOSING real repo
  // instead of `victimDir`, corrupting it with a stray "victim init" commit
  // — reproduced and fixed after it did exactly that to a live merge
  // worktree. Only `unsafeGit` (used solely inside the negative-control test,
  // deliberately) is allowed to stay unsanitized — that vulnerability is the
  // thing under test there, not an accident.
  function vgit(...args: string[]): string {
    return runGit(args, { cwd: victimDir });
  }

  beforeAll(() => {
    // The "enclosing real repo" a hook would be running in.
    victimDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bug-apigen-052-victim-')));
    vgit('init', '-q');
    vgit('config', 'user.email', 'victim@example.com');
    vgit('config', 'user.name', 'victim');
    fs.writeFileSync(path.join(victimDir, 'tracked.txt'), 'tracked\n');
    vgit('add', 'tracked.txt');
    vgit('commit', '-q', '-m', 'victim init');
  });

  afterAll(() => {
    fs.rmSync(victimDir, { recursive: true, force: true });
  });

  // Every test that leaks env must restore it — never let a leaked GIT_DIR
  // survive into a later test or another suite in the same worker.
  afterEach(() => {
    for (const key of LEAK_VARS) {
      delete process.env[key];
    }
  });

  /** Snapshot of everything a leak could corrupt, for before/after comparison. */
  function victimFingerprint(): { name: string; email: string; log: string; status: string } {
    return {
      name: vgit('config', 'user.name').trim(),
      email: vgit('config', 'user.email').trim(),
      log: vgit('log', '--oneline'),
      status: vgit('status', '--porcelain'),
    };
  }

  it(
    '[negative control] the OLD unsafe pattern DOES corrupt the victim repo under leaked hook env ' +
      '— proves the hazard is real and the regression test below has teeth',
    () => {
      // A concurrent agent's staged-but-uncommitted work in the victim repo.
      fs.writeFileSync(path.join(victimDir, 'concurrent-work.txt'), 'do not commit me\n');
      vgit('add', 'concurrent-work.txt');
      const before = victimFingerprint();
      expect(before.status).toContain('concurrent-work.txt');

      // Exactly the original bug's on-disk layout: the scratch dir NESTED
      // inside the victim's own working tree (findRepoRoot(__dirname)/tmp/…).
      const nestedScratchDir = fs.mkdtempSync(
        path.join(victimDir, 'tmp-nested-scratch-')
      );

      // Simulate the leaked hook environment.
      process.env.GIT_DIR = path.join(victimDir, '.git');
      process.env.GIT_WORK_TREE = victimDir;
      process.env.GIT_INDEX_FILE = path.join(victimDir, '.git', 'index');

      unsafeGit(['init', '-q'], nestedScratchDir);
      unsafeGit(['config', 'user.email', 'parity-harness-self-test@example.com'], nestedScratchDir);
      unsafeGit(['config', 'user.name', 'parity-harness-self-test'], nestedScratchDir);
      fs.writeFileSync(path.join(nestedScratchDir, 'subject.txt'), 'before\n');
      unsafeGit(['add', 'subject.txt'], nestedScratchDir);
      unsafeGit(['commit', '-q', '-m', 'init: subject.txt'], nestedScratchDir);

      for (const key of LEAK_VARS) delete process.env[key];

      const after = victimFingerprint();
      // The victim's identity was overwritten by the "harness".
      expect(after.name).toBe('parity-harness-self-test');
      expect(after.email).toBe('parity-harness-self-test@example.com');
      // A junk commit landed on the victim's real history…
      expect(after.log).toContain('init: subject.txt');
      // …and it SWEPT IN the concurrent agent's staged file (no longer
      // "staged, uncommitted" — it's now part of a commit it never asked for).
      expect(after.status).not.toContain('concurrent-work.txt');
      expect(vgit('show', '--stat', '--format=', 'HEAD')).toContain('concurrent-work.txt');
    }
  );

  it(
    'runGit (env-sanitized, -C scoped) is immune to the SAME leaked env at the SAME nested layout ' +
      '— proves the fix is the env sanitization, not merely tmpdir placement',
    () => {
      fs.writeFileSync(path.join(victimDir, 'concurrent-work-2.txt'), 'do not commit me either\n');
      vgit('add', 'concurrent-work-2.txt');
      const before = victimFingerprint();

      // Deliberately the SAME hazardous nested layout as the negative
      // control above — proving `runGit` alone (not tmpdir separation)
      // is what neutralizes the leak.
      const nestedScratchDir = fs.mkdtempSync(
        path.join(victimDir, 'tmp-nested-scratch-fixed-')
      );

      process.env.GIT_DIR = path.join(victimDir, '.git');
      process.env.GIT_WORK_TREE = victimDir;
      process.env.GIT_INDEX_FILE = path.join(victimDir, '.git', 'index');

      runGit(['init', '-q'], { cwd: nestedScratchDir });
      assertIsolatedRepoRoot(nestedScratchDir);
      runGit(['config', 'user.email', 'harness@example.com'], { cwd: nestedScratchDir });
      runGit(['config', 'user.name', 'parity-harness-self-test'], { cwd: nestedScratchDir });
      fs.writeFileSync(path.join(nestedScratchDir, 'subject.txt'), 'before\n');
      runGit(['add', 'subject.txt'], { cwd: nestedScratchDir });
      // A message distinct from the negative-control test's ('init:
      // subject.txt') — that test legitimately, intentionally commits that
      // exact string into victimDir's real log as part of proving the
      // hazard, so re-using it here would make the "victim log must NOT
      // contain this" assertion below unsatisfiable regardless of whether
      // THIS (fixed) code path leaks anything.
      runGit(['commit', '-q', '-m', 'init: subject.txt (fixed-nested)'], { cwd: nestedScratchDir });

      for (const key of LEAK_VARS) delete process.env[key];

      // And the scratch repo really did receive the commit — isolation, not
      // silent no-op. Verified BEFORE removing nestedScratchDir below.
      expect(
        runGit(['log', '--oneline'], { cwd: nestedScratchDir })
      ).toContain('init: subject.txt (fixed-nested)');

      // nestedScratchDir is a real, separate, isolated git repo nested
      // physically inside victimDir's own working tree — from victimDir's
      // perspective that is an embedded, untracked repo boundary that
      // `git status` reports (a single "?? tmp-nested-scratch-fixed-…/"
      // line). Clean it up before fingerprinting the victim so the "after"
      // snapshot reflects only whether the LEAK affected victimDir, not the
      // mere on-disk presence of an unrelated isolated scratch repo this
      // test itself created inside it.
      fs.rmSync(nestedScratchDir, { recursive: true, force: true });

      const after = victimFingerprint();
      expect(after).toEqual(before);
      expect(after.status).toContain('concurrent-work-2.txt');
      expect(after.log).not.toContain('init: subject.txt (fixed-nested)');
    }
  );

  it(
    'createIsolatedScratchRepo end-to-end stays isolated under the same leaked hook env',
    () => {
      const before = victimFingerprint();

      process.env.GIT_DIR = path.join(victimDir, '.git');
      process.env.GIT_WORK_TREE = victimDir;
      process.env.GIT_INDEX_FILE = path.join(victimDir, '.git', 'index');

      const { dir: scratchDir } = createIsolatedScratchRepo('bug-apigen-052-e2e-');
      runGit(['config', 'user.email', 'harness@example.com'], { cwd: scratchDir });
      runGit(['config', 'user.name', 'parity-harness-self-test'], { cwd: scratchDir });
      fs.writeFileSync(path.join(scratchDir, 'subject.txt'), 'before\n');
      runGit(['add', 'subject.txt'], { cwd: scratchDir });
      runGit(['commit', '-q', '-m', 'init: subject.txt'], { cwd: scratchDir });

      for (const key of LEAK_VARS) delete process.env[key];

      expect(victimFingerprint()).toEqual(before);
      expect(
        runGit(['log', '--oneline'], { cwd: scratchDir })
      ).toContain('init: subject.txt');

      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  );

  it('assertIsolatedRepoRoot throws loudly when the target resolves to a DIFFERENT repo root', () => {
    // A plain subdirectory of the victim repo is not itself a repo root —
    // `git -C <subdir> rev-parse --show-toplevel` resolves to victimDir.
    const subDir = path.join(victimDir, 'not-a-repo-root');
    fs.mkdirSync(subDir);
    expect(() => assertIsolatedRepoRoot(subDir)).toThrow(/isolation violated/);
  });

  it('assertIsolatedRepoRoot throws loudly when the target is not inside any git repo at all', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bug-apigen-052-not-a-repo-'));
    try {
      expect(() => assertIsolatedRepoRoot(outside)).toThrow(/rev-parse --show-toplevel.*failed/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
