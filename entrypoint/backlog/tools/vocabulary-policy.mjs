/**
 * vocabulary-policy.mjs — the SINGLE SOURCE OF TRUTH for @adhd/backlog's
 * shipped-vocabulary policy.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * One policy, three consumers:
 *
 *   1. `tools/gate/vocabulary-gate.mjs` (source-tree gate) — scans `src/` plus
 *      the package's top-level markdown, `CHANGELOG.md` included.
 *   2. `scripts/check-vocabulary.mjs` (packed-tarball gate) — scans the built
 *      artifact as a consumer receives it.
 *   3. The `version` executor's `writeChangelogEntry`
 *      (`tools/nx-plugins/build/executors/version/impl.js`) — scrubs the
 *      GENERATED CHANGELOG before it ships.
 *
 * (3) exists because the CHANGELOG is a GENERATED projection of git commit
 * subjects (Nx's conventional-commits renderer), and a commit whose *purpose*
 * is to remove a banned term must name that term to describe itself. The name
 * then lands verbatim in the shipped CHANGELOG — and (1) and (2) scan it, so
 * the gate fails on the fix's own commit message and recurs for every such
 * commit. No hand-reword is durable (the next `nx release changelog` for the
 * package regenerates the section from history). The durable fix is at the
 * generator: after Nx writes the entry, neutralise the package's own
 * forbidden vocabulary in it. The replacements below keep the entry TRUTHFUL
 * — they paraphrase the term ("store-engine" for the store adapter, "upgrade"
 * for a schema change), never delete the fact the entry records.
 *
 * Keeping all three in ONE file is deliberate. The gate's `TERMS` and the
 * tarball gate's `BANNED` were already two hand-synchronised copies of the
 * same stems; adding a third copy for the scrub would make drift certain.
 * Importing both terms and the scrub from here means a term added below is
 * simultaneously (a) enforced on authored prose and (b) scrubbed out of
 * generated prose — they cannot fall out of step.
 *
 * This file necessarily SPELLS the banned terms (they ARE its regexes),
 * exactly as the two gate scripts do. It lives under `tools/`, which the
 * source-tree gate neither scans (it walks `src/` + top-level `*.md`) nor the
 * tarball gate packs (`package.json` `files` is `["dist","CHANGELOG.md",
 * "skill"]`) — the same rationale the gate header gives for its own
 * exclusion and `scripts/check-vocabulary.mjs`'s.
 */

/**
 * Source-tree terms — the exact set `tools/gate/vocabulary-gate.mjs` enforces.
 * Each carries its own rationale, so a future reader knows what the gate is
 * protecting rather than guessing from a bare regex.
 */
export const SRC_TERMS = [
  // The lookbehind is [a-z0-9] rather than \b so an `UNDERSCORE_v2`-shaped
  // document name is CAUGHT -- `_` is a word character, so \b treats `_v2` as
  // mid-word and misses it, which is how a whole set of stale spec-document
  // references survived an earlier sweep.
  // `(?!\.\d)` exempts a THIRD-PARTY version string -- an embedding model id
  // like `bge-base-en-v1.5` is a real external identifier, not this package
  // naming its own surface. `server.v2.spec.ts` is NOT exempted: `v2` there is
  // followed by `.s`, not by a digit, so the two cases separate cleanly
  // without a hand-maintained allowlist that would rot.
  // `(?!\.db\b)` MIRRORS the tarball gate's carve-out
  // (`scripts/check-vocabulary.mjs`), kept here for consistency across the two
  // gates and for future `src/` use. It is deliberately NOT load-bearing for
  // THIS gate today: no file in this gate's scope (`src/` plus the package's
  // top-level markdown) contains a `.db` data-file name. The hit the carve-out
  // actually protects is the shipped `skill/SKILL.md`, which reproduces the
  // live production store's filename verbatim and is packed-and-scanned ONLY
  // by the tarball gate (`package.json` `files` includes `skill`). Should a
  // `src/` file ever need to name that store
  // (`~/.adhd/backlog/production/data/backlog-v2.db`, declared by config.yaml
  // `db.path` and reported by `sandbox-path`) — an operational identifier, not
  // this package naming its own surface `v2` — this exemption keeps that
  // possible rather than forcing the docs to lie about the path or go silent.
  // The exemption is exactly `.db` (word-bounded), so bare `v2` prose,
  // `server.v2.spec.ts`, and `v2.dbx`-like names all still fail.
  {
    name: 'v1',
    re: /(?<![a-z0-9])v1\b(?!\.\d)(?!\.db\b)/i,
    why: 'there is no v1 to contrast against — only backlog',
    // Neutral replacement used ONLY when scrubbing a generated CHANGELOG
    // (see CHANGELOG_SCRUB below); the detection regex above is untouched.
    scrub: 'prior-version',
  },
  {
    name: 'v2',
    re: /(?<![a-z0-9])v2\b(?!\.\d)(?!\.db\b)/i,
    why: 'the replacement IS backlog; calling it v2 implies a v1 still exists',
    scrub: 'current-version',
  },
  {
    name: 'humanId',
    re: /human[_-]?id/i,
    why: 'human ids were removed from the data model entirely',
    scrub: 'identifier',
  },
  {
    name: 'migration',
    re: /\bmigrat(e|ed|ing|ion|ions)\b/i,
    why: 'a hard replacement has no migration path by construction',
    scrub: 'upgrade',
    // The tarball gate enforces the broader stem `migrat` (no `\b` suffix), so
    // scrubbing with the source gate's narrower verb-form regex would leave
    // e.g. `migrator` behind. Absorb the whole stem.
    scrubRe: /\bmigrat\w*/gi,
  },
  {
    name: 'sqlite',
    re: /sqlite|better[_-]?sqlite/i,
    why: 'the store adapter is the only DB seam; no direct sqlite dependency, import, or reference',
    // The detection regex deliberately matches the `better-sqlite` prefix only
    // (it stops before the package's trailing `3`); scrubbing with that same
    // prefix would strand the `3` as `store-engine3`. The scrub pattern below
    // therefore absorbs an optional trailing `3`/`-3` so `better-sqlite3`
    // becomes `store-engine` whole.
    scrub: 'store-engine',
    scrubRe: /better[_-]?sqlite3?|sqlite/gi,
  },
];

/**
 * The tarball gate's banned stems (`scripts/check-vocabulary.mjs`). The same
 * rule, expressed against the PACKED artifact.
 *
 * `minifiable` marks the two terms a JavaScript minifier can FABRICATE out of
 * nothing. A bundler renaming locals emits `v1`, `V1`, `function v2(t,e)` by
 * the dozen, and third-party sources ship their own `// TODO: remove in v2`.
 * Matching those in a generated bundle reports 14 violations that say nothing
 * about this package's vocabulary — a gate that cries wolf is a gate that gets
 * ignored. `humanid`/`migrat`/`sqlite` are NOT minifiable: no renamer invents
 * them, so they stay in force everywhere, bundles included. That is the half
 * of the rule that actually protects the criterion, and it is the half that
 * would have caught a real leak (verified: both bundles contain zero).
 */
export const TARBALL_TERMS = [
  { name: 'humanId', re: /humanid/i, minifiable: false },
  { name: 'migrat', re: /migrat/i, minifiable: false },
  { name: 'sqlite', re: /sqlite/i, minifiable: false },
  { name: 'v1', re: /\bv1\b(?!\.\d)(?!\.db\b)/i, minifiable: true },
  { name: 'v2', re: /\bv2\b(?!\.\d)(?!\.db\b)/i, minifiable: true },
];

/**
 * The two gates name one shared stem differently — the source gate calls the
 * verb-form term `migration`, the tarball gate calls the broader stem
 * `migrat`. Canonicalising the alias here lets coverage/dedup treat them as
 * one term without renaming either gate's output label.
 */
const TERM_ALIASES = { migrat: 'migration' };
function canonicalName(name) {
  return TERM_ALIASES[name] ?? name;
}

/**
 * The patterns that neutralise forbidden vocabulary in a GENERATED CHANGELOG.
 *
 * Derived from the term tables above so it can never drift: every distinct
 * term name across BOTH gates must map to a neutral replacement here, or
 * `uncoveredTerms()` (below) names it and the coverage test fails. A term that
 * is enforced but not scrubbed would make the generator hand the gate a
 * guaranteed-dirty changelog — exactly the defect this module exists to fix.
 *
 * Each entry rewrites the term to a truthful paraphrase; the replacement text
 * itself contains no banned stem (asserted by the coverage test), so scrubbing
 * is idempotent and always terminates.
 */
export const CHANGELOG_SCRUB = buildScrubPatterns();

function buildScrubPatterns() {
  // Union of both term tables, keyed by CANONICAL name. `SRC_TERMS` wins on a
  // collision (it carries the `scrub`/`scrubRe` fields).
  const byName = new Map();
  for (const term of [...SRC_TERMS, ...TARBALL_TERMS]) {
    const key = canonicalName(term.name);
    if (byName.has(key)) continue;
    byName.set(key, term);
  }
  const out = [];
  for (const term of byName.values()) {
    if (!term.scrub) continue; // uncovered -> `uncoveredTerms()` reports it
    const re =
      term.scrubRe ??
      new RegExp(
        term.re.source,
        term.re.flags.includes('g') ? term.re.flags : term.re.flags + 'g'
      );
    out.push({ name: canonicalName(term.name), re, replacement: term.scrub });
  }
  return out;
}

/**
 * Canonical names of every term enforced by a gate but lacking a scrubbing
 * replacement. Must be empty — the coverage test asserts it, so adding a term
 * to a gate without a scrubbed paraphrase is a loud failure, never a silent
 * gap that hands the gate a guaranteed-dirty changelog.
 */
export function uncoveredTerms() {
  const names = new Set(
    [...SRC_TERMS, ...TARBALL_TERMS].map((t) => canonicalName(t.name))
  );
  const covered = new Set(CHANGELOG_SCRUB.map((s) => s.name));
  return [...names].filter((n) => !covered.has(n));
}

/**
 * Every line of `text` that still carries a term enforced by EITHER gate.
 * Used by the version executor as a post-scrub self-check (never write a
 * CHANGELOG the gate would reject) and by the coverage test.
 *
 * @param {string} text
 * @returns {{ term: string, line: string }[]}
 */
export function findBannedHits(text) {
  const hits = [];
  for (const line of String(text).split('\n')) {
    for (const term of [...SRC_TERMS, ...TARBALL_TERMS]) {
      if (term.re.test(line)) {
        hits.push({ term: term.name, line: line.trim().slice(0, 160) });
        break;
      }
    }
  }
  return hits;
}

/**
 * Neutralise every forbidden term in `text` using the derived scrub patterns.
 * Pure: same input -> same output; idempotent (replacements contain no banned
 * stem). Throws if a residual hit survives — a scrub that cannot produce a
 * gate-clean string must never hand back a dirty one.
 *
 * @param {string} text
 * @returns {string}
 */
export function scrubChangelog(text) {
  let out = String(text);
  for (const { re, replacement } of CHANGELOG_SCRUB) {
    out = out.replace(re, replacement);
  }
  const residual = findBannedHits(out);
  if (residual.length) {
    const sample = residual
      .slice(0, 3)
      .map((h) => `[${h.term}] ${h.line}`)
      .join('\n  ');
    throw new Error(
      `scrubChangelog left ${residual.length} forbidden reference(s); a term is ` +
        `enforced by a gate but not covered by CHANGELOG_SCRUB:\n  ${sample}`
    );
  }
  return out;
}
