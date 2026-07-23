/**
 * Teeth tests for `sync` (deps sync --fix) — BUILD-TOOLING-METRICS-001's
 * in-process elimination of the outer `node eslint-check.mjs` subprocess.
 *
 * Mocking boundary: `module.exports.__internals.runDependencyCheck` — the
 * seam this executor calls instead of spawning a subprocess. Proves (a) it
 * is invoked with the right absolute package.json path + `--fix`, (b) its
 * return code maps correctly to `{success}`, (c) `node:child_process` is
 * NEVER touched at all (the actual elimination — spawnSync/execFileSync are
 * both mocked to throw if called, so a regression back to subprocess-spawning
 * fails loudly), and (d) a metrics record lands via `lib/metrics.js`.
 *
 * Run: node --test tools/nx-plugins/deps/executors/sync/impl.spec.mjs
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

test('never touches node:child_process at all — the whole point of the elimination', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'sync-impl-'));
  try {
    t.mock.method(child_process, 'spawnSync', () => { throw new Error('spawnSync must NEVER be called by sync/impl.js'); });
    t.mock.method(child_process, 'execFileSync', () => { throw new Error('execFileSync must NEVER be called by sync/impl.js'); });
    const context = makeContext(rootDir, '@adhd/pkg-b', 'packages/pkg-b');
    const impl = loadFreshImpl();
    impl.__internals.runDependencyCheck = async () => 0;

    const result = await impl({}, context);
    assert.equal(result.success, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('invokes runDependencyCheck with the absolute package.json path and --fix', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'sync-impl-'));
  try {
    const context = makeContext(rootDir, '@adhd/pkg-b', 'packages/pkg-b');
    const impl = loadFreshImpl();
    const calls = [];
    impl.__internals.runDependencyCheck = async (pkgJsonPath, extraArgs) => {
      calls.push({ pkgJsonPath, extraArgs });
      return 0;
    };

    await impl({}, context);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pkgJsonPath, join(rootDir, 'packages/pkg-b/package.json'));
    assert.deepEqual(calls[0].extraArgs, ['--fix']);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a non-zero exit code from runDependencyCheck maps to success:false', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'sync-impl-'));
  try {
    const context = makeContext(rootDir, '@adhd/pkg-b', 'packages/pkg-b');
    const impl = loadFreshImpl();
    impl.__internals.runDependencyCheck = async () => 1;

    const result = await impl({}, context);
    assert.equal(result.success, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('records a sync-deps metrics.json entry with a subprocess sample attributed to the in-process call', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'sync-impl-'));
  try {
    const context = makeContext(rootDir, '@adhd/pkg-b', 'packages/pkg-b');
    const impl = loadFreshImpl();
    impl.__internals.runDependencyCheck = async () => 0;

    await impl({}, context);
    delete require.cache[metricsAbs];
    const { readMetrics } = require(metricsAbs);
    const { records } = readMetrics(rootDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].task, 'sync-deps');
    assert.equal(records[0].project, '@adhd/pkg-b');
    assert.equal(records[0].subprocess.count, 1, 'the in-process eslint-check call is still tracked as one "subprocess" unit of work');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('loadEslintCheck really resolves the real eslint-check.mjs module (integration smoke, not a mock)', async () => {
  const impl = loadFreshImpl();
  const mod = await impl.__internals.loadEslintCheck();
  assert.equal(typeof mod.main, 'function');
  assert.equal(typeof mod.isRealInstall, 'function');
});
