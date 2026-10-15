/**
 * analysis.spec.mjs: the percentile math, tier summaries, tier-budget offenders, flake detection, and the G5 and G7
 * verdicts, each on known inputs, with the boundary and the near-miss that must NOT trip.
 *
 * guards: a slow test goes unreported, a flaky test is missed or a stable one accused, or a gate verdict is computed
 *   from the wrong runs (dirty trees, non-mainline runs, fewer than five prior runs).
 * tier: S (pure functions over in-memory records).
 * cites: 595965cc T36.AC1 (both outcomes on the same code), T37.AC2 (over-budget tests listed and failed at the configured severity).
 * teeth: red 2026-10-15: `node --test analysis.spec.mjs` -> exit 1 with percentile using floor (3 cases), the dirty filter dropped (1),
 *   the G7 ratio removed (2), the budget compare `>=` (1) and the minimum prior runs set to 3 (1) (authorship was not separated).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { flaky, g5, g7, history, median, offenders, percentile, summary } from './analysis.mjs';

let seq = 0;
/** A 'test' record with sensible defaults. */
const rec = (o = {}) => ({
  kind: 'test', runId: o.runId ?? `run-${seq++}`, project: 'p', file: 'a.spec.ts', name: 't', tier: 'S', tierSource: 'header',
  outcome: 'pass', durationMs: 1, retryCount: 0, gitSha: 'sha1', dirty: false, branch: 'main', mainline: true, group: null,
  ts: '2026-10-14T00:00:00.000Z', loadAvgStart: 1, cpus: 10, ...o,
});

describe('percentile and median (nearest-rank)', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  it('known inputs', () => {
    assert.equal(percentile(hundred, 50), 50);
    assert.equal(percentile(hundred, 95), 95);
    assert.equal(percentile(hundred, 100), 100);
    assert.equal(percentile([10, 20, 30, 40, 50], 50), 30);
    assert.equal(percentile([10, 20, 30, 40, 50], 95), 50);
    assert.equal(percentile([7], 95), 7);
    assert.equal(percentile([], 95), null);
  });
  it('is order-independent and does not mutate its input', () => {
    const v = [50, 10, 40, 20, 30];
    assert.equal(percentile(v, 50), 30);
    assert.deepEqual(v, [50, 10, 40, 20, 30]);
  });
  it('median averages the middle pair of an even count', () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([5, 1, 3]), 3);
    assert.equal(median([]), null);
  });
});

describe('summary', () => {
  it('reports p50/p95 per tier and per project, and counts outcomes', () => {
    const rows = [
      ...[10, 20, 30, 40, 50].map((d, i) => rec({ name: `s${i}`, durationMs: d })),
      rec({ name: 'skipped', outcome: 'skip', durationMs: 0 }),
      rec({ name: 'e2e', tier: 'P', project: 'q', durationMs: 4000 }),
      { kind: 'run', runId: 'r1', project: 'p', ts: '2026-10-14T00:00:00.000Z', wallMs: 900, reporterMs: 2 },
    ];
    const s = summary(rows);
    assert.deepEqual([s.byTier.S.p50Ms, s.byTier.S.p95Ms, s.byTier.S.executed, s.byTier.S.skip], [30, 50, 5, 1]);
    assert.equal(s.byTier.P.p95Ms, 4000);
    assert.equal(s.byProject.q.executed, 1);
    assert.equal(s.suiteWallMs.p.latestMs, 900);
    assert.equal(s.reporterOverheadMs.max, 2);
  });
});

describe('offenders', () => {
  it('flags a tier S test whose p95 is over 100 ms, and one run over 1 s, and nothing at exactly the budget', () => {
    const slow = [90, 110, 120, 130].map((d) => rec({ name: 'slow', durationMs: d }));
    const huge = [rec({ name: 'huge', durationMs: 1500 })];
    const edge = [rec({ name: 'edge', durationMs: 100 })];
    const quick = [rec({ name: 'quick', durationMs: 5 })];
    const found = offenders([...slow, ...huge, ...edge, ...quick]);
    assert.deepEqual(found.map((o) => [o.test, o.over]), [['a.spec.ts :: huge', ['p95', 'ceiling']], ['a.spec.ts :: slow', ['p95']]]);
  });
  it('applies the P budget (10 s) and never flags tier X', () => {
    const found = offenders([
      rec({ name: 'p-ok', tier: 'P', durationMs: 9999 }),
      rec({ name: 'p-slow', tier: 'P', durationMs: 10_001 }),
      rec({ name: 'x', tier: 'X', durationMs: 999_999 }),
    ]);
    assert.deepEqual(found.map((o) => o.test), ['a.spec.ts :: p-slow']);
  });
  it('ignores skipped tests and uses a test\'s p95 over runs, not one outlier', () => {
    const runs = Array.from({ length: 20 }, (_, i) => rec({ name: 'steady', durationMs: i === 0 ? 150 : 20 }));
    assert.equal(offenders([...runs, rec({ name: 'sk', outcome: 'skip', durationMs: 9000 })]).length, 0, 'one outlier in 20 runs is under the p95');
  });
});

describe('flaky (both outcomes on the same code)', () => {
  const two = (a, b, over = {}) => [rec({ outcome: a, ...over }), rec({ outcome: b, ...over })];
  it('flags a test that passed in one run and failed in another run of the same clean sha', () => {
    const f = flaky(two('pass', 'fail'));
    assert.equal(f.mixed.length, 1);
    assert.deepEqual([f.mixed[0].passes, f.mixed[0].fails, f.mixed[0].runs], [1, 1, 2]);
    assert.equal(f.repeatCoverage, 1);
  });
  it('does not flag consistent outcomes, a different sha, or a single run', () => {
    assert.equal(flaky(two('pass', 'pass')).mixed.length, 0);
    assert.equal(flaky([rec({ outcome: 'pass', gitSha: 'a' }), rec({ outcome: 'fail', gitSha: 'b' })]).mixed.length, 0, 'different code is a regression, not a flake');
    assert.equal(flaky([rec({ outcome: 'fail' })]).mixed.length, 0);
    assert.equal(flaky([rec({ outcome: 'pass', runId: 'same' }), rec({ outcome: 'fail', runId: 'same' })]).mixed.length, 0, 'one run is not a repeat');
  });
  it('treats a dirty or unknown tree as no evidence unless asked', () => {
    assert.equal(flaky(two('pass', 'fail', { dirty: true })).mixed.length, 0);
    assert.equal(flaky(two('pass', 'fail', { dirty: null })).mixed.length, 0);
    assert.equal(flaky(two('pass', 'fail', { dirty: true }), { includeDirty: true }).mixed.length, 1);
  });
  it('uses the repeat group as the identity of the code, dirty tree or not', () => {
    const g = two('pass', 'fail', { group: 'g1', dirty: true, gitSha: null });
    assert.equal(flaky(g).mixed.length, 1);
  });
  it('lists tests that used a retry', () => {
    const f = flaky([rec({ name: 'r', retryCount: 2, outcome: 'pass' }), rec({ name: 'ok' })]);
    assert.deepEqual(f.retried.map((r) => [r.test, r.maxRetries, r.recovered]), [['a.spec.ts :: r', 2, 1]]);
  });
});

describe('g5 (flake share per tier, no retry)', () => {
  const hundredStable = (n) => Array.from({ length: n }, (_, i) => rec({ name: `stable-${i}` }));
  it('passes with no flakes, and with history it cannot judge it says insufficient', () => {
    assert.equal(g5(hundredStable(50)).status, 'pass');
    const empty = g5([]);
    assert.equal(empty.status, 'insufficient');
    assert.match(empty.message, /insufficient history/);
  });
  it('fails when the flaky share exceeds 1% of the tier\'s executions (3 of 100), passes at the limit (1 of 100)', () => {
    const mixed = (n) => [rec({ name: `f${n}`, outcome: 'pass' }), rec({ name: `f${n}`, outcome: 'fail' })];
    const over = g5([...hundredStable(94), ...mixed(1), ...mixed(2), ...mixed(3)]); // 6 flaky records of 100
    assert.equal(over.status, 'fail');
    assert.equal(over.violations.find((v) => v.rule === 'flake-share').tier, 'S');
    const atLimit = g5([...hundredStable(99), rec({ name: 'f', outcome: 'pass', retryCount: 0 })]);
    assert.equal(atLimit.status, 'pass');
  });
  it('fails any retry in use: with no tracking-item registry every retry is unrecorded', () => {
    const r = g5([...hundredStable(500), rec({ name: 'retried', retryCount: 1 })]);
    assert.equal(r.status, 'fail');
    assert.deepEqual(r.violations.map((v) => v.rule), ['unrecorded-retry']);
  });
});

describe('g7 (budgets and the regression rule)', () => {
  /** n prior mainline runs of one project/tier, each with a single test at `p95` ms, then one latest run. */
  const history5 = (priorMs, latestMs, { priorOver = {}, latestOver = {} } = {}) => [
    ...priorMs.map((d, i) => rec({ runId: `prior-${i}`, durationMs: d, ts: `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`, ...priorOver })),
    rec({ runId: 'latest', durationMs: latestMs, ts: '2026-10-14T00:00:00.000Z', mainline: false, branch: 'feat', ...latestOver }),
  ];
  it('reports insufficient history, and passes, with fewer than 5 prior mainline runs', () => {
    const r = g7(history5([10, 10, 10, 10], 500));
    assert.equal(r.status, 'pass');
    assert.match(r.message, /insufficient history/);
    assert.equal(r.units[0].state, 'insufficient history');
    assert.equal(r.units[0].priorMainlineRuns, 4);
  });
  it('fails a regression: latest p95 more than 10% above the median of the previous five mainline runs', () => {
    const r = g7(history5([10, 10, 10, 10, 10], 12));
    assert.equal(r.status, 'fail');
    assert.equal(r.regressions[0].ratio, 1.2);
    assert.equal(r.regressions[0].medianPriorP95Ms, 10);
  });
  it('passes exactly 10% above and below, and uses the median not the mean', () => {
    assert.equal(g7(history5([10, 10, 10, 10, 10], 11)).status, 'pass', 'the boundary is allowed');
    assert.equal(g7(history5([10, 10, 10, 10, 10], 5)).status, 'pass');
    assert.equal(g7(history5([1, 1, 1, 100, 100], 1.05)).status, 'pass', 'median 1, so 1.05 is within 10%');
  });
  it('counts only clean mainline runs as the baseline', () => {
    const notMainline = g7(history5([10, 10, 10, 10, 10], 50, { priorOver: { mainline: false } }));
    assert.match(notMainline.message, /insufficient history/);
    const dirty = g7(history5([10, 10, 10, 10, 10], 50, { priorOver: { dirty: true } }));
    assert.match(dirty.message, /insufficient history/);
  });
  it('uses only the five most recent prior mainline runs', () => {
    // five old fast runs then five recent runs at 10 ms: the last five give median 10 (11 ms passes); all ten would give 5.5
    const r = g7(history5([1, 1, 1, 1, 1, 10, 10, 10, 10, 10], 11));
    assert.equal(r.status, 'pass');
    assert.equal(r.units[0].medianPriorP95Ms, 10);
  });
  it('lists per-test budget breaches as warnings by default and as failures when the severity is fail', () => {
    const budgetOnly = [rec({ runId: 'only', name: 'slow', durationMs: 2000 })];
    const warn = g7(budgetOnly);
    assert.equal(warn.status, 'pass');
    assert.equal(warn.budget.offenders.length, 1);
    assert.equal(g7(budgetOnly, { budgetSeverity: 'fail' }).status, 'fail');
    assert.equal(g7([rec({ runId: 'only', durationMs: 5 })], { budgetSeverity: 'fail' }).status, 'pass', 'nothing over budget never fails');
  });
  it('says insufficient history when there is no data at all', () => {
    assert.equal(g7([]).status, 'insufficient');
  });
});

describe('history', () => {
  it('returns the matching test\'s executions oldest first', () => {
    const h = history([rec({ name: 'b', ts: '2026-10-02T00:00:00Z' }), rec({ name: 'a', ts: '2026-10-03T00:00:00Z' }), rec({ name: 'a', ts: '2026-10-01T00:00:00Z' })], ':: a');
    assert.deepEqual(h.map((r) => r.ts), ['2026-10-01T00:00:00Z', '2026-10-03T00:00:00Z']);
  });
});
