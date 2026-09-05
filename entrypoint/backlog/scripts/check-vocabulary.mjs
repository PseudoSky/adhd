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
 * could not run (pack/extract failure) — a hard failure, never a silent pass.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, extname } from 'node:path';

/**
 * The four banned stems. `migrat` is deliberately a STEM, not a word: it catches
 * migrate/migrated/migrating/migration/migrator in one rule. `v1`/`v2` are
 * word-bounded and must not be followed by `.<digit>`, so genuine dependency and
 * model versions (`bge-base-en-v1.5`) are not false positives.
 */
const BANNED = [
  { name: 'humanId', re: /humanid/i },
  { name: 'v1', re: /\bv1\b(?!\.\d)/i },
  { name: 'v2', re: /\bv2\b(?!\.\d)/i },
  { name: 'migrat', re: /migrat/i },
];

/** Source maps embed original source verbatim and are not human-facing shipped
 *  prose. Excluded deliberately, and COUNTED, so the exclusion can never
 *  silently hide a real hit. */
const EXCLUDED_EXT = new Set(['.map']);

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
      execFileSync('tar', ['-xzf', join(work, tarball), '-C', work], { stdio: 'ignore' });
    } catch (err) {
      console.error(`check-vocabulary: could not extract ${tarball}: ${err.message}`);
      return 2;
    }

    const root = join(work, 'package');
    const files = walk(root);
    const violations = [];
    let excludedHits = 0;

    for (const file of files) {
      const rel = relative(root, file);
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue; // binary / unreadable: nothing to match
      }
      const excluded = EXCLUDED_EXT.has(extname(file));
      text.split('\n').forEach((line, i) => {
        for (const { name, re } of BANNED) {
          if (!re.test(line)) continue;
          if (excluded) excludedHits++;
          else violations.push({ file: rel, line: i + 1, token: name, text: line.trim().slice(0, 160) });
          break;
        }
      });
    }

    if (violations.length) {
      console.error('VOCABULARY GATE FAIL — banned tokens in the shipped artifact:\n');
      for (const v of violations) console.error(`  ${v.file}:${v.line}  [${v.token}]  ${v.text}`);
      const byToken = {};
      for (const v of violations) byToken[v.token] = (byToken[v.token] ?? 0) + 1;
      console.error(`\ntotal: ${violations.length} line(s) across ${new Set(violations.map((v) => v.file)).size} file(s)`);
      console.error(`by token: ${Object.entries(byToken).map(([k, n]) => `${k}=${n}`).join(' ')}`);
      return 1;
    }

    console.log('VOCABULARY GATE PASS — zero banned tokens in the shipped artifact.');
    console.log(`  tarball: ${tarball}`);
    console.log(`  files scanned: ${files.length}`);
    console.log(`  .map hits (excluded, informational): ${excludedHits}`);
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

process.exit(main());
