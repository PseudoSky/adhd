#!/usr/bin/env node
/**
 * task-report.mjs — what did this release execute, by TASK, from the publish onward?
 *
 * WHY. A release is only auditable if you can see every task it ran and how long
 * each took. `metrics.json` — the local perf log written by every
 * `withMetrics`-wrapped executor (`tools/nx-plugins/lib/metrics.js`) — records
 * exactly that. This tool reports it GROUPED BY TASK, bounded at the point the
 * publish phase began, so the publish's own cost is readable on its own.
 *
 * WINDOW. `--since <iso>` (or `--since-last <min>`) bounds it explicitly.
 * With neither, the window starts at the PUBLISH START, auto-detected as the
 * earliest record whose task is `publish` or `publish-hygiene` — i.e. the report
 * is "everything that ran as part of publishing". `--all` widens it to the whole
 * log (the version/gate phases included), which is what you want when asking
 * "what did the whole run do" rather than "what did the publish do".
 *
 * HONEST LIMIT (do not overstate): `metrics.json` covers the executors that wrap
 * their work in `withMetrics` — version, publish, publish-hygiene, dist-manifest,
 * verify-dist-load, sync-deps-check, secret-scan, assets-*. Plain nx
 * `build`/`test` tasks are NOT in it: nx caches them and their per-task timings
 * live in nx's own run data (`.nx/workspace-data/*.db`). This report says so in
 * its own output rather than implying total coverage.
 *
 * OUTCOMES. For the `publish` task it also partitions each package by the
 * executor's OWN machine-readable outcome (`publish/impl.js` returns
 * `outcome`; `withMetrics` persists it): PUBLISHED name@version vs SKIPPED
 * (already published) vs DRY-RUN. This is deliberate — the `✔ :publish`
 * console line is IDENTICAL for a real publish and a skip, and re-reading the
 * registry afterwards is unreliable (read-after-write/packument lag). A record
 * with no `outcome` (a failed/refused publish, or one written before the
 * outcome field existed) is reported UNCLASSIFIED, never guessed.
 *
 * USAGE
 *   node task-report.mjs                  # by task, from publish start
 *   node task-report.mjs --all            # by task, whole log
 *   node task-report.mjs --by-project     # task x project pairs
 *   node task-report.mjs --json           # machine-readable
 *
 * Exit: 0 = report produced (an empty/missing log is reported, not an error);
 *       1 = the metrics file exists but is unreadable/corrupt.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.env.ADHD_REPO_ROOT || process.cwd();
const METRICS = join(REPO_ROOT, 'metrics.json');
const PUBLISH_TASKS = new Set(['publish', 'publish-hygiene']);

function argVal(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : (process.argv[i + 1] ?? true);
}
const has = (name) => process.argv.includes(`--${name}`);

let records = [];
let state = 'ok';
if (!existsSync(METRICS)) state = 'no-metrics-file';
else {
  try { records = JSON.parse(readFileSync(METRICS, 'utf8')).records || []; }
  catch { state = 'unreadable'; }
}

// Window: explicit > publish-start (auto) > whole log.
let since = argVal('since');
if (!since && argVal('since-last')) since = new Date(Date.now() - Number(argVal('since-last')) * 60_000).toISOString();
let windowSource = since ? 'explicit --since' : null;
if (!since && !has('all')) {
  // metrics.json is append-only across many runs, so "the publish start" means
  // the publish start of the LAST run: walk back from the newest record until a
  // time gap (> 30 min) marks the run boundary, then take that run's earliest
  // publish/publish-hygiene stamp.
  const GAP_MS = 30 * 60 * 1000;
  const sorted = records.slice().sort((a, b) => String(a.t).localeCompare(String(b.t)));
  if (sorted.length) {
    let runStart = String(sorted[sorted.length - 1].t);
    for (let i = sorted.length - 1; i > 0; i--) {
      const cur = Date.parse(String(sorted[i].t));
      const prev = Date.parse(String(sorted[i - 1].t));
      if (Number.isFinite(cur) && Number.isFinite(prev) && cur - prev > GAP_MS) { runStart = String(sorted[i].t); break; }
      runStart = String(sorted[i - 1].t);
    }
    const inRun = sorted.filter((r) => String(r.t) >= runStart);
    const pub = inRun.filter((r) => PUBLISH_TASKS.has(r.task)).map((r) => String(r.t)).sort();
    if (pub.length) { since = pub[0]; windowSource = 'publish start (auto, last run)'; }
    else { windowSource = 'whole log (no publish records in the last run)'; }
  } else windowSource = 'whole log (no records)';
} else if (!since) windowSource = 'whole log (--all)';

const run = since ? records.filter((r) => String(r.t) >= since) : records;

// Group BY TASK (project is the detail under it).
const byTask = new Map();
for (const r of run) {
  const e = byTask.get(r.task) || { task: r.task, n: 0, total: 0, max: 0, fail: 0, projects: new Map() };
  e.n += 1; e.total += r.durationMs || 0; e.max = Math.max(e.max, r.durationMs || 0);
  if (r.success === false) e.fail += 1;
  const p = e.projects.get(r.project) || { n: 0, total: 0 };
  p.n += 1; p.total += r.durationMs || 0; e.projects.set(r.project, p);
  byTask.set(r.task, e);
}
const tasks = [...byTask.values()].sort((a, b) => b.total - a.total);

// Publish outcomes — the executor's OWN signal (publish/impl.js returns
// `outcome`; withMetrics persists it). The `✔ :publish` console line is the
// same for a real publish and a skip, and the registry read lags the publish,
// so this field is the only sound source for the PUBLISHED/SKIPPED partition.
const publishRecords = run.filter((r) => r.task === 'publish');
const publishOutcomes = { published: [], skipped: [], 'dry-run': [], unclassified: [] };
const pkgLabel = (r) =>
  r.outcome && r.outcome.name ? `${r.outcome.name}@${r.outcome.version}` : (r.project || '(unknown)');
for (const r of publishRecords) {
  const status = r.outcome && r.outcome.status;
  if (status === 'published') publishOutcomes.published.push(pkgLabel(r));
  else if (status === 'skipped-already-published') publishOutcomes.skipped.push(pkgLabel(r));
  else if (status === 'dry-run') publishOutcomes['dry-run'].push(pkgLabel(r));
  else publishOutcomes.unclassified.push(pkgLabel(r) + (r.success === false ? ' (failed)' : ''));
}

if (has('json')) {
  console.log(JSON.stringify({ state, window: windowSource, since, records: run.length,
    tasks: tasks.map((t) => ({ task: t.task, count: t.n, totalMs: Math.round(t.total), maxMs: Math.round(t.max),
      fail: t.fail, projects: [...t.projects].map(([p, v]) => ({ project: p, count: v.n, totalMs: Math.round(v.total) }))
        .sort((a, b) => b.totalMs - a.totalMs) })),
    publishes: publishRecords.length ? {
      published: publishOutcomes.published,
      skippedAlreadyPublished: publishOutcomes.skipped,
      dryRun: publishOutcomes['dry-run'],
      unclassified: publishOutcomes.unclassified,
    } : null }, null, 2));
} else {
  const pad = (s, n) => String(s ?? '').padEnd(n);
  const padl = (s, n) => String(s ?? '').padStart(n);
  console.log('release task report — source: metrics.json (withMetrics executors only)');
  console.log(`  state: ${state}   window: ${windowSource}${since ? '  @ ' + since : ''}`);
  console.log(`  ${run.length} record(s), ${tasks.length} distinct task(s)`);
  console.log(`  BY TASK (project shown when a task touched more than one):\n`);
  console.log(pad('task', 22) + padl('n', 5) + padl('total_ms', 10) + padl('max_ms', 9) + padl('fail', 6));
  for (const t of tasks) {
    console.log(pad(t.task, 22) + padl(t.n, 5) + padl(Math.round(t.total), 10) + padl(Math.round(t.max), 9) + padl(t.fail || '', 6));
    if (t.projects.size > 1 && (has('by-project') || t.projects.size <= 6)) {
      for (const [p, v] of [...t.projects].sort((a, b) => b[1].total - a[1].total).slice(0, 60)) {
        console.log('  ' + pad('└ ' + p, 20) + padl(v.n, 5) + padl(Math.round(v.total), 10));
      }
    }
  }
  if (publishRecords.length) {
    console.log('\nPUBLISH OUTCOMES (per package, from the executor — no registry query):');
    console.log(`  PUBLISHED (${publishOutcomes.published.length}): ` + (publishOutcomes.published.join(', ') || '—'));
    console.log(`  SKIPPED already published (${publishOutcomes.skipped.length}): ` + (publishOutcomes.skipped.join(', ') || '—'));
    if (publishOutcomes['dry-run'].length) {
      console.log(`  DRY-RUN (${publishOutcomes['dry-run'].length}): ` + publishOutcomes['dry-run'].join(', '));
    }
    if (publishOutcomes.unclassified.length) {
      console.log(`  UNCLASSIFIED (${publishOutcomes.unclassified.length}): ` + publishOutcomes.unclassified.join(', '));
      console.log('    (failed/refused, or recorded before the outcome field existed — no published-vs-skipped signal)');
    }
  }
  const fails = run.filter((r) => r.success === false);
  console.log(`\nfailures: ${fails.length}` + (fails.length ? ' — ' + fails.map((f) => `${f.task}:${f.project}`).join(', ') : ''));
  console.log('covered: version, publish, publish-hygiene, dist-manifest, verify-dist-load, sync-deps-check, secret-scan, assets-*');
  console.log('NOT covered (nx-native — read nx run data): build, test, e2e, lint, typecheck*');
}
process.exit(state === 'unreadable' ? 1 : 0);
