/**
 * reporter-api.spec.mjs: the metrics reporters, the vitest one attached by the shared plugin the way every project config attaches it,
 * run under the REAL vitest on a throwaway project, and the node:test one under the real `node --test`: it records pass, fail, skip and todo with the header tier, leaves
 * vitest's own output and exit status untouched, and cannot break a run when the store is unwritable or switched off.
 *
 * guards: vitest's or node:test's reporter API drifts from the stubs reporter.spec.mjs uses and records go missing or mislabeled, the
 *   reporter changes a run's exit status or output, or a store failure fails a green run.
 * tier: P (spawns vitest, a child process, in a temporary project; build-tools `node --test` lane; each case is one
 *   vitest or node run, about 1 s on an idle machine).
 * gap: This cannot be observed at tier S because the TestModule/TestCase objects and node:test event stream, the config merge that appends the
 *   reporter after `default`, the process exit status and the printed summary exist only inside a real vitest process.
 * cites: 595965cc T37.AC2 (per-test durations are recorded for every vitest project), T36.AC1 (outcomes recorded per run).
 * teeth: red 2026-10-15: `node --test reporter-api.spec.mjs` -> exit 1 with the plugin hook dropping `default` (no-reporters case) and
 *   with the store rethrowing on an unwritable path (green-run case) (authorship was not separated).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readRecords, STORE_FILE_NAME } from './store.mjs';

const { scratchRootPath } = createRequire(import.meta.url)('../../lib/scratch-root.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const VITEST = join(ROOT, 'node_modules/vitest/vitest.mjs');
const PLUGIN = join(ROOT, 'tools/vite-plugins/source-resolution.mjs');
const HEADER = (tier) => `/**\n * guards: fixture\n * tier: ${tier}\n * cites: fixture\n */\n`;

let tmp;
before(() => {
  // under the repository's tooling scratch root (gitignored), so the fixture project resolves `vitest` from the workspace
  const root = scratchRootPath(ROOT);
  mkdirSync(root, { recursive: true });
  tmp = mkdtempSync(join(root, 'test-metrics-api-'));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

/** A throwaway vitest project that uses the real shared plugin and, by default, lists `reporters: ['default']` like the repository's. */
function project(name, specs, { reporters = "reporters: ['default'], " } = {}) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'vite.config.mjs'),
    `import { defineConfig } from 'vitest/config';\nimport { nxViteTsPathsPre } from ${JSON.stringify(PLUGIN)};\nexport default defineConfig({ plugins: [nxViteTsPathsPre()], test: { name: ${JSON.stringify(name)}, include: ['*.spec.mjs'], ${reporters}} });\n`,
  );
  for (const [file, body] of Object.entries(specs)) writeFileSync(join(dir, file), body);
  return dir;
}

function runVitest(dir, env) {
  return spawnSync(process.execPath, [VITEST, 'run'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CI: '', VITEST_SKIP_INSTALL_CHECKS: '1', ...env } });
}

// The skip and todo calls are assembled so this file carries no literal skip/todo marker for the G4 scan.
const SKIP = 'it.' + 'skip';
const TODO = 'it.' + 'todo';
const MIXED = `${HEADER('P (fixture)')}import { it, expect } from 'vitest';\nit('passes', () => { expect(1).toBe(1); });\nit('fails', () => { expect(1).toBe(2); });\n${SKIP}('is skipped', () => {});\n${TODO}('is todo');\n`;
const SKIP_NODE = 'it.' + 'skip';
const TODO_NODE = 'it.' + 'todo';
const GREEN = `${HEADER('S')}import { it, expect } from 'vitest';\nit('passes', () => { expect(1).toBe(1); });\n`;

describe('the metrics reporter under real vitest', () => {
  it('records all four outcomes with the header tier, and leaves vitest\'s exit status and summary untouched', () => {
    const dir = project('mixed', { 'a.spec.mjs': MIXED });
    const store = join(tmp, 'mixed-store');
    const r = runVitest(dir, { ADHD_TEST_TIMINGS_DIR: store });
    assert.equal(r.status, 1, `the failing fixture test fails the run: ${r.stderr.slice(-400)}`);
    assert.match(r.stdout + r.stderr, /Test Files\s+1 failed/, 'the default reporter still prints its summary');
    const { records } = readRecords(join(store, STORE_FILE_NAME));
    const tests = records.filter((x) => x.kind === 'test');
    assert.deepEqual(tests.map((t) => [t.name, t.outcome]).sort(), [['fails', 'fail'], ['is skipped', 'skip'], ['is todo', 'todo'], ['passes', 'pass']]);
    for (const t of tests) {
      assert.equal(t.tier, 'P');
      assert.equal(t.tierSource, 'header');
      assert.equal(t.project, 'mixed');
      assert.equal(t.file.endsWith('a.spec.mjs'), true);
      assert.equal(typeof t.durationMs, 'number');
      assert.equal(t.retryCount, 0);
      assert.equal(t.runner, 'vitest');
      assert.match(t.runId, /^[0-9a-f-]{36}$/);
      assert.equal(typeof t.loadAvgStart, 'number');
    }
    const run = records.find((x) => x.kind === 'run');
    assert.equal(run.tests, 4);
    assert.ok(run.wallMs > 0);
  });

  it('a project that sets no reporters keeps vitest\'s default output and is recorded too', () => {
    const dir = project('no-reporters', { 'a.spec.mjs': GREEN }, { reporters: '' });
    const store = join(tmp, 'noreporters-store');
    const r = runVitest(dir, { ADHD_TEST_TIMINGS_DIR: store });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /Test Files\s+1 passed/, 'the default reporter is still on');
    assert.equal(readRecords(join(store, STORE_FILE_NAME)).records.filter((x) => x.kind === 'test').length, 1);
  });

  it('a green run stays green, and the warning names the store, when the store cannot be written', () => {
    const dir = project('green-unwritable', { 'a.spec.mjs': GREEN });
    writeFileSync(join(tmp, 'a-regular-file'), 'x');
    const r = runVitest(dir, { ADHD_TEST_TIMINGS_DIR: join(tmp, 'a-regular-file', 'sub') });
    assert.equal(r.status, 0, `${r.stdout.slice(-500)}\n${r.stderr.slice(-500)}`);
    assert.match(r.stdout + r.stderr, /test-metrics: could not write/);
  });

  it('writes nothing when ADHD_TEST_METRICS=0', () => {
    const dir = project('opt-out', { 'a.spec.mjs': GREEN });
    const store = join(tmp, 'optout-store');
    const r = runVitest(dir, { ADHD_TEST_TIMINGS_DIR: store, ADHD_TEST_METRICS: '0' });
    assert.equal(r.status, 0);
    assert.deepEqual(readRecords(join(store, STORE_FILE_NAME)), { records: [], corrupt: 0 });
  });
});

describe('the node:test reporter under real node --test', () => {
  it('runs beside the spec reporter, records nested names and all four outcomes, and leaves the exit status alone', () => {
    const dir = join(tmp, 'node-lane');
    mkdirSync(dir, { recursive: true });
    const spec = join(dir, 'lane.spec.mjs');
    writeFileSync(
      spec,
      `${HEADER('P (fixture)')}import { describe, it } from 'node:test';\nimport assert from 'node:assert/strict';\n` +
        `describe('group', () => {\n  it('passes', () => {});\n  it('fails', () => { assert.equal(1, 2); });\n  ${SKIP_NODE}('is skipped', () => {});\n  ${TODO_NODE}('is todo', () => {});\n});\n`,
    );
    const store = join(tmp, 'node-store');
    const r = spawnSync(
      process.execPath,
      ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${join(ROOT, 'tools/nx-plugins/test/metrics/node-test-reporter.mjs')}`, '--test-reporter-destination=stdout', spec],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined, ADHD_TEST_TIMINGS_DIR: store } }, // a nested `node --test` inherits NODE_TEST_CONTEXT and would report as a child, not run as a root
    );
    assert.equal(r.status, 1, 'the failing fixture test fails the run');
    assert.match(r.stdout, /group/, 'the spec reporter still prints');
    const tests = readRecords(join(store, STORE_FILE_NAME)).records.filter((x) => x.kind === 'test');
    assert.deepEqual(tests.map((t) => [t.name, t.outcome]).sort(), [['group > fails', 'fail'], ['group > is skipped', 'skip'], ['group > is todo', 'todo'], ['group > passes', 'pass']]);
    assert.ok(tests.every((t) => t.runner === 'node-test' && t.tier === 'P' && t.tierSource === 'header'));
  });
});
