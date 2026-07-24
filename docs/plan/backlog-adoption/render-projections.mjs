#!/usr/bin/env node
// render-projections.mjs — backlog-adoption MIGRATION.md Phase 3 step 2: for
// every {sourcePath, filter} row in projection-manifest.json, render the
// graph's current view of that projection via the REAL built `@adhd/backlog`
// CLI (`render-to-markdown`) — never an in-process import, same convention
// as import-manifest.mjs/parity-check.mjs — and overwrite that row's live
// markdown file with the result.
//
// SAFETY: every row is round-trip-verified BEFORE any file is written. The
// rendered markdown is re-parsed by the OLD `tools/util/backlog.mjs` (the
// same independent oracle parity-check.mjs uses) and its {id -> status,
// priority} map must be IDENTICAL to what parity-check.mjs would report for
// that row RIGHT NOW. Any row that fails this check is left untouched and
// reported — the whole run aborts with a non-zero exit before writing
// anything if even one row fails, so a partial/inconsistent projection set
// is never committed.
//
// Usage:
//   node docs/plan/backlog-adoption/render-projections.mjs [--dry-run] [--only <sourcePath-substring>]

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const CLI = join(REPO_ROOT, 'entrypoint/backlog/dist/index.js');
const LEGACY_TOOL = join(REPO_ROOT, 'tools/util/backlog.mjs');
const MANIFEST = JSON.parse(readFileSync(join(HERE, 'projection-manifest.json'), 'utf8'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

// Mirrors entrypoint/backlog/src/markdown.ts's normalizeLegacyStatus (kept in
// sync by inspection, not by import — same no-in-process-import convention
// as parity-check.mjs).
const CANONICAL = new Set([
  'OPEN', 'IN_PROGRESS', 'PARTIAL', 'OUTSTANDING', 'DEFERRED', 'BLOCKED', 'MIXED', 'UNKNOWN',
  'FIXED', 'RESOLVED', 'DONE', 'SHIPPED', 'VERIFIED', 'REMOVED', 'MITIGATED', 'SUPERSEDED',
  'INVALID', 'DUPLICATE', 'WONTFIX',
]);
function normalizeLegacyStatus(raw) {
  const label = String(raw).toUpperCase();
  if (label === 'IN-PROGRESS') return 'IN_PROGRESS';
  if (label === 'CLOSED') return 'RESOLVED';
  if (CANONICAL.has(label)) return label;
  return 'UNKNOWN';
}

function runCli(cliArgs) {
  const out = execFileSync('node', [CLI, ...cliArgs], { cwd: REPO_ROOT, encoding: 'utf8' });
  const lines = out.split('\n').filter((l) => l.trim());
  return JSON.parse(lines[lines.length - 1]);
}

function legacyJson(file) {
  const out = execFileSync('node', [LEGACY_TOOL, 'json', '--file', file], { encoding: 'utf8' });
  return JSON.parse(out);
}

function toMap(items) {
  const m = new Map();
  for (const it of items) m.set(it.id ?? it.humanId, { status: normalizeLegacyStatus(it.status), priority: it.priority ?? '' });
  return m;
}

function diffMaps(oracle, reparsed) {
  const divergences = [];
  for (const [id, o] of oracle) {
    const r = reparsed.get(id);
    if (!r) { divergences.push({ id, kind: 'missing-from-render', oracle: o }); continue; }
    if (r.status !== o.status) divergences.push({ id, kind: 'status-mismatch', oracle: o.status, rendered: r.status });
    else if (o.priority && r.priority !== o.priority) divergences.push({ id, kind: 'priority-mismatch', oracle: o.priority, rendered: r.priority });
  }
  for (const id of reparsed.keys()) {
    if (!oracle.has(id)) divergences.push({ id, kind: 'extra-in-render' });
  }
  return divergences;
}

const workDir = mkdtempSync(join(tmpdir(), 'backlog-render-'));
const plan = [];
let anyDivergence = false;

try {
  for (const entry of MANIFEST.entries) {
    if (only && !entry.sourcePath.includes(only)) continue;
    const livePath = join(REPO_ROOT, entry.sourcePath);

    // 1. Render the graph's CURRENT view of this projection via the real CLI.
    const rendered = runCli(['render-to-markdown', '--filter', JSON.stringify(entry.filter)]);

    // 2. Verify equivalence BEFORE writing anything: re-parse the rendered
    //    markdown with the independent legacy oracle and compare against
    //    the graph's OWN current view of the same filter (list-items) — not
    //    against the pre-render live file, which is exactly what this step
    //    is about to REPLACE. This proves the render is a faithful
    //    id/status/priority reflection of the graph, independent of the
    //    formatting `renderItemsToMarkdown` chose.
    const graphItems = runCli(['list-items', '--filter', JSON.stringify(entry.filter)]);
    const graphMap = toMap(graphItems.map((it) => ({ id: it.humanId, status: it.status, priority: it.priority })));

    const scratchPath = join(workDir, `${entry.sourcePath.replace(/[/\\]/g, '__')}.md`);
    writeFileSync(scratchPath, rendered, 'utf8');
    const reparsedMap = toMap(legacyJson(scratchPath));

    const divergences = diffMaps(graphMap, reparsedMap);
    const status = divergences.length === 0 ? 'VERIFIED' : 'DIVERGED';
    if (divergences.length > 0) anyDivergence = true;
    console.log(`[${status}] ${entry.sourcePath}  (graph=${graphMap.size} rendered=${reparsedMap.size})`);
    for (const d of divergences) console.log(`    ${JSON.stringify(d)}`);

    plan.push({ entry, livePath, rendered, ok: divergences.length === 0 });
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

if (anyDivergence) {
  console.error('\nABORT — at least one row failed round-trip verification; NO files written.');
  process.exit(1);
}

console.log(`\nAll ${plan.length} rows verified equivalent to the live graph.`);

if (dryRun) {
  console.log('--dry-run: not writing any files.');
  process.exit(0);
}

for (const { entry, livePath, rendered } of plan) {
  writeFileSync(livePath, rendered, 'utf8');
  console.log(`[WRITTEN] ${entry.sourcePath}`);
}

console.log(`\nRendered ${plan.length} projection(s) to disk.`);
