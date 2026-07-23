/**
 * Teeth tests for the `version` executor's composition (impl.js) —
 * BUILD-TOOLING-VERSION-SYNC-DEPS-001, Change 1.
 *
 * Covers what compare-published.spec.mjs (the pure decision core) cannot:
 * the ORCHESTRATION around it — that after deciding whether to bump, `run()`
 * reconciles THIS package's own internal `@adhd/*` ranges by calling through
 * to the `deps` plugin's real `sync-deps` (fix) / `sync-deps-check` (dryRun)
 * executors — not a reimplementation — writes only ITS OWN package.json,
 * and never lets that reconciliation cause (or be caused by) a spurious own
 * version bump.
 *
 * Mocking boundary: ONLY `node:child_process.spawnSync` is mocked — the
 * external-process boundary (real `npm`/`tar`, and the real `node
 * eslint-check.mjs` subprocess `deps/executors/sync/impl.js` shells out to).
 * Everything else (compare-published.js's real diffing, the real
 * `deps/executors/sync|check/impl.js` modules, real file I/O) runs for real.
 *
 * Run: node --test tools/nx-plugins/build/executors/version/impl.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import child_process from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const implAbs = require.resolve('./impl.js');
const syncAbs = require.resolve('../../../deps/executors/sync/impl.js');
const checkAbs = require.resolve('../../../deps/executors/check/impl.js');

/** Force impl.js AND the deps modules it requires to reload, so their
 * top-level `const { spawnSync } = require('node:child_process')` picks up
 * whatever mock is currently installed on the (singleton) child_process module. */
function resetAll() {
  delete require.cache[implAbs];
  delete require.cache[syncAbs];
  delete require.cache[checkAbs];
}
function loadFreshImpl() {
  resetAll();
  return require(implAbs);
}

/** Materialize a directory from a {relpath: contents} map. */
function makeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
}

/**
 * Fabricate a `spawnSync` stand-in that fakes the OS-process boundary:
 *  - `npm view <name> versions --json`      -> state.publishedVersions
 *  - `npm pack <name>@<v> --pack-destination <dir> --json` -> writes a dummy
 *    .tgz and reports its filename (real tar/npm never run)
 *  - `tar -xzf <tgz> -C <dir>`               -> materializes state.publishedFiles
 *    directly under <dir>/package (skips real extraction)
 *  - `node .../eslint-check.mjs <pkgJsonPath> [--fix]` -> the reused
 *    deps/executors/sync|check impl's real subprocess call; records every
 *    invocation in state.eslintCalls and returns state.eslintStatus (default 0)
 */
function makeSpawnSyncMock(state) {
  return (cmd, args = [], _opts = {}) => {
    state.calls.push({ cmd, args });
    if (cmd === 'npm' && args[0] === 'view') {
      return { status: 0, stdout: JSON.stringify(state.publishedVersions ?? []), stderr: '' };
    }
    if (cmd === 'npm' && args[0] === 'pack') {
      const destIdx = args.indexOf('--pack-destination');
      const workDir = args[destIdx + 1];
      writeFileSync(join(workDir, 'fake-0.0.0.tgz'), 'not a real tarball\n');
      return { status: 0, stdout: JSON.stringify([{ filename: 'fake-0.0.0.tgz' }]), stderr: '' };
    }
    if (cmd === 'tar') {
      const workDir = args[3];
      const pkgDir = join(workDir, 'package');
      makeFiles(pkgDir, state.publishedFiles ?? {});
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'node' && args.some((a) => String(a).includes('eslint-check.mjs'))) {
      state.eslintCalls.push(args);
      return { status: state.eslintStatus ?? 0, stdout: '', stderr: '' };
    }
    if (cmd === 'git' && args[0] === 'log') {
      return { status: 0, stdout: state.lastChangelogSha ?? '', stderr: '' };
    }
    if (cmd === 'npx' && args[0] === 'nx' && args[1] === 'release' && args[2] === 'changelog') {
      state.changelogCalls.push(args);
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

test('reuses the deps plugin sync/check modules verbatim — not a duplicated reimplementation', () => {
  const versionImpl = loadFreshImpl();
  const directSync = require(syncAbs);
  const directCheck = require(checkAbs);
  assert.strictEqual(versionImpl.__internals.syncInternalDeps, directSync, 'must be the SAME function reference as deps/executors/sync/impl.js — not a copy');
  assert.strictEqual(versionImpl.__internals.checkInternalDeps, directCheck, 'must be the SAME function reference as deps/executors/check/impl.js — not a copy');
});

test('"not yet published" path: reconciles via sync (fix), not check', async (t) => {
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

    const result = await versionImpl({}, context);
    assert.equal(result.success, true);
    assert.equal(state.eslintCalls.length, 1, 'sync-deps subprocess must run exactly once');
    assert.ok(state.eslintCalls[0].includes('--fix'), 'must invoke the FIX mode (sync), not check, when not a dry run');
    assert.ok(state.eslintCalls[0][0].endsWith('tools/nx-plugins/deps/eslint-check.mjs'), 'must be the shared script — proves reuse, not reimplementation');
    assert.ok(state.eslintCalls[0][1].endsWith(join('packages', 'pkg-b', 'package.json')), 'must target THIS project\'s own package.json');
    // Version untouched (no dist to compare against — release is already pending).
    const after = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    assert.equal(after.version, '9.9.9');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('dry run: reconciliation delegates to check (read-only) and NEVER writes / never fails on drift', async (t) => {
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

    const result = await versionImpl({ dryRun: true }, context);
    assert.equal(result.success, true, 'a dry run must never fail just because check reported drift');
    assert.equal(state.eslintCalls.length, 1);
    assert.ok(!state.eslintCalls[0].includes('--fix'), 'dry run must use CHECK (read-only), never fix');
    const after = readFileSync(join(pkgRoot, 'package.json'), 'utf8');
    assert.equal(after, before, 'dry run must never write anything');
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

test('published + range-only drift vs published tarball: does NOT bump, but DOES reconcile the range (no cascade, no false positive)', async (t) => {
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

    const result = await versionImpl({}, context);
    assert.equal(result.success, true);
    const after = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    assert.equal(after.version, '1.0.0', 'a range-only diff vs published must NOT bump the own version');
    assert.equal(state.eslintCalls.length, 1, 'must STILL reconcile the (now-known-stale) internal range going forward');
    assert.ok(state.eslintCalls[0].includes('--fix'));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('published + REAL code drift: DOES bump, then reconciles ranges afterward', async (t) => {
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

    const result = await versionImpl({}, context);
    assert.equal(result.success, true);
    const after = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    assert.equal(after.version, '1.0.1', 'a genuine code change must still bump (unchanged pre-existing behavior)');
    assert.equal(state.eslintCalls.length, 1, 'reconciliation runs after the bump too');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('published + REAL code drift: generates a CHANGELOG.md entry via real `nx release changelog`, --first-release when no prior entry commit is known', async (t) => {
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

    const result = await versionImpl({}, context);
    assert.equal(result.success, true);
    assert.equal(state.changelogCalls.length, 1, 'nx release changelog must be invoked exactly once');
    const args = state.changelogCalls[0];
    assert.deepEqual(args.slice(0, 4), ['nx', 'release', 'changelog', '1.0.1'], 'must target the NEW version just decided');
    assert.ok(args.includes('--projects') && args.includes('pkg-b'), 'must scope to THIS project only');
    assert.ok(args.includes('--first-release'), 'no prior changelog commit known -> --first-release, not a fabricated --from');
    assert.ok(!args.includes('--from'), 'must not pass --from when no boundary is known');
    assert.ok(args.includes('--git-commit') && args[args.indexOf('--git-commit') + 1] === 'false', 'must never let nx auto-commit');
    assert.ok(args.includes('--git-tag') && args[args.indexOf('--git-tag') + 1] === 'false', 'must never let nx auto-tag');
    assert.ok(!args.includes('--dry-run'), 'a real (non-dry-run) bump must NOT pass --dry-run to the changelog call');
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

    const result = await versionImpl({}, context);
    assert.equal(result.success, true);
    const args = state.changelogCalls[0];
    assert.ok(args.includes('--from') && args[args.indexOf('--from') + 1] === 'deadbeef1234567890deadbeef1234567890dead');
    assert.ok(!args.includes('--first-release'), 'a known boundary must not ALSO claim first-release');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('dry run with real code drift: previews the changelog via --dry-run and never writes package.json', async (t) => {
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

    const result = await versionImpl({}, context);
    assert.equal(result.success, false, 'a real (non-dry-run) sync-deps failure must fail the version task');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
