/**
 * analysis — the pure statistics behind `test-report.mjs`: percentiles, per-tier and per-project summaries, tier-budget
 * offenders, flake detection, and the G5 and G7 verdicts. No I/O: every function takes the records `store.readRecords`
 * returns, so each rule is testable on known inputs.
 *
 * DEFINITIONS (the report's help text states the same):
 *   executed  a 'test' record whose outcome is pass or fail (skip and todo have no duration worth measuring).
 *   run       one runner process: every record sharing a `runId` (one vitest project run, or one `node --test` lane).
 *   code      what "the same code" means for flake detection: the run `group` when set (a repeat-run), else the git sha
 *             of a CLEAN working tree (`dirty === false`). A dirty or unknown tree is never evidence of a flake.
 *   mainline  a run on `main` or on a commit already reachable from `origin/main`, with a clean working tree.
 *   percentile  nearest-rank: the smallest observed value with at least p percent of observations at or below it.
 */
import { isQuarantined } from './quarantine.mjs';
import { TIER_BUDGETS, TIER_ORDER } from './tiers.mjs';

export const G5_FLAKE_SHARE_LIMIT = 0.01;
export const G7_REGRESSION_RATIO = 1.1;
export const G7_MIN_PRIOR_MAINLINE_RUNS = 5;

/** Nearest-rank percentile of `values` (any order). Returns null for an empty list. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** The arithmetic median (mean of the two middle values for an even count). Null for an empty list. */
export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round = (n) => (n === null ? null : Math.round(n * 100) / 100);
export const isTest = (r) => r.kind === 'test';
export const isExecuted = (r) => isTest(r) && (r.outcome === 'pass' || r.outcome === 'fail');
export const testKey = (r) => `${r.project}\u0000${r.file}\u0000${r.name}`;
export const displayKey = (r) => `${r.file} :: ${r.name}`;

/** Keep the records matching the optional project, tier and since filters. `since` is an ISO string. */
export function filterRecords(records, { project, tier, since } = {}) {
  return records.filter(
    (r) => (!project || r.project === project || String(r.project).split(',').includes(project)) && (!tier || r.tier === tier || r.kind === 'run') && (!since || r.ts >= since),
  );
}

function stats(recs) {
  const exec = recs.filter(isExecuted);
  const d = exec.map((r) => r.durationMs);
  const count = (o) => recs.filter((r) => isTest(r) && r.outcome === o).length;
  return { executed: exec.length, p50Ms: round(percentile(d, 50)), p95Ms: round(percentile(d, 95)), maxMs: round(d.length ? Math.max(...d) : null), pass: count('pass'), fail: count('fail'), skip: count('skip'), todo: count('todo') };
}

const groupBy = (items, keyFn) => {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
};

/** Load of a set of records relative to the CPU count: the median of loadAvgStart / cpus (above 1 the machine was oversubscribed). */
export function loadRatio(recs) {
  const ratios = recs.filter((r) => typeof r.loadAvgStart === 'number' && r.cpus).map((r) => r.loadAvgStart / r.cpus);
  return round(median(ratios));
}

/** p50/p95 per tier and per project, and suite wall time per project. */
export function summary(records) {
  const tests = records.filter(isTest);
  const runs = records.filter((r) => r.kind === 'run');
  const byTier = {};
  for (const t of TIER_ORDER) {
    const recs = tests.filter((r) => r.tier === t);
    if (recs.length) byTier[t] = { ...stats(recs), budgetP95Ms: TIER_BUDGETS[t].p95Ms };
  }
  const byProject = {};
  for (const [project, recs] of groupBy(tests, (r) => r.project)) {
    byProject[project] = { ...stats(recs), tiers: Object.fromEntries(TIER_ORDER.filter((t) => recs.some((r) => r.tier === t)).map((t) => [t, stats(recs.filter((r) => r.tier === t))])) };
  }
  const wall = {};
  for (const [project, rs] of groupBy(runs, (r) => r.project)) {
    const sorted = [...rs].sort((a, b) => (a.ts < b.ts ? -1 : 1));
    wall[project] = { runs: rs.length, latestMs: sorted.at(-1).wallMs, medianMs: median(rs.map((r) => r.wallMs)) };
  }
  const reporterMs = runs.map((r) => r.reporterMs).filter((n) => typeof n === 'number');
  return {
    records: tests.length,
    runs: new Set(tests.map((r) => r.runId)).size,
    byTier,
    byProject,
    suiteWallMs: wall,
    reporterOverheadMs: { p50: round(percentile(reporterMs, 50)), max: round(reporterMs.length ? Math.max(...reporterMs) : null) },
    loadRatio: loadRatio(tests),
    highLoadRuns: new Set(tests.filter((r) => r.cpus && r.loadAvgStart / r.cpus > 1).map((r) => r.runId)).size,
  };
}

/**
 * Tests over their tier's budget. A test is over `p95` when its own p95 exceeds the tier's per-test p95 budget, and over
 * `ceiling` (tier S) when any single execution exceeded the split-or-fix threshold.
 * @returns {{ test: string, project: string, tier: string, tierSource: string, runs: number, p95Ms: number, maxMs: number, budgetMs: number|null, over: string[], loadRatio: number|null }[]}
 */
export function offenders(records, { budgets = TIER_BUDGETS } = {}) {
  const out = [];
  for (const recs of groupBy(records.filter(isExecuted), testKey).values()) {
    const first = recs[0];
    const budget = budgets[first.tier];
    if (!budget) continue;
    const d = recs.map((r) => r.durationMs);
    const p95 = percentile(d, 95);
    const max = Math.max(...d);
    const over = [];
    if (budget.p95Ms !== null && p95 > budget.p95Ms) over.push('p95');
    if (budget.splitOrFixMs !== null && max > budget.splitOrFixMs) over.push('ceiling');
    if (over.length) out.push({ test: displayKey(first), project: first.project, tier: first.tier, tierSource: first.tierSource, runs: recs.length, p95Ms: round(p95), maxMs: round(max), budgetMs: budget.p95Ms, over, loadRatio: loadRatio(recs) });
  }
  return out.sort((a, b) => b.p95Ms - a.p95Ms);
}

/** The identity of "the same code" for a record, or null when the record is not evidence of anything (see the header). */
export function codeId(r, { includeDirty = false } = {}) {
  if (r.group) return `group:${r.group}`;
  if (!r.gitSha) return null;
  if (r.dirty === false) return `sha:${r.gitSha}`;
  return includeDirty ? `sha:${r.gitSha}+dirty` : null;
}

/**
 * Flake evidence: tests with both a pass and a fail on the same code across distinct runs (`mixed`), tests that needed a
 * retry (`retried`), and how many tests have any same-code repeat at all (`repeatCoverage`; without a repeat-run a test
 * cannot be shown flaky, and nx's cache means same-sha repeats are rare until the repeat-run mode is used).
 */
export function flaky(records, { includeDirty = false } = {}) {
  const exec = records.filter(isExecuted);
  const mixed = [];
  let repeated = 0;
  for (const recs of groupBy(exec, (r) => `${testKey(r)}\u0001${codeId(r, { includeDirty })}`).values()) {
    const code = codeId(recs[0], { includeDirty });
    if (code === null) continue;
    if (new Set(recs.map((r) => r.runId)).size < 2) continue;
    repeated++;
    const passes = recs.filter((r) => r.outcome === 'pass').length;
    const fails = recs.length - passes;
    if (passes && fails) mixed.push({ test: displayKey(recs[0]), project: recs[0].project, tier: recs[0].tier, code, runs: new Set(recs.map((r) => r.runId)).size, passes, fails, ids: recs.map((r) => r.runId) });
  }
  const retried = [];
  for (const recs of groupBy(exec.filter((r) => r.retryCount > 0), testKey).values()) {
    retried.push({ test: displayKey(recs[0]), project: recs[0].project, tier: recs[0].tier, records: recs.length, maxRetries: Math.max(...recs.map((r) => r.retryCount)), recovered: recs.filter((r) => r.outcome === 'pass').length });
  }
  return { mixed, retried, repeatCoverage: repeated, executed: exec.length };
}

/**
 * G5: the flaky share of each tier's executions is at most 1 percent, and no retry is in use. A record is flaky when its
 * test is `mixed` on its code or the record itself used a retry. No executions at all is `insufficient`, not a pass.
 *
 * `quarantine` (T36.AC2) is `{ active, violations }` from `quarantine.mjs`: the executions of a quarantined test are
 * left out of the share and out of the flake and retry violations, and are listed under `quarantined` with their
 * outcomes (the test still runs and is still reported); an expired or malformed entry is itself a violation.
 */
export function g5(records, { limit = G5_FLAKE_SHARE_LIMIT, includeDirty = false, quarantine = { active: [], violations: [] } } = {}) {
  const exec = records.filter(isExecuted);
  if (exec.length === 0) return { status: 'insufficient', message: 'insufficient history: no executed test records', tiers: {}, violations: [], quarantined: [] };
  const held = (r) => isQuarantined(quarantine.active, displayKey(r));
  const gated = exec.filter((r) => !held(r));
  const quarantined = [];
  for (const recs of groupBy(exec.filter(held), testKey).values()) {
    quarantined.push({ test: displayKey(recs[0]), tier: recs[0].tier, executions: recs.length, passes: recs.filter((r) => r.outcome === 'pass').length, fails: recs.filter((r) => r.outcome === 'fail').length });
  }
  const f = flaky(records.filter((r) => !isExecuted(r) || !held(r)), { includeDirty });
  const mixedKeys = new Set(f.mixed.map((m) => `${m.test}\u0001${m.code}`));
  const tiers = {};
  for (const t of TIER_ORDER) {
    const recs = gated.filter((r) => r.tier === t);
    if (!recs.length) continue;
    const flakyRecs = recs.filter((r) => r.retryCount > 0 || mixedKeys.has(`${displayKey(r)}\u0001${codeId(r, { includeDirty })}`));
    tiers[t] = { executed: recs.length, flaky: flakyRecs.length, share: round(flakyRecs.length / recs.length) };
  }
  const violations = [];
  for (const [t, v] of Object.entries(tiers)) if (v.flaky / v.executed > limit) violations.push({ rule: 'flake-share', tier: t, share: v.share, limit });
  for (const r of f.retried) violations.push({ rule: 'unrecorded-retry', test: r.test, tier: r.tier, maxRetries: r.maxRetries });
  for (const v of quarantine.violations) violations.push({ rule: v.rule, test: v.entry.test ?? null, message: v.message });
  // With no same-code repeat anywhere, no flake CAN be observed (nx's cache means same-sha repeats are rare), so a clean
  // result is absence of evidence: `insufficient`, which the gate reports as unmeasured, until `repeat` has produced some.
  const unobservable = violations.length === 0 && f.repeatCoverage === 0;
  return {
    status: violations.length ? 'fail' : unobservable ? 'insufficient' : 'pass',
    message: unobservable ? 'insufficient history: no test has a same-code repeat, so a flake cannot be observed; run `test-report.mjs repeat --times 5 -- <test command>`' : undefined,
    tiers, violations, mixed: f.mixed, retried: f.retried, quarantined, repeatCoverage: f.repeatCoverage,
  };
}

const runsOf = (recs) => {
  const m = new Map();
  for (const r of recs) {
    const cur = m.get(r.runId);
    if (!cur) m.set(r.runId, { runId: r.runId, ts: r.ts, mainline: r.mainline === true && r.dirty === false, recs: [r] });
    else cur.recs.push(r);
  }
  return [...m.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
};

/**
 * G7: (1) per-test budgets by tier, evaluated on each project's latest run; (2) a regression rule per project and tier: the
 * latest run's p95 must be at most 10 percent above the median of the p95s of the previous five mainline runs. Fewer than
 * five prior mainline runs for a unit is `insufficient history` for that unit. Budget breaches are warnings unless
 * `budgetSeverity` is 'fail'; a regression always fails.
 */
export function g7(records, { budgetSeverity = 'warn', ratio = G7_REGRESSION_RATIO, minPrior = G7_MIN_PRIOR_MAINLINE_RUNS } = {}) {
  const exec = records.filter(isExecuted);
  if (exec.length === 0) return { status: 'insufficient', message: 'insufficient history: no executed test records', budget: { severity: budgetSeverity, offenders: [] }, regressions: [], units: [] };
  const regressions = [];
  const units = [];
  const latestRecs = [];
  for (const recs of groupBy(exec, (r) => r.project).values()) {
    const runs = runsOf(recs);
    const latest = runs.at(-1);
    latestRecs.push(...latest.recs);
    const prior = runs.filter((r) => r.runId !== latest.runId && r.mainline).slice(-minPrior);
    const priorAll = runs.filter((r) => r.runId !== latest.runId && r.mainline).length;
    for (const t of TIER_ORDER) {
      const cur = latest.recs.filter((r) => r.tier === t).map((r) => r.durationMs);
      if (!cur.length) continue;
      const p95 = percentile(cur, 95);
      const unit = { project: recs[0].project, tier: t, latestP95Ms: round(p95), latestRun: latest.runId, loadRatio: loadRatio(latest.recs) };
      const priorP95 = prior.map((run) => percentile(run.recs.filter((r) => r.tier === t).map((r) => r.durationMs), 95)).filter((v) => v !== null);
      if (priorAll < minPrior || priorP95.length < minPrior) {
        units.push({ ...unit, state: 'insufficient history', priorMainlineRuns: priorAll });
        continue;
      }
      const base = median(priorP95);
      const ok = p95 <= base * ratio;
      units.push({ ...unit, state: ok ? 'ok' : 'regression', medianPriorP95Ms: round(base), ratio: base > 0 ? round(p95 / base) : null, priorMainlineRuns: priorAll });
      if (!ok) regressions.push(units.at(-1));
    }
  }
  const budgetOffenders = offenders(latestRecs);
  const failing = regressions.length > 0 || (budgetSeverity === 'fail' && budgetOffenders.length > 0);
  const allInsufficient = units.every((u) => u.state === 'insufficient history');
  return {
    status: failing ? 'fail' : allInsufficient ? 'insufficient' : 'pass',
    message: allInsufficient ? `insufficient history: no project has ${minPrior} prior mainline runs, the regression rule was not evaluated` : undefined,
    budget: { severity: budgetSeverity, offenders: budgetOffenders },
    regressions,
    units,
  };
}

/** Every record of the tests matching `spec` (a substring of `file :: name`), oldest first. */
export function history(records, spec) {
  return records
    .filter(isTest)
    .filter((r) => displayKey(r).includes(spec))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    .map((r) => ({ ts: r.ts, test: displayKey(r), outcome: r.outcome, durationMs: r.durationMs, retryCount: r.retryCount, runId: r.runId, gitSha: r.gitSha, dirty: r.dirty, branch: r.branch, loadAvgStart: r.loadAvgStart }));
}
