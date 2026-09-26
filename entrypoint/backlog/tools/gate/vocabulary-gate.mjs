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
 * SCOPE: `src/` — the code that ships AND its non-code text assets
 * (`.md`/`.json`/`.yaml`/`.sql`/…; a code-only walk left
 * `src/write/CONTRACT.md`, 757 lines of shipped contract prose, invisible to
 * both path and content scanning) — AND the package's own top-level
 * markdown (`SPEC.md`, `DESIGN.md`, `DATA_MODEL.md`, `RAG-SPEC.md`,
 * `README.md`, `CHANGELOG.md`). The docs were once excluded here with the
 * note "handled by a docs rewrite, not by grep", and that is precisely how a
 * whole `## 8. Data load (ETL)` section, and a dozen references to it,
 * survived in `SPEC.md` long after the loader itself was deleted. A rewrite
 * is a one-time act; a gate is what keeps it true. They are in scope now.
 *
 * `CHANGELOG.md` is scanned like the rest, deliberately. Describing a removal
 * without naming the removed thing is awkward but possible ("the one-time
 * corpus load and its section"), and the alternative — one exempt file — is
 * the seam every banned term would eventually be written through.
 *
 * Deliberately OUT of scope: this file and `scripts/check-vocabulary.mjs`.
 * Both necessarily spell the banned terms out, because the terms ARE their
 * regexes. They live under `tools/`/`scripts/`, neither of which is scanned
 * or packed.
 *
 * Its sibling `scripts/check-vocabulary.mjs` scans the PACKED TARBALL instead,
 * which is what catches the leak a source-tree gate structurally cannot: a
 * `.d.ts` reproduces its source doc comments verbatim, so a banned term can
 * reach a consumer through generated output that never appears in `src/`.
 *
 * Run: node tools/gate/vocabulary-gate.mjs [pkgDir]
 *   (exit 0 clean, 1 dirty). `pkgDir` defaults to this package; pass one to
 *   scan a fixture instead (used by src/vocabulary-gate.spec.ts).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { SRC_TERMS } from '../vocabulary-policy.mjs';

// Defaults to this package. An explicit path argument overrides it so a test
// can point the gate at a fixture instead of the live tree (C-22).
const PKG = process.argv[2]
  ? resolve(process.argv[2])
  : new URL('../..', import.meta.url).pathname;
const ROOT = join(PKG, 'src');

/**
 * The term table lives in the package's single-source policy module
 * (`tools/vocabulary-policy.mjs`). The SAME terms must also drive the
 * packed-tarball gate and the version executor's generated-CHANGELOG scrub;
 * two hand-synchronised copies already existed, and a third would guarantee
 * drift. Importing from one source keeps this gate's DETECTION byte-identical
 * while making a newly-added term automatically enforced on authored prose
 * AND scrubbed out of generated prose. Each term still carries its own
 * rationale in that module.
 */
const TERMS = SRC_TERMS;

/**
 * Extensions whose contents are text the term regexes can meaningfully scan.
 * Code first, then the non-code text assets under `src/` — a `.md`/`.json`/
 * `.yaml`/`.sql` file ships the same vocabulary as a `.ts` one, and the
 * earlier code-only filter made `src/write/CONTRACT.md` (757 lines) invisible
 * to both path and content scanning. `.map` is deliberately absent: it is
 * generated output, not authored text, and the sources it embeds are already
 * scanned at their source.
 */
const SCANNABLE_EXT =
  /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx|md|markdown|json|jsonc|ya?ml|sql|txt|toml|sh|css|html)$/i;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (SCANNABLE_EXT.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Internal rollout/tracking docs that are never shipped (absent from
 * package.json's `files`) and describe the in-progress cutover itself, not
 * the package's post-cutover surface. `STATE.md` in particular necessarily
 * narrates the OLD/NEW-store transition by name (e.g. `cutover-target-v2.db`,
 * the literal ETL output filename) while the rollout is in progress — that
 * is the document's job, not a defect the gate should catch. It is deleted
 * or archived once the cutover lands; excluding it here is not the same
 * exemption this file's own header warns against for shipped docs, because
 * this file never reaches a consumer.
 */
const INTERNAL_DOCS = new Set(['STATE.md']);

/** The package's own top-level markdown — its spec surface, scanned alongside `src/`. */
function packageDocs() {
  return readdirSync(PKG)
    .filter((entry) => entry.endsWith('.md') && !INTERNAL_DOCS.has(entry))
    .map((entry) => join(PKG, entry))
    .filter((full) => statSync(full).isFile());
}

const hits = [];
for (const file of [...walk(ROOT), ...packageDocs()]) {
  // PATHS are scanned before contents. The zero-v1/v2-reference criterion
  // covers the tree, not just what is inside the files: `server.v2.spec.ts`
  // satisfies a contents-only gate while still shipping banned vocabulary in
  // its own name, where every consumer, stack trace and test report shows it.
  // A contents-only gate goes green on that file and defers the finding to the
  // acceptance step, which is exactly too late.
  const rel = relative(PKG, file);
  for (const term of TERMS) {
    if (term.re.test(rel)) {
      hits.push({
        file: rel,
        line: 0,
        term: term.name,
        text: `[FILENAME] ${rel}`,
      });
    }
  }
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const term of TERMS) {
      if (term.re.test(line)) {
        hits.push({
          file: relative(PKG, file),
          line: i + 1,
          term: term.name,
          text: line.trim().slice(0, 120),
        });
      }
    }
  });
}

if (hits.length === 0) {
  console.log(
    'vocabulary-gate: CLEAN — src/ and the package docs contain no v1/v2/humanId/migration/sqlite reference.'
  );
  process.exit(0);
}

// Group by term, then by file, so the output is a work list and not a wall.
const byTerm = new Map();
for (const h of hits) {
  if (!byTerm.has(h.term)) byTerm.set(h.term, []);
  byTerm.get(h.term).push(h);
}

console.log(
  `vocabulary-gate: DIRTY — ${hits.length} reference(s) across ${
    new Set(hits.map((h) => h.file)).size
  } file(s).\n`
);
for (const term of TERMS) {
  const termHits = byTerm.get(term.name);
  if (!termHits) continue;
  const files = new Map();
  for (const h of termHits) files.set(h.file, (files.get(h.file) ?? 0) + 1);
  console.log(
    `  ${term.name} — ${termHits.length} hit(s) in ${files.size} file(s); ${term.why}`
  );
  for (const [file, count] of [...files]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)) {
    console.log(`      ${String(count).padStart(4)}  ${file}`);
  }
  if (files.size > 12)
    console.log(`      ... and ${files.size - 12} more file(s)`);
  console.log();
}
process.exit(1);
