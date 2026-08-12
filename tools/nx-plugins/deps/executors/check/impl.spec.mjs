/**
 * Teeth tests for `check` (deps sync-deps-check, read-only) — mirrors
 * `../sync/impl.spec.mjs`. See that file's header for the full rationale
 * (BUILD-TOOLING-METRICS-001).
 *
 * Run: node --test tools/nx-plugins/deps/executors/check/impl.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import child_process from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// BUG (flaky CPU-guard trips under real machine load, test:build-tools):
// mirror of `../sync/impl.spec.mjs` — same class of flake, same fix. This file
// exercises the real `check` executor end-to-end, which wraps its work in
// `withMetrics` (BUILD-TOOLING-METRICS-001), and `withMetrics` always runs the
// REAL `checkCpuGuard` (FEAT-NXMETRICS-CPU-GUARD-001) against a REAL
// `process.cpuUsage()` measurement of single-digit-ms wall windows (the child
// boundary is mocked). On a loaded machine that real measured % can
// legitimately exceed the default `ADHD_NX_METRICS_MAX_CPU_PCT=300` threshold
// for such short bursts, tripping the guard and failing a test that has
// nothing to do with the guard itself. The guard's own pass/fail LOGIC is
// fully covered, deterministically, by `tools/nx-plugins/lib/metrics.spec.mjs`
// — this file only asserts check orchestration + metrics-record shape, so
// disable the guard here (metrics recording, including the real `cpuPercent`
// value, still happens; only the throw-on-trip is turned off).
process.env.ADHD_NX_METRICS_MAX_CPU_PCT = '0';

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
  const rootDir = mkdtempSync(join(tmpdir(), 'check-impl-'));
  try {
    t.mock.method(child_process, 'spawnSync', () => { throw new Error('spawnSync must NEVER be called by check/impl.js'); });
    t.mock.method(child_process, 'execFileSync', () => { throw new Error('execFileSync must NEVER be called by check/impl.js'); });
    const context = makeContext(rootDir, '@adhd/pkg-b', 'packages/pkg-b');
    const impl = loadFreshImpl();
    impl.__internals.runDependencyCheck = async () => 0;

    const result = await impl({}, context);
    assert.equal(result.success, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('invokes runDependencyCheck with the absolute package.json path and NO --fix', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'check-impl-'));
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
    assert.deepEqual(calls[0].extraArgs, [], 'check mode must never pass --fix');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a non-zero exit code from runDependencyCheck maps to success:false', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'check-impl-'));
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

test('records a sync-deps-check metrics.json entry', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'check-impl-'));
  try {
    const context = makeContext(rootDir, '@adhd/pkg-b', 'packages/pkg-b');
    const impl = loadFreshImpl();
    impl.__internals.runDependencyCheck = async () => 0;

    await impl({}, context);
    delete require.cache[metricsAbs];
    const { readMetrics } = require(metricsAbs);
    const { records } = readMetrics(rootDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].task, 'sync-deps-check');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
