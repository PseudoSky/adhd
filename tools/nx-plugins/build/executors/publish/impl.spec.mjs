/**
 * Teeth tests for the `publish` executor's cache integration
 * (PUBLISHED-STATE-CACHE-001, Deliverables 3 + 5).
 *
 * Mocking boundary: ONLY `node:child_process.spawnSync` is mocked (the real
 * `npm publish`/`npm pack` process boundary). Everything else — the real
 * `lib/published-state.js` cache I/O (including its real lockfile),
 * `compare-published.js`'s real `normalizedHash`, real file I/O — runs for
 * real, including a genuine multi-process-shaped concurrency proof (parallel
 * in-process `run()` calls, each racing for the SAME lockfile a separate `nx
 * run-many -t publish` process would use).
 *
 * Run: node --test tools/nx-plugins/build/executors/publish/impl.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import child_process from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// BUG (flaky CPU-guard trips under real machine load, test:build-tools): this
// file exercises the real `publish` executor end-to-end (only `spawnSync` is
// mocked), which wraps its work in `withMetrics` (BUILD-TOOLING-METRICS-001) —
// and `withMetrics` always runs the REAL `checkCpuGuard`
// (FEAT-NXMETRICS-CPU-GUARD-001) against a REAL `process.cpuUsage()`
// measurement of whatever brief work `run()` just did. On a loaded machine
// (e.g. many concurrent `node --test` workers sharing cores) that real
// measured % can legitimately exceed the default
// `ADHD_NX_METRICS_MAX_CPU_PCT=300` threshold for these short bursts, tripping
// the guard and failing a test that has nothing to do with the guard itself.
// The guard's own pass/fail LOGIC is fully covered, deterministically, by
// `tools/nx-plugins/lib/metrics.spec.mjs` — this file only asserts publish
// cache/dist/backstop orchestration, so disable the guard here (metrics
// recording, including the real `cpuPercent` value, still happens; only the
// throw-on-trip is turned off).
process.env.ADHD_NX_METRICS_MAX_CPU_PCT = '0';

// DEFECT 32af828b: `publish` now VERIFIES the just-published version is
// retrievable from the registry (lib/publish-verify.js) BEFORE writing
// published-state.json. These tests never touch the real network — they stub
// publish-verify's module-level reader seam below. Pin the poll budget to 0 so
// a stubbed reader is consulted EXACTLY ONCE with no real sleep (the production
// default is a ~30-minute bounded poll; an unpinned 404 stub would otherwise
// sleep 15s per attempt for 30 minutes).
process.env.ADHD_PUBLISH_VERIFY_TIMEOUT_MS = '0';
process.env.ADHD_PUBLISH_VERIFY_INTERVAL_MS = '0';

const require = createRequire(import.meta.url);
const implAbs = require.resolve('./impl.js');
const npmRegistryAbs = require.resolve('../../lib/npm-registry.js');
const publishedStateAbs = require.resolve('../../lib/published-state.js');
const publishVerify = require('../../lib/publish-verify.js');
const { writeReleaseManifest } = require('../../lib/release-manifest.js');

function resetAll() {
  delete require.cache[implAbs];
  delete require.cache[npmRegistryAbs];
  delete require.cache[publishedStateAbs];
  // publish-verify.js is DELIBERATELY not cache-busted: its module-level reader
  // seam (__setReadVersion) must survive a loadFreshImpl() reload so the offline
  // registry stub set below stays in effect for every executor under test.
}
/**
 * Stub the post-publish registry read (defect 32af828b) so the executor's new
 * verification step answers locally instead of hitting the network. The echo
 * reader claims every requested version is retrievable — exactly what the
 * pre-existing "publish then write-through" tests already assume happened.
 */
function stubRegistryAlwaysRetrievable() {
  publishVerify.__setReadVersion(async ({ name, version }) => ({ status: 200, body: { name, version } }));
}
function loadFreshImpl() {
  resetAll();
  stubRegistryAlwaysRetrievable();
  return require(implAbs);
}

function makeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
}

function publishedStatePath(rootDir) {
  return join(rootDir, 'published-state.json');
}

function writePublishedState(rootDir, entries) {
  writeFileSync(publishedStatePath(rootDir), JSON.stringify(entries, null, 2) + '\n');
}

/**
 * @param {object} state
 * @param {number} [state.publishStatus] exit code for `npm publish` (default 0)
 * @param {string} [state.publishStderr] stderr text for a failed publish
 */
function makeSpawnSyncMock(state) {
  return (cmd, args = [], _opts = {}) => {
    state.calls.push({ cmd, args });
    if (cmd === 'npm' && args[0] === 'publish') {
      return { status: state.publishStatus ?? 0, stdout: '', stderr: state.publishStderr ?? '' };
    }
    if (cmd === 'npm' && args[0] === 'view') {
      return { status: state.viewStatus ?? 1, stdout: state.viewStatus === 0 ? state.viewStdout ?? '' : '', stderr: '' };
    }
    if (cmd === 'npm' && args[0] === 'pack') {
      // packLocalDir (write-through) — always local/offline in these tests.
      const destIdx = args.indexOf('--pack-destination');
      const workDir = args[destIdx + 1];
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, 'local.tgz'), state.tgzContent ?? 'tgz-bytes\n');
      return { status: 0, stdout: JSON.stringify([{ filename: 'local.tgz' }]), stderr: '' };
    }
    throw new Error(`unexpected spawnSync in test mock: ${cmd} ${JSON.stringify(args)}`);
  };
}

function makeProject({ rootDir, name, projectRoot, distPkg, srcPkg, skipManifest = false }) {
  const pkgRoot = join(rootDir, projectRoot);
  // `publish` now re-stamps dist/package.json from the SOURCE manifest as its
  // truly-last step before `npm publish` (BUG-BUILD-PUBLISH-DISTMANIFEST-
  // CLOBBERED-001) — a real project always has both a source and dist
  // package.json, so the fixture must too. Defaults to `distPkg`'s own shape
  // (no bin/exports/files to rebase in these minimal fixtures, so the
  // resulting dist manifest is identical either way).
  makeFiles(pkgRoot, { 'package.json': JSON.stringify(srcPkg ?? distPkg, null, 2) });
  makeFiles(join(pkgRoot, 'dist'), { 'package.json': JSON.stringify(distPkg, null, 2), 'index.js': 'x\n' });
  const context = {
    root: rootDir,
    projectName: name,
    projectsConfigurations: { projects: { [name]: { root: projectRoot } } },
  };
  // MANIFEST BACKSTOP (Phase 3): every one of these pre-existing cache/
  // dist-manifest tests exercises behavior AFTER the backstop check passes —
  // they are not testing the backstop itself (see manifest-backstop.spec.mjs
  // for that), so default to writing a fresh manifest that already lists
  // this project, matching what a real `computeChangedProjectSet` call
  // (via `run-release.mjs`) would have produced moments before `publish` runs.
  if (!skipManifest) {
    writeReleaseManifest(rootDir, [name]);
  }
  return { pkgRoot, distDir: join(pkgRoot, 'dist'), context };
}

function newState(overrides = {}) {
  return { calls: [], publishStatus: 0, ...overrides };
}

test('cache HIT (already published at this version): ZERO network — skips without calling npm at all', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'publish-impl-'));
  try {
    const distPkg = { name: '@adhd/pkg-b', version: '1.0.0' };
    const { context } = makeProject({ rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', distPkg });
    writePublishedState(rootDir, { '@adhd/pkg-b': { version: '1.0.0', normalizedHash: 'sha256:x', publishedIntegrity: 'sha512-x' } });

    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const publishImpl = loadFreshImpl();

    const result = await publishImpl({}, context);
    assert.equal(result.success, true);
    assert.deepEqual(state.calls, [], 'a cache hit must never invoke npm at all — not even a read');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cache MISS (not yet in cache): publishes for real, then write-through updates the cache from the just-packed dist', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'publish-impl-'));
  try {
    const distPkg = { name: '@adhd/pkg-b', version: '1.0.0' };
    const { context, distDir } = makeProject({ rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', distPkg });

    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const publishImpl = loadFreshImpl();

    const result = await publishImpl({}, context);
    assert.equal(result.success, true);
    const publishCalls = state.calls.filter((c) => c.cmd === 'npm' && c.args[0] === 'publish');
    assert.equal(publishCalls.length, 1, 'a genuine cache miss must actually attempt npm publish');
    assert.ok(publishCalls[0].args.includes(distDir), 'must publish from the dist dir');

    const cached = JSON.parse(readFileSync(publishedStatePath(rootDir), 'utf8'));
    assert.equal(cached['@adhd/pkg-b'].version, '1.0.0');
    assert.match(cached['@adhd/pkg-b'].normalizedHash, /^sha256:[0-9a-f]{64}$/);
    assert.match(cached['@adhd/pkg-b'].publishedIntegrity, /^sha512-/);
    // The write-through's publishedIntegrity is a LOCAL pack (offline), not a re-fetch.
    const packCalls = state.calls.filter((c) => c.cmd === 'npm' && c.args[0] === 'pack');
    assert.equal(packCalls.length, 1, 'write-through packs the dist exactly once, locally');
    assert.ok(packCalls[0].args[1].startsWith('/'), 'must pack the LOCAL dist dir, not re-fetch from the registry');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('"cannot publish over previously published version" is treated as SUCCESS and still reconciles the cache (npm read-lag case)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'publish-impl-'));
  try {
    const distPkg = { name: '@adhd/pkg-b', version: '1.0.0' };
    const { context } = makeProject({ rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', distPkg });
    // Cache doesn't know it yet (stale/behind), but the registry actually already has it.
    const state = newState({
      publishStatus: 1,
      publishStderr: 'npm error 403 403 Forbidden - PUT https://registry.npmjs.org/@adhd%2fpkg-b - You cannot publish over the previously published versions: 1.0.0.',
    });
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const publishImpl = loadFreshImpl();

    const result = await publishImpl({}, context);
    assert.equal(result.success, true, 'must be treated as already-published, not a failure');
    const cached = JSON.parse(readFileSync(publishedStatePath(rootDir), 'utf8'));
    assert.equal(cached['@adhd/pkg-b'].version, '1.0.0', 'must still reconcile the cache from the local dist we attempted to publish');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a REAL publish failure (not the "already published" message) fails the task and does NOT write the cache', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'publish-impl-'));
  try {
    const distPkg = { name: '@adhd/pkg-b', version: '1.0.0' };
    const { context } = makeProject({ rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', distPkg });
    const state = newState({ publishStatus: 1, publishStderr: 'npm error 401 Unauthorized', viewStatus: 1 });
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const publishImpl = loadFreshImpl();

    const result = await publishImpl({}, context);
    assert.equal(result.success, false);
    assert.equal(existsSync(publishedStatePath(rootDir)), false, 'a real failure must never write a (wrong) cache entry');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('--dryRun: never writes the cache, even on a "successful" (dry) npm publish', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'publish-impl-'));
  try {
    const distPkg = { name: '@adhd/pkg-b', version: '1.0.0' };
    const { context } = makeProject({ rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', distPkg });
    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const publishImpl = loadFreshImpl();

    const result = await publishImpl({ dryRun: true }, context);
    assert.equal(result.success, true);
    const publishCalls = state.calls.filter((c) => c.cmd === 'npm' && c.args[0] === 'publish');
    assert.ok(publishCalls[0].args.includes('--dry-run'));
    assert.equal(existsSync(publishedStatePath(rootDir)), false, 'a dry run must never write published-state.json');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('DEBT-002 #2: defaults --access from the dist manifest\'s publishConfig.access when no explicit task option is given', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'publish-impl-'));
  try {
    const distPkg = { name: '@adhd/pkg-b', version: '1.0.0', publishConfig: { access: 'restricted' } };
    const { context, distDir } = makeProject({ rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', distPkg });

    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const publishImpl = loadFreshImpl();

    const result = await publishImpl({}, context);
    assert.equal(result.success, true);
    const publishCalls = state.calls.filter((c) => c.cmd === 'npm' && c.args[0] === 'publish');
    assert.equal(publishCalls.length, 1);
    const accessIdx = publishCalls[0].args.indexOf('--access');
    assert.equal(publishCalls[0].args[accessIdx + 1], 'restricted', 'must honor the package\'s own declared publishConfig.access, not hardcode public');
    assert.ok(publishCalls[0].args.includes(distDir));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('DEBT-002 #2: an explicit task option.access OVERRIDES the manifest\'s publishConfig.access', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'publish-impl-'));
  try {
    const distPkg = { name: '@adhd/pkg-b', version: '1.0.0', publishConfig: { access: 'restricted' } };
    const { context } = makeProject({ rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', distPkg });

    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const publishImpl = loadFreshImpl();

    const result = await publishImpl({ access: 'public' }, context);
    assert.equal(result.success, true);
    const publishCalls = state.calls.filter((c) => c.cmd === 'npm' && c.args[0] === 'publish');
    const accessIdx = publishCalls[0].args.indexOf('--access');
    assert.equal(publishCalls[0].args[accessIdx + 1], 'public', 'an explicit task option must win over the manifest\'s own declared access');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('DEBT-002 #2: no publishConfig.access declared and no option override -> unchanged default of "public" (every package in this workspace today)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'publish-impl-'));
  try {
    const distPkg = { name: '@adhd/pkg-b', version: '1.0.0' }; // no publishConfig at all
    const { context } = makeProject({ rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', distPkg });

    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const publishImpl = loadFreshImpl();

    const result = await publishImpl({}, context);
    assert.equal(result.success, true);
    const publishCalls = state.calls.filter((c) => c.cmd === 'npm' && c.args[0] === 'publish');
    const accessIdx = publishCalls[0].args.indexOf('--access');
    assert.equal(publishCalls[0].args[accessIdx + 1], 'public', 'must remain unchanged for every existing (public) package');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('BUG-005 write-through guard: a successful publish for an OLDER version than what the cache already recorded must NOT regress the cache', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'publish-impl-'));
  try {
    // Cache already recorded 2.0.0 as published (e.g. from a prior, correct
    // run). This run's dist somehow carries a REGRESSED 1.0.0 (the exact
    // shape `version/impl.js`'s own semver guard is meant to catch upstream —
    // this test proves `publish`'s write-through is a second, independent
    // line of defense: even if a regressed version slipped past that guard,
    // the cache itself must never be allowed to move backwards).
    const distPkg = { name: '@adhd/pkg-b', version: '1.0.0' };
    const { context } = makeProject({ rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', distPkg });
    writePublishedState(rootDir, {
      '@adhd/pkg-b': { version: '2.0.0', normalizedHash: 'sha256:the-real-2.0.0-hash', publishedIntegrity: 'sha512-real' },
    });

    const state = newState(); // npm publish "succeeds" (mock always returns status 0)
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const publishImpl = loadFreshImpl();

    const result = await publishImpl({}, context);
    assert.equal(result.success, true, 'the publish attempt itself is not what this guards — the write-through afterward is');
    const cached = JSON.parse(readFileSync(publishedStatePath(rootDir), 'utf8'));
    assert.equal(cached['@adhd/pkg-b'].version, '2.0.0', 'the cache must be left at the NEWER already-recorded version, never regressed to 1.0.0');
    assert.equal(cached['@adhd/pkg-b'].normalizedHash, 'sha256:the-real-2.0.0-hash', 'the existing (correct, newer) entry must be preserved verbatim, not partially overwritten');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('BUG-005 write-through guard: a NEWER version writes through normally (unchanged happy-path behavior)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'publish-impl-'));
  try {
    const distPkg = { name: '@adhd/pkg-b', version: '2.0.0' };
    const { context } = makeProject({ rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', distPkg });
    writePublishedState(rootDir, {
      '@adhd/pkg-b': { version: '1.0.0', normalizedHash: 'sha256:old', publishedIntegrity: 'sha512-old' },
    });

    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const publishImpl = loadFreshImpl();

    const result = await publishImpl({}, context);
    assert.equal(result.success, true);
    const cached = JSON.parse(readFileSync(publishedStatePath(rootDir), 'utf8'));
    assert.equal(cached['@adhd/pkg-b'].version, '2.0.0', 'a genuinely newer version must still write through normally');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('BUG-BUILD-PUBLISH-DISTMANIFEST-CLOBBERED-001: publish re-stamps dist/package.json from source, even if a sibling task (build) clobbered it with an un-rebased copy first', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'publish-impl-'));
  try {
    // Real source manifest: bin/exports point at ./dist/... (source-relative,
    // as authored), files:["dist",...] (a source-root allowlist), and a real
    // internal @adhd/* dependency range that must resolve to the sibling's
    // CURRENT on-disk version.
    const srcPkg = {
      name: '@adhd/pkg-b',
      version: '1.0.0',
      files: ['dist', 'CHANGELOG.md'],
      bin: { 'pkg-b': './dist/src/cli/run.js' },
      exports: { '.': { types: './dist/src/index.d.ts', default: './dist/src/index.js' } },
      dependencies: { '@adhd/pkg-dep': '^1.0.0' },
      devDependencies: { typescript: '^5.0.0' },
    };
    // Simulates `@nx/js:tsc`'s OWN un-rebased package.json emission INSIDE
    // dist/ (the exact corrupted shape observed on
    // agent-engine-compiler@2.1.7/2.1.8: source `files` verbatim — a
    // self-referential allowlist matching nothing once dist IS the package
    // root — un-rebased `bin`/`exports`, and `devDependencies` still present).
    const clobberedDistPkg = { ...srcPkg };
    const { pkgRoot, distDir, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', distPkg: clobberedDistPkg, srcPkg,
    });
    // A sibling project whose version has moved since `srcPkg` was authored —
    // proves the re-stamp re-resolves internal ranges from a LIVE snapshot,
    // not merely copying source's originally-authored range through.
    makeFiles(join(rootDir, 'packages/pkg-dep'), { 'package.json': JSON.stringify({ name: '@adhd/pkg-dep', version: '1.2.0' }) });
    context.projectsConfigurations.projects['pkg-dep'] = { root: 'packages/pkg-dep' };

    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const publishImpl = loadFreshImpl();

    const result = await publishImpl({}, context);
    assert.equal(result.success, true);

    // Negative control: if `publish` trusted the (clobbered) dist/package.json
    // as-is instead of re-stamping it, EVERY assertion below would fail —
    // this is exactly the shape that produced a 1-file (`package.json`-only)
    // tarball in production, because npm's `files` allowlist pointed at a
    // "dist" subdirectory that doesn't exist inside dist/ itself.
    const finalDistPkg = JSON.parse(readFileSync(join(distDir, 'package.json'), 'utf8'));
    assert.equal(finalDistPkg.files, undefined, 'source "files" allowlist must be stripped, not shipped verbatim into dist/package.json');
    assert.deepEqual(finalDistPkg.bin, { 'pkg-b': 'src/cli/run.js' }, 'bin must be rebased dist-root-relative with no leading ./, not left as ./dist/...');
    assert.equal(finalDistPkg.exports['.'].default, './src/index.js', 'exports must be rebased to dist-root-relative paths');
    assert.equal(finalDistPkg.devDependencies, undefined, 'devDependencies must never ship');
    assert.equal(finalDistPkg.dependencies['@adhd/pkg-dep'], '^1.2.0', 'internal @adhd/* range must resolve to the sibling\'s CURRENT on-disk version, not the originally-authored range');

    // And the actual `npm publish` call must have been given the RE-STAMPED
    // dist dir (publish reads name/version off the freshly written manifest).
    const publishCalls = state.calls.filter((c) => c.cmd === 'npm' && c.args[0] === 'publish');
    assert.equal(publishCalls.length, 1);
    assert.ok(publishCalls[0].args.includes(distDir));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('concurrency: N parallel publish tasks (simulating `nx run-many -t publish`) each write-through WITHOUT losing another\'s update', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'publish-impl-'));
  try {
    const N = 12;
    const contexts = [];
    for (let i = 0; i < N; i++) {
      const distPkg = { name: `@adhd/pkg-${i}`, version: '1.0.0' };
      // skipManifest: written once below, listing ALL N projects — writing it
      // per-project here (as the default helper does) would have each
      // iteration overwrite the previous one's single-project manifest.
      const { context } = makeProject({ rootDir, name: `pkg-${i}`, projectRoot: `packages/pkg-${i}`, distPkg, skipManifest: true });
      contexts.push(context);
    }
    writeReleaseManifest(rootDir, Array.from({ length: N }, (_, i) => `pkg-${i}`));
    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const publishImpl = loadFreshImpl();

    const results = await Promise.all(contexts.map((ctx) => publishImpl({}, ctx)));
    assert.ok(results.every((r) => r.success), 'every parallel publish must succeed');

    const cached = JSON.parse(readFileSync(publishedStatePath(rootDir), 'utf8'));
    assert.equal(Object.keys(cached).length, N, `expected all ${N} parallel write-throughs to land — a lost update would show up as a smaller count`);
    for (let i = 0; i < N; i++) {
      assert.equal(cached[`@adhd/pkg-${i}`].version, '1.0.0', `pkg-${i}'s write-through must be intact`);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// DEFECT 32af828b — post-publish retrievability verification.
//
// Proven here, with no network and no wall-clock:
//   * INTEGRATION (through the real executor + a genuinely-written state file):
//     a publish whose version is NOT retrievable returns success:false and the
//     state file is NOT written (the cache is not poisoned); a retrievable one
//     writes through and reports the verification.
//   * UNIT (lib/publish-verify.js's pure predicate + the bounded poll itself):
//     the whole "retrievable?" contract, the retry-until-found path, the
//     give-up-at-budget path, and the never-throw-on-transport-error guarantee.
// ---------------------------------------------------------------------------

test('defect 32af828b: a publish whose version is NOT retrievable FAILS and does NOT write published-state.json', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'publish-impl-'));
  try {
    const distPkg = { name: '@adhd/pkg-hidden', version: '1.0.0' };
    const { context } = makeProject({ rootDir, name: 'pkg-hidden', projectRoot: 'packages/pkg-hidden', distPkg });
    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const errors = [];
    t.mock.method(console, 'error', (...a) => errors.push(a.join(' ')));
    const publishImpl = loadFreshImpl();
    // npm publish "succeeds" (exit 0 — the HTTP 202 "being processed" case), but
    // the version never promotes, so every post-publish read is a 404.
    publishVerify.__setReadVersion(async () => ({ status: 404, body: null }));

    const res = await publishImpl({}, context);

    assert.equal(res.success, false, 'a 202-without-retrievability must be a FAILURE, not a success');
    assert.equal(
      existsSync(publishedStatePath(rootDir)),
      false,
      'the cache must NOT be poisoned — published-state.json is not written when the version is not retrievable'
    );
    const publishCalls = state.calls.filter((c) => c.cmd === 'npm' && c.args[0] === 'publish');
    assert.equal(publishCalls.length, 1, 'npm publish was still attempted before the verification vetoed it');
    assert.ok(errors.some((m) => /NOT retrievable/.test(m)), 'the failure must be reported as non-retrievability');
    assert.ok(errors.some((m) => /HTTP 202/.test(m)), 'the message must name the 202 lag, not a generic failure');
  } finally {
    publishVerify.__resetReadVersion();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('defect 32af828b: a publish whose version IS retrievable writes through and reports the verification', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'publish-impl-'));
  try {
    const distPkg = { name: '@adhd/pkg-promoted', version: '2.0.0' };
    const { context } = makeProject({ rootDir, name: 'pkg-promoted', projectRoot: 'packages/pkg-promoted', distPkg });
    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const errors = [];
    t.mock.method(console, 'error', (...a) => errors.push(a.join(' ')));
    const publishImpl = loadFreshImpl(); // loadFreshImpl installs the always-retrievable echo stub

    const res = await publishImpl({}, context);

    assert.equal(res.success, true);
    const cached = JSON.parse(readFileSync(publishedStatePath(rootDir), 'utf8'));
    assert.equal(cached['@adhd/pkg-promoted'].version, '2.0.0', 'the write-through must land once the version is verified');
    assert.ok(errors.some((m) => /verified over 1 attempt/.test(m)), 'success must record that the version was verified');
  } finally {
    publishVerify.__resetReadVersion();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('publish-verify.versionManifestMatches: only an exact 200-for-this-version is retrievable', () => {
  const { versionManifestMatches } = publishVerify;
  assert.equal(versionManifestMatches('@x/p', '1.0.0', 200, { name: '@x/p', version: '1.0.0' }), true);
  assert.equal(versionManifestMatches('@x/p', '1.0.0', 200, { version: '1.0.0' }), true, 'name is optional in the body');
  assert.equal(versionManifestMatches('@x/p', '1.0.0', 202, { version: '1.0.0' }), false, 'HTTP 202 (accepted, not promoted) is NOT retrievable');
  assert.equal(versionManifestMatches('@x/p', '1.0.0', 404, null), false);
  assert.equal(versionManifestMatches('@x/p', '1.0.0', 0, null), false, 'a transport failure is not retrievable');
  assert.equal(versionManifestMatches('@x/p', '1.0.0', 200, { version: '1.0.1' }), false, 'a different version is not this version');
  assert.equal(versionManifestMatches('@x/p', '1.0.0', 200, null), false);
  assert.equal(versionManifestMatches('@x/p', '1.0.0', 200, { name: '@x/other', version: '1.0.0' }), false, 'a name mismatch is not retrievable');
});

test('publish-verify.verifyVersionRetrievable: polls until the version appears, then stops', async () => {
  let fakeNow = 0;
  let reads = 0;
  const res = await publishVerify.verifyVersionRetrievable({
    name: '@x/p',
    version: '1.0.0',
    timeoutMs: 10_000,
    intervalMs: 100,
    now: () => fakeNow,
    sleep: async (ms) => { fakeNow += ms; },
    readVersion: async () => (++reads < 3 ? { status: 404, body: null } : { status: 200, body: { name: '@x/p', version: '1.0.0' } }),
  });
  assert.deepEqual(res, { retrievable: true, attempts: 3, lastStatus: 200 });
  assert.equal(reads, 3, 'must stop reading the moment the version is retrievable');
});

test('publish-verify.verifyVersionRetrievable: gives up at the budget and reports NOT retrievable', async () => {
  let fakeNow = 0;
  const res = await publishVerify.verifyVersionRetrievable({
    name: '@x/p',
    version: '1.0.0',
    timeoutMs: 150,
    intervalMs: 100,
    now: () => fakeNow,
    sleep: async (ms) => { fakeNow += ms; },
    readVersion: async () => ({ status: 404, body: null }),
  });
  assert.deepEqual(res, { retrievable: false, attempts: 3, lastStatus: 404 });
});

test('publish-verify.verifyVersionRetrievable: a throwing reader is not-retrievable, never thrown outward', async () => {
  const res = await publishVerify.verifyVersionRetrievable({
    name: '@x/p',
    version: '1.0.0',
    timeoutMs: 0,
    readVersion: async () => { throw new Error('ECONNRESET'); },
  });
  assert.deepEqual(res, { retrievable: false, attempts: 1, lastStatus: 0 }, 'a transient transport error must not abort the release as an exception');
});

test('publish-verify.versionUrl: scoped names encode the slash and a cache-buster is appended', () => {
  assert.match(publishVerify.versionUrl('@babel/core', '7.0.0', 'cb-123'), /^https:\/\/registry\.npmjs\.org\/@babel%2fcore\/7\.0\.0\?_=cb-123$/);
  assert.equal(publishVerify.versionUrl('left-pad', '1.0.0'), 'https://registry.npmjs.org/left-pad/1.0.0');
});
