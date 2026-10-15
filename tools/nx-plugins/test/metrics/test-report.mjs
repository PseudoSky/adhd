#!/usr/bin/env node
/**
 * test-report — reads the test-metrics history (store.mjs) and reports on it.
 *
 *   summary            p50/p95 per tier and per project, suite wall time, reporter overhead, machine load
 *   offenders          tests over their tier's budget (S: 100 ms p95, any run over 1 s; P: 10 s p95; H: 2 min p95)
 *   flaky              tests with both outcomes on the same code, tests that used a retry, and repeat coverage
 *   history <test>     every recorded execution of the tests whose `file :: name` contains <test>
 *   g7                 gate G7: per-test budgets (warnings; --budget-severity fail makes them failures) and the
 *                      regression rule (latest run p95 <= 1.10 x the median of the previous 5 mainline runs)
 *   g5                 gate G5: flaky share per tier <= 1 percent and no retry in use
 *   repeat --times N -- <command...>   run <command> N times as one repeat group, then report flakes in that group
 *
 * DEFINITIONS. executed: a pass or fail record. run: one runner process (one runId). same code: the repeat group, else
 * the git sha of a clean working tree. mainline run: on main or reachable from origin/main, clean tree. percentile:
 * nearest-rank. A unit (project and tier) with fewer than 5 prior mainline runs reports `insufficient history`.
 *
 * Options: --file <store> (default: ADHD_TEST_METRICS_FILE or ~/.adhd/test-timings/test-metrics.jsonl), --json,
 * --since <ISO date>, --project <name>, --tier S|P|H|X, --limit <n>, --include-dirty, --check, --budget-severity warn|fail.
 * --check makes `offenders` and `flaky` exit 1 when they list anything. `g5` and `g7` always exit 1 on a violation.
 *
 * Exit: 0 report ok (also `insufficient history`), 1 gate violation, 65 usage error, 78 with --gate when the history
 * is insufficient (the gate engine reports 78 as `unmeasured`, never as a pass).
 * The reporters never run this file; it only reads what they wrote.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { filterRecords, flaky, g5, g7, history, offenders, summary } from './analysis.mjs';
import { checkQuarantine, loadQuarantine } from './quarantine.mjs';
import { scanWorkspace } from './retry-scan.mjs';
import { readRecords, storePath } from './store.mjs';

/** Exit for a gate result. With --gate an `insufficient` result is UNMEASURED_EXIT (78), never 0: the gate engine reports
 * 78 as `unmeasured`, so an empty store (CI has none) is not counted as a pass. Without --gate it stays a report: 0. */
export const UNMEASURED_EXIT = 78;
function gateExit(r, opts) {
  if (r.status === 'fail') return 1;
  if (r.status === 'insufficient' && opts.gate) return UNMEASURED_EXIT;
  return 0;
}

const COMMANDS = ['summary', 'offenders', 'flaky', 'history', 'g7', 'g5', 'repeat'];

/** Parse argv (after the node and script entries). Returns { cmd, opts, rest } or { error }. */
export function parseArgs(argv) {
  const dd = argv.indexOf('--');
  const head = dd === -1 ? argv : argv.slice(0, dd);
  const tail = dd === -1 ? [] : argv.slice(dd + 1);
  const [cmd, ...more] = head;
  if (!COMMANDS.includes(cmd)) return { error: `unknown or missing subcommand ${JSON.stringify(cmd ?? '')}; expected one of ${COMMANDS.join(', ')}` };
  const opts = { json: false, check: false, gate: false, retryScan: true, includeDirty: false, budgetSeverity: 'warn', limit: 25, times: 3 };
  const rest = [];
  for (let i = 0; i < more.length; i++) {
    const a = more[i];
    const val = () => more[++i];
    if (a === '--json') opts.json = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--gate') opts.gate = true;
    else if (a === '--no-retry-scan') opts.retryScan = false;
    else if (a === '--quarantine') opts.quarantine = val();
    else if (a === '--include-dirty') opts.includeDirty = true;
    else if (a === '--file') opts.file = val();
    else if (a === '--workspace-root') opts.workspaceRoot = val();
    else if (a === '--since') opts.since = val();
    else if (a === '--project') opts.project = val();
    else if (a === '--tier') opts.tier = val();
    else if (a === '--limit') opts.limit = Number(val());
    else if (a === '--times') opts.times = Number(val());
    else if (a === '--budget-severity') opts.budgetSeverity = val();
    else if (a.startsWith('--')) return { error: `unknown option ${a}` };
    else rest.push(a);
  }
  if (!['warn', 'fail'].includes(opts.budgetSeverity)) return { error: '--budget-severity must be warn or fail' };
  if (opts.tier && !['S', 'P', 'H', 'X'].includes(opts.tier)) return { error: '--tier must be S, P, H or X' };
  if (!Number.isInteger(opts.times) || opts.times < 2) return { error: '--times must be an integer of at least 2' };
  if (cmd === 'history' && rest.length !== 1) return { error: 'history takes exactly one <test> argument' };
  if (cmd === 'repeat' && tail.length === 0) return { error: 'repeat needs a command after --' };
  return { cmd, opts, rest, tail };
}

const pad = (v, n) => String(v ?? '-').padEnd(n);
const num = (v) => (v === null || v === undefined ? '-' : String(v));

function renderSummary(s) {
  const lines = [`records ${s.records}, runs ${s.runs}, load/cpu ${num(s.loadRatio)} (${s.highLoadRuns} run(s) above 1.0: durations from those are inflated), reporter overhead p50 ${num(s.reporterOverheadMs.p50)} ms max ${num(s.reporterOverheadMs.max)} ms`, '', 'tier  executed  p50 ms   p95 ms   max ms   budget p95  pass  fail  skip  todo'];
  for (const [t, v] of Object.entries(s.byTier)) lines.push(`${pad(t, 5)} ${pad(v.executed, 9)} ${pad(v.p50Ms, 8)} ${pad(v.p95Ms, 8)} ${pad(v.maxMs, 8)} ${pad(v.budgetP95Ms ?? 'metered', 11)} ${pad(v.pass, 5)} ${pad(v.fail, 5)} ${pad(v.skip, 5)} ${v.todo}`);
  lines.push('', 'project                                   executed  p50 ms   p95 ms');
  for (const [p, v] of Object.entries(s.byProject)) lines.push(`${pad(p, 41)} ${pad(v.executed, 9)} ${pad(v.p50Ms, 8)} ${v.p95Ms}`);
  lines.push('', 'suite wall time (one runner process per row)   runs  latest ms  median ms');
  for (const [p, w] of Object.entries(s.suiteWallMs)) lines.push(`${pad(p, 46)} ${pad(w.runs, 5)} ${pad(w.latestMs, 10)} ${w.medianMs}`);
  return lines.join('\n');
}

function renderOffenders(list, limit) {
  if (!list.length) return 'no test is over its tier budget';
  const lines = [`${list.length} test(s) over budget (showing ${Math.min(limit, list.length)}); load/cpu above 1.0 inflates durations`, 'tier  p95 ms   max ms   budget   over          load  test'];
  for (const o of list.slice(0, limit)) lines.push(`${pad(o.tier + (o.tierSource === 'inferred' ? '*' : ''), 5)} ${pad(o.p95Ms, 8)} ${pad(o.maxMs, 8)} ${pad(o.budgetMs, 8)} ${pad(o.over.join('+'), 13)} ${pad(num(o.loadRatio), 5)} ${o.test}`);
  lines.push('* tier inferred from the file name (no header)');
  return lines.join('\n');
}

function renderFlaky(f) {
  const lines = [`executed ${f.executed}; tests with a same-code repeat ${f.repeatCoverage}`];
  lines.push(f.mixed.length ? `MIXED OUTCOMES (${f.mixed.length}):` : 'no test has both outcomes on the same code');
  for (const m of f.mixed) lines.push(`  ${m.tier} ${m.test}  ${m.passes} pass / ${m.fails} fail over ${m.runs} runs  (${m.code})`);
  lines.push(f.retried.length ? `RETRIES IN USE (${f.retried.length}):` : 'no retry was used');
  for (const r of f.retried) lines.push(`  ${r.tier} ${r.test}  retried up to ${r.maxRetries}x, ${r.recovered}/${r.records} executions passed`);
  return lines.join('\n');
}

function renderG5(r) {
  if (r.status === 'insufficient') return [`G5: ${r.message}`, ...(r.quarantined ?? []).map((q) => `  quarantined (still runs, not gated) ${q.tier} ${q.test}: ${q.passes} pass / ${q.fails} fail of ${q.executions}`)].join('\n');
  const lines = [`G5 ${r.status.toUpperCase()}: flaky share per tier (limit 1%), repeat coverage ${r.repeatCoverage ?? 0} test(s)`];
  for (const [t, v] of Object.entries(r.tiers)) lines.push(`  ${t}: ${v.flaky}/${v.executed} = ${(v.share * 100).toFixed(2)}%`);
  for (const q of r.quarantined ?? []) lines.push(`  quarantined (still runs, not gated) ${q.tier} ${q.test}: ${q.passes} pass / ${q.fails} fail of ${q.executions}`);
  for (const v of r.violations) {
    if (v.rule === 'flake-share') lines.push(`  violation flake-share: tier ${v.tier} ${(v.share * 100).toFixed(2)}% > ${v.limit * 100}%`);
    else if (v.rule === 'unrecorded-retry') lines.push(`  violation unrecorded-retry: ${v.test}, retried up to ${v.maxRetries}x`);
    else lines.push(`  violation ${v.rule}: ${v.test ?? ''} ${v.message ?? ''}`.trimEnd());
  }
  return lines.join('\n');
}

function renderG7(r) {
  const lines = [`G7 ${r.status.toUpperCase()}${r.message ? ` (${r.message})` : ''}`];
  lines.push(`  per-test budgets (${r.budget.severity === 'fail' ? 'failing' : 'warning only'}): ${r.budget.offenders.length} over budget in the latest run of their project`);
  for (const o of r.budget.offenders.slice(0, 10)) lines.push(`    ${o.tier} p95 ${o.p95Ms} ms (budget ${o.budgetMs}) ${o.test}`);
  lines.push('  regression rule per project and tier:');
  for (const u of r.units) lines.push(`    ${pad(u.state, 20)} ${pad(u.project, 36)} ${u.tier}  latest p95 ${u.latestP95Ms} ms${u.medianPriorP95Ms !== undefined ? `, prior-5 median ${u.medianPriorP95Ms} ms, x${u.ratio}` : `, ${u.priorMainlineRuns} prior mainline run(s)`}${u.loadRatio > 1 ? '  [machine overloaded: noisy]' : ''}`);
  return lines.join('\n');
}

function renderHistory(h) {
  if (!h.length) return 'no recorded execution matches';
  return h.map((r) => `${r.ts} ${pad(r.outcome, 5)} ${pad(r.durationMs, 9)} retry ${r.retryCount} ${String(r.gitSha ?? '-').slice(0, 9)}${r.dirty ? '+dirty' : ''} ${r.branch ?? '-'} load ${num(r.loadAvgStart)}  ${r.test}`).join('\n');
}

/**
 * Run the CLI. Returns the exit code.
 * @param {string[]} argv
 * @param {{ out?: (s: string) => void, err?: (s: string) => void, env?: NodeJS.ProcessEnv, spawn?: typeof spawnSync }} [io]
 */
export function main(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = io.err ?? ((s) => process.stderr.write(`${s}\n`));
  const env = io.env ?? process.env;
  const parsed = parseArgs(argv);
  if (parsed.error) {
    err(`test-report: ${parsed.error}`);
    return 65;
  }
  const { cmd, opts, rest, tail } = parsed;
  const file = opts.file ?? storePath(env);
  const emit = (data, text) => out(opts.json ? JSON.stringify(data, null, 2) : text);

  if (cmd === 'repeat') {
    const group = randomUUID();
    const exits = [];
    for (let i = 0; i < opts.times; i++) {
      const r = (io.spawn ?? spawnSync)(tail[0], tail.slice(1), { stdio: 'inherit', env: { ...env, ADHD_TEST_RUN_GROUP: group } });
      exits.push(r.status ?? 1);
    }
    const f = flaky(readRecords(file).records.filter((r) => r.group === group));
    const differingExits = new Set(exits).size > 1;
    emit({ group, exits, ...f, differingExits }, `repeat group ${group}: exit codes ${exits.join(', ')}${differingExits ? ' (they differ: the command itself is non-deterministic)' : ''}\n${renderFlaky(f)}`);
    return f.mixed.length || differingExits ? 1 : 0;
  }

  const { records, corrupt } = readRecords(file);
  if (corrupt) err(`test-report: skipped ${corrupt} unreadable line(s) in ${file}`);
  const recs = filterRecords(records, opts);
  switch (cmd) {
    case 'summary': {
      const s = summary(recs);
      emit(s, recs.length ? renderSummary(s) : `insufficient history: no records in ${file}`);
      return 0;
    }
    case 'offenders': {
      const o = offenders(recs);
      emit(o, renderOffenders(o, opts.limit));
      return opts.check && o.length ? 1 : 0;
    }
    case 'flaky': {
      const f = flaky(recs, { includeDirty: opts.includeDirty });
      emit(f, renderFlaky(f));
      return opts.check && (f.mixed.length || f.retried.length) ? 1 : 0;
    }
    case 'history': {
      const h = history(recs, rest[0]);
      emit(h, renderHistory(h));
      return 0;
    }
    case 'g5': {
      let quarantine;
      try {
        quarantine = checkQuarantine(loadQuarantine(opts.quarantine));
      } catch (e) {
        err(`test-report: ${e.message}`);
        return 65;
      }
      const r = g5(recs, { includeDirty: opts.includeDirty, quarantine });
      // T36.AC3: a retry in a runner config with no tracking item is a violation whatever the history says.
      if (opts.retryScan) {
        const retries = scanWorkspace(opts.workspaceRoot ?? process.cwd());
        for (const v of retries) r.violations.push({ rule: v.rule, test: `${v.file}:${v.line}`, message: v.text });
        if (retries.length) r.status = 'fail';
      }
      emit(r, renderG5(r));
      return gateExit(r, opts);
    }
    case 'g7': {
      const r = g7(recs, { budgetSeverity: opts.budgetSeverity });
      emit(r, r.status === 'insufficient' ? `G7: ${r.message}` : renderG7(r));
      return gateExit(r, opts);
    }
    default:
      return 65;
  }
}

const isEntry = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isEntry) process.exit(main(process.argv.slice(2)));
