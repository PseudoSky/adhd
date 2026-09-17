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
 *  - `SPEC.md` / docs. Handled by a docs rewrite, not by grep.
 *  - This file and `scripts/check-vocabulary.mjs`. Both necessarily spell the
 *    banned terms out, because the terms ARE their regexes. They live under
 *    `tools/`/`scripts/`, neither of which is scanned or packed.
 *
 * The one-shot corpus loader under `tools/etl/**` used to be excluded here,
 * for its frozen pre-cutover fixtures. It no longer exists — the loader was
 * retired once parity was proven — so there is nothing left to exempt, and
 * `src/` is now the whole of what this gate needs to reach.
 *
 * Its sibling `scripts/check-vocabulary.mjs` scans the PACKED TARBALL instead,
 * which is what catches the leak a source-tree gate structurally cannot: a
 * `.d.ts` reproduces its source doc comments verbatim, so a banned term can
 * reach a consumer through generated output that never appears in `src/`.
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
  // The lookbehind is [a-z0-9] rather than \b so `INTERFACE_v2` is CAUGHT --
  // `_` is a word character, so \b treats `_v2` as mid-word and misses it,
  // which is how stale spec-document references survived an earlier sweep.
  // `(?!\.\d)` exempts a THIRD-PARTY version string -- an embedding model id
  // like `bge-base-en-v1.5` is a real external identifier, not this package
  // naming its own surface. `server.v2.spec.ts` is NOT exempted: `v2` there is
  // followed by `.s`, not by a digit, so the two cases separate cleanly
  // without a hand-maintained allowlist that would rot.
  { name: 'v1',        re: /(?<![a-z0-9])v1\b(?!\.\d)/i,              why: 'there is no v1 to contrast against — only backlog' },
  { name: 'v2',        re: /(?<![a-z0-9])v2\b(?!\.\d)/i,              why: 'the replacement IS backlog; calling it v2 implies a v1 still exists' },
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
  // PATHS are scanned before contents. The zero-v1/v2-reference criterion
  // covers the tree, not just what is inside the files: `server.v2.spec.ts`
  // satisfies a contents-only gate while still shipping banned vocabulary in
  // its own name, where every consumer, stack trace and test report shows it.
  // A contents-only gate goes green on that file and defers the finding to the
  // acceptance step, which is exactly too late.
  const rel = relative(ROOT, file);
  for (const term of TERMS) {
    if (term.re.test(rel)) {
      hits.push({ file: rel, line: 0, term: term.name, text: `[FILENAME] ${rel}` });
    }
  }
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
