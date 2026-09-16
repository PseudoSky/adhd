#!/usr/bin/env node
/**
 * vocabulary-gate.mjs — the acceptance gate for the hard replacement.
 *
 * The criterion: once the cutover lands, the shipped code contains no
 * reference to v1, v2, humanId, migration, or sqlite. There is no "old" and
 * "new" backlog to distinguish any more — there is only backlog — so any
 * surviving mention is either dead code or a stale comment describing a
 * world that no longer exists. Both are defects.
 *
 * SCOPE (decided in TASKS.md F6): `src/` only — the code that ships.
 *
 * Deliberately OUT of scope, and why:
 *  - `tools/etl/**` + the frozen corpus JSONL fixtures. These are the ETL
 *    parity gate's own reference data, captured from the pre-cutover corpus.
 *    `corpus-types.ts` carries a literal `humanId` fixture key because the
 *    source records literally had one; `run-etl.spec.ts` already asserts it
 *    never leaks past the boundary. Regenerating them would churn the very
 *    fixtures that prove the ETL correct.
 *  - `SPEC.md` / docs. Handled by a docs rewrite, not by grep.
 *
 * Run: node tools/gate/vocabulary-gate.mjs   (exit 0 clean, 1 dirty)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../../src', import.meta.url).pathname;

/**
 * Each term carries its own rationale, so a future reader knows what the gate
 * is actually protecting rather than guessing from a bare regex.
 */
const TERMS = [
  { name: 'v1',        re: /\bv1\b/i,                      why: 'there is no v1 to contrast against — only backlog' },
  { name: 'v2',        re: /\bv2\b/i,                      why: 'the replacement IS backlog; calling it v2 implies a v1 still exists' },
  { name: 'humanId',   re: /human[_-]?id/i,                why: 'human ids were removed from the data model entirely' },
  { name: 'migration', re: /\bmigrat(e|ed|ing|ion|ions)\b/i, why: 'a hard replacement has no migration path by construction' },
  { name: 'sqlite',    re: /sqlite|better[_-]?sqlite/i,    why: 'the store adapter is the only DB seam; no direct sqlite dependency, import, or reference' },
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|mts|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

const hits = [];
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const term of TERMS) {
      if (term.re.test(line)) {
        hits.push({ file: relative(ROOT, file), line: i + 1, term: term.name, text: line.trim().slice(0, 120) });
      }
    }
  });
}

if (hits.length === 0) {
  console.log('vocabulary-gate: CLEAN — src/ contains no v1/v2/humanId/migration/sqlite reference.');
  process.exit(0);
}

// Group by term, then by file, so the output is a work list and not a wall.
const byTerm = new Map();
for (const h of hits) {
  if (!byTerm.has(h.term)) byTerm.set(h.term, []);
  byTerm.get(h.term).push(h);
}

console.log(`vocabulary-gate: DIRTY — ${hits.length} reference(s) across ${new Set(hits.map((h) => h.file)).size} file(s) in src/.\n`);
for (const term of TERMS) {
  const termHits = byTerm.get(term.name);
  if (!termHits) continue;
  const files = new Map();
  for (const h of termHits) files.set(h.file, (files.get(h.file) ?? 0) + 1);
  console.log(`  ${term.name} — ${termHits.length} hit(s) in ${files.size} file(s); ${term.why}`);
  for (const [file, count] of [...files].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`      ${String(count).padStart(4)}  ${file}`);
  }
  if (files.size > 12) console.log(`      ... and ${files.size - 12} more file(s)`);
  console.log();
}
process.exit(1);
