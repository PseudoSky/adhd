#!/usr/bin/env node
/**
 * check-vocabulary.mjs — acceptance gate: the shipped @adhd/backlog artifact
 * carries no versioned-rebuild vocabulary.
 *
 * The requirement is a property of what SHIPS, not of what the source tree
 * happens to contain, so this audits the PACKED TARBALL. A src/-only grep is
 * the weak version of this check: `skill/`, `CHANGELOG.md`, and every
 * `dist/**\/*.d.ts` (which carries source doc comments verbatim) all ship and
 * are invisible to it. A directory rename does not rewrite the prose inside the
 * files it moved, and that is exactly how the tokens survive.
 *
 * EXIT CODES: 0 = clean. 1 = banned vocabulary found. 2 = the check itself
 * could not run — a pack/extract failure, OR the packed tarball contains no
 * `dist/**\/*.d.ts` at all. The second case is a real pass-by-omission: npm
 * pack exits 0 when package.json's `files` names a directory that does not
 * exist, so an unbuilt package would otherwise report PASS while scanning only
 * package.json/CHANGELOG.md/skill and silently skipping the one surface that
 * reproduces source doc comments verbatim. A hard failure, never a silent pass.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, extname } from 'node:path';

/**
 * The banned stems. `migrat` and `sqlite` are deliberately STEMS, not words:
 * `migrat` catches migrate/migrated/migrating/migration/migrator in one rule,
 * and `sqlite` catches `better-sqlite3` and every casing. `v1`/`v2` are
 * word-bounded and must not be followed by `.<digit>`, so genuine dependency
 * and model versions (`bge-base-en-v1.5`) are not false positives. They are
 * likewise not followed by `.db`: `backlog-v2.db` is the live production
 * store's real filename (config.yaml `db.path` / `sandbox-path`), an
 * operational identifier the docs must reproduce verbatim, not this package
 * naming its own surface. The carve-out is exactly `.db` (word-bounded), so
 * bare `v2` prose and `v2.dbx`-shaped names still fail.
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
const BANNED = [
  { name: 'humanId', re: /humanid/i, minifiable: false },
  { name: 'migrat', re: /migrat/i, minifiable: false },
  { name: 'sqlite', re: /sqlite/i, minifiable: false },
  { name: 'v1', re: /\bv1\b(?!\.\d)(?!\.db\b)/i, minifiable: true },
  { name: 'v2', re: /\bv2\b(?!\.\d)(?!\.db\b)/i, minifiable: true },
];

/** Source maps embed original source verbatim and are not human-facing shipped
 *  prose. Excluded deliberately, and COUNTED, so the exclusion can never
 *  silently hide a real hit. */
const EXCLUDED_EXT = new Set(['.map']);

/**
 * A GENERATED bundle: minifier output, where identifier names are invented by
 * the tool and carry no authorial intent. Only the non-minifiable terms apply
 * here. Everything else in the tarball — every `.d.ts` (which carries source
 * doc comments VERBATIM, the exact leak a src/-only grep misses), `skill/`,
 * `CHANGELOG.md`, `package.json`, `README.md` — is authored prose and is held
 * to the full rule.
 */
const GENERATED_BUNDLE = /^dist\/[^/]+\.m?js$/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function main() {
  const pkgDir = process.argv[2] ?? process.cwd();
  const work = mkdtempSync(join(tmpdir(), 'backlog-vocab-'));
  try {
    let tarball;
    try {
      const out = execFileSync('npm', ['pack', '--pack-destination', work], {
        cwd: pkgDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      tarball = out.trim().split('\n').pop();
    } catch (err) {
      console.error(`check-vocabulary: npm pack failed: ${err.message}`);
      return 2;
    }
    try {
      execFileSync('tar', ['-xzf', join(work, tarball), '-C', work], {
        stdio: 'ignore',
      });
    } catch (err) {
      console.error(
        `check-vocabulary: could not extract ${tarball}: ${err.message}`
      );
      return 2;
    }

    const root = join(work, 'package');
    const files = walk(root);

    // Pass-by-omission guard. `npm pack` exits 0 when a `files` entry names a
    // directory that does not exist, yielding a tarball with no dist/ at all.
    // Without this check the gate would then "pass" while scanning only
    // package.json/CHANGELOG.md/skill — silently dropping the shipped
    // declarations, the surface this gate exists to check. Treat an empty
    // dist/ as the documented exit-2 "could not run" case, never a pass.
    const declarations = files.filter((file) =>
      /^dist\/.+\.d\.ts$/.test(relative(root, file))
    );
    if (declarations.length === 0) {
      console.error(
        'check-vocabulary: CANNOT RUN — the packed tarball contains no dist/**/*.d.ts.\n' +
          '  The shipped type declarations are the surface this gate exists to check, so an\n' +
          '  empty dist/ is a hard failure, not a clean result. Verify the package builds\n' +
          '  dist/ and that package.json `files` names it.\n' +
          `  tarball: ${tarball}\n` +
          `  files found in tarball: ${files.length}`
      );
      return 2;
    }

    const violations = [];
    let excludedHits = 0;
    let minifiedHits = 0;

    for (const file of files) {
      const rel = relative(root, file);
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue; // binary / unreadable: nothing to match
      }
      const excluded = EXCLUDED_EXT.has(extname(file));
      const generated = GENERATED_BUNDLE.test(rel);
      text.split('\n').forEach((line, i) => {
        for (const { name, re, minifiable } of BANNED) {
          if (!re.test(line)) continue;
          // A minifiable term inside a generated bundle is the tool's own
          // identifier, not this package's vocabulary. Counted, never silent.
          if (generated && minifiable) {
            minifiedHits++;
            continue;
          }
          if (excluded) excludedHits++;
          else
            violations.push({
              file: rel,
              line: i + 1,
              token: name,
              text: line.trim().slice(0, 160),
            });
          break;
        }
      });
    }

    if (violations.length) {
      console.error(
        'VOCABULARY GATE FAIL — banned tokens in the shipped artifact:\n'
      );
      for (const v of violations)
        console.error(`  ${v.file}:${v.line}  [${v.token}]  ${v.text}`);
      const byToken = {};
      for (const v of violations)
        byToken[v.token] = (byToken[v.token] ?? 0) + 1;
      console.error(
        `\ntotal: ${violations.length} line(s) across ${
          new Set(violations.map((v) => v.file)).size
        } file(s)`
      );
      console.error(
        `by token: ${Object.entries(byToken)
          .map(([k, n]) => `${k}=${n}`)
          .join(' ')}`
      );
      return 1;
    }

    console.log(
      'VOCABULARY GATE PASS — zero banned tokens in the shipped artifact.'
    );
    console.log(`  tarball: ${tarball}`);
    console.log(`  files scanned: ${files.length}`);
    console.log(`  dist/*.d.ts declarations scanned: ${declarations.length}`);
    console.log(`  .map hits (excluded, informational): ${excludedHits}`);
    console.log(
      `  minifier-identifier v1/v2 hits in generated bundles (excluded, informational): ${minifiedHits}`
    );
    console.log(
      '  humanId/migrat/sqlite were enforced everywhere, generated bundles included.'
    );
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

process.exit(main());
