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

test('end-to-end integration (real module, real npm pack --dry-run, no mocks): BUG-RELEASE-NX-RELEASE-PUBLISH-EMPTY-TARBALL-001 repro — a stale "files" field (relative to the WRONG packageRoot) that matches nothing FAILS on the empty-tarball guard, even though real code exists on disk', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hygiene-impl-'));
  try {
    const projectRoot = 'packages/pkg-b';
    const distDir = join(rootDir, projectRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    // Reproduces the live incident exactly: `dist-manifest` did NOT strip the
    // source-root-relative "files":["dist", …] allowlist (as it's supposed
    // to — see generate-manifest.js's "(4) Drops files" step) before this
    // manifest was packed FROM the dist directory itself. Relative to
    // packageRoot=dist/, "dist" matches nothing, so npm's `files` allowlist
    // excludes the real `index.js` sitting right next to package.json — npm
    // packs ONLY package.json. Verified empirically (real `npm pack
    // --dry-run`, no mock) before writing this assertion.
    writeFileSync(
      join(distDir, 'package.json'),
      JSON.stringify({ name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', files: ['dist', 'CHANGELOG.md'] })
    );
    writeFileSync(join(distDir, 'index.js'), 'module.exports = {};\n'); // real code IS on disk — npm's `files` field is what excludes it
    const context = { root: rootDir, projectName: '@adhd/pkg-b', projectsConfigurations: { projects: { '@adhd/pkg-b': { root: projectRoot } } } };
    const impl = loadFreshImpl(); // real __internals.runHygieneCheck — not overridden

    const result = await impl({}, context);
    assert.equal(result.success, false, 'an empty (package.json-only) tarball must fail even when the real code exists on disk');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('end-to-end integration (real module, real npm pack --dry-run, no mocks): empty-tarball guard fires even for a manifest with NO declared entry point at all (isolates the new assertion from the pre-existing "declared entry missing" check)', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hygiene-impl-'));
  try {
    const projectRoot = 'packages/pkg-b';
    const distDir = join(rootDir, projectRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    // No main/module/typings/exports declared at all — `collectExpectedTargets`
    // returns nothing, so the PRE-EXISTING "declared entry missing" check has
    // nothing to check. Only the new, unconditional empty-tarball guard can
    // catch this shape.
    writeFileSync(join(distDir, 'package.json'), JSON.stringify({ name: '@adhd/pkg-b', version: '1.0.0', files: ['dist'] }));
    writeFileSync(join(distDir, 'index.js'), 'module.exports = {};\n');
    const context = { root: rootDir, projectName: '@adhd/pkg-b', projectsConfigurations: { projects: { '@adhd/pkg-b': { root: projectRoot } } } };
    const impl = loadFreshImpl();

    const result = await impl({}, context);
    assert.equal(result.success, false, 'a package.json-only tarball must fail even when it declares no entry point to check against');
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
