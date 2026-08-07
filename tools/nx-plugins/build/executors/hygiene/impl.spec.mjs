/**
 * Teeth tests for `publish-hygiene` — BUILD-TOOLING-METRICS-001's in-process
 * elimination of the outer `node check-publish-hygiene.mjs` subprocess.
 *
 * Mocking boundary: `module.exports.__internals.runHygieneCheck` — the seam
 * this executor calls instead of spawning a subprocess. Proves (a) it is
 * invoked with THIS project's workspace-relative root, (b) its return code
 * maps correctly to `{success}`, (c) `node:child_process` is NEVER touched
 * at all by the EXECUTOR layer (the actual elimination — spawnSync is mocked
 * to throw if called, so a regression back to subprocess-spawning fails
 * loudly), and (d) a metrics record lands via `lib/metrics.js`.
 *
 * Run: node --test tools/nx-plugins/build/executors/hygiene/impl.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import child_process from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const implAbs = require.resolve('./impl.js');
const metricsAbs = require.resolve('../../../lib/metrics.js');

function resetAll() {
  delete require.cache[implAbs];
}
function loadFreshImpl() {
  resetAll();
  return require(implAbs);
}

function makeContext(rootDir, name, projectRoot) {
  mkdirSync(join(rootDir, projectRoot), { recursive: true });
  writeFileSync(join(rootDir, projectRoot, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  return { root: rootDir, projectName: name, projectsConfigurations: { projects: { [name]: { root: projectRoot } } } };
}

test('never touches node:child_process at the EXECUTOR layer — the whole point of the elimination', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hygiene-impl-'));
  try {
    t.mock.method(child_process, 'spawnSync', () => { throw new Error('spawnSync must NEVER be called directly by hygiene/impl.js'); });
    const context = makeContext(rootDir, '@adhd/pkg-b', 'packages/pkg-b');
    const impl = loadFreshImpl();
    impl.__internals.runHygieneCheck = async () => 0;

    const result = await impl({}, context);
    assert.equal(result.success, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('invokes runHygieneCheck with THIS project\'s workspace-relative root and the workspace root', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hygiene-impl-'));
  try {
    const context = makeContext(rootDir, '@adhd/pkg-b', 'packages/pkg-b');
    const impl = loadFreshImpl();
    const calls = [];
    impl.__internals.runHygieneCheck = async (projectRoot, repoRoot) => {
      calls.push({ projectRoot, repoRoot });
      return 0;
    };

    await impl({}, context);
    assert.deepEqual(calls, [{ projectRoot: 'packages/pkg-b', repoRoot: rootDir }]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a non-zero exit code from runHygieneCheck maps to success:false', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hygiene-impl-'));
  try {
    const context = makeContext(rootDir, '@adhd/pkg-b', 'packages/pkg-b');
    const impl = loadFreshImpl();
    impl.__internals.runHygieneCheck = async () => 1;

    const result = await impl({}, context);
    assert.equal(result.success, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('records a publish-hygiene metrics.json entry with a subprocess sample attributed to the in-process call', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hygiene-impl-'));
  try {
    const context = makeContext(rootDir, '@adhd/pkg-b', 'packages/pkg-b');
    const impl = loadFreshImpl();
    impl.__internals.runHygieneCheck = async () => 0;

    await impl({}, context);
    delete require.cache[metricsAbs];
    const { readMetrics } = require(metricsAbs);
    const { records } = readMetrics(rootDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].task, 'publish-hygiene');
    assert.equal(records[0].project, '@adhd/pkg-b');
    assert.equal(records[0].subprocess.count, 1, 'the in-process check-publish-hygiene call is still tracked as one "subprocess" unit of work');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('loadHygieneCheck really resolves the real check-publish-hygiene.mjs module (integration smoke, not a mock)', async () => {
  const impl = loadFreshImpl();
  const mod = await impl.__internals.loadHygieneCheck();
  assert.equal(typeof mod.main, 'function');
});

test('end-to-end integration (real module, real npm pack --dry-run, no mocks): a package with a missing declared entry FAILS', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hygiene-impl-'));
  try {
    const projectRoot = 'packages/pkg-b';
    const distDir = join(rootDir, projectRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    // Declares `main: ./index.js` but never writes it — a real, unmocked
    // publish-hygiene violation (missing declared entry point).
    writeFileSync(join(distDir, 'package.json'), JSON.stringify({ name: '@adhd/pkg-b', version: '1.0.0', main: './index.js' }));
    const context = { root: rootDir, projectName: '@adhd/pkg-b', projectsConfigurations: { projects: { '@adhd/pkg-b': { root: projectRoot } } } };
    const impl = loadFreshImpl(); // real __internals.runHygieneCheck — not overridden

    const result = await impl({}, context);
    assert.equal(result.success, false, 'a real missing declared entry point must fail the check even with zero mocking');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('end-to-end integration (real module, real npm pack --dry-run, no mocks): BUG-001 — a TRANSIENT stale "files" field left by a `build` re-clobber is fixed by the executor\'s own re-stamp before hygiene packs, so a package with real code on disk now PASSES', async () => {
  // CONTRACT CHANGE (BUG-001): this test used to assert `success:false` for
  // exactly this fixture, under the name
  // BUG-RELEASE-NX-RELEASE-PUBLISH-EMPTY-TARBALL-001. That was correct for
  // the OLD executor, which trusted whatever was sitting in dist/ when it
  // ran. But `publish`/`version` ALREADY defend against this exact shape by
  // calling `writeDistManifest` as their own truly-last write before they
  // trust dist/'s content (`dist-manifest` is a sibling of `build` in
  // `publish`'s `dependsOn`, so nx guarantees both complete but not their
  // relative order — a cache-restored `build` can re-clobber the rebase
  // `dist-manifest` already did). `publish-hygiene` now does the same
  // re-stamp (see impl.js), so a dist caught in this TRANSIENT clobbered
  // state — real code on disk, package.json's `files` field just hasn't
  // been re-rebased yet — is exactly what the re-stamp fixes, and hygiene
  // now checks the SAME state the real publish will pack: a false-fail
  // eliminated, not a real defect masked. The case where re-stamping cannot
  // help (no source package.json to re-stamp FROM, or dist has no code even
  // after a correct re-stamp) is covered below and still fails.
  const rootDir = mkdtempSync(join(tmpdir(), 'hygiene-impl-'));
  try {
    const projectRoot = 'packages/pkg-b';
    const pkgRoot = join(rootDir, projectRoot);
    const distDir = join(pkgRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    // The real, authored SOURCE manifest — present so the executor's
    // re-stamp (writeDistManifest) has something correct to regenerate FROM.
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: '@adhd/pkg-b', version: '1.0.0', main: './dist/index.js', files: ['dist', 'CHANGELOG.md'] }));
    // The DIST manifest, caught mid-transient exactly like the live incident:
    // `dist-manifest` did NOT strip the source-root-relative "files" allowlist
    // (it's supposed to — see generate-manifest.js's "(4) Drops files" step)
    // before this was packed FROM the dist directory itself. Relative to
    // packageRoot=dist/, "dist" matches nothing, so npm's `files` allowlist
    // would exclude the real `index.js` sitting right next to package.json —
    // UNLESS something re-stamps first.
    writeFileSync(
      join(distDir, 'package.json'),
      JSON.stringify({ name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', files: ['dist', 'CHANGELOG.md'] })
    );
    writeFileSync(join(distDir, 'index.js'), 'module.exports = {};\n'); // real code IS on disk
    const context = { root: rootDir, projectName: '@adhd/pkg-b', projectsConfigurations: { projects: { '@adhd/pkg-b': { root: projectRoot } } } };
    const impl = loadFreshImpl(); // real __internals.runHygieneCheck AND restampDistManifest — not overridden

    const result = await impl({}, context);
    assert.equal(result.success, true, 'the executor\'s own re-stamp must repair a transient stale "files" field before hygiene packs, matching what the real publish would ship');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('end-to-end integration (real module, real npm pack --dry-run, no mocks): BUG-001 — re-stamp also fixes a manifest with NO declared entry point at all (isolates the fix from the pre-existing "declared entry missing" check)', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hygiene-impl-'));
  try {
    const projectRoot = 'packages/pkg-b';
    const pkgRoot = join(rootDir, projectRoot);
    const distDir = join(pkgRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: '@adhd/pkg-b', version: '1.0.0', files: ['dist'] }));
    // No main/module/typings/exports declared at all — `collectExpectedTargets`
    // returns nothing, so the pre-existing "declared entry missing" check has
    // nothing to check; only the empty-tarball guard is in play here, and the
    // re-stamp (stripping the stale "files" allowlist) is what lets the real
    // `index.js` through.
    writeFileSync(join(distDir, 'package.json'), JSON.stringify({ name: '@adhd/pkg-b', version: '1.0.0', files: ['dist'] }));
    writeFileSync(join(distDir, 'index.js'), 'module.exports = {};\n');
    const context = { root: rootDir, projectName: '@adhd/pkg-b', projectsConfigurations: { projects: { '@adhd/pkg-b': { root: projectRoot } } } };
    const impl = loadFreshImpl();

    const result = await impl({}, context);
    assert.equal(result.success, true, 'the re-stamp must strip the stale "files" allowlist so the real index.js is packed even when no entry point is declared');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('end-to-end integration (real module, real npm pack --dry-run, no mocks): a GENUINELY empty tarball — no shippable code even AFTER a correct re-stamp — still FAILS (the guarantee the re-stamp must never weaken)', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hygiene-impl-'));
  try {
    const projectRoot = 'packages/pkg-b';
    const pkgRoot = join(rootDir, projectRoot);
    const distDir = join(pkgRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    // A real, well-formed source manifest — the re-stamp runs successfully
    // and regenerates a perfectly correct dist/package.json. But the build
    // never actually emitted any code into dist/ (e.g. a genuinely broken
    // build), so there is nothing for the re-stamp to rescue: dist/ contains
    // ONLY package.json before AND after re-stamping.
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: '@adhd/pkg-b', version: '1.0.0' }));
    writeFileSync(join(distDir, 'package.json'), JSON.stringify({ name: '@adhd/pkg-b', version: '1.0.0' }));
    const context = { root: rootDir, projectName: '@adhd/pkg-b', projectsConfigurations: { projects: { '@adhd/pkg-b': { root: projectRoot } } } };
    const impl = loadFreshImpl(); // real re-stamp AND real hygiene check — not overridden

    const result = await impl({}, context);
    assert.equal(result.success, false, 'a dist with no shippable files must still fail even after the executor\'s own correct re-stamp — the re-stamp fixes a stale manifest, it cannot manufacture missing code');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('end-to-end integration (real module, real npm pack --dry-run, no mocks): a clean package PASSES', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hygiene-impl-'));
  try {
    const projectRoot = 'packages/pkg-b';
    const distDir = join(rootDir, projectRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'package.json'), JSON.stringify({ name: '@adhd/pkg-b', version: '1.0.0', main: './index.js' }));
    writeFileSync(join(distDir, 'index.js'), 'module.exports = {};\n');
    const context = { root: rootDir, projectName: '@adhd/pkg-b', projectsConfigurations: { projects: { '@adhd/pkg-b': { root: projectRoot } } } };
    const impl = loadFreshImpl();

    const result = await impl({}, context);
    assert.equal(result.success, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
