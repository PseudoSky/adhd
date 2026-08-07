#!/usr/bin/env node
/**
 * version-all.mjs — set every @adhd/* workspace package's version in one shot,
 * and rewrite every internal @adhd/* dependency range to match, so the whole
 * family stays coherent and the pre-publish range-check gate passes.
 *
 * Two strategies:
 *
 *   fixed <version>   Every @adhd/* package -> the SAME exact version.
 *                     Internal ranges -> <prefix><version>. Idempotent.
 *                     e.g.  node version-all.mjs fixed 3.0.0 --write
 *
 *   bump <level>      Every @adhd/* package -> semver-inc(ITS OWN version, level),
 *                     level = patch|minor|major. Each package gets its own new
 *                     version; internal ranges are rewritten to point at the
 *                     DEPENDENCY's new version. NOT idempotent (re-running bumps
 *                     again) — run once, review the diff.
 *                     e.g.  node version-all.mjs bump major --write
 *
 * Back-compat: a bare semver first arg is treated as `fixed <version>`
 *              (node version-all.mjs 3.0.0  ==  node version-all.mjs fixed 3.0.0).
 *
 * FLAGS:
 *   --write            apply changes (default is a dry run — prints the plan, writes nothing)
 *   --range-prefix=^   prefix for internal dep ranges (default "^"; "" = exact pin, "~" = tilde)
 *   --skip-private     leave private packages at their current version (their ranges are still
 *                      rewritten, and dependents still point at their unchanged version)
 *
 * AFTER RUNNING (--write):
 *   1. pnpm install                              # refresh pnpm-lock.yaml
 *   2. pnpm run build                            # dist re-stamped (version is hashed into dist)
 *   3. (fixed only) re-run this dry -> "files changed: 0"   # bump mode is NOT idempotent; review diff instead
 *   4. pnpm run check:release-ranges             # GATE 1: every internal range must resolve
 *   5. commit package.json + pnpm-lock.yaml (explicit pathspec), then `pnpm release`
 *
 * SAFETY: only touches package.json `version` and @adhd/* dep ranges. Never touches
 * external deps, source, non-@adhd packages, or `workspace:` protocol ranges.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const INTERNAL_SCOPE = '@adhd/';
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const SEMVER_RE = /^\d+\.\d+\.\d+([-+].+)?$/;

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith('-'));
const positional = argv.filter((a) => !a.startsWith('-'));
const WRITE = flags.includes('--write');
const SKIP_PRIVATE = flags.includes('--skip-private');
const rangePrefixArg = flags.find((a) => a.startsWith('--range-prefix='));
const RANGE_PREFIX = rangePrefixArg ? rangePrefixArg.split('=')[1] : '^';

let strategy, fixedVersion, bumpLevel;
if (positional[0] === 'fixed') { strategy = 'fixed'; fixedVersion = positional[1]; }
else if (positional[0] === 'bump') { strategy = 'bump'; bumpLevel = positional[1]; }
else if (positional[0] && SEMVER_RE.test(positional[0])) { strategy = 'fixed'; fixedVersion = positional[0]; } // back-compat
else { strategy = null; }

function usage(msg) {
  if (msg) console.error(`ERROR: ${msg}\n`);
  console.error('Usage:');
  console.error('  node version-all.mjs fixed <version> [--write]              # all @adhd -> same version');
  console.error('  node version-all.mjs bump <patch|minor|major> [--write]     # all @adhd -> inc(own version)');
  console.error('  Flags: --write  --range-prefix=^|~|""  --skip-private');
  process.exit(2);
}
if (!strategy) usage('first arg must be "fixed <version>", "bump <level>", or a bare semver.');
if (strategy === 'fixed' && (!fixedVersion || !SEMVER_RE.test(fixedVersion))) usage(`fixed needs a valid semver, got "${fixedVersion}".`);
if (strategy === 'bump' && !['patch', 'minor', 'major'].includes(bumpLevel)) usage(`bump needs patch|minor|major, got "${bumpLevel}".`);

// ---- semver bump (core M.m.p; strips any -prerelease/+build) ---------------
function incVersion(version, level) {
  const core = String(version).split(/[-+]/)[0];
  const parts = core.split('.').map((n) => parseInt(n, 10));
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`cannot bump non-semver version "${version}"`);
  }
  const [maj, min, pat] = parts;
  if (level === 'major') return `${maj + 1}.0.0`;
  if (level === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`; // patch
}

// ---- discover workspace package.json files (via git; respects .gitignore) --
const tracked = execSync('git ls-files packages entrypoint "*/package.json" package.json', { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((p) => p.endsWith('package.json') && !p.includes('/node_modules/') && !p.includes('/dist/') && !p.startsWith('tmp/'));
const pkgPaths = [...new Set(tracked)];

const internalNames = new Set();
const pkgs = [];
for (const rel of pkgPaths) {
  const abs = join(ROOT, rel);
  let raw, json;
  try { raw = readFileSync(abs, 'utf8'); json = JSON.parse(raw); } catch { continue; }
  if (!json.name) continue;
  pkgs.push({ rel, abs, raw, json });
  if (json.name.startsWith(INTERNAL_SCOPE)) internalNames.add(json.name);
}

// ---- pass 1: compute each package's NEW version ----------------------------
// newVersionByName maps every internal @adhd name -> the version it will carry
// after this run. Ranges pointing at a dep are rewritten to that dep's NEW version,
// which is what keeps ranges resolvable in bump mode (each package differs).
const newVersionByName = new Map();
for (const { json } of pkgs) {
  if (!json.name || !json.name.startsWith(INTERNAL_SCOPE)) continue;
  const isPrivate = json.private === true;
  if (isPrivate && SKIP_PRIVATE) { newVersionByName.set(json.name, json.version); continue; }
  const next = strategy === 'fixed' ? fixedVersion : incVersion(json.version, bumpLevel);
  newVersionByName.set(json.name, next);
}

// ---- pass 2: apply version + range rewrites --------------------------------
let versionChanges = 0, depChanges = 0, filesChanged = 0, skippedPrivate = 0;
const report = [];

for (const { abs, raw, json } of pkgs) {
  if (!json.name || !json.name.startsWith(INTERNAL_SCOPE)) continue;
  const isPrivate = json.private === true;
  const newVersion = newVersionByName.get(json.name);
  let touched = false;
  const lines = [];

  if (isPrivate && SKIP_PRIVATE) {
    skippedPrivate++;
  } else if (json.version !== newVersion) {
    lines.push(`    version: ${json.version} -> ${newVersion}${isPrivate ? ' (private)' : ''}`);
    json.version = newVersion;
    versionChanges++; touched = true;
  }

  for (const field of DEP_FIELDS) {
    const deps = json[field];
    if (!deps) continue;
    for (const dep of Object.keys(deps)) {
      if (!internalNames.has(dep)) continue;          // only known internal packages
      const cur = deps[dep];
      if (typeof cur !== 'string' || cur.startsWith('workspace:')) continue;
      const wanted = `${RANGE_PREFIX}${newVersionByName.get(dep)}`; // point at the DEP's new version
      if (cur === wanted) continue;
      lines.push(`    ${field}.${dep}: ${cur} -> ${wanted}`);
      deps[dep] = wanted;
      depChanges++; touched = true;
    }
  }

  if (touched) {
    filesChanged++;
    report.push(`\n${json.name}  (${relative(ROOT, abs)})`);
    report.push(...lines);
    if (WRITE) {
      const trailingNewline = raw.endsWith('\n') ? '\n' : '';
      writeFileSync(abs, JSON.stringify(json, null, 2) + trailingNewline);
    }
  }
}

console.log(report.join('\n'));
console.log('\n' + '='.repeat(60));
console.log(WRITE ? 'APPLIED' : 'DRY RUN (no files written — pass --write to apply)');
console.log(`strategy       : ${strategy}${strategy === 'fixed' ? ` ${fixedVersion}` : ` ${bumpLevel}`}`);
console.log(`internal range : ${RANGE_PREFIX}<dependency's new version>`);
console.log(`@adhd packages : ${internalNames.size}`);
console.log(`files changed  : ${filesChanged}`);
console.log(`version bumps  : ${versionChanges}`);
console.log(`dep rewrites   : ${depChanges}`);
if (SKIP_PRIVATE) console.log(`private skipped: ${skippedPrivate}`);
if (strategy === 'bump') {
  console.log('\nNOTE: bump mode is NOT idempotent — re-running bumps again. Run once, review the diff.');
}
if (!WRITE) console.log('\nRe-run with --write to apply. Then: pnpm install && pnpm run build && pnpm run check:release-ranges');
