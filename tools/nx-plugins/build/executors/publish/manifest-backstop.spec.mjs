/**
 * Integration teeth tests: the REAL `publish` executor (`impl.js`) actually
 * refuses/allows/overrides based on the release-manifest backstop (Phase 3,
 * `tmp/release-pipeline-audit.md`). `impl.spec.mjs` covers the cache/dist
 * behavior AFTER this check passes (its `makeProject` helper writes a
 * passing manifest by default); this file exists specifically to prove the
 * backstop itself has teeth against the real executor, not just the
 * standalone `release-manifest.js` decision function (see
 * `../../lib/release-manifest.spec.mjs` for that unit-level coverage).
 *
 * Mocking boundary: ONLY `node:child_process.spawnSync` is mocked (same
 * boundary as `impl.spec.mjs`) — everything else, including the real
 * manifest file I/O, is exercised for real.
 *
 * Run: node --test tools/nx-plugins/build/executors/publish/manifest-backstop.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import child_process from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const implAbs = require.resolve('./impl.js');
const npmRegistryAbs = require.resolve('../../lib/npm-registry.js');
const publishedStateAbs = require.resolve('../../lib/published-state.js');
const releaseManifestAbs = require.resolve('../../lib/release-manifest.js');
const { writeReleaseManifest, readReleaseManifest, OVERRIDE_LOG_RELATIVE_PATH } = require('../../lib/release-manifest.js');

function resetAll() {
  delete require.cache[implAbs];
  delete require.cache[npmRegistryAbs];
  delete require.cache[publishedStateAbs];
  delete require.cache[releaseManifestAbs];
}
function loadFreshImpl() {
  resetAll();
  return require(implAbs);
}

function makeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
}

function makeProject({ rootDir, name, projectRoot, distPkg }) {
  const pkgRoot = join(rootDir, projectRoot);
  makeFiles(pkgRoot, { 'package.json': JSON.stringify(distPkg, null, 2) });
  makeFiles(join(pkgRoot, 'dist'), { 'package.json': JSON.stringify(distPkg, null, 2), 'index.js': 'x\n' });
  const context = {
    root: rootDir,
    projectName: name,
    projectsConfigurations: { projects: { [name]: { root: projectRoot } } },
  };
  return { pkgRoot, distDir: join(pkgRoot, 'dist'), context };
}

function makeSpawnSyncMock(state) {
  return (cmd, args = [], _opts = {}) => {
    state.calls.push({ cmd, args });
    if (cmd === 'npm' && args[0] === 'publish') {
      return { status: state.publishStatus ?? 0, stdout: '', stderr: state.publishStderr ?? '' };
    }
    if (cmd === 'npm' && args[0] === 'view') {
      return { status: 1, stdout: '', stderr: '' };
    }
    if (cmd === 'npm' && args[0] === 'pack') {
      const destIdx = args.indexOf('--pack-destination');
      const workDir = args[destIdx + 1];
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, 'local.tgz'), 'tgz-bytes\n');
      return { status: 0, stdout: JSON.stringify([{ filename: 'local.tgz' }]), stderr: '' };
    }
    throw new Error(`unexpected spawnSync in test mock: ${cmd} ${JSON.stringify(args)}`);
  };
}

test('(a) REFUSES to run npm publish when NO manifest exists at all', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'manifest-backstop-'));
  try {
    const distPkg = { name: '@adhd/pkg-b', version: '1.0.0' };
    const { context } = makeProject({ rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', distPkg });
    // Deliberately NOT calling writeReleaseManifest — simulates a caller that
    // bypassed run-release.mjs / computeChangedProjectSet entirely.
    assert.equal(readReleaseManifest(rootDir), null, 'sanity: no manifest present');

    const state = { calls: [] };
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const publishImpl = loadFreshImpl();

    const result = await publishImpl({}, context);
    assert.equal(result.success, false, 'must refuse without a manifest');
    const publishCalls = state.calls.filter((c) => c.cmd === 'npm' && c.args[0] === 'publish');
    assert.equal(publishCalls.length, 0, 'must NEVER invoke npm publish when no manifest exists');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('(a) REFUSES to run npm publish when a manifest exists but this project is NOT listed in it', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'manifest-backstop-'));
  try {
    const distPkg = { name: '@adhd/pkg-b', version: '1.0.0' };
    const { context } = makeProject({ rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', distPkg });
    writeReleaseManifest(rootDir, ['some-unrelated-project']);

    const state = { calls: [] };
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const publishImpl = loadFreshImpl();

    const result = await publishImpl({}, context);
    assert.equal(result.success, false, 'must refuse when this project is out of the computed scope');
    const publishCalls = state.calls.filter((c) => c.cmd === 'npm' && c.args[0] === 'publish');
    assert.equal(publishCalls.length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('(b) PROCEEDS (real npm publish attempted) when this project IS listed in a fresh manifest', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'manifest-backstop-'));
  try {
    const distPkg = { name: '@adhd/pkg-b', version: '1.0.0' };
    const { context, distDir } = makeProject({ rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', distPkg });
    writeReleaseManifest(rootDir, ['pkg-b', 'some-other-project'], { baseRef: 'HEAD~1' });

    const state = { calls: [] };
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const publishImpl = loadFreshImpl();

    const result = await publishImpl({}, context);
    assert.equal(result.success, true, 'a listed project in a fresh manifest must be allowed through to the real publish attempt');
    const publishCalls = state.calls.filter((c) => c.cmd === 'npm' && c.args[0] === 'publish');
    assert.equal(publishCalls.length, 1, 'the backstop passing must actually result in a real npm publish attempt');
    assert.ok(publishCalls[0].args.includes(distDir));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('(c) RELEASE_FORCE_FULL_PUBLISH + RELEASE_FORCE_REASON bypasses the backstop even with NO manifest, and the override is logged (auditable, not silent)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'manifest-backstop-'));
  const savedForce = process.env.RELEASE_FORCE_FULL_PUBLISH;
  const savedReason = process.env.RELEASE_FORCE_REASON;
  try {
    const distPkg = { name: '@adhd/pkg-b', version: '1.0.0' };
    const { context, distDir } = makeProject({ rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', distPkg });
    // No manifest at all.
    assert.equal(readReleaseManifest(rootDir), null);

    process.env.RELEASE_FORCE_FULL_PUBLISH = '1';
    process.env.RELEASE_FORCE_REASON = 'incident-driven manual republish, see INC-1234';

    const state = { calls: [] };
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const publishImpl = loadFreshImpl();

    const result = await publishImpl({}, context);
    assert.equal(result.success, true, 'the explicit force override must bypass the missing-manifest refusal');
    const publishCalls = state.calls.filter((c) => c.cmd === 'npm' && c.args[0] === 'publish');
    assert.equal(publishCalls.length, 1, 'the override must actually reach the real npm publish attempt');
    assert.ok(publishCalls[0].args.includes(distDir));

    const logPath = join(rootDir, OVERRIDE_LOG_RELATIVE_PATH);
    assert.ok(existsSync(logPath), 'the override use must be written to the audit log — never silent');
    const entry = JSON.parse(readFileSync(logPath, 'utf8').trim());
    assert.equal(entry.projectName, 'pkg-b');
    assert.match(entry.reason, /INC-1234/);
  } finally {
    if (savedForce === undefined) delete process.env.RELEASE_FORCE_FULL_PUBLISH;
    else process.env.RELEASE_FORCE_FULL_PUBLISH = savedForce;
    if (savedReason === undefined) delete process.env.RELEASE_FORCE_REASON;
    else process.env.RELEASE_FORCE_REASON = savedReason;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('RELEASE_FORCE_FULL_PUBLISH set WITHOUT RELEASE_FORCE_REASON is REFUSED, even with no manifest (reason is mandatory, not optional)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'manifest-backstop-'));
  const savedForce = process.env.RELEASE_FORCE_FULL_PUBLISH;
  const savedReason = process.env.RELEASE_FORCE_REASON;
  try {
    const distPkg = { name: '@adhd/pkg-b', version: '1.0.0' };
    const { context } = makeProject({ rootDir, name: 'pkg-b', projectRoot: 'packages/pkg-b', distPkg });

    process.env.RELEASE_FORCE_FULL_PUBLISH = '1';
    delete process.env.RELEASE_FORCE_REASON;

    const state = { calls: [] };
    t.mock.method(child_process, 'spawnSync', makeSpawnSyncMock(state));
    const publishImpl = loadFreshImpl();

    const result = await publishImpl({}, context);
    assert.equal(result.success, false, 'the flag alone (no reason) must NOT bypass the backstop');
    const publishCalls = state.calls.filter((c) => c.cmd === 'npm' && c.args[0] === 'publish');
    assert.equal(publishCalls.length, 0);
  } finally {
    if (savedForce === undefined) delete process.env.RELEASE_FORCE_FULL_PUBLISH;
    else process.env.RELEASE_FORCE_FULL_PUBLISH = savedForce;
    if (savedReason === undefined) delete process.env.RELEASE_FORCE_REASON;
    else process.env.RELEASE_FORCE_REASON = savedReason;
    rmSync(rootDir, { recursive: true, force: true });
  }
});
