/**
 * reporter.spec.mjs: the vitest and node:test reporters write one record per test (pass, fail, skip, todo) with the
 * run's identity, never throw when the store cannot be written, and are attached to every vitest project by the shared
 * plugin hook. Vitest's TestModule and TestCase are stubbed here; reporter-api.spec.mjs runs the real vitest.
 *
 * guards: a test result is lost or mislabeled in the history, a failed write breaks the run being observed, or a
 *   vitest project is not given the reporter.
 * tier: S (stubbed vitest objects, an injected writer, no subprocess).
 * cites: 595965cc T37.AC2 (the duration report reads these records), T36.AC1 (the repeat-run reads their outcomes).
 * teeth: red 2026-10-15: `node --test reporter.spec.mjs` -> exit 1 with todo mapped to skip (2 cases), onTestRunEnd rethrowing (1) and
 *   the plugin hook dropping `default` (1); the lane-wiring cases failed until package.json carried the reporter pair.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { testMetricsConfig, TEST_METRICS_REPORTER } from '../../../vite-plugins/test-metrics.mjs';
import { nxViteTsPathsPre } from '../../../vite-plugins/source-resolution.mjs';
import { collectFromEvents, outcomeOfEvent } from './node-test-reporter.mjs';
import Reporter, { outcomeOf } from './vitest-reporter.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const RUN = { runId: 'run-1', runner: 'vitest', group: null, startedAt: '2026-10-14T00:00:00.000Z', loadAvgStart: 3.5, cpus: 10, ci: false, gitSha: 'abc', dirty: false, branch: 'main', mainline: true };

const testCase = ({ fullName, state, duration = 1, retryCount = 0, mode = 'run', project = 'proj', moduleId = `${ROOT}/pkg/a.spec.ts` }) => ({
  fullName,
  project: { name: project },
  module: { moduleId },
  options: { mode },
  result: () => ({ state }),
  diagnostic: () => (state === 'skipped' ? undefined : { duration, retryCount }),
});
const testModule = (moduleId, tests) => ({ moduleId, project: { name: 'proj' }, children: { allTests: () => tests } });

function reporter(extra = {}) {
  const writes = [];
  const warnings = [];
  const r = new Reporter({
    env: {},
    root: ROOT,
    begin: async () => RUN,
    tierOf: () => ({ tier: 'S', tierSource: 'header' }),
    append: async (file, records) => { writes.push({ file, records }); return { ok: true, written: records.length }; },
    store: '/store.jsonl',
    warn: (m) => warnings.push(m),
    ...extra,
  });
  return { r, writes, warnings };
}

describe('vitest reporter', () => {
  it('records pass, fail, skip and todo with the run identity, tier, duration and retry count', async () => {
    const { r, writes } = reporter();
    r.onInit();
    r.onTestRunStart();
    const mod = testModule(`${ROOT}/pkg/a.spec.ts`, [
      testCase({ fullName: 'suite > passes', state: 'passed', duration: 12.345 }),
      testCase({ fullName: 'suite > fails', state: 'failed', duration: 7, retryCount: 1 }),
      testCase({ fullName: 'suite > skipped', state: 'skipped', mode: 'skip' }),
      testCase({ fullName: 'suite > todo', state: 'skipped', mode: 'todo' }),
    ]);
    await r.onTestRunEnd([mod]);
    assert.equal(writes.length, 1, 'one batch per run');
    assert.equal(writes[0].file, '/store.jsonl');
    const tests = writes[0].records.filter((x) => x.kind === 'test');
    assert.deepEqual(tests.map((t) => [t.name, t.outcome]), [['suite > passes', 'pass'], ['suite > fails', 'fail'], ['suite > skipped', 'skip'], ['suite > todo', 'todo']]);
    const [pass, fail] = tests;
    assert.deepEqual(
      { project: pass.project, file: pass.file, tier: pass.tier, durationMs: pass.durationMs, retryCount: pass.retryCount, runId: pass.runId, gitSha: pass.gitSha, ts: pass.ts, loadAvgStart: pass.loadAvgStart, runner: pass.runner },
      { project: 'proj', file: 'pkg/a.spec.ts', tier: 'S', durationMs: 12.35, retryCount: 0, runId: 'run-1', gitSha: 'abc', ts: RUN.startedAt, loadAvgStart: 3.5, runner: 'vitest' },
    );
    assert.equal(fail.retryCount, 1);
    const run = writes[0].records.find((x) => x.kind === 'run');
    assert.equal(run.tests, 4);
    assert.equal(run.project, 'proj');
    assert.ok(typeof run.wallMs === 'number' && typeof run.reporterMs === 'number');
  });

  it('outcomeOf distinguishes todo from skip', () => {
    assert.equal(outcomeOf(testCase({ fullName: 'x', state: 'skipped', mode: 'todo' })), 'todo');
    assert.equal(outcomeOf(testCase({ fullName: 'x', state: 'skipped', mode: 'skip' })), 'skip');
    assert.equal(outcomeOf(testCase({ fullName: 'x', state: 'pending' })), 'skip');
  });

  it('never throws, and warns, when the writer rejects, when the run context fails, and when a test case is malformed', async () => {
    for (const extra of [
      { append: async () => { throw new Error('boom'); } },
      { begin: async () => { throw new Error('git is gone'); } },
    ]) {
      const { r, warnings } = reporter(extra);
      r.onInit();
      r.onTestRunStart();
      await r.onTestRunEnd([testModule('/x/a.spec.ts', [testCase({ fullName: 'a', state: 'passed' })])]);
      assert.match(warnings.join('\n'), /test-metrics: could not record this run/);
    }
    const { r, warnings } = reporter();
    r.onTestRunStart();
    await r.onTestRunEnd([{ moduleId: '/x', children: { allTests: () => { throw new Error('api changed'); } } }]);
    assert.match(warnings.join('\n'), /api changed/);
  });

  it('records nothing when ADHD_TEST_METRICS=0', async () => {
    const { r, writes } = reporter({ env: { ADHD_TEST_METRICS: '0' } });
    r.onInit();
    r.onTestRunStart();
    await r.onTestRunEnd([testModule('/x/a.spec.ts', [testCase({ fullName: 'a', state: 'passed' })])]);
    assert.equal(writes.length, 0);
  });
});

describe('node:test reporter', () => {
  const ev = (type, data) => ({ type, data: { file: '/r/tools/x.spec.mjs', nesting: 0, ...data } });
  async function* stream(events) {
    for (const e of events) yield e;
  }
  const collect = (events) => collectFromEvents(stream(events), { ...RUN, runner: 'node-test' }, { root: '/r', tierOf: () => ({ tier: 'P', tierSource: 'header' }), projectOf: () => '@adhd/nx-plugins' });

  it('records tests with their ancestors\' names, skips suites, and maps skip, todo and fail', async () => {
    const { records } = await collect([
      ev('test:start', { name: 'group', nesting: 0 }),
      ev('test:start', { name: 'passes', nesting: 1 }),
      ev('test:pass', { name: 'passes', nesting: 1, details: { type: 'test', duration_ms: 4.2 } }),
      ev('test:start', { name: 'fails', nesting: 1 }),
      ev('test:fail', { name: 'fails', nesting: 1, details: { duration_ms: 9 } }),
      ev('test:start', { name: 'skipped', nesting: 1 }),
      ev('test:pass', { name: 'skipped', nesting: 1, skip: true, details: { duration_ms: 0 } }),
      ev('test:start', { name: 'todo', nesting: 1 }),
      ev('test:pass', { name: 'todo', nesting: 1, todo: 'later', details: { duration_ms: 0 } }),
      ev('test:pass', { name: 'group', nesting: 0, details: { type: 'suite', duration_ms: 20 } }),
      ev('test:diagnostic', { message: 'ignored' }),
    ]);
    assert.deepEqual(records.map((x) => [x.name, x.outcome, x.durationMs]), [['group > passes', 'pass', 4.2], ['group > fails', 'fail', 9], ['group > skipped', 'skip', 0], ['group > todo', 'todo', 0]]);
    assert.deepEqual([records[0].file, records[0].tier, records[0].project, records[0].runner], ['tools/x.spec.mjs', 'P', '@adhd/nx-plugins', 'node-test']);
  });

  it('keeps each file\'s name stack apart when two files\' events interleave', async () => {
    const other = (type, data) => ({ type, data: { file: '/r/tools/y.spec.mjs', nesting: 0, ...data } });
    const { records } = await collect([
      ev('test:start', { name: 'A', nesting: 0 }),
      other('test:start', { name: 'B', nesting: 0 }),
      ev('test:start', { name: 'a1', nesting: 1 }),
      other('test:start', { name: 'b1', nesting: 1 }),
      other('test:pass', { name: 'b1', nesting: 1, details: { duration_ms: 1 } }),
      ev('test:pass', { name: 'a1', nesting: 1, details: { duration_ms: 1 } }),
    ]);
    assert.deepEqual(records.map((x) => x.name).sort(), ['A > a1', 'B > b1']);
  });

  it('outcomeOfEvent treats todo:false and skip:false as ordinary tests', () => {
    assert.equal(outcomeOfEvent('test:pass', { todo: false, skip: false }), 'pass');
    assert.equal(outcomeOfEvent('test:fail', {}), 'fail');
  });
});

describe('the shared vite plugin hook', () => {
  it('adds the reporter after the project\'s own list, so `default` keeps printing', () => {
    assert.deepEqual(testMetricsConfig({ test: { reporters: ['default'] } }, {}), { test: { reporters: [TEST_METRICS_REPORTER] } });
  });
  it('adds `default` too when the project sets no reporters, so the default output is not lost', () => {
    assert.deepEqual(testMetricsConfig({ test: {} }, {}), { test: { reporters: ['default', TEST_METRICS_REPORTER] } });
  });
  it('leaves configs without a test block (builds, storybook) and opted-out runs alone', () => {
    assert.equal(testMetricsConfig({}, {}), undefined);
    assert.equal(testMetricsConfig(undefined, {}), undefined);
    assert.equal(testMetricsConfig({ test: { reporters: ['default'] } }, { ADHD_TEST_METRICS: '0' }), undefined);
  });
  it('is carried by nxViteTsPathsPre, the plugin every project config already installs', () => {
    const plugin = nxViteTsPathsPre();
    assert.equal(plugin.name, 'nx-vite-ts-paths-pre');
    assert.deepEqual(plugin.config({ test: { reporters: ['default'] } }), { test: { reporters: [TEST_METRICS_REPORTER] } });
  });
  it('points at a reporter file that exists and default-exports a class', async () => {
    const mod = await import(TEST_METRICS_REPORTER);
    assert.equal(typeof mod.default, 'function');
  });
});

describe('lane wiring', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const lane = pkg.scripts['test:build-tools'];
  it('pairs the spec reporter and the metrics reporter, each with its own destination, in the build-tools lane', () => {
    assert.match(lane, /^node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=\.\/tools\/nx-plugins\/test\/metrics\/node-test-reporter\.mjs --test-reporter-destination=stdout /);
  });
  it('lists every spec of this directory, so the lane reaches them', () => {
    const specs = readdirSync(dirname(fileURLToPath(import.meta.url))).filter((f) => f.endsWith('.spec.mjs'));
    assert.ok(specs.length >= 4, `found ${specs.join(', ')}`);
    for (const f of specs) assert.ok(lane.includes(`tools/nx-plugins/test/metrics/${f}`), f);
  });
});
