/**
 * Teeth tests for the `verify-dist-load` executor's re-stamp fix (the
 * `dist-manifest`/`build` clobber race — see impl.js's own doc comment).
 *
 * Mocking boundary: `module.exports.__internals.restampDistManifest` is a
 * mockable seam (mirrors `hygiene/impl.js`'s identical pattern) for the pure
 * unit tests; the end-to-end tests below run the REAL restamp + the REAL
 * verify-dist-load.mjs script as a real child process (no mocking at all) to
 * prove the actual regression is fixed.
 *
 * IMPORTANT: `impl.js` resolves the verify-dist-load.mjs SCRIPT path off
 * `context.root` (`join(context.root, 'tools/nx-plugins/.../verify-dist-load.mjs')`),
 * not off this spec file's own location — so any test that lets the real
 * `spawnSync` run (i.e. doesn't fully mock the executor away) MUST pass the
 * REAL repo root as `context.root`. Fixtures therefore live under this repo's
 * own `tmp/` (the canonical ephemeral root — see AGENTS.md §10), cleaned up
 * in `finally`, exactly like verify-dist-load.spec.mjs's own fixtures.
 *
 * Run: node --test tools/nx-plugins/build/executors/verify/impl.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const implAbs = require.resolve('./impl.js');

function findRepoRoot(d) {
  while (d !== dirname(d)) {
    if (existsSync(join(d, 'nx.json'))) return d;
    d = dirname(d);
  }
  throw new Error('could not locate workspace root (nx.json) walking up from ' + __dirname);
}
const REPO_ROOT = findRepoRoot(__dirname);

function loadFreshImpl() {
  delete require.cache[implAbs];
  return require(implAbs);
}

/** Plant a fixture project under the REAL repo's `tmp/` and return {rootDir: REPO_ROOT, projectRoot: workspace-relative path}. */
function plantFixture(label) {
  const projectRoot = join('tmp', 'nx-build-verify-impl-spec', `${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(REPO_ROOT, projectRoot), { recursive: true });
  return projectRoot;
}

function makeContext(name, projectRoot) {
  return { root: REPO_ROOT, projectName: name, projectsConfigurations: { projects: { [name]: { root: projectRoot } } } };
}

test('calls restampDistManifest with THIS project\'s pkgRoot/distDir before running the real script', async () => {
  const projectRoot = plantFixture('mocked-restamp');
  const pkgRoot = join(REPO_ROOT, projectRoot);
  const distDir = join(pkgRoot, 'dist');
  try {
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: '@adhd/pkg-b', version: '1.0.0', main: './dist/index.js' }));
    writeFileSync(join(distDir, 'index.js'), 'module.exports = {};\n');
    writeFileSync(join(distDir, 'package.json'), JSON.stringify({ name: '@adhd/pkg-b', version: '1.0.0', main: './index.js' }));
    const context = makeContext('@adhd/pkg-b', projectRoot);
    const impl = loadFreshImpl();

    const calls = [];
    impl.__internals.restampDistManifest = async (ctx, pr, dd) => {
      calls.push({ pkgRoot: pr, distDir: dd });
    };

    const result = await impl({}, context);
    assert.equal(result.success, true);
    assert.equal(calls.length, 1, 'restampDistManifest must be called exactly once');
    assert.equal(calls[0].pkgRoot, pkgRoot);
    assert.equal(calls[0].distDir, distDir);
  } finally {
    rmSync(pkgRoot, { recursive: true, force: true });
  }
});

test('restampDistManifest guard: no-ops when the source package.json is missing (nothing to re-stamp FROM)', async () => {
  const projectRoot = plantFixture('guard-no-src-pkg');
  const pkgRoot = join(REPO_ROOT, projectRoot);
  const distDir = join(pkgRoot, 'dist');
  try {
    mkdirSync(distDir, { recursive: true }); // dist exists, but no source package.json
    const impl = loadFreshImpl();
    // Must not throw even though writeDistManifest would fail reading a
    // nonexistent source package.json — the guard short-circuits first.
    await assert.doesNotReject(() => impl.__internals.restampDistManifest({ root: REPO_ROOT }, pkgRoot, distDir));
    assert.equal(existsSync(join(distDir, 'package.json')), false, 'must not have fabricated a dist manifest out of nothing');
  } finally {
    rmSync(pkgRoot, { recursive: true, force: true });
  }
});

test('restampDistManifest guard: no-ops when dist/ does not exist yet (build never ran)', async () => {
  const projectRoot = plantFixture('guard-no-dist');
  const pkgRoot = join(REPO_ROOT, projectRoot);
  try {
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: '@adhd/pkg-b', version: '1.0.0' }));
    const distDir = join(pkgRoot, 'dist'); // deliberately never created
    const impl = loadFreshImpl();
    await assert.doesNotReject(() => impl.__internals.restampDistManifest({ root: REPO_ROOT }, pkgRoot, distDir));
    assert.equal(existsSync(distDir), false);
  } finally {
    rmSync(pkgRoot, { recursive: true, force: true });
  }
});

test('CLOBBER-RACE regression (real restamp, real script, no mocking): a dist manifest with a REBASED main but a STALE un-rebased exports["."].default (the exact @nx/js:tsc partial-rebase shape) now PASSES after the executor\'s own re-stamp', async () => {
  const projectRoot = plantFixture('clobber-race');
  const pkgRoot = join(REPO_ROOT, projectRoot);
  const distDir = join(pkgRoot, 'dist');
  try {
    mkdirSync(join(distDir, 'src'), { recursive: true });
    // Real, correctly-authored source manifest.
    writeFileSync(
      join(pkgRoot, 'package.json'),
      JSON.stringify({
        name: '@adhd/pkg-b',
        version: '1.0.0',
        main: './dist/src/index.js',
        exports: { '.': { types: './dist/src/index.d.ts', default: './dist/src/index.js' } },
      })
    );
    writeFileSync(join(distDir, 'src', 'index.js'), 'module.exports = { ok: true };\n');
    // The TRANSIENT clobbered dist manifest: `@nx/js:tsc` rebased `main` but
    // NOT `exports` — exactly the reported live shape
    // (`exports["."].default` resolving to `dist/dist/src/index.js`).
    writeFileSync(
      join(distDir, 'package.json'),
      JSON.stringify({
        name: '@adhd/pkg-b',
        version: '1.0.0',
        main: './src/index.js', // correctly rebased
        exports: { '.': { types: './dist/src/index.d.ts', default: './dist/src/index.js' } }, // STALE, un-rebased
      })
    );
    const context = makeContext('@adhd/pkg-b', projectRoot);
    const impl = loadFreshImpl(); // real restampDistManifest, not mocked

    const result = await impl({}, context);
    assert.equal(result.success, true, 'the executor\'s own re-stamp must repair the partially-rebased exports before verify-dist-load reads it');

    // And the repair must actually be on disk, not merely papered over in-memory.
    const distPkgNow = JSON.parse(readFileSync(join(distDir, 'package.json'), 'utf8'));
    assert.equal(distPkgNow.exports['.'].default, './src/index.js', 're-stamp must rebase exports too, not just main');
  } finally {
    rmSync(pkgRoot, { recursive: true, force: true });
  }
});

test('a GENUINELY wrong dist manifest (even after a correct re-stamp) still fails — the re-stamp cannot manufacture a missing file', async () => {
  const projectRoot = plantFixture('genuinely-missing');
  const pkgRoot = join(REPO_ROOT, projectRoot);
  const distDir = join(pkgRoot, 'dist');
  try {
    mkdirSync(distDir, { recursive: true });
    // Source declares an entry that was never actually built.
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: '@adhd/pkg-b', version: '1.0.0', main: './dist/missing.js' }));
    // No dist/missing.js written at all — a genuine broken build.
    const context = makeContext('@adhd/pkg-b', projectRoot);
    const impl = loadFreshImpl();

    const result = await impl({}, context);
    assert.equal(result.success, false, 're-stamping a manifest whose declared file was never built must still fail verify-dist-load');
  } finally {
    rmSync(pkgRoot, { recursive: true, force: true });
  }
});
