#!/usr/bin/env node
// parity-check.mjs — backlog-adoption MIGRATION.md Phase 2 step 1: a
// READ-ONLY check that, for every {sourcePath, filter} row in
// projection-manifest.json, renders the graph's current view of that
// projection via the REAL built `@adhd/backlog` CLI (never an in-process
// import — same convention as the rest of this migration) and diffs it
// against the live hand-edited markdown file, using the same technique
// `entrypoint/backlog/src/markdown.spec.ts` already proves: the OLD
// `tools/util/backlog.mjs` subprocess parses both sides into an
// {id -> {status, priority}} map, normalized through the canonical status
// vocabulary so prose differences don't produce false divergences.
//
// This is a diagnostic tool, not a gate — it reports divergences, it does
// not fail the process (MIGRATION.md §Phase 2: "non-blocking report for a
// soak period"). It never writes to any BACKLOG.md file.
//
// Usage: node docs/plan/backlog-adoption/parity-check.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const CLI = join(REPO_ROOT, 'entrypoint/backlog/dist/index.js');
const LEGACY_TOOL = join(REPO_ROOT, 'tools/util/backlog.mjs');
const MANIFEST = JSON.parse(readFileSync(join(HERE, 'projection-manifest.json'), 'utf8'));

// Mirrors entrypoint/backlog/src/markdown.ts's normalizeLegacyStatus (kept in
// sync by inspection, not by import, per this script's own no-in-process-
// import convention — see markdown.ts for the canonical source).
const CANONICAL = new Set([
  'OPEN','IN_PROGRESS','PARTIAL','OUTSTANDING','DEFERRED','BLOCKED','MIXED','UNKNOWN',
  'FIXED','RESOLVED','DONE','SHIPPED','VERIFIED','REMOVED','MITIGATED','SUPERSEDED',
  'INVALID','DUPLICATE','WONTFIX',
]);
function normalizeLegacyStatus(raw) {
  const label = String(raw).toUpperCase();
  if (label === 'IN-PROGRESS') return 'IN_PROGRESS';
  if (label === 'CLOSED') return 'RESOLVED';
  if (CANONICAL.has(label)) return label;
  return 'UNKNOWN';
}

function runCli(args) {
  const out = execFileSync('node', [CLI, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
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

const workDir = mkdtempSync(join(tmpdir(), 'backlog-parity-'));
let anyDivergence = false;

try {
  for (const entry of MANIFEST.entries) {
    const livePath = join(REPO_ROOT, entry.sourcePath);
    const oracle = toMap(legacyJson(livePath));

    // §2.2: root BACKLOG.md's projection is items OWNED by root (real,
    // server-side `filter.importedFrom` — see `DEBT-BACKLOG-IMPORT-SCOPE-
    // CROSSFILE-001`/`model.ts`'s `BacklogFilter.importedFrom`). This used
    // to be a client-side `!it.projectPath && !it.plan` post-filter, which
    // wrongly excluded a root-owned item the moment ANY other file
    // cross-referenced it (e.g. a plan file attaching `plan` to a root
    // item) — the row's own `filter` object now encodes ownership directly,
    // so no post-filtering is needed here at all.
    const items = runCli(['list-items', '--filter', JSON.stringify(entry.filter)]);
    const renderedMap = toMap(items.map((it) => ({ id: it.humanId, status: it.status, priority: it.priority })));

    const divergences = diffMaps(oracle, renderedMap);
    const status = divergences.length === 0 ? 'PARITY' : 'DIVERGED';
    if (divergences.length > 0) anyDivergence = true;
    console.log(`[${status}] ${entry.sourcePath}  (oracle=${oracle.size} rendered=${renderedMap.size})`);
    for (const d of divergences) console.log(`    ${JSON.stringify(d)}`);
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log(anyDivergence
  ? '\nRESULT: divergences found -- non-blocking per Phase 2 (see MIGRATION.md), reconcile before promoting to blocking in Phase 3.'
  : '\nRESULT: full parity across every manifest row.');
