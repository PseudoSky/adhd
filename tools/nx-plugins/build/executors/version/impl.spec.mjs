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
 *     internal `@adhd/*` ranges by calling through to the `deps` plugin's
 *     real `sync-deps` (fix) / `sync-deps-check` (dryRun) executors — not a
 *     reimplementation — writes only ITS OWN package.json, and never lets
 *     that reconciliation cause (or be caused by) a spurious own version bump.
 *
 * Mocking boundary: `node:child_process.spawnSync` is mocked for the real
 * `npm`/`tar`/`git`/`nx` process boundary. The `deps/executors/sync|check`
 * dependency-check call is mocked one layer further in, at their own
 * `__internals.runDependencyCheck` seam (BUILD-TOOLING-METRICS-001 — that
 * call is now an in-process `import()` of `eslint-check.mjs`, not a
 * subprocess at all; see `deps/executors/sync/impl.spec.mjs` for the
 * dedicated proof that it never touches `node:child_process`). Everything
 * else (compare-published.js's real hashing/diffing, the real
 * `reconcile-core.js` gate, the real `lib/published-state.js` cache I/O, the
 * real `deps/executors/sync|check/impl.js` orchestration, real file I/O)
 * runs for real.
 *
 * Run: node --test tools/nx-plugins/build/executors/version/impl.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import child_process from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
 * sync/check modules `impl.js` just picked up (via `resetAll`'s cache
 * eviction) — call AFTER `loadFreshImpl()`. Populates `state.eslintCalls`
 * exactly like the old spawnSync-mock branch used to, so every existing
 * assertion below keeps working against the new in-process call shape:
 * `state.eslintCalls[i] === [pkgJsonPath, ...extraArgs]`.
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
 * The dependency-check call (`deps/executors/sync|check`) is NOT a spawnSync
 * call anymore (BUILD-TOOLING-METRICS-001 — it's now in-process) — see
 * `installEslintCheckMock` above, which mocks it at its own
 * `__internals.runDependencyCheck` seam instead, populating `state.eslintCalls`
 * the same way for every assertion below.
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

test('reuses the deps plugin sync/check modules verbatim — not a duplicated reimplementation', () => {
  const versionImpl = loadFreshImpl();
  const directSync = require(syncAbs);
  const directCheck = require(checkAbs);
  assert.strictEqual(versionImpl.__internals.syncInternalDeps, directSync, 'must be the SAME function reference as deps/executors/sync/impl.js — not a copy');
  assert.strictEqual(versionImpl.__internals.checkInternalDeps, directCheck, 'must be the SAME function reference as deps/executors/check/impl.js — not a copy');
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
    assert.equal(state.eslintCalls.length, 1, 'sync-deps reconciliation still runs (a separate, already-zero-network step)');
    const after = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    assert.equal(after.version, '1.0.0', 'unchanged vs the cached published hash -> no bump');

    // BUILD-TOOLING-METRICS-001: `run()` records a 'version' task-run, plus a
    // NESTED 'sync-deps' record from the in-process reconciliation call.
    const metricsAbs = require.resolve('../../../lib/metrics.js');
    delete require.cache[metricsAbs];
    const { readMetrics } = require(metricsAbs);
    const { records } = readMetrics(rootDir);
    const versionRecords = records.filter((r) => r.task === 'version');
    const syncDepsRecords = records.filter((r) => r.task === 'sync-deps');
    assert.equal(versionRecords.length, 1);
    assert.equal(versionRecords[0].project, 'pkg-b');
    assert.equal(versionRecords[0].success, true);
    assert.equal(syncDepsRecords.length, 1, 'the in-process sync-deps call must land its own nested metrics record');
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

test('"not yet published" path (cache miss -> backfill -> still pending): reconciles via sync (fix), not check, and writes NO cache entry', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const { pkgRoot, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b',
      srcPkg: { name: '@adhd/pkg-b', version: '9.9.9', dependencies: { '@adhd/pkg-a': '^1.0.0' } },
      distFiles: { 'package.json': JSON.stringify({ name: '@adhd/pkg-b', version: '9.9.9' }), 'index.js': 'x\n' },
    });
    const state = newState({ publishedVersions: [] }); // never published
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, true);
    assert.equal(state.eslintCalls.length, 1, 'sync-deps subprocess must run exactly once');
    assert.ok(state.eslintCalls[0].includes('--fix'), 'must invoke the FIX mode (sync), not check, when not a dry run');
    assert.ok(state.eslintCalls[0][0].endsWith(join('packages', 'pkg-b', 'package.json')), 'must target THIS project\'s own package.json');
    assert.equal(existsSync(publishedStatePath(rootDir)), false, '"pending" (never published) must never write a cache entry');
    // Version untouched (no dist to compare against — release is already pending).
    const after = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    assert.equal(after.version, '9.9.9');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('dry run: reconciliation delegates to check (read-only) and NEVER writes package.json / never fails on drift', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const { pkgRoot, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b',
      srcPkg: { name: '@adhd/pkg-b', version: '9.9.9', dependencies: {} },
      distFiles: { 'package.json': JSON.stringify({ name: '@adhd/pkg-b', version: '9.9.9' }), 'index.js': 'x\n' },
    });
    const before = readFileSync(join(pkgRoot, 'package.json'), 'utf8');
    const state = newState({ publishedVersions: [], eslintStatus: 1 }); // simulate a REAL drift finding (check would "fail")
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({ dryRun: true }, context);
    assert.equal(result.success, true, 'a dry run must never fail just because check reported drift');
    assert.equal(state.eslintCalls.length, 1);
    assert.ok(!state.eslintCalls[0].includes('--fix'), 'dry run must use CHECK (read-only), never fix');
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
    assert.ok(!state.eslintCalls[0].includes('--fix'), 'env-var dry run must route reconciliation through check, not fix');
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
    assert.equal(state.eslintCalls.length, 1, 'must STILL reconcile the (now-known-stale) internal range going forward');
    assert.ok(state.eslintCalls[0].includes('--fix'));
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
    assert.equal(state.eslintCalls.length, 1, 'reconciliation runs after the bump too');
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

test('changelog generation failure fails the whole version task (bump already landed, still surfaced as a failure)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: {} };
    const { pkgRoot, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b',
      srcPkg: localPkg,
      distFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'export const x = 2;\n' },
    });
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
    assert.equal(state.eslintCalls.length, 0, 'must fail FAST — never reach range reconciliation once changelog generation fails');
    const after = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    assert.equal(after.version, '1.0.1', 'the version write itself already landed before the changelog step — this is a surfaced failure, not a rollback');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('sync-deps failure during reconciliation propagates as an overall executor failure', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const { context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b',
      srcPkg: { name: '@adhd/pkg-b', version: '9.9.9', dependencies: {} },
      distFiles: { 'package.json': JSON.stringify({ name: '@adhd/pkg-b', version: '9.9.9' }), 'index.js': 'x\n' },
    });
    const state = newState({ publishedVersions: [], eslintStatus: 1 }); // real, unfixable eslint failure
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, false, 'a real (non-dry-run) sync-deps failure must fail the version task');
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
    assert.equal(state.eslintCalls.length, 1, 'range reconciliation still runs even after a backfill error');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// STALE-GRAPH FIX — reconcileInternalRangesFromDisk (direct on-disk read,
// bypassing the cached project graph the ESLint dependency-checks rule uses
// during a multi-project `nx run-many -t version`)
// ---------------------------------------------------------------------------

test('reconciles an internal @adhd/* range directly from the dependency\'s on-disk package.json even when the (stale-graph-simulating) ESLint mock reports no drift', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    // pkg-a already bumped to 2.0.0 ON DISK (simulating its OWN `version`
    // task having already run earlier in this same `run-many`, per the
    // `^version` topological dependsOn), but pkg-b still declares the OLD
    // range AND the mocked ESLint dependency-checks call reports zero
    // drift (simulating its cached project graph still seeing pkg-a@1.0.0).
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

    const state = newState(); // eslintStatus 0 -> mock reports "no drift" (simulating a stale graph)
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, true);
    const after = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    assert.equal(
      after.dependencies['@adhd/pkg-a'], '^2.0.0',
      'the internal range must be corrected from pkg-a\'s ACTUAL on-disk version, even though the (stale-graph-simulating) ESLint mock reported no drift'
    );
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

test('leaves an internal range untouched when the dependency is not a known workspace project (e.g. no on-disk package.json to trust)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'version-impl-'));
  try {
    const localPkg = { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js', dependencies: { '@adhd/not-a-real-project': '^1.0.0' } };
    const { pkgRoot, context } = makeProject({
      rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', srcPkg: localPkg,
      distFiles: { 'package.json': JSON.stringify(localPkg), 'index.js': 'x\n' },
    });
    const before = readFileSync(join(pkgRoot, 'package.json'), 'utf8');

    const state = newState();
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const versionImpl = loadFreshImpl();
    installEslintCheckMock(state);

    const result = await versionImpl({}, context);
    assert.equal(result.success, true);
    const after = readFileSync(join(pkgRoot, 'package.json'), 'utf8');
    assert.equal(after, before, 'no known on-disk project for the dep -> leave the declared range exactly as-is');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
