/**
 * guards: release:pending reports a project whose shipped source is unchanged, or misses one that changed
 * tier: S
 * cites: release-perf handoff P2
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { isRelevant } = createRequire(import.meta.url)('./release-pending.js');

test('release-neutral paths are not source changes', () => {
  for (const f of ['p/dist/a.js', 'p/node_modules/x/i.js', 'p/test/unit/a.mjs', 'p/README.md', 'p/CHANGELOG.md', 'p/eslint.config.mjs', 'p/src/a.spec.ts'])
    assert.equal(isRelevant(f), false, f);
});

test('shipped source and tsconfig are source changes', () => {
  for (const f of ['p/src/index.ts', 'p/package.json', 'p/tsconfig.lib.json', 'p/project.json']) assert.equal(isRelevant(f), true, f);
});

// ---------------------------------------------------------------------------
// computePending over a real throwaway git repo: each false negative the first version had is pinned here.
// ---------------------------------------------------------------------------
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const { computePending } = createRequire(import.meta.url)('./release-pending.js');
const { scratchRootPath } = createRequire(import.meta.url)('../../lib/scratch-root.js');
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const g = (cwd, ...a) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const put = (ws, rel, body) => {
  mkdirSync(join(ws, dirname(rel)), { recursive: true });
  writeFileSync(join(ws, rel), body);
};
const manifest = (name, extra = {}) => JSON.stringify({ name, version: '1.0.0', ...extra }, null, 2);

/** Two packages, `a` (leaf) and `b` (depends on `a`), committed and recorded as published at that commit. */
function fixture(fn) {
  const scratch = scratchRootPath(REPO_ROOT);
  mkdirSync(scratch, { recursive: true });
  const ws = mkdtempSync(join(scratch, 'rp-'));
  try {
    g(ws, 'init', '-q');
    put(ws, 'packages/a/package.json', manifest('@adhd/a', { assets: ['skill'] }));
    put(ws, 'packages/a/src/index.ts', 'export const a = 1;\n');
    put(ws, 'packages/a/README.md', '# a\n');
    put(ws, 'packages/a/skill/guide.md', 'guide\n');
    put(ws, 'packages/a/project.json', '{"name":"a"}');
    put(ws, 'packages/b/package.json', manifest('@adhd/b', { dependencies: { '@adhd/a': '^1.0.0', lodash: '^4.0.0' } }));
    put(ws, 'packages/b/src/index.ts', 'export const b = 1;\n');
    put(ws, 'tsconfig.base.json', '{}');
    put(ws, 'tools/nx-plugins/build/executors/manifest/generate-manifest.js', '// v1\n');
    put(ws, 'tools/nx-plugins/build/executors/publish/impl.js', '// release flow v1\n');
    g(ws, 'add', '-A');
    g(ws, 'commit', '-q', '-m', 'init');
    const ref = g(ws, 'rev-parse', 'HEAD');
    const state = { '@adhd/a': { version: '1.0.0', publishedFromRef: ref }, '@adhd/b': { version: '1.0.0', publishedFromRef: ref } };
    const releaseSet = [
      { projectRoot: 'packages/a', name: '@adhd/a', version: '1.0.0', deps: [] },
      { projectRoot: 'packages/b', name: '@adhd/b', version: '1.0.0', deps: [{ field: 'dependencies', depName: '@adhd/a', range: '^1.0.0' }] },
    ];
    const pending = () => Object.fromEntries(computePending({ workspaceRoot: ws, releaseSet, state }).map((p) => [p.name, p.reasons]));
    return fn({ ws, pending, state, releaseSet, ref });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

test('nothing changed since the published ref: nothing pending', () => {
  fixture(({ pending }) => assert.deepEqual(pending(), {}));
});

test('a source edit in a leaf marks it source-changed and its dependent dependency-changed', () => {
  fixture(({ ws, pending }) => {
    put(ws, 'packages/a/src/index.ts', 'export const a = 2;\n');
    assert.deepEqual(pending(), { '@adhd/a': ['source-changed'], '@adhd/b': ['dependency-changed'] });
  });
});

test('a README edit is shipped content (assets copies it into dist) and is not ignored', () => {
  fixture(({ ws, pending }) => {
    put(ws, 'packages/a/README.md', '# a changed\n');
    assert.deepEqual(pending()['@adhd/a'], ['source-changed']);
  });
});

test('a file under a package.json assets entry counts even though it is markdown', () => {
  fixture(({ ws, pending }) => {
    put(ws, 'packages/a/skill/guide.md', 'guide changed\n');
    assert.deepEqual(pending()['@adhd/a'], ['source-changed']);
  });
});

test('a CHANGELOG-only edit is release output and does not mark the package', () => {
  fixture(({ ws, pending }) => {
    put(ws, 'packages/a/CHANGELOG.md', '# 1.0.1\n');
    assert.deepEqual(pending(), {});
  });
});

test('a project.json edit holds build config and marks the package', () => {
  fixture(({ ws, pending }) => {
    put(ws, 'packages/a/project.json', '{"name":"a","targets":{}}');
    assert.deepEqual(pending()['@adhd/a'], ['source-changed']);
  });
});

test('a version bump alone, or an internal range rewrite alone, is not a source change', () => {
  fixture(({ ws, pending }) => {
    put(ws, 'packages/b/package.json', manifest('@adhd/b', { dependencies: { '@adhd/a': '^1.2.0', lodash: '^4.0.0' } }).replace('1.0.0"', '1.0.1"'));
    assert.deepEqual(pending(), {});
  });
});

test('adding an internal dependency is a source change even though internal ranges are stripped', () => {
  fixture(({ ws, pending }) => {
    put(ws, 'packages/a/package.json', manifest('@adhd/a', { assets: ['skill'], dependencies: { '@adhd/b': '^1.0.0' } }));
    assert.ok(pending()['@adhd/a'].includes('source-changed'));
  });
});

test('a third-party dependency range edit marks the package and its dependent', () => {
  fixture(({ ws, pending }) => {
    put(ws, 'packages/a/package.json', manifest('@adhd/a', { assets: ['skill'], dependencies: { lodash: '^5.0.0' } }));
    assert.deepEqual(pending(), { '@adhd/a': ['source-changed'], '@adhd/b': ['dependency-changed'] });
  });
});

test('a workspace-level build input marks every package; release-flow files do not', () => {
  fixture(({ ws, pending }) => {
    put(ws, 'tools/nx-plugins/build/executors/publish/impl.js', '// release flow v2\n');
    assert.deepEqual(pending(), {});
    put(ws, 'tsconfig.base.json', '{"compilerOptions":{}}');
    assert.deepEqual(pending(), { '@adhd/a': ['global-input-changed'], '@adhd/b': ['dependency-changed', 'global-input-changed'] });
  });
});

test('the manifest generator is a global input', () => {
  fixture(({ ws, pending }) => {
    put(ws, 'tools/nx-plugins/build/executors/manifest/generate-manifest.js', '// v2\n');
    assert.deepEqual(Object.keys(pending()).sort(), ['@adhd/a', '@adhd/b']);
  });
});

test('an untracked source file is pending', () => {
  fixture(({ ws, pending }) => {
    put(ws, 'packages/a/src/new.ts', 'export {};\n');
    assert.ok(pending()['@adhd/a'].includes('source-changed'));
  });
});

test('a version that differs from the recorded published version is version-drift', () => {
  fixture(({ pending, releaseSet, state, ws }) => {
    releaseSet[0].version = '1.0.1';
    const out = computePending({ workspaceRoot: ws, releaseSet, state });
    assert.deepEqual(out.find((p) => p.name === '@adhd/a').reasons, ['version-drift']);
  });
});

test('a package with no published-state entry is never-published', () => {
  fixture(({ ws, releaseSet, state }) => {
    delete state['@adhd/a'];
    assert.ok(computePending({ workspaceRoot: ws, releaseSet, state }).find((p) => p.name === '@adhd/a').reasons.includes('never-published'));
  });
});

test('an unresolvable recorded ref falls back to the commit that wrote it, then to ref-unresolvable', () => {
  fixture(({ ws, releaseSet, state }) => {
    const ghost = 'a'.repeat(40);
    state['@adhd/a'].publishedFromRef = ghost;
    const out = computePending({ workspaceRoot: ws, releaseSet, state });
    assert.ok(out.find((p) => p.name === '@adhd/a').reasons.includes('ref-unresolvable'));
    // The ref is recorded in a committed published-state.json: that commit becomes the baseline.
    put(ws, 'published-state.json', JSON.stringify({ '@adhd/a': { publishedFromRef: ghost } }));
    g(ws, 'add', 'published-state.json');
    g(ws, 'commit', '-q', '-m', 'record publish');
    const after = computePending({ workspaceRoot: ws, releaseSet, state });
    assert.deepEqual(after.filter((p) => p.name === '@adhd/a'), []);
  });
});
