/**
 * Teeth tests for the `version` executor's composition (impl.js) —
 * BUILD-TOOLING-VERSION-SYNC-DEPS-001 (orchestration/reuse),
 * PUBLISHED-STATE-CACHE-001 (cache-driven, zero-network happy path), and
 * BUILD-TOOLING-METRICS-001 (subprocess-overhead elimination).
 *
 * Covers what compare-published.spec.mjs (the pure decision core) and
 * reconcile-core.spec.mjs (the pure backfill core) cannot: the ORCHESTRATION
 * around them —
 *   - a CACHE HIT never touches npm/tar at all (Deliverables 1 + 2);
 *   - a CACHE MISS backfills exactly once (via the SAME reconcile-core.js
 *     logic the standalone `reconcile` task uses — not a duplicated
 *     reimplementation), then decides from the now-populated entry;
 *   - after deciding whether to bump, `run()` reconciles THIS package's own
 *     internal `@adhd/*` ranges directly from disk (`reconcileInternalRangesFromDisk`),
 *     writes only ITS OWN package.json, and never lets that reconciliation
 *     cause (or be caused by) a spurious own version bump.
 *
 * DEBT-BUILD-VERSION-SYNCDEPS-REDUNDANT-001 (b): `version` used to ALSO
 * delegate range reconciliation to the `deps` plugin's `sync-deps` (fix) /
 * `sync-deps-check` (dryRun) executors in-process — a SECOND, redundant run
 * of the full `@nx/dependency-checks` ESLint rule for the same project,
 * since `version`'s own `dependsOn` chain (`build` -> `lint` -> `sync-deps`)
 * already runs the real `sync-deps` for this exact project earlier in the
 * same task-graph invocation. That in-process call has been removed;
 * `reconcileOwnInternalRanges` now delegates SOLELY to
 * `reconcileInternalRangesFromDisk`. The tests below that still install
 * `installEslintCheckMock` retain it only to PROVE the deps-plugin executors
 * are never reached (`state.eslintCalls.length` must be `0` everywhere) — it
 * is a negative-space assertion, not a positive one.
 *
 * Mocking boundary: `node:child_process.spawnSync` is mocked for the real
 * `npm`/`tar`/`git`/`nx` process boundary. Everything else (compare-
 * published.js's real hashing/diffing, the real `reconcile-core.js` gate,
 * the real `lib/published-state.js` cache I/O, the real
 * `reconcileInternalRangesFromDisk` on-disk reconciliation, real file I/O)
 * runs for real.
 *
 * Run: node --test tools/nx-plugins/build/executors/version/impl.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import child_process from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// BUG (flaky CPU-guard trips under real machine load, test:build-tools):
// this file exercises the real `version` executor end-to-end, which wraps
// its work in `withMetrics` (BUILD-TOOLING-METRICS-001) — and `withMetrics`
// always runs the REAL `checkCpuGuard` (FEAT-NXMETRICS-CPU-GUARD-001) against
// a REAL `process.cpuUsage()` measurement of whatever brief work `run()` just
// did. On a loaded machine (e.g. many concurrent `node --test` workers) that
// real measured % can legitimately exceed the default
// `ADHD_NX_METRICS_MAX_CPU_PCT=300` threshold for these short bursts, tripping
// the guard and failing a test that has nothing to do with the guard itself.
// The guard's own pass/fail LOGIC is fully covered, deterministically (mocked
// `process.cpuUsage()`), by `tools/nx-plugins/lib/metrics.spec.mjs` — this
// file only asserts version/cache/sync-deps orchestration, so disable the
// guard here (metrics recording, including the real `cpuPercent` value,
// still happens; only the throw-on-trip is turned off).
process.env.ADHD_NX_METRICS_MAX_CPU_PCT = '0';

const require = createRequire(import.meta.url);
const implAbs = require.resolve('./impl.js');
const reconcileCoreAbs = require.resolve('../reconcile/reconcile-core.js');
const npmRegistryAbs = require.resolve('../../lib/npm-registry.js');
const publishedStateAbs = require.resolve('../../lib/published-state.js');
const syncAbs = require.resolve('../../../deps/executors/sync/impl.js');
const checkAbs = require.resolve('../../../deps/executors/check/impl.js');
const NX_BIN = require.resolve('nx/bin/nx.js');

/** Force impl.js AND every module it (transitively) requires that itself
 * touches `node:child_process.spawnSync` to reload, so their top-level
 * `const { spawnSync } = require('node:child_process')` picks up whatever
 * mock is currently installed on the (singleton) child_process module. */
function resetAll() {
  delete require.cache[implAbs];
  delete require.cache[reconcileCoreAbs];
  delete require.cache[npmRegistryAbs];
  delete require.cache[publishedStateAbs];
  delete require.cache[syncAbs];
  delete require.cache[checkAbs];
}
function loadFreshImpl() {
  resetAll();
  return require(implAbs);
}

/**
 * Install the `__internals.runDependencyCheck` mock on BOTH the fresh
 * sync/check modules `impl.js` used to call (before
 * DEBT-BUILD-VERSION-SYNCDEPS-REDUNDANT-001 (b) removed that in-process
 * call) — call AFTER `loadFreshImpl()`. `state.eslintCalls` now exists
 * purely as a NEGATIVE-SPACE probe: `version` no longer reaches the `deps`
 * plugin's sync/check executors at all, so every test below asserts
 * `state.eslintCalls.length === 0` — proof the redundant call stays gone,
 * not evidence it ran correctly.
 */
function installEslintCheckMock(state) {
  const fn = async (pkgJsonPath, extraArgs) => {
    state.eslintCalls.push([pkgJsonPath, ...extraArgs]);
    return state.eslintStatus ?? 0;
  };
  require(syncAbs).__internals.runDependencyCheck = fn;
  require(checkAbs).__internals.runDependencyCheck = fn;
}

/** Materialize a directory from a {relpath: contents} map. */
function makeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
}

/** sha512-<base64> of a string/Buffer's bytes — matches npm-registry.js's `tarballIntegrity` format. */
function integrityOf(content) {
  return `sha512-${createHash('sha512').update(Buffer.from(content)).digest('base64')}`;
}

/**
 * Fabricate a `spawnSync` stand-in that fakes the OS-process boundary:
 *  - `npm view <name> versions --json`                    -> state.publishedVersions
 *  - `npm view <name>@<v> dist.integrity`                  -> state.publishedIntegrity
 *    (undefined/null -> npm-view "not found", forcing the reconcile
 *    integrity gate's SLOW/tarball-pull path — the default here, so tests
 *    that don't care about the fast path get the old, fully-materialized
 *    published-dir behavior by default)
 *  - `npm pack <ABSOLUTE local dir path> --pack-destination <dir> --json`
 *    (packLocalDir, offline)                                -> writes a
 *    tarball with bytes `state.localTgzContent` (default: a fixed string,
 *    deliberately never equal to `state.publishedIntegrity` unless a test
 *    opts in, to force the slow path by default)
 *  - `npm pack <name>@<v> --pack-destination <dir> --json`  -> writes a dummy
 *    .tgz and reports its filename (real tar/npm never run)
 *  - `tar -xzf <tgz> -C <dir>`                              -> materializes
 *    state.publishedFiles directly under <dir>/package (skips real extraction)
 *  - `<nx bin> release changelog ...`                       -> records into
 *    state.changelogCalls and returns state.changelogStatus (default 0)
 *
 * The `deps/executors/sync|check` dependency-check call is never made by
 * `version` at all anymore (DEBT-BUILD-VERSION-SYNCDEPS-REDUNDANT-001 (b)) —
 * `installEslintCheckMock` above still installs the mock at its
 * `__internals.runDependencyCheck` seam, purely so tests can assert
 * `state.eslintCalls.length === 0` (proof it's never reached).
 */
function makeSpawnSyncMock(state) {
  return (cmd, args = [], _opts = {}) => {
    state.calls.push({ cmd, args });
    if (cmd === 'npm' && args[0] === 'view' && args[2] === 'versions') {
      return { status: 0, stdout: JSON.stringify(state.publishedVersions ?? []), stderr: '' };
    }
    if (cmd === 'npm' && args[0] === 'view' && args[2] === 'dist.integrity') {
      if (state.publishedIntegrity == null) return { status: 1, stdout: '', stderr: 'npm error E404' };
      return { status: 0, stdout: state.publishedIntegrity, stderr: '' };
    }
    if (cmd === 'npm' && args[0] === 'pack' && String(args[1]).startsWith('/')) {
      // packLocalDir — an absolute filesystem path, never a `name@version` spec.
      const destIdx = args.indexOf('--pack-destination');
      const workDir = args[destIdx + 1];
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, 'local-fake.tgz'), state.localTgzContent ?? 'local-tgz-bytes\n');
      return { status: 0, stdout: JSON.stringify([{ filename: 'local-fake.tgz' }]), stderr: '' };
    }
    if (cmd === 'npm' && args[0] === 'pack') {
      // fetchPublished — a `name@version` registry spec.
      const destIdx = args.indexOf('--pack-destination');
      const workDir = args[destIdx + 1];
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, 'fake-0.0.0.tgz'), 'not a real tarball\n');
      return { status: 0, stdout: JSON.stringify([{ filename: 'fake-0.0.0.tgz' }]), stderr: '' };
    }
    if (cmd === 'tar') {
      const workDir = args[3];
      const pkgDir = join(workDir, 'package');
      makeFiles(pkgDir, state.publishedFiles ?? {});
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'git' && args[0] === 'log') {
      return { status: 0, stdout: state.lastChangelogSha ?? '', stderr: '' };
    }
    // BUILD-TOOLING-METRICS-001: `nx release changelog` is now invoked as
    // `node <nx/bin/nx.js> release changelog ...` directly (never `npx nx
    // ...` — npx's own resolution overhead was pure waste in a monorepo
    // where the local `nx` binary is always already known). `args[0]` is the
    // resolved nx bin path; the actual CLI argv starts at `args[1]`.
    if (cmd === process.execPath && args[0] === NX_BIN && args[1] === 'release' && args[2] === 'changelog') {
      state.changelogCalls.push(args.slice(1));
      // A real `nx release changelog` writes CHANGELOG.md; tests that need the
      // scrub path to have a file to act on provide `state.changelogWrite`
      // (an { absolutePath: contents } map). Absent -> write nothing (the
      // default, mirroring a no-op mock).
      if (state.changelogWrite) {
        for (const [abs, contents] of Object.entries(state.changelogWrite)) writeFileSync(abs, contents);
      }
      return { status: state.changelogStatus ?? 0, stdout: '', stderr: state.changelogStatus ? 'boom' : '' };
    }
    throw new Error(`unexpected spawnSync in test mock: ${cmd} ${JSON.stringify(args)}`);
  };
}

/** Build a temp {rootDir, projectRoot} with a dist + source package.json, and a matching context. */
function makeProject({ rootDir, name, projectRoot, srcPkg, distFiles }) {
  const pkgRoot = join(rootDir, projectRoot);
  makeFiles(pkgRoot, { 'package.json': JSON.stringify(srcPkg, null, 2) });
  makeFiles(join(pkgRoot, 'dist'), distFiles);
  const context = {
    root: rootDir,
    projectName: name,
    projectsConfigurations: { projects: { [name]: { root: projectRoot } } },
  };
  return { pkgRoot, srcPkgPath: join(pkgRoot, 'package.json'), context };
}

function newState(overrides = {}) {
  return { calls: [], eslintCalls: [], changelogCalls: [], publishedVersions: [], publishedFiles: {}, eslintStatus: 0, changelogStatus: 0, ...overrides };
}

/** Every spawnSync call this run made that hit the registry or the tarball layer (npm/tar) — the zero-network assertion helper. */
function networkCalls(state) {
  return state.calls.filter((c) => c.cmd === 'npm' || c.cmd === 'tar');
}

function publishedStatePath(rootDir) {
  return join(rootDir, 'published-state.json');
}

function writePublishedState(rootDir, entries) {
  writeFileSync(publishedStatePath(rootDir), JSON.stringify(entries, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// DEBT-BUILD-VERSION-SYNCDEPS-REDUNDANT-001 (b) — `version` must NEVER
// invoke the `deps` plugin's `sync-deps`/`sync-deps-check` executors
// in-process anymore. That in-process call was a provably redundant SECOND
// run of the full `@nx/dependency-checks` ESLint rule per project per
// `version` invocation — the real `sync-deps` already ran for this exact
// project earlier in the same task-graph invocation, via `version`'s own
// `dependsOn:["build",...]` -> `build`'s `dependsOn:["^build","lint"]` ->
// `lint`'s `dependsOn:["sync-deps"]` (nx.json targetDefaults). Internal-range
// drift is instead reconciled solely via `reconcileInternalRangesFromDisk`
// (see the dedicated STALE-GRAPH FIX test block further below).
// ---------------------------------------------------------------------------

test('DEBT-BUILD-VERSION-SYNCDEPS-REDUNDANT-001 (b): a REAL bump never invokes the deps-plugin sync/check executors — only reconcileInternalRangesFromDisk runs', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    makeFiles(join(rootDir, 'packages/pkg-a'), { 'package.json': JSON.stringify({ name: '@adhd/pkg-a', version: '2.0.0' }, null, 2) });
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: { '@adhd/pkg-a': '^1.0.0' } };
    const { pkgRoot, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', srcPkg: localPkg,
      distFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 2;\n' }, // NEW code -> real bump
    });
    context.projectsConfigurations.projects['pkg-a'] = { root: 'packages/pkg-a' };
    const state = newState({
      publishedVersions: ['1.0.0'],
      publishedFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 1;\n' },
    });
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, true);
    assert.equal(state.eslintCalls.length, 0, 'a real bump must NEVER invoke the deps-plugin sync/check executors — the upstream lint->sync-deps pass already covered this project');
    const after = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    assert.equal(after.version, '1.0.1', 'the bump itself must still happen');
    assert.equal(after.dependencies['@adhd/pkg-a'], '^2.0.0', 'the internal range must still be reconciled — by reconcileInternalRangesFromDisk alone');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('DEBT-BUILD-VERSION-SYNCDEPS-REDUNDANT-001 (b): a dry run never invokes the deps-plugin sync/check executors — only reconcileInternalRangesFromDisk runs (read-only)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    makeFiles(join(rootDir, 'packages/pkg-a'), { 'package.json': JSON.stringify({ name: '@adhd/pkg-a', version: '2.0.0' }, null, 2) });
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: { '@adhd/pkg-a': '^1.0.0' } };
    const { pkgRoot, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', srcPkg: localPkg,
      distFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'x\n' },
    });
    context.projectsConfigurations.projects['pkg-a'] = { root: 'packages/pkg-a' };
    const before = readFileSync(join(pkgRoot, 'package.json'), 'utf8');

    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({ dryRun: true }, context);
    assert.equal(result.success, true);
    assert.equal(state.eslintCalls.length, 0, 'a dry run must NEVER invoke the deps-plugin sync/check executors either');
    const after = readFileSync(join(pkgRoot, 'package.json'), 'utf8');
    assert.equal(after, before, 'dry run must never write package.json');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PUBLISHED-STATE-CACHE-001 — cache HIT: zero-network happy path
// ---------------------------------------------------------------------------

test('cache HIT, unchanged: ZERO network calls (no npm/tar spawnSync at all), no bump', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: {} };
    const distFiles = { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 1;\n' };
    const { pkgRoot, context } = makeProject({ rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', srcPkg: localPkg, distFiles });
    // Pre-populate the cache with the EXACT local dist's normalizedHash.
    const { normalizedHash } = require('./compare-published.js');
    const localDist = join(pkgRoot, 'dist');
    writePublishedState(rootDir, {
      '@adhd/pkg-b': { version: '1.0.0', normalizedHash: normalizedHash(localDist), publishedIntegrity: 'sha512-whatever' },
    });

    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, true);
    assert.deepEqual(networkCalls(state), [], 'a cache hit must NEVER touch npm or tar');
    assert.equal(state.eslintCalls.length, 0, 'DEBT-BUILD-VERSION-SYNCDEPS-REDUNDANT-001 (b): version must NEVER invoke the deps-plugin sync/check executors — range reconciliation is on-disk only');
    const after = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    assert.equal(after.version, '1.0.0', 'unchanged vs the cached published hash -> no bump');

    // BUILD-TOOLING-METRICS-001: `run()` records a 'version' task-run. There
    // is no NESTED 'sync-deps' record anymore — DEBT-BUILD-VERSION-SYNCDEPS-
    // REDUNDANT-001 (b) removed the in-process reconciliation call that used
    // to produce one; `reconcileInternalRangesFromDisk` is a plain on-disk
    // read/write, not a metrics-recorded sub-task.
    const metricsAbs = require.resolve('../../../lib/metrics.js');
    delete require.cache[metricsAbs];
    const { readMetrics } = require(metricsAbs);
    const { records } = readMetrics(rootDir);
    const versionRecords = records.filter((r) => r.task === 'version');
    const syncDepsRecords = records.filter((r) => r.task === 'sync-deps');
    assert.equal(versionRecords.length, 1);
    assert.equal(versionRecords[0].project, 'pkg-b');
    assert.equal(versionRecords[0].success, true);
    assert.equal(syncDepsRecords.length, 0, 'no nested sync-deps metrics record — the in-process call that produced it is gone');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('BUG-BUILD-ASSETS-CACHE-STALE-AFTER-CLEAN-001: a dist/ MISSING README.md (as a stale `assets` cache-hit after a fresh `build` clean would leave it) is repaired before hashing, so an unchanged package does NOT spuriously bump', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const srcPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: {} };
    const README = '# pkg-b\n\nReal docs.\n';
    // The published tarball DOES have README.md (assets ran correctly at
    // publish time) — this is the cache's baseline.
    const { generateDistManifest } = require('../manifest/generate-manifest.js');
    const correctDistManifest = generateDistManifest(srcPkg, {});
    const distFilesCorrect = { 'package.json': JSON.stringify(correctDistManifest), 'index.js': 'export const x = 1;\n', 'README.md': README };
    const tmpCheck = mkdtempSync(join(tmpdir(), 'version-impl-hashcheck-'));
    let publishedHash;
    try {
      makeFiles(tmpCheck, distFilesCorrect);
      const { normalizedHash } = require('./compare-published.js');
      publishedHash = normalizedHash(tmpCheck);
    } finally {
      rmSync(tmpCheck, { recursive: true, force: true });
    }

    // But the CURRENT on-disk dist is missing README.md — exactly the shape
    // left behind when `build`'s `clean:true` wipes `dist/` and a stale
    // `assets` cache-hit skips re-copying it.
    const distFilesStale = { 'package.json': JSON.stringify(correctDistManifest), 'index.js': 'export const x = 1;\n' };
    const { pkgRoot, context } = makeProject({ rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', srcPkg, distFiles: distFilesStale });
    // The real source project root DOES have a README.md (assets re-copies FROM here).
    makeFiles(pkgRoot, { 'README.md': README });
    writePublishedState(rootDir, {
      '@adhd/pkg-b': { version: '1.0.0', normalizedHash: publishedHash, publishedIntegrity: 'sha512-whatever' },
    });

    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    assert.equal(existsSync(join(pkgRoot, 'dist', 'README.md')), false, 'sanity: dist starts WITHOUT README.md');
    const result = await versionImpl({}, context);
    assert.equal(result.success, true);
    // Negative control: without repairing dist before hashing, README.md's
    // absence would make `normalizedHash` differ from the published hash and
    // spuriously bump a package with zero real code changes — forever, on
    // every future run too (observed live: agent-store-tools 2.1.7 -> 2.1.8
    // -> 2.1.9 -> … with "there were no code changes" on every entry).
    assert.equal(existsSync(join(pkgRoot, 'dist', 'README.md')), true, 're-stamp must restore the missing README.md before hashing');
    assert.equal(readFileSync(join(pkgRoot, 'dist', 'README.md'), 'utf8'), README);
    const after = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    assert.equal(after.version, '1.0.0', 'a package with no real content change must NOT bump, even if dist was missing an asset before this run');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('BUG-BUILD-PUBLISH-DISTMANIFEST-CLOBBERED-001: a CORRUPTED dist/package.json (as `build` alone would leave it) is re-stamped before hashing, so an unchanged package does NOT spuriously bump', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    // Real source manifest — bin/exports source-relative, a "files" allowlist,
    // devDependencies present, and an internal @adhd/* dependency.
    const srcPkg = {
      name: '@adhd/pkg-b',
      version: '1.0.0',
      files: ['dist', 'CHANGELOG.md'],
      bin: { 'pkg-b': './dist/src/cli/run.js' },
      exports: { '.': { types: './dist/src/index.d.ts', default: './dist/src/index.js' } },
      dependencies: { '@adhd/pkg-dep': '^1.0.0' },
      devDependencies: { typescript: '^5.0.0' },
    };
    // The CORRECT, dist-manifest'd shape (what a prior successful publish
    // actually shipped and what the cache's normalizedHash was computed from).
    const { generateDistManifest } = require('../manifest/generate-manifest.js');
    const correctDistManifest = generateDistManifest(srcPkg, { '@adhd/pkg-dep': '1.0.0' });
    const distFilesCorrect = { 'package.json': JSON.stringify(correctDistManifest), 'src/index.js': 'export const x = 1;\n' };

    // Compute the cache's baseline against the CORRECT (un-corrupted) dist —
    // this is what got published and cached last time.
    const tmpCheck = mkdtempSync(join(tmpdir(), 'version-impl-hashcheck-'));
    try {
      makeFiles(tmpCheck, distFilesCorrect);
      var { normalizedHash } = require('./compare-published.js');
      var publishedHash = normalizedHash(tmpCheck);
    } finally {
      rmSync(tmpCheck, { recursive: true, force: true });
    }

    // But the ACTUAL on-disk dist right now is CORRUPTED — as `@nx/js:tsc`'s
    // `build` (un-rebased bin/exports, source `files`, devDependencies still
    // present) would leave it if it (re)ran after `dist-manifest` last time.
    const clobberedDistManifest = { ...srcPkg };
    const distFilesCorrupted = { 'package.json': JSON.stringify(clobberedDistManifest), 'src/index.js': 'export const x = 1;\n' };
    const { pkgRoot, context } = makeProject({ rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', srcPkg, distFiles: distFilesCorrupted });
    makeFiles(join(rootDir, 'packages/pkg-dep'), { 'package.json': JSON.stringify({ name: '@adhd/pkg-dep', version: '1.0.0' }) });
    context.projectsConfigurations.projects['pkg-dep'] = { root: 'packages/pkg-dep' };
    writePublishedState(rootDir, {
      '@adhd/pkg-b': { version: '1.0.0', normalizedHash: publishedHash, publishedIntegrity: 'sha512-whatever' },
    });

    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, true);
    // Negative control: without the re-stamp, `normalizedHash` would hash the
    // CORRUPTED dist (files/bin/exports/devDependencies all differing from
    // the published, correct shape) and see "changed" — spuriously bumping a
    // package with ZERO real code changes, forever, on every future run too.
    assert.deepEqual(networkCalls(state), [], 'a cache hit (after correct re-stamping) must never touch npm or tar');
    const after = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    assert.equal(after.version, '1.0.0', 'a package with no real content change must NOT bump, even if dist was corrupted before this run');
    // And the corruption itself must actually be fixed on disk, not merely worked around in-memory.
    const distPkgNow = JSON.parse(readFileSync(join(pkgRoot, 'dist', 'package.json'), 'utf8'));
    assert.equal(distPkgNow.files, undefined, 're-stamp must strip the source "files" allowlist');
    assert.deepEqual(distPkgNow.bin, { 'pkg-b': 'src/cli/run.js' }, 're-stamp must rebase bin');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cache HIT, changed: ZERO network calls, still bumps correctly', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: {} };
    const distFiles = { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 2;\n' }; // NEW code
    const { pkgRoot, context } = makeProject({ rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', srcPkg: localPkg, distFiles });
    // Cache holds the hash of the OLD published content (different index.js).
    const { normalizedHash } = require('./compare-published.js');
    const oldPublishedDir = mkdtempSync(join(tmpdir(), 'old-published-'));
    makeFiles(oldPublishedDir, { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 1;\n' });
    writePublishedState(rootDir, {
      '@adhd/pkg-b': { version: '1.0.0', normalizedHash: normalizedHash(oldPublishedDir), publishedIntegrity: 'sha512-whatever' },
    });
    rmSync(oldPublishedDir, { recursive: true, force: true });

    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, true);
    assert.deepEqual(networkCalls(state), [], 'a cache hit must NEVER touch npm or tar, even when the package DID change (Deliverable 2)');
    const after = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    assert.equal(after.version, '1.0.1', 'a real code change vs the cached hash must still bump');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cache HIT but source already ahead of the cached version: ZERO network, treated as "release pending"', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.1', main: './index.js', dependencies: {} }; // already bumped locally
    const distFiles = { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 2;\n' };
    const { pkgRoot, context } = makeProject({ rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', srcPkg: localPkg, distFiles });
    writePublishedState(rootDir, {
      '@adhd/pkg-b': { version: '1.0.0', normalizedHash: 'sha256:irrelevant', publishedIntegrity: 'sha512-whatever' },
    });

    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, true);
    assert.deepEqual(networkCalls(state), [], 'must never touch the network just to notice source is already ahead of the cache');
    const after = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    assert.equal(after.version, '1.0.1', 'must be left exactly as-is — release already pending');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// BUG-005 — semver-DIRECTIONAL check on `cached.version !== version`
// ---------------------------------------------------------------------------

test('BUG-005 REGRESSION-LOWER: source version BEHIND the cache\'s recorded published version is a HARD FAILURE, not "release pending"', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    // Source has REVERTED to 1.0.0 (a bad merge / stale branch rebuilt),
    // while the cache already recorded 1.0.1 as published.
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: {} };
    const distFiles = { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 1;\n' };
    const { pkgRoot, context } = makeProject({ rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', srcPkg: localPkg, distFiles });
    writePublishedState(rootDir, {
      '@adhd/pkg-b': { version: '1.0.1', normalizedHash: 'sha256:irrelevant', publishedIntegrity: 'sha512-whatever' },
    });

    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, false, 'a version regression relative to the published-state cache must fail, never silently pass');
    assert.deepEqual(networkCalls(state), [], 'detecting the regression itself must still be zero-network — the cache alone is enough to know');
    const after = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    assert.equal(after.version, '1.0.0', 'a failed regression gate must never rewrite the (already-wrong) source version');
    // Negative control for the poisoning hazard this fix closes: with the old
    // `!==` check, this exact scenario was silently treated as "release
    // pending", and — had `publish` run next — its own `cached.version ===
    // version` existence check would MISS (1.0.1 !== 1.0.0), `npm publish`
    // would be attempted for the OLD 1.0.0, npm would reject with "cannot
    // publish over previously published version", and the write-through path
    // would then overwrite the cache's 1.0.1 entry with a hash computed from
    // the CURRENT (regressed) 1.0.0 dist — permanently poisoning
    // published-state.json. Failing loudly HERE is what prevents all of that.
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('BUG-005 boundary: source version EQUAL to the cache\'s recorded version is NOT a regression (falls through to the normal hash-compare path)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: {} };
    const distFiles = { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 1;\n' };
    const { pkgRoot, context } = makeProject({ rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', srcPkg: localPkg, distFiles });
    const { normalizedHash } = require('./compare-published.js');
    writePublishedState(rootDir, {
      '@adhd/pkg-b': { version: '1.0.0', normalizedHash: normalizedHash(join(pkgRoot, 'dist')), publishedIntegrity: 'sha512-whatever' },
    });

    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, true, 'an EQUAL version is never a regression — this must reach the hash-compare path and succeed normally');
    assert.deepEqual(networkCalls(state), []);
    const after = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    assert.equal(after.version, '1.0.0', 'unchanged content vs published -> no bump');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('BUG-005 boundary: source version AHEAD of the cache\'s recorded version is the legitimate "release pending" case (unchanged behavior)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.1', main: './index.js', dependencies: {} }; // already bumped locally
    const distFiles = { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 2;\n' };
    const { pkgRoot, context } = makeProject({ rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', srcPkg: localPkg, distFiles });
    writePublishedState(rootDir, {
      '@adhd/pkg-b': { version: '1.0.0', normalizedHash: 'sha256:irrelevant', publishedIntegrity: 'sha512-whatever' },
    });

    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, true, 'source ahead of the cache is a legitimate pending release, not a regression');
    assert.deepEqual(networkCalls(state), []);
    const after = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    assert.equal(after.version, '1.0.1', 'must be left exactly as-is — release already pending');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cache HIT, integrity fast path used at backfill time is directly consumable later with zero network (end-to-end: miss -> populate -> hit)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: {} };
    const distFiles = { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 1;\n' };
    const { pkgRoot, context } = makeProject({ rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', srcPkg: localPkg, distFiles });

    // Run 1: cold cache -> backfill fires, and (fast path) integrity MATCHES,
    // so no tarball is ever pulled even on this first, cache-populating run.
    const matchingIntegrity = integrityOf('local-tgz-bytes\n'); // must equal packLocalDir's default fake tgz bytes
    const state1 = newState({ publishedVersions: ['1.0.0'], publishedIntegrity: matchingIntegrity });
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state1));
    let versionImpl = loadFreshImpl();
    installEslintCheckMock(state1);
    const result1 = await versionImpl({}, context);
    assert.equal(result1.success, true);
    assert.ok(existsSync(publishedStatePath(rootDir)), 'backfill must have populated published-state.json');
    const tarCalls1 = state1.calls.filter((c) => c.cmd === 'tar');
    assert.deepEqual(tarCalls1, [], 'the FAST path (integrity match) must never pull/extract a tarball, even on the populating run');
    const after1 = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    assert.equal(after1.version, '1.0.0', 'local content matches what was just confirmed published -> no bump');

    // Run 2: SAME cache, now warm -> must be entirely zero-network.
    const state2 = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state2));
    versionImpl = loadFreshImpl();
    installEslintCheckMock(state2);
    const result2 = await versionImpl({}, context);
    assert.equal(result2.success, true);
    assert.deepEqual(networkCalls(state2), [], 'the second run, against the now-warm cache, must be entirely zero-network');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PUBLISHED-STATE-CACHE-001 — cache MISS: single-package backfill
// ---------------------------------------------------------------------------

test('"not yet published" path (cache miss -> backfill -> still pending): reconciles the internal range on-disk, never via the deps-plugin executors, and writes NO cache entry', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const { pkgRoot, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b',
      srcPkg: { name: '@adhd/pkg-b', version: '9.9.9', dependencies: { '@adhd/pkg-a': '^1.0.0' } },
      distFiles: { 'package.json': JSON.stringify({ name: '@adhd/pkg-b', version: '9.9.9' }), 'index.js': 'x\n' },
    });
    // DEBT-002 #1: writeDistManifest now hard-gates on any @adhd/* dependency
    // that doesn't resolve to a real on-disk sibling — register pkg-a as a
    // real workspace project so this test's own (unrelated) cache-miss/
    // backfill scenario isn't collaterally blocked by that gate.
    makeFiles(join(rootDir, 'packages/pkg-a'), { 'package.json': JSON.stringify({ name: '@adhd/pkg-a', version: '1.0.0' }) });
    context.projectsConfigurations.projects['pkg-a'] = { root: 'packages/pkg-a' };
    const state = newState({ publishedVersions: [] }); // never published
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, true);
    assert.equal(state.eslintCalls.length, 0, 'DEBT-BUILD-VERSION-SYNCDEPS-REDUNDANT-001 (b): must NEVER invoke the deps-plugin sync/check executors — reconciliation is on-disk only');
    assert.equal(existsSync(publishedStatePath(rootDir)), false, '"pending" (never published) must never write a cache entry');
    // Version untouched (no dist to compare against — release is already pending).
    const after = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    assert.equal(after.version, '9.9.9');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('dry run: reconciliation is read-only on-disk, NEVER writes package.json, and never invokes the deps-plugin executors', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const { pkgRoot, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b',
      srcPkg: { name: '@adhd/pkg-b', version: '9.9.9', dependencies: {} },
      distFiles: { 'package.json': JSON.stringify({ name: '@adhd/pkg-b', version: '9.9.9' }), 'index.js': 'x\n' },
    });
    const before = readFileSync(join(pkgRoot, 'package.json'), 'utf8');
    const state = newState({ publishedVersions: [], eslintStatus: 1 }); // even if the (unreached) mock would report a "failure"
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({ dryRun: true }, context);
    assert.equal(result.success, true, 'a dry run must never fail — reconcileInternalRangesFromDisk only logs on a dry run, never throws/fails');
    assert.equal(state.eslintCalls.length, 0, 'DEBT-BUILD-VERSION-SYNCDEPS-REDUNDANT-001 (b): dry run must NEVER invoke the deps-plugin sync/check executors');
    const after = readFileSync(join(pkgRoot, 'package.json'), 'utf8');
    assert.equal(after, before, 'dry run must never write package.json');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('ADHD_NX_VERSION_DRY_RUN=1 env var forces dry-run behavior even when options.dryRun is NOT set (BUG-NX-RUNMANY-DRYRUN-NOT-PROPAGATED-TO-DEPENDENCY-TASKS-001 mitigation)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  const prevEnv = process.env.ADHD_NX_VERSION_DRY_RUN;
  try {
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: {} };
    const { pkgRoot, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b',
      srcPkg: localPkg,
      distFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 2;\n' }, // would normally bump
    });
    const before = readFileSync(join(pkgRoot, 'package.json'), 'utf8');
    const state = newState({
      publishedVersions: ['1.0.0'],
      publishedFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 1;\n' },
    });
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    process.env.ADHD_NX_VERSION_DRY_RUN = '1';
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    // Note: options.dryRun is deliberately OMITTED here — simulating a
    // dependency task that `nx run-many --dryRun` failed to propagate the
    // CLI flag to. The env var must still force dry-run behavior.
    const result = await versionImpl({}, context);
    assert.equal(result.success, true);
    const after = readFileSync(join(pkgRoot, 'package.json'), 'utf8');
    assert.equal(after, before, 'env-var dry run must never write, even though a real code change would otherwise bump');
    assert.equal(state.eslintCalls.length, 0, 'DEBT-BUILD-VERSION-SYNCDEPS-REDUNDANT-001 (b): env-var dry run must NEVER invoke the deps-plugin sync/check executors');
  } finally {
    if (prevEnv === undefined) delete process.env.ADHD_NX_VERSION_DRY_RUN;
    else process.env.ADHD_NX_VERSION_DRY_RUN = prevEnv;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('published (cache miss, backfill) + range-only drift vs published tarball: does NOT bump, but DOES reconcile the range (no cascade, no false positive)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: { '@adhd/pkg-a': '^1.1.0' } };
    const publishedPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: { '@adhd/pkg-a': '^1.0.0' } }; // only the internal range is stale
    const { pkgRoot, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b',
      srcPkg: localPkg,
      distFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 1;\n' },
    });
    // DEBT-002 #1: writeDistManifest now hard-gates on any @adhd/* dependency
    // absent from the workspace version map — register pkg-a as a real
    // sibling project so this test's own range-only-drift scenario isn't
    // collaterally blocked.
    makeFiles(join(rootDir, 'packages/pkg-a'), { 'package.json': JSON.stringify({ name: '@adhd/pkg-a', version: '1.1.0' }) });
    context.projectsConfigurations.projects['pkg-a'] = { root: 'packages/pkg-a' };
    const state = newState({
      publishedVersions: ['1.0.0'],
      publishedFiles: { 'package.json': JSON.stringify(publishedPkg), 'index.js': 'export const x = 1;\n' },
    });
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, true);
    const after = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    assert.equal(after.version, '1.0.0', 'a range-only diff vs published must NOT bump the own version');
    assert.equal(state.eslintCalls.length, 0, 'DEBT-BUILD-VERSION-SYNCDEPS-REDUNDANT-001 (b): must NEVER invoke the deps-plugin sync/check executors — the internal range is already correct on disk, reconciled via reconcileInternalRangesFromDisk alone');
    assert.ok(existsSync(publishedStatePath(rootDir)), 'the backfill must have populated the cache');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('published (cache miss, backfill) + REAL code drift: DOES bump, then reconciles ranges afterward', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: {} };
    const { pkgRoot, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b',
      srcPkg: localPkg,
      distFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 2;\n' }, // NEW code
    });
    const state = newState({
      publishedVersions: ['1.0.0'],
      publishedFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 1;\n' }, // OLD published code
    });
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, true);
    const after = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    assert.equal(after.version, '1.0.1', 'a genuine code change must still bump (unchanged pre-existing behavior)');
    assert.equal(state.eslintCalls.length, 0, 'DEBT-BUILD-VERSION-SYNCDEPS-REDUNDANT-001 (b): must NEVER invoke the deps-plugin sync/check executors, even after a real bump');
    const cached = JSON.parse(readFileSync(publishedStatePath(rootDir), 'utf8'));
    assert.equal(cached['@adhd/pkg-b'].version, '1.0.0', 'cache records the PUBLISHED version (pre-bump), not the new local one');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('published (cache miss, backfill) + REAL code drift: generates a CHANGELOG.md entry via real `nx release changelog`, --first-release when no prior entry commit is known', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: {} };
    const { context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b',
      srcPkg: localPkg,
      distFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 2;\n' },
    });
    const state = newState({
      publishedVersions: ['1.0.0'],
      publishedFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 1;\n' },
      lastChangelogSha: '', // no prior commit touched this project's CHANGELOG.md
    });
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, true);
    assert.equal(state.changelogCalls.length, 1, 'nx release changelog must be invoked exactly once');
    const args = state.changelogCalls[0];
    assert.deepEqual(args.slice(0, 3), ['release', 'changelog', '1.0.1'], 'must target the NEW version just decided');
    assert.ok(args.includes('--projects') && args.includes('pkg-b'), 'must scope to THIS project only');
    assert.ok(args.includes('--first-release'), 'no prior changelog commit known -> --first-release, not a fabricated --from');
    assert.ok(!args.includes('--from'), 'must not pass --from when no boundary is known');
    assert.ok(args.includes('--git-commit') && args[args.indexOf('--git-commit') + 1] === 'false', 'must never let nx auto-commit');
    assert.ok(args.includes('--git-tag') && args[args.indexOf('--git-tag') + 1] === 'false', 'must never let nx auto-tag');
    assert.ok(!args.includes('--dry-run'), 'a real (non-dry-run) bump must NOT pass --dry-run to the changelog call');
    assert.ok(
      state.calls.every((c) => c.cmd !== 'npx'),
      'BUILD-TOOLING-METRICS-001: the changelog call must invoke the local nx bin directly, never via `npx` (npx resolution overhead is pure waste in a monorepo)'
    );
    assert.ok(
      state.calls.some((c) => c.cmd === process.execPath && c.args[0] === NX_BIN),
      'must invoke `node <nx/bin/nx.js> ...` directly'
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("when a prior commit touched this project's CHANGELOG.md, uses --from=<that sha> instead of --first-release", async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: {} };
    const { context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b',
      srcPkg: localPkg,
      distFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 2;\n' },
    });
    const state = newState({
      publishedVersions: ['1.0.0'],
      publishedFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 1;\n' },
      lastChangelogSha: 'deadbeef1234567890deadbeef1234567890dead',
    });
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, true);
    const args = state.changelogCalls[0];
    assert.ok(args.includes('--from') && args[args.indexOf('--from') + 1] === 'deadbeef1234567890deadbeef1234567890dead');
    assert.ok(!args.includes('--first-release'), 'a known boundary must not ALSO claim first-release');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('dry run with real code drift (cache miss -> backfill still runs, but never writes package.json): previews the changelog via --dry-run', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: {} };
    const { pkgRoot, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b',
      srcPkg: localPkg,
      distFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 2;\n' },
    });
    const before = readFileSync(join(pkgRoot, 'package.json'), 'utf8');
    const state = newState({
      publishedVersions: ['1.0.0'],
      publishedFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 1;\n' },
    });
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({ dryRun: true }, context);
    assert.equal(result.success, true);
    const after = readFileSync(join(pkgRoot, 'package.json'), 'utf8');
    assert.equal(after, before, 'dry run must never write package.json');
    assert.equal(state.changelogCalls.length, 1, 'dry run still PREVIEWS the changelog for visibility');
    assert.ok(state.changelogCalls[0].includes('--dry-run'), 'the preview call must itself be a dry run — never writes CHANGELOG.md');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('changelog generation failure fails the whole version task (bump already landed, still surfaced as a failure) and never reaches range reconciliation', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    // Give pkg-b a genuinely STALE internal range against a real sibling, so
    // "reconciliation never ran" is provable by the range staying untouched
    // on disk — not just by an (unreachable-anyway) mock call count.
    makeFiles(join(rootDir, 'packages/pkg-a'), { 'package.json': JSON.stringify({ name: '@adhd/pkg-a', version: '2.0.0' }, null, 2) });
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: { '@adhd/pkg-a': '^1.0.0' } };
    const { pkgRoot, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b',
      srcPkg: localPkg,
      distFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 2;\n' },
    });
    context.projectsConfigurations.projects['pkg-a'] = { root: 'packages/pkg-a' };
    const state = newState({
      publishedVersions: ['1.0.0'],
      publishedFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 1;\n' },
      changelogStatus: 1, // real nx release changelog failure
    });
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, false, 'a real changelog-generation failure must fail the task');
    assert.equal(state.eslintCalls.length, 0, 'the deps-plugin executors are never invoked regardless (DEBT-BUILD-VERSION-SYNCDEPS-REDUNDANT-001 (b))');
    const after = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    assert.equal(after.version, '1.0.1', 'the version write itself already landed before the changelog step — this is a surfaced failure, not a rollback');
    assert.equal(after.dependencies['@adhd/pkg-a'], '^1.0.0', 'must fail FAST — reconcileInternalRangesFromDisk must never run once changelog generation fails, so the genuinely-stale range must be left untouched');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('DEBT-BUILD-VERSION-SYNCDEPS-REDUNDANT-001 (b): a REAL on-disk write failure during range reconciliation propagates as an overall executor failure (no mocking — package.json chmod 0444)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    // pkg-a is genuinely ahead on disk, so `reconcileInternalRangesFromDisk`
    // must actually detect drift and attempt a real write.
    makeFiles(join(rootDir, 'packages/pkg-a'), { 'package.json': JSON.stringify({ name: '@adhd/pkg-a', version: '2.0.0' }, null, 2) });
    const localPkg = { name: '@adhd/pkg-b', version: '9.9.9', dependencies: { '@adhd/pkg-a': '^1.0.0' } };
    const { pkgRoot, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b',
      srcPkg: localPkg,
      distFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'x\n' },
    });
    context.projectsConfigurations.projects['pkg-a'] = { root: 'packages/pkg-a' };
    const srcPkgPath = join(pkgRoot, 'package.json');
    // Real OS-level permission failure — never mocked — makes the write
    // `reconcileInternalRangesFromDisk` attempts genuinely fail.
    chmodSync(srcPkgPath, 0o444);

    const state = newState({ publishedVersions: [] }); // never published -> pending, no own-version bump attempted
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    try {
      const result = await versionImpl({}, context);
      assert.equal(result.success, false, 'a real reconcileInternalRangesFromDisk write failure must propagate as an overall executor failure');
      assert.equal(state.eslintCalls.length, 0, 'still never invokes the deps-plugin executors — the failure is entirely within the on-disk reconciliation path');
    } finally {
      chmodSync(srcPkgPath, 0o644); // restore before rmSync cleanup below
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('backfill failure (network error reconciling a cache miss) leaves version untouched and still reconciles ranges', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: {} };
    const { pkgRoot, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b',
      srcPkg: localPkg,
      distFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'x\n' },
    });
    // publishedVersions says it IS published, but the tarball fetch (both
    // packLocalDir-independent integrity check AND the fallback pull) fails
    // -> reconcile-core returns status:'error'.
    const state = newState({ publishedVersions: ['1.0.0'] });
    // Override the mock so `npm pack <name>@<version>` (the registry pull) fails.
    const baseMock = makeSpawnSyncMock(state);
    t.mock.method(child_process, 'spawnSync', (cmd, args = [], opts = {}) => {
      if (cmd === 'npm' && args[0] === 'pack' && !String(args[1]).startsWith('/')) {
        state.calls.push({ cmd, args });
        return { status: 1, stdout: '', stderr: 'network unreachable' };
      }
      return baseMock(cmd, args, opts);
    });
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, true, 'a backfill failure must not fail the whole task — it leaves version as-is for manual verification');
    const after = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    assert.equal(after.version, '1.0.0', 'must be left untouched on a backfill error');
    assert.equal(existsSync(publishedStatePath(rootDir)), false, 'an errored backfill must never write a cache entry');
    assert.equal(state.eslintCalls.length, 0, 'DEBT-BUILD-VERSION-SYNCDEPS-REDUNDANT-001 (b): range reconciliation still runs after a backfill error, but never via the deps-plugin executors');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// STALE-GRAPH FIX — reconcileInternalRangesFromDisk (direct on-disk read).
// Per DEBT-BUILD-VERSION-SYNCDEPS-REDUNDANT-001 (b), this on-disk read is now
// the ONLY internal-range reconciliation `version` performs — the deps-
// plugin's ESLint-rule-backed `sync-deps`/`sync-deps-check` executors, whose
// cached project graph could go mid-run-stale, are never consulted here at
// all anymore.
// ---------------------------------------------------------------------------

test('reconciles an internal @adhd/* range directly from the dependency\'s on-disk package.json, without ever consulting the deps-plugin executors', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    // pkg-a already bumped to 2.0.0 ON DISK (simulating its OWN `version`
    // task having already run earlier in this same `run-many`, per the
    // `^version` topological dependsOn), but pkg-b still declares the OLD
    // range.
    makeFiles(join(rootDir, 'packages/pkg-a'), { 'package.json': JSON.stringify({ name: '@adhd/pkg-a', version: '2.0.0' }, null, 2) });
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: { '@adhd/pkg-a': '^1.0.0' } };
    const { pkgRoot, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', srcPkg: localPkg,
      distFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'x\n' },
    });
    // Register pkg-a in the SAME project graph pkg-b's context uses.
    context.projectsConfigurations.projects['pkg-a'] = { root: 'packages/pkg-a' };

    const { normalizedHash } = require('./compare-published.js');
    writePublishedState(rootDir, {
      '@adhd/pkg-b': { version: '1.0.0', normalizedHash: normalizedHash(join(pkgRoot, 'dist')), publishedIntegrity: 'sha512-whatever' },
    });

    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, true);
    const after = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    assert.equal(
      after.dependencies['@adhd/pkg-a'], '^2.0.0',
      'the internal range must be corrected from pkg-a\'s ACTUAL on-disk version'
    );
    assert.equal(state.eslintCalls.length, 0, 'DEBT-BUILD-VERSION-SYNCDEPS-REDUNDANT-001 (b): the deps-plugin executors must never be consulted for this');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('dry run: reports the internal-range fix it would make but never writes package.json', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    makeFiles(join(rootDir, 'packages/pkg-a'), { 'package.json': JSON.stringify({ name: '@adhd/pkg-a', version: '2.0.0' }, null, 2) });
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: { '@adhd/pkg-a': '^1.0.0' } };
    const { pkgRoot, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', srcPkg: localPkg,
      distFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'x\n' },
    });
    context.projectsConfigurations.projects['pkg-a'] = { root: 'packages/pkg-a' };
    const before = readFileSync(join(pkgRoot, 'package.json'), 'utf8');

    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({ dryRun: true }, context);
    assert.equal(result.success, true);
    const after = readFileSync(join(pkgRoot, 'package.json'), 'utf8');
    assert.equal(after, before, 'dry run must never write the internal-range fix either');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// CONTRACT REFINEMENT (DEBT-002 #1, post-audit false positive): the FIRST cut
// of this gate treated ANY @adhd/* name absent from the workspace version map
// as a hazard — which blocked a real release: `@adhd/backlog` legitimately
// depends on `@adhd/sox-graph-store@^0.3.0`, a genuine EXTERNAL npm package
// (published 0.3.0/0.5.0) that merely shares the `@adhd/` scope and is not a
// workspace sibling. Map absence alone says nothing about installability — a
// CONCRETE range on such a name is exactly what a legitimate external
// @adhd-scoped dependency looks like, and must pass through untouched. The
// real hazard `assertResolvedInternalDeps` targets is the LITERAL RANGE
// itself: a `workspace:` protocol range (npm never substitutes it) or a bare
// `*` — see generate-manifest.js's `assertResolvedInternalDeps` doc comment
// and generate-manifest.spec.mjs's dedicated tests for the pure-function
// proof. This test (and its sibling below) now assert the CORRECTED contract
// at the `version` task's orchestration layer.
test('DEBT-002 #1 (corrected): a CONCRETE range on an @adhd/* dependency absent from the workspace project graph is ALLOWED — a legitimate external @adhd-scoped package (e.g. @adhd/sox-graph-store) — version proceeds normally', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: { '@adhd/sox-graph-store': '^0.3.0' } };
    const { pkgRoot, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', srcPkg: localPkg,
      distFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'x\n' },
    });

    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, true, 'a concrete external @adhd/* range must never be treated as an unresolvable hazard');
    const after = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    assert.equal(after.dependencies['@adhd/sox-graph-store'], '^0.3.0', 'the external range must be left exactly as authored');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('DEBT-002 #1 (corrected): a surviving "workspace:*" range on an @adhd/* dependency absent from the workspace project graph is STILL a hard failure (the real hazard)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: { '@adhd/not-a-real-project': 'workspace:*' } };
    const { pkgRoot, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', srcPkg: localPkg,
      distFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'x\n' },
    });
    const before = readFileSync(join(pkgRoot, 'package.json'), 'utf8');

    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    await assert.rejects(
      () => versionImpl({}, context),
      /not-a-real-project/,
      'a surviving workspace: protocol range must still fail the task loudly, naming the offending dependency'
    );
    const after = readFileSync(join(pkgRoot, 'package.json'), 'utf8');
    assert.equal(after, before, 'a failed gate must never have written a (still-unresolvable) version bump to the source package.json');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// DEBT-002 #5 — reconcileInternalRangesFromDisk must scope by (field, depName),
// never rewrite a dep's range in EVERY field it appears in from just one
// field's computed prefix.
// ---------------------------------------------------------------------------

test('DEBT-002 #5: a dep declared with DIFFERENT range prefixes in `dependencies` (^) vs `peerDependencies` (~) each keep their OWN prefix — no cross-field contamination', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    // pkg-a is now at 2.0.0 on disk. pkg-b declares it TWICE, with two
    // DIFFERENT prefixes in two DIFFERENT fields — the exact shape that used
    // to collapse onto whichever field's entry populated the (depName-only)
    // map first, forcing one field's prefix onto the other.
    makeFiles(join(rootDir, 'packages/pkg-a'), { 'package.json': JSON.stringify({ name: '@adhd/pkg-a', version: '2.0.0' }, null, 2) });
    const localPkg = {
      name: '@adhd/pkg-b',
      version: '1.0.0',
      main: './index.js',
      dependencies: { '@adhd/pkg-a': '^1.0.0' },
      peerDependencies: { '@adhd/pkg-a': '~1.0.0' },
    };
    const { pkgRoot, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', srcPkg: localPkg,
      distFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'x\n' },
    });
    context.projectsConfigurations.projects['pkg-a'] = { root: 'packages/pkg-a' };

    const { normalizedHash } = require('./compare-published.js');
    writePublishedState(rootDir, {
      '@adhd/pkg-b': { version: '1.0.0', normalizedHash: normalizedHash(join(pkgRoot, 'dist')), publishedIntegrity: 'sha512-whatever' },
    });

    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, true);
    const after = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    // Negative control: the OLD (depName-keyed, global-replace) implementation
    // would compute ONE desired range from whichever field's Object.entries
    // iteration reached `@adhd/pkg-a` first (dependencies, since it's declared
    // first), then blindly replace EVERY textual `"@adhd/pkg-a": "..."`
    // occurrence with that SAME desired range — forcing `^2.0.0` onto
    // peerDependencies too, silently discarding its intentionally different
    // `~` prefix. Both assertions below would NOT both hold under that bug.
    assert.equal(after.dependencies['@adhd/pkg-a'], '^2.0.0', 'dependencies keeps its OWN ^ prefix, updated to the current on-disk version');
    assert.equal(after.peerDependencies['@adhd/pkg-a'], '~2.0.0', 'peerDependencies keeps its OWN ~ prefix — must NOT be contaminated by dependencies\' ^ prefix');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('DEBT-002 #5 dry run: reports BOTH fields\' fixes with their own prefixes, never writes package.json', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    makeFiles(join(rootDir, 'packages/pkg-a'), { 'package.json': JSON.stringify({ name: '@adhd/pkg-a', version: '2.0.0' }, null, 2) });
    const localPkg = {
      name: '@adhd/pkg-b',
      version: '1.0.0',
      main: './index.js',
      dependencies: { '@adhd/pkg-a': '^1.0.0' },
      devDependencies: { '@adhd/pkg-a': '1.0.0' }, // no prefix -> defaults to ^ per existing convention
    };
    const { pkgRoot, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', srcPkg: localPkg,
      distFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'x\n' },
    });
    context.projectsConfigurations.projects['pkg-a'] = { root: 'packages/pkg-a' };

    const { normalizedHash } = require('./compare-published.js');
    writePublishedState(rootDir, {
      '@adhd/pkg-b': { version: '1.0.0', normalizedHash: normalizedHash(join(pkgRoot, 'dist')), publishedIntegrity: 'sha512-whatever' },
    });
    const before = readFileSync(join(pkgRoot, 'package.json'), 'utf8');

    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({ dryRun: true }, context);
    assert.equal(result.success, true);
    const after = readFileSync(join(pkgRoot, 'package.json'), 'utf8');
    assert.equal(after, before, 'a dry run must never write package.json, even with multi-field drift');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Generated-CHANGELOG forbidden-vocabulary scrub.
//
// The changelog is a projection of git commit subjects; a commit that REMOVES
// a package's forbidden term must name it, so the term lands in the shipped
// changelog and the package's own vocabulary gate then fails on the fix's own
// commit (the live incident: `backlog:vocabulary-gate` failed on
// CHANGELOG.md:25/27 and blocked `backlog@1.0.1`). The fix is at the generator:
// a package that declares `changelogVocabulary` has its generated CHANGELOG
// scrubbed in place. These tests drive THAT path through the real executor.
// ---------------------------------------------------------------------------

const SCRUB_POLICY_SRC = [
  'export function scrubChangelog(text) {',
  "  return text.replace(/sqlite/gi, 'store-engine');",
  '}',
  '',
].join('\n');

test('changelog scrub: a package declaring `changelogVocabulary` has its GENERATED CHANGELOG.md scrubbed in place (real executor, real fs, real dynamic import)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: {} };
    const { pkgRoot, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b',
      srcPkg: localPkg,
      distFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 2;\n' }, // NEW code -> real bump
    });
    // The package opts in via its project.json; the policy module is loaded by
    // absolute file URL from the project root.
    makeFiles(pkgRoot, {
      'project.json': JSON.stringify({ name: 'pkg-b', changelogVocabulary: 'tools/vocabulary-policy.mjs' }),
      'tools/vocabulary-policy.mjs': SCRUB_POLICY_SRC,
    });
    const changelogPath = join(pkgRoot, 'CHANGELOG.md');
    const dirtyEntry = '## 1.0.1\n\n### 🩹 Fixes\n\n- **backlog:** drop the forbidden sqlite term\n';

    const state = newState({
      publishedVersions: ['1.0.0'],
      publishedFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 1;\n' },
      lastChangelogSha: '',
      changelogWrite: { [changelogPath]: dirtyEntry }, // what the real nx renderer would have written
    });
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, true, 'a successful generate+scrub must not fail the task');
    const after = readFileSync(changelogPath, 'utf8');
    assert.ok(!/sqlite/i.test(after), `the generated entry must carry no forbidden term\n---\n${after}`);
    assert.ok(/store-engine/i.test(after), 'the forbidden term must be rewritten to its neutral paraphrase, not deleted');
    assert.ok(after.startsWith('## 1.0.1'), 'the entry structure must survive the scrub');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('changelog scrub: a package with NO `changelogVocabulary` declaration is left untouched (other packages legitimately name such terms)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: {} };
    const { pkgRoot, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b',
      srcPkg: localPkg,
      distFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 2;\n' },
    });
    const changelogPath = join(pkgRoot, 'CHANGELOG.md');
    const entry = '## 1.0.1\n\n### 🩹 Fixes\n\n- fix the sqlite thing\n';

    const state = newState({
      publishedVersions: ['1.0.0'],
      publishedFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 1;\n' },
      lastChangelogSha: '',
      changelogWrite: { [changelogPath]: entry },
    });
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, true);
    assert.equal(readFileSync(changelogPath, 'utf8'), entry, 'no declaration -> the historical record must be byte-identical');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('changelog scrub: a declared-but-BROKEN policy fails the task loudly (never silently ships a dirty changelog)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: {} };
    const { pkgRoot, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b',
      srcPkg: localPkg,
      distFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 2;\n' },
    });
    makeFiles(pkgRoot, {
      'project.json': JSON.stringify({ name: 'pkg-b', changelogVocabulary: 'tools/missing-policy.mjs' }),
    });
    const changelogPath = join(pkgRoot, 'CHANGELOG.md');

    const state = newState({
      publishedVersions: ['1.0.0'],
      publishedFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 1;\n' },
      lastChangelogSha: '',
      changelogWrite: { [changelogPath]: '## 1.0.1\n\n- a change\n' },
    });
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, false, 'a declared policy that cannot be loaded must fail the task, never be silently skipped');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('changelog policy (single source of truth): the REAL @adhd/backlog policy scrubs every term BOTH gates enforce, and the live incident lines', async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
  const policy = await import(
    pathToFileURL(join(repoRoot, 'entrypoint/backlog/tools/vocabulary-policy.mjs')).href
  );

  assert.deepEqual(
    policy.uncoveredTerms(),
    [],
    'every term a gate enforces must have a scrubbed paraphrase — a gate term the scrub ignores would hand the gate a guaranteed-dirty changelog'
  );

  const samples = {
    v1: 'this replaced the old backlog v1 era',
    v2: 'the backlog v2 store',
    humanId: 'the humanId column',
    migration: 'a migration and a migrator and a migrating path',
    migrat: 'a migration',
    sqlite: 'the better-sqlite3 binding',
  };
  for (const term of [...policy.SRC_TERMS, ...policy.TARBALL_TERMS]) {
    const sample = samples[term.name] ?? `x ${term.name} y`;
    assert.ok(term.re.test(sample), `test sample for '${term.name}' must match that gate's own detection regex`);
    const scrubbed = policy.scrubChangelog(sample);
    assert.deepEqual(
      policy.findBannedHits(scrubbed),
      [],
      `scrubChangelog must neutralise '${term.name}': ${JSON.stringify(scrubbed)}`
    );
    assert.equal(policy.scrubChangelog(scrubbed), scrubbed, 'scrub must be idempotent');
  }

  // The exact generated lines that failed the 2026-09-26 release.
  const incidentLines = [
    "- **backlog:** drop the forbidden 'sqlite' term from the CPU-THRASH-SKIP comment ([4dae6ee2](https://github.com/PseudoSky/adhd/commit/4dae6ee2))",
    '- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))',
  ];
  for (const line of incidentLines) {
    assert.deepEqual(policy.findBannedHits(policy.scrubChangelog(line)), [], `incident line must scrub clean: ${line}`);
  }
});
