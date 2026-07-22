'use strict';
/**
 * @adhd/nx-build:version — per-project versioning TASK.
 *
 * Bumps a package's SOURCE package.json `version` iff it needs a new release,
 * using the npm registry as the baseline (no git tags, no diff base):
 *
 *   - source version NOT on npm  -> a release is already pending; leave as-is.
 *   - source version IS on npm   -> compare the freshly-built dist against the
 *                                   published tarball (see compare-published.js,
 *                                   which ignores the version field + internal
 *                                   @adhd/* ranges). Changed -> bump; identical
 *                                   -> leave.
 *
 * dependsOn ["build"]: needs the built dist to compare. Runs per-project (each
 * writes only its own package.json — no cross-file contention). Not cached: it
 * reads live registry state and mutates source.
 *
 * Options: --bump=patch|minor|major (default patch), --dryRun (report, no write).
 *
 * The write is a targeted replace of the `"version"` field only, preserving the
 * file's existing formatting. It does NOT commit — review `git diff` and commit
 * the bumps yourself (or let `pnpm release` proceed to publish them).
 */
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } = require('node:fs');
const { join, relative } = require('node:path');
const { comparePublishedToLocal, bumpVersion } = require('./compare-published');

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

/** Published versions of `name`, or [] if the package has never been published. */
function publishedVersions(name) {
  const res = sh('npm', ['view', name, 'versions', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (res.status !== 0) return []; // E404 — never published
  try {
    const parsed = JSON.parse(res.stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/** Download + extract the published tarball for name@version; returns the extracted package dir or null. */
function fetchPublished(name, version, workDir) {
  mkdirSync(workDir, { recursive: true });
  const packed = sh('npm', ['pack', `${name}@${version}`, '--pack-destination', workDir, '--json', '--silent'], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (packed.status !== 0) return null;
  let filename;
  try { filename = JSON.parse(packed.stdout)[0].filename; } catch { return null; }
  // npm may report the filename with the scope dir stripped; resolve what actually landed.
  let tgz = join(workDir, filename);
  if (!existsSync(tgz)) {
    const found = readdirSync(workDir).find((f) => f.endsWith('.tgz'));
    if (!found) return null;
    tgz = join(workDir, found);
  }
  const untar = sh('tar', ['-xzf', tgz, '-C', workDir]);
  if (untar.status !== 0) return null;
  return join(workDir, 'package'); // npm tarballs extract under package/
}

async function run(options, context) {
  const level = options.bump || 'patch';
  const dryRun = !!options.dryRun;
  const projectRoot = context.projectsConfigurations.projects[context.projectName].root;
  const pkgRoot = join(context.root, projectRoot);
  const distDir = join(pkgRoot, 'dist');
  const srcPkgPath = join(pkgRoot, 'package.json');

  if (!existsSync(distDir)) {
    console.error(`version: no built dist at ${relative(context.root, distDir)} — this target dependsOn build.`);
    return { success: false };
  }
  const raw = readFileSync(srcPkgPath, 'utf8');
  const { name, version } = JSON.parse(raw);
  if (!name || !version) { console.error(`version: ${relative(context.root, srcPkgPath)} missing name/version.`); return { success: false }; }

  const versions = publishedVersions(name);
  if (!versions.includes(version)) {
    console.error(`version: ${name}@${version} not yet on npm — release pending, no bump.`);
    return { success: true };
  }

  const workDir = join(context.root, 'tmp', 'nx-build-version', context.projectName);
  let publishedDir;
  try {
    publishedDir = fetchPublished(name, version, workDir);
    if (!publishedDir) { console.error(`version: could not fetch published ${name}@${version} — leaving as-is (verify manually).`); return { success: true }; }

    const { changed, reasons } = comparePublishedToLocal(distDir, publishedDir);
    if (!changed) {
      console.error(`version: ${name}@${version} unchanged vs published — no bump.`);
      return { success: true };
    }

    const next = bumpVersion(version, level);
    console.error(`version: ${name} changed since ${version} -> bumping to ${next} (${level})`);
    for (const r of reasons.slice(0, 6)) console.error(`         · ${r}`);
    if (dryRun) { console.error(`version: [dry-run] would write ${next} to ${relative(context.root, srcPkgPath)}`); return { success: true }; }

    // Targeted replace of the version field only — preserve file formatting.
    const replaced = raw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`);
    if (replaced === raw) { console.error(`version: FAILED to rewrite version field in ${srcPkgPath}.`); return { success: false }; }
    writeFileSync(srcPkgPath, replaced);
    return { success: true };
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

module.exports = run;
module.exports.default = run;
