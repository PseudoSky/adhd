#!/usr/bin/env node
/**
 * gen-ac-traceability.mjs — generate `docs/plan/backlog-consolidation/ac-traceability.json`
 * from the REAL, measured acceptance-criterion rows in `QA-STRATEGY.md` §3.
 *
 * Why a generator, not a hand-curated file (QA-STRATEGY.md §6): "The traceability
 * file is generated, never hand-curated; a drift check fails when a bound test is
 * deleted or renamed." This script IS that generator. It:
 *
 *   1. Parses the 12 per-spec AC tables (S01–S12) out of QA-STRATEGY.md §3 — the
 *      measured decomposition of `SPEC-SET.md`'s 107 numbered AC bullets. The row
 *      count is ASSERTED to be 107; a parser drift or a doc edit that changes the
 *      AC count fails loudly rather than silently emitting a short file.
 *   2. Classifies every AC into exactly one of three states:
 *        - `bound`       — a real (non-`it.todo`) test file named in the row's
 *                          candidate/status column exists on disk. The binding is
 *                          recorded as a CANDIDATE binding: the file exercises the
 *                          AC's surface, but per QA-STRATEGY.md §6 a binding is
 *                          only `proven` once it records a red_sha AND green_sha,
 *                          and NO test currently names an AC id. `proven` is
 *                          therefore false for every entry today — stated, not
 *                          hidden.
 *        - `unreachable` — the row's own measured status marks the surface absent
 *                          (e.g. `surface-absent`, `rg -F` = 0 matches). The
 *                          reason is carried verbatim from the measured doc, and
 *                          the generator cross-checks it with a LIVE `rg -F`
 *                          count over `entrypoint/backlog/src` for the row's
 *                          absent token where one can be extracted.
 *        - `unbound`     — no real test and no absence measurement: a coverage gap.
 *   3. Writes the artifact with derived counts (bound / unreachable / unbound /
 *      proven) so a reader never has to run a query to see the state.
 *
 * Usage:
 *   node entrypoint/backlog/scripts/gen-ac-traceability.mjs           # write
 *   node entrypoint/backlog/scripts/gen-ac-traceability.mjs --check   # validate only
 *
 * `--check` exits non-zero when: the AC count is not 107, a `bound` test file no
 * longer exists, or the generated body differs from the committed artifact (drift).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const PKG_ROOT = join(REPO_ROOT, 'entrypoint', 'backlog');
const STRATEGY = join(REPO_ROOT, 'docs', 'plan', 'backlog-consolidation', 'QA-STRATEGY.md');
const OUT = join(REPO_ROOT, 'docs', 'plan', 'backlog-consolidation', 'ac-traceability.json');
const EXPECTED_AC_COUNT = 107;

/** The 12 spec ids, in order. */
const SPEC_IDS = ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11', 'S12'];

/** Markers in a row's status/candidate column that mean "no shipped surface". */
const ABSENT_MARKERS = [
  'surface-absent',
  'unreachable-until-implemented',
  'unshipped',
  'not yet built',
  '0 matches',
  'rg -F',
  'rg` = 0',
  'file a coordinated upgrade',
];

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '<unknown>';
  }
}

/** Count case-insensitive fixed-string matches of `token` under entrypoint/backlog/src. */
function rgCount(token) {
  if (!token) return null;
  try {
    const out = execFileSync(
      'rg',
      ['-F', '--count-matches', '--no-messages', token, join(PKG_ROOT, 'src')],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    const total = out
      .split('\n')
      .filter(Boolean)
      .reduce((n, line) => n + Number(line.split(':').pop() ?? 0), 0);
    return total;
  } catch (err) {
    if (err && err.status === 1) return 0; // rg: no matches
    return null; // rg missing / other error — never fabricate
  }
}

/**
 * A row's real test file, if the row names one that exists and contains at least
 * one real `it(` case (a stub whose every case is `it.todo` does NOT count — the
 * default-lane `*.spec.ts` stubs are exactly that and prove nothing).
 */
function resolveCandidate(cell) {
  const m = cell.match(/(src\/[^\s,;`)]+\.(?:spec|e2e)\.ts)/g);
  if (!m) return null;
  for (const rel of m) {
    const abs = join(PKG_ROOT, rel);
    if (!existsSync(abs)) continue;
    const body = readFileSync(abs, 'utf8');
    const real = (body.match(/^\s*it\(/gm) ?? []).length;
    const todo = (body.match(/^\s*it\.todo\(/gm) ?? []).length;
    if (real > 0 && real >= todo) return rel;
  }
  return null;
}

/** Parse the per-spec AC tables out of QA-STRATEGY.md §3. */
function parseAcRows(md) {
  const lines = md.split('\n');
  const rows = [];
  let spec = null;
  let inTable = false;
  for (const line of lines) {
    const h = line.match(/^### (S\d\d)\b/);
    if (h) {
      spec = h[1];
      inTable = false;
      continue;
    }
    if (!spec) continue;
    if (/^\|\s*AC\s*\|/.test(line)) {
      inTable = true;
      continue;
    }
    if (inTable && /^\|.*\|$/.test(line)) {
      if (/^\|[\s-]*\|/.test(line)) continue; // separator
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
      if (cells.length < 5) continue;
      rows.push({
        spec,
        ac: cells[0],
        claim: cells[1],
        level: cells[2],
        live: /yes/i.test(cells[3]),
        statusCell: cells[4],
      });
      continue;
    }
    if (inTable && line.trim() !== '' && !line.startsWith('|')) {
      // table ended; stay in this spec until the next heading
      inTable = false;
    }
  }
  return rows;
}

function classify(row) {
  const candidate = resolveCandidate(row.statusCell) ?? resolveCandidate(row.claim);
  const hay = `${row.statusCell} ${row.claim}`.toLowerCase();
  const absent = ABSENT_MARKERS.some((mk) => hay.includes(mk.toLowerCase()));
  if (candidate) {
    return {
      binding: 'bound',
      test: candidate,
      proof: 'candidate',
      proven: false,
      negative_control: null,
      red_sha: null,
      green_sha: null,
      note: 'candidate binding — the named file exercises this surface but does not name the AC id; red→green proof not yet recorded (QA-STRATEGY.md §6)',
    };
  }
  if (absent) {
    // Extract a short backticked token from the row to cross-check with a real rg.
    const tok = (row.claim.match(/`([a-zA-Z0-9_.:\- ]{2,40})`/) ?? [])[1];
    const n = rgCount(tok);
    return {
      binding: 'unreachable',
      reason: row.statusCell,
      measured: tok ? { token: tok, rg_matches_in_src: n } : null,
    };
  }
  return {
    binding: 'unbound',
    reason:
      row.statusCell && row.statusCell !== ''
        ? row.statusCell
        : 'no real test bound and no absence measurement recorded in QA-STRATEGY.md §3',
    ...(row.statusCell && /partial|todo/i.test(row.statusCell)
      ? {
          note: 'status cell names a candidate that is either absent (renamed/removed) or an all-`it.todo` stub — not a real assertion (QA-STRATEGY.md §5 "the green is thin")',
        }
      : {}),
  };
}

function build() {
  const md = readFileSync(STRATEGY, 'utf8');
  const rows = parseAcRows(md);
  if (rows.length !== EXPECTED_AC_COUNT) {
    throw new Error(
      `AC count drift: parsed ${rows.length}, expected ${EXPECTED_AC_COUNT}. ` +
        `Either QA-STRATEGY.md §3 changed (update this generator) or the parser failed.`
    );
  }
  const bindings = rows.map((row) => {
    const cls = classify(row);
    return {
      spec: row.spec,
      ac: row.ac,
      claim: row.claim,
      level: row.level,
      live: row.live,
      status: cls.binding,
      ...(cls.test ? { test: cls.test } : {}),
      ...(cls.proof ? { proof: cls.proof, proven: cls.proven } : {}),
      ...(cls.reason ? { reason: cls.reason } : {}),
      ...(cls.measured ? { measured: cls.measured } : {}),
      ...(cls.note ? { note: cls.note } : {}),
      negative_control: cls.negative_control ?? null,
      red_sha: cls.red_sha ?? null,
      green_sha: cls.green_sha ?? null,
    };
  });
  const counts = {
    total: bindings.length,
    bound: bindings.filter((b) => b.status === 'bound').length,
    unreachable: bindings.filter((b) => b.status === 'unreachable').length,
    unbound: bindings.filter((b) => b.status === 'unbound').length,
    proven: bindings.filter((b) => b.proven === true).length,
  };
  const perSpec = {};
  for (const id of SPEC_IDS) {
    const s = bindings.filter((b) => b.spec === id);
    perSpec[id] = {
      total: s.length,
      bound: s.filter((b) => b.status === 'bound').length,
      unreachable: s.filter((b) => b.status === 'unreachable').length,
      unbound: s.filter((b) => b.status === 'unbound').length,
    };
  }
  return {
    schema: 1,
    generated_from: gitHead(),
    generated_by: 'entrypoint/backlog/scripts/gen-ac-traceability.mjs',
    source: 'docs/plan/backlog-consolidation/QA-STRATEGY.md §3 (107 measured AC bullets, SPEC-SET.md S01–S12)',
    counts,
    per_spec: perSpec,
    bindings,
  };
}

function main() {
  const check = process.argv.includes('--check');
  const artifact = build();
  const json = `${JSON.stringify(artifact, null, 2)}\n`;

  if (check) {
    if (!existsSync(OUT)) {
      console.error(`[ac-traceability] MISSING ${OUT} — run without --check to generate`);
      process.exit(1);
    }
    const committed = readFileSync(OUT, 'utf8');
    // Ignore the volatile generated_from/generated_at lines when diffing so a new
    // commit does not spuriously fail a `--check` on an otherwise-identical body.
    const norm = (s) => s.replace(/"generated_from": "[^"]*",\n/, '');
    if (norm(committed) !== norm(json)) {
      console.error('[ac-traceability] DRIFT: committed artifact differs from generated body');
      process.exit(1);
    }
    const missing = artifact.bindings
      .filter((b) => b.status === 'bound' && !existsSync(join(PKG_ROOT, b.test)))
      .map((b) => `${b.spec}/${b.ac} -> ${b.test}`);
    if (missing.length) {
      console.error(`[ac-traceability] bound test missing:\n  ${missing.join('\n  ')}`);
      process.exit(1);
    }
  } else {
    writeFileSync(OUT, json, 'utf8');
  }
  const c = artifact.counts;
  console.log(
    `[ac-traceability] total=${c.total} bound=${c.bound} unreachable=${c.unreachable} ` +
      `unbound=${c.unbound} proven=${c.proven}`
  );
}

main();
