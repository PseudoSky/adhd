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
 * dependsOn ["build", "^version"]: needs the built dist to compare (`build`),
 * and needs every internal @adhd/* dependency to have ALREADY settled its own
 * version first (`^version` — topological). Runs per-project (each writes
 * only its own package.json — no cross-file contention). Not cached: it reads
 * live registry state and mutates source.
 *
 * Options: --bump=patch|minor|major (default patch), --dryRun (report, no write).
 *
 * The write is a targeted replace of the `"version"` field only, preserving the
 * file's existing formatting. It does NOT commit — review `git diff` and commit
 * the bumps yourself (or let `pnpm release` proceed to publish them).
 *
 * DEPENDENT-RANGE RECONCILIATION (final step, every run, regardless of the
 * bump decision above): after deciding whether THIS package's own version
 * bumps, `reconcileOwnInternalRanges` below reconciles THIS package's
 * declared internal `@adhd/*` dependency ranges to the workspace's current
 * versions. Because of the `^version` topological ordering, those versions
 * are already settled by the time this runs. This REUSES the `deps` plugin's
 * `sync-deps` (fix) / `sync-deps-check` (read-only, dryRun) executors
 * directly — see tools/nx-plugins/deps/executors/{sync,check}/impl.js — no
 * reconciliation logic is duplicated here. It writes ONLY this project's own
 * package.json (both reused executors scope to `context.projectName`'s
 * root), never a sibling's. It never causes a spurious bump of its own:
 * compare-published.js's `normalizeManifest` strips internal `@adhd/*`
 * ranges before diffing (see compare-published.spec.mjs), so a range-only
 * edit here is invisible to the NEXT run's change-detector — no cascade.
 *
 * CHANGELOG GENERATION (real bump only, before range reconciliation): once
 * the own-version write lands, `writeChangelogEntry` shells out to the REAL
 * `nx release changelog` (Nx's own conventional-commits parser + renderer,
 * configured via `nx.json` `release.changelog.projectChangelogs`) to update
 * THIS project's `{projectRoot}/CHANGELOG.md`. `--from` is resolved from the
 * commit that last touched that file (self-maintaining — no separate tag or
 * marker bookkeeping), falling back to `--first-release` for a package with
 * no prior recorded entry. `--git-commit=false --git-tag=false`: identical
 * "never commits" contract as the version bump itself. A dry run previews
 * via `--dry-run` (never writes); a changelog-generation failure fails the
 * whole task, same as a `sync-deps` reconciliation failure does below.
 */
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } = require('node:fs');
const { join, relative } = require('node:path');
const { comparePublishedToLocal, bumpVersion } = require('./compare-published');
// Reuse — never duplicate — the `deps` plugin's own reconciliation logic.
const syncInternalDeps = require('../../../deps/executors/sync/impl');
const checkInternalDeps = require('../../../deps/executors/check/impl');

/**
 * The `--from` git ref for `nx release changelog`'s commit range: the commit
 * that last touched THIS project's own CHANGELOG.md (i.e. when the previous
 * entry was recorded), or null if the file has never been committed —
 * `nx release changelog` is told `--first-release` in that case (lists full
 * history, correct for a genuinely first entry).
 *
 * Deliberately NOT git tags: this repo's `{project}@{version}` tags are
 * leftovers from the retired `nx release version` era (PUBLISHING.md) and
 * are already stale relative to the real npm-published version — the npm
 * registry, not git tags, is this repo's source of truth (compare-published.js
 * uses the same principle for the bump DECISION). The changelog file's own
 * last-modifying commit is self-maintaining instead: every future run's
 * boundary is set by THIS run's own write (once committed), with no
 * separate tag/marker bookkeeping to fall out of sync.
 *
 * @param {import('@nx/devkit').ExecutorContext} context
 * @param {string} changelogRelPath workspace-root-relative path, e.g. "packages/x/y/CHANGELOG.md"
 * @returns {string | null}
 */
function lastChangelogCommit(context, changelogRelPath) {
  const res = sh('git', ['log', '-1', '--format=%H', '--', changelogRelPath], { cwd: context.root });
  const sha = (res.stdout || '').trim();
  return res.status === 0 && sha ? sha : null;
}

/**
 * Generate/update THIS project's `{projectRoot}/CHANGELOG.md` by shelling
 * out to the REAL `nx release changelog` — reusing Nx's own conventional-
 * commits parser + renderer (already configured via `nx.json`
 * `release.changelog.projectChangelogs`) rather than hand-rolling markdown
 * generation. `--git-commit=false --git-tag=false`: this task, like the
 * version bump itself, never commits — a human (or `pnpm release`'s
 * downstream publish step) reviews and commits the diff.
 *
 * @param {import('@nx/devkit').ExecutorContext} context
 * @param {string} projectRoot
 * @param {string} version the version this changelog entry is FOR (the new,
 *                         just-decided version — matches the header nx renders)
 * @param {boolean} dryRun
 * @returns {boolean} success
 */
function writeChangelogEntry(context, projectRoot, version, dryRun) {
  const changelogRelPath = join(projectRoot, 'CHANGELOG.md').split('\\').join('/');
  const fromSha = lastChangelogCommit(context, changelogRelPath);
  const args = [
    'nx', 'release', 'changelog', version,
    '--projects', context.projectName,
    '--to', 'HEAD',
    '--git-commit', 'false',
    '--git-tag', 'false',
  ];
  if (fromSha) args.push('--from', fromSha);
  else args.push('--first-release');
  if (dryRun) args.push('--dry-run');
  const res = sh('npx', args, { cwd: context.root });
  if (res.status !== 0) {
    console.error(`version: changelog generation FAILED for ${context.projectName}:\n${res.stderr || res.stdout}`);
    return false;
  }
  console.error(`version: ${dryRun ? '[dry-run] would update' : 'updated'} ${changelogRelPath}`);
  // On a dry run, `nx release changelog --dry-run`'s own diff preview is the
  // only visibility into what would actually be written — without echoing it,
  // a dry run reports NOTHING about content, unlike the version bump's own
  // `reasons` list above. Preview output is on stdout; forward it verbatim.
  if (dryRun && res.stdout && res.stdout.trim()) {
    console.error(res.stdout.trim());
  }
  return true;
}

/**
 * Reconcile THIS package's own declared internal `@adhd/*` dependency ranges
 * to the current workspace versions of those dependencies, by delegating to
 * the `deps` plugin's sync (fix) / check (read-only) executors.
 *
 * `dryRun`: reconciliation writes a file, so a dry run must never apply it —
 * delegate to the read-only check instead, purely for visibility, and never
 * let its (possibly non-zero) result fail the overall dry-run report.
 *
 * @param {import('@nx/devkit').ExecutorContext} context
 * @param {boolean} dryRun
 * @returns {Promise<{success: boolean}>}
 */
async function reconcileOwnInternalRanges(context, dryRun) {
  if (dryRun) {
    console.error('version: [dry-run] checking internal @adhd/* range drift (sync-deps-check, not applying)…');
    await checkInternalDeps({}, context);
    return { success: true };
  }
  return syncInternalDeps({}, context);
}

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
  // BUG-NX-RUNMANY-DRYRUN-NOT-PROPAGATED-TO-DEPENDENCY-TASKS-001 (BACKLOG.md):
  // `nx run-many -t version --projects=A,B --dryRun` (and even a single
  // `nx run A:version --dryRun`) only applies the `--dryRun` CLI override to
  // the EXPLICITLY requested task(s) — NOT to the dependency tasks `^version`
  // pulls in automatically. Those dependency tasks run with the schema
  // DEFAULT (`dryRun: false`) and WILL actually bump + write, even though the
  // invocation looks like a safe, read-only dry run. Verified live 2026-07-22
  // (an intended `--dryRun` proof-of-topology run for 2 projects instead
  // really wrote version bumps — including a real internal-range sync — to
  // 10 unrelated dependency packages; reverted via `git restore`, no lasting
  // damage, but a real close call). The env var below is a belt-and-braces
  // fallback that IS honored uniformly across every task in a single nx
  // invocation (nx's task workers inherit the parent process's env), so a
  // wrapping `ADHD_NX_VERSION_DRY_RUN=1` covers dependency tasks the CLI
  // flag alone cannot reach. `pnpm release:dry` sets it; see PUBLISHING.md.
  const dryRun = !!options.dryRun || process.env.ADHD_NX_VERSION_DRY_RUN === '1';
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
    const sync = await reconcileOwnInternalRanges(context, dryRun);
    return { success: sync.success };
  }

  const workDir = join(context.root, 'tmp', 'nx-build-version', context.projectName);
  let publishedDir;
  try {
    publishedDir = fetchPublished(name, version, workDir);
    if (!publishedDir) {
      console.error(`version: could not fetch published ${name}@${version} — leaving as-is (verify manually).`);
      const sync = await reconcileOwnInternalRanges(context, dryRun);
      return { success: sync.success };
    }

    const { changed, reasons } = comparePublishedToLocal(distDir, publishedDir);
    if (!changed) {
      console.error(`version: ${name}@${version} unchanged vs published — no bump.`);
      const sync = await reconcileOwnInternalRanges(context, dryRun);
      return { success: sync.success };
    }

    const next = bumpVersion(version, level);
    console.error(`version: ${name} changed since ${version} -> bumping to ${next} (${level})`);
    for (const r of reasons.slice(0, 6)) console.error(`         · ${r}`);
    if (dryRun) {
      console.error(`version: [dry-run] would write ${next} to ${relative(context.root, srcPkgPath)}`);
      writeChangelogEntry(context, projectRoot, next, true);
      const sync = await reconcileOwnInternalRanges(context, dryRun);
      return { success: sync.success };
    }

    // Targeted replace of the version field only — preserve file formatting.
    const replaced = raw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`);
    if (replaced === raw) { console.error(`version: FAILED to rewrite version field in ${srcPkgPath}.`); return { success: false }; }
    writeFileSync(srcPkgPath, replaced);
    if (!writeChangelogEntry(context, projectRoot, next, false)) return { success: false };
    // Own bump is applied; now reconcile dependency ranges against the
    // (topologically) already-settled versions of internal deps. Order is
    // safe either way — the fix only touches dependency-range fields, never
    // "version" — but doing it after keeps the log narrative in decision order.
    const sync = await reconcileOwnInternalRanges(context, dryRun);
    return { success: sync.success };
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

module.exports = run;
module.exports.default = run;
// Test-only introspection seam (mirrors compare-published.js exporting its
// pure helpers) — lets tests assert THIS module's `syncInternalDeps` /
// `checkInternalDeps` are literally === the `deps` plugin's own executors
// (same require-cache entry, same absolute file), proving reuse rather than
// a duplicated reimplementation. Not used by Nx (which only calls the
// default export).
module.exports.__internals = { reconcileOwnInternalRanges, syncInternalDeps, checkInternalDeps, lastChangelogCommit, writeChangelogEntry };
