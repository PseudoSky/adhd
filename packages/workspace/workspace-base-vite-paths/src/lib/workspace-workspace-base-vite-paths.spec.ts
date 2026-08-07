import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  findWorkspaceRoot,
  projectCacheDir,
  projectCoverage,
  projectDist,
  workspaceNodeModules,
} from './workspace-workspace-base-vite-paths';

/**
 * These tests drive the REAL filesystem (real `fs.mkdirSync`/`writeFileSync`/
 * `renameSync`/`rmSync`) against synthetic `nx.json`-rooted directory trees —
 * no mocked `fs`. That is the actual consumer contract: every exported
 * function's sole documented call site is a real `vite.config.ts` reading
 * the real filesystem via its own `__dirname`.
 *
 * Fixture location: per AGENTS.md §10, ephemeral test fixtures write under
 * this repo's own `tmp/`. The one exception is the `findWorkspaceRoot`
 * "throws" negative case below, which needs a directory tree that is
 * genuinely NOT inside any Nx workspace — this repo's own `tmp/` cannot
 * provide that, because walking up from anywhere under `tmp/` eventually
 * reaches the real repo root, which DOES have an `nx.json` above it. That
 * one fixture is built under `os.tmpdir()` instead, and is still removed on
 * teardown.
 */

const REPO_TMP_ROOT = path.join(__dirname, '../../../../../tmp/workspace-base-vite-paths-tests');

function makeSyntheticWorkspace(label: string): { workspaceRoot: string; cleanup: () => void } {
  const workspaceRoot = fs.mkdtempSync(path.join(REPO_TMP_ROOT, `${label}-`));
  fs.writeFileSync(path.join(workspaceRoot, 'nx.json'), '{}');
  return {
    workspaceRoot,
    cleanup: () => fs.rmSync(workspaceRoot, { recursive: true, force: true }),
  };
}

beforeAll(() => {
  fs.mkdirSync(REPO_TMP_ROOT, { recursive: true });
});

afterAll(() => {
  // Remove the whole scratch root, not just per-test dirs — bounded,
  // deterministic cleanup with no leftover artifacts (AGENTS.md §10/§7).
  fs.rmSync(REPO_TMP_ROOT, { recursive: true, force: true });
});

describe('findWorkspaceRoot', () => {
  it('finds the nearest ancestor directory containing nx.json, from a deeply nested package dir', () => {
    const { workspaceRoot, cleanup } = makeSyntheticWorkspace('find-nested');
    try {
      const pkgDir = path.join(workspaceRoot, 'packages', 'domain', 'domain-base-thing');
      fs.mkdirSync(pkgDir, { recursive: true });

      expect(findWorkspaceRoot(pkgDir)).toBe(fs.realpathSync(workspaceRoot));
    } finally {
      cleanup();
    }
  });

  it('resolves correctly when fromDir IS the workspace root itself', () => {
    const { workspaceRoot, cleanup } = makeSyntheticWorkspace('find-at-root');
    try {
      expect(findWorkspaceRoot(workspaceRoot)).toBe(fs.realpathSync(workspaceRoot));
    } finally {
      cleanup();
    }
  });

  it('throws a descriptive error when no nx.json is found before reaching the filesystem root', () => {
    // Genuine isolation from any ancestor nx.json — see file header comment
    // for why this one fixture uses os.tmpdir() instead of the repo's tmp/.
    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-paths-no-workspace-'));
    try {
      expect(() => findWorkspaceRoot(isolatedDir)).toThrow(/nx\.json/);
      expect(() => findWorkspaceRoot(isolatedDir)).toThrow(/filesystem root/);
    } finally {
      fs.rmSync(isolatedDir, { recursive: true, force: true });
    }
  });
});

describe('projectCacheDir', () => {
  it('derives node_modules/.vite/<relative-path> from the workspace root', () => {
    const { workspaceRoot, cleanup } = makeSyntheticWorkspace('cache-dir');
    try {
      const pkgDir = path.join(workspaceRoot, 'packages', 'apigen', 'apigen-core-widget');
      fs.mkdirSync(pkgDir, { recursive: true });

      expect(projectCacheDir(pkgDir)).toBe(
        path.join(fs.realpathSync(workspaceRoot), 'node_modules/.vite/packages/apigen/apigen-core-widget')
      );
    } finally {
      cleanup();
    }
  });
});

describe('projectCoverage', () => {
  it('derives coverage/<relative-path> from the workspace root', () => {
    const { workspaceRoot, cleanup } = makeSyntheticWorkspace('coverage-dir');
    try {
      const pkgDir = path.join(workspaceRoot, 'packages', 'apigen', 'apigen-core-widget');
      fs.mkdirSync(pkgDir, { recursive: true });

      expect(projectCoverage(pkgDir)).toBe(
        path.join(fs.realpathSync(workspaceRoot), 'coverage/packages/apigen/apigen-core-widget')
      );
    } finally {
      cleanup();
    }
  });
});

describe('move-safety (the actual point of this package)', () => {
  it('projectCacheDir and projectCoverage resolve to the NEW location after a real git-mv-style directory move — zero recomputation needed, zero stale value carried over', () => {
    const { workspaceRoot, cleanup } = makeSyntheticWorkspace('move-safety');
    try {
      const oldDir = path.join(workspaceRoot, 'packages', 'apigen', 'apigen-core-widget');
      fs.mkdirSync(oldDir, { recursive: true });

      const cacheDirBeforeMove = projectCacheDir(oldDir);
      const coverageBeforeMove = projectCoverage(oldDir);
      expect(cacheDirBeforeMove).toContain('packages/apigen/apigen-core-widget');
      expect(coverageBeforeMove).toContain('packages/apigen/apigen-core-widget');

      // The real move: `git mv packages/apigen/apigen-core-widget packages/data/data-core-widget`
      const newDir = path.join(workspaceRoot, 'packages', 'data', 'data-core-widget');
      fs.mkdirSync(path.dirname(newDir), { recursive: true });
      fs.renameSync(oldDir, newDir);

      // NEGATIVE CONTROL for this assertion: the bug this package fixes is a
      // literal path string baked into vite.config.ts at scaffold time, which
      // would still equal `cacheDirBeforeMove` (the OLD location) after the
      // move — that is exactly the failure mode this test must catch. Since
      // `projectCacheDir`/`projectCoverage` recompute from `fromDir` on every
      // call rather than memoizing, calling them again with `newDir` MUST
      // reflect the new location, not the old one.
      const cacheDirAfterMove = projectCacheDir(newDir);
      const coverageAfterMove = projectCoverage(newDir);

      expect(cacheDirAfterMove).toBe(
        path.join(fs.realpathSync(workspaceRoot), 'node_modules/.vite/packages/data/data-core-widget')
      );
      expect(coverageAfterMove).toBe(
        path.join(fs.realpathSync(workspaceRoot), 'coverage/packages/data/data-core-widget')
      );
      // The teeth: the new value must differ from the stale pre-move value.
      expect(cacheDirAfterMove).not.toBe(cacheDirBeforeMove);
      expect(coverageAfterMove).not.toBe(coverageBeforeMove);
    } finally {
      cleanup();
    }
  });
});

describe('projectDist', () => {
  it('returns <fromDir>/dist, package-relative (not workspace-root-relative)', () => {
    const fromDir = path.join('/some/arbitrary/path', 'packages', 'domain', 'domain-base-thing');
    expect(projectDist(fromDir)).toBe(path.join(fromDir, 'dist'));
  });
});

describe('workspaceNodeModules', () => {
  it('returns <workspaceRoot>/node_modules', () => {
    const { workspaceRoot, cleanup } = makeSyntheticWorkspace('node-modules');
    try {
      const pkgDir = path.join(workspaceRoot, 'packages', 'domain', 'domain-base-thing');
      fs.mkdirSync(pkgDir, { recursive: true });

      expect(workspaceNodeModules(pkgDir)).toBe(path.join(fs.realpathSync(workspaceRoot), 'node_modules'));
    } finally {
      cleanup();
    }
  });
});
