'use strict';
/**
 * @adhd/nx-build:version — per-project versioning TASK.
 *
 * Bumps a package's SOURCE package.json `version` iff it needs a new release,
 * using the committed `published-state.json` cache as the baseline
 * (PUBLISHED-STATE-CACHE-001 — no git tags, no diff base, and — on the happy
 * path — NO NETWORK):
 *
 *   - package absent from the cache -> single-package BACKFILL (in-process
 *     call into `reconcile-core.js`'s `reconcilePackage`, the exact same
 *     logic the standalone `reconcile` task uses) reconciles just this one
 *     package from npm, then the decision below proceeds against the
 *     now-populated entry. This is the ONLY place `version` touches the
 *     network, and only for packages the cache doesn't know about yet.
 *   - cached version !== source version -> source is already ahead of what's
 *     recorded as published (a bump is already pending publish); leave as-is.
 *   - cached version === source version -> compare `normalizedHash(localDist)`
 *     against the cache's `normalizedHash` (the PUBLISHED content's hash,
 *     computed with the exact same `normalizeManifest`/`listFiles`/
 *     `stableStringify` primitives `comparePublishedToLocal` uses — see
 *     compare-published.js's equivalence proof). Equal -> unchanged, leave;
 *     different -> bump.
 *
 * This is a drop-in behavioral replacement for the pre-cache tarball-fetch
 * flow: the decision (bump / no-bump, and the resulting version) is provably
 * identical (compare-published.spec.mjs's normalizedHash-equivalence suite),
 * only the mechanism moved from "fetch + per-file diff every run" to
 * "cache-hash compare, backfill only on a miss".
 *
 * dependsOn ["build", "assets", "^version"]: needs the built + doc-complete
 * dist to hash (`build`+`assets`), and needs every internal @adhd/*
 * dependency to have ALREADY settled its own version first (`^version` —
 * topological). Runs per-project (each writes only its own package.json —
 * no cross-file contention). Not cached: it reads/writes live
 * published-state (on a miss) and mutates source.
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
 * This step is ALSO already zero-network — `sync-deps`/`sync-deps-check`
 * (tools/nx-plugins/deps/eslint-check.mjs) reconcile against Nx's own
 * project graph (every sibling's on-disk source package.json), never the
 * registry.
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
const { existsSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { join, relative } = require('node:path');
const { bumpVersion, normalizedHash } = require('./compare-published');
const { readState, updatePublishedState } = require('../../lib/published-state');
const { reconcilePackage, describeNetworkCalls } = require('../reconcile/reconcile-core');
const { withMetrics } = require('../../../lib/metrics');
// Reuse — never duplicate — the `deps` plugin's own reconciliation logic.
const syncInternalDeps = require('../../../deps/executors/sync/impl');
const checkInternalDeps = require('../../../deps/executors/check/impl');

/**
 * Absolute path to the workspace's own locally-installed `nx` CLI entry.
 * `writeChangelogEntry` invokes this directly (`node <nxBin> release
 * changelog ...`) instead of `npx nx release changelog ...`
 * (BUILD-TOOLING-METRICS-001) — `npx` pays its own extra resolution overhead
 * (checking whether `nx` is installed locally, resolving the bin shim) EVERY
 * time, purely to re-discover a binary that's already known and pinned at
 * this exact absolute path in a monorepo like this one. Behavior is
 * identical: `npx nx <args>` and `node <nx/bin/nx.js> <args>` invoke the same
 * CLI entry point with the same argv.
 */
const NX_BIN = require.resolve('nx/bin/nx.js');

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
 * @param {import('../../../lib/metrics').MetricsRecorder} [rec]
 * @returns {string | null}
 */
function lastChangelogCommit(context, changelogRelPath, rec) {
  const cmd = ['git', 'log', '-1', '--format=%H', '--', changelogRelPath];
  const res = rec
    ? rec.time(cmd.join(' '), () => sh('git', cmd.slice(1), { cwd: context.root }))
    : sh('git', cmd.slice(1), { cwd: context.root });
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
 * @param {import('../../../lib/metrics').MetricsRecorder} [rec]
 * @returns {boolean} success
 */
function writeChangelogEntry(context, projectRoot, version, dryRun, rec) {
  const changelogRelPath = join(projectRoot, 'CHANGELOG.md').split('\\').join('/');
  const fromSha = lastChangelogCommit(context, changelogRelPath, rec);
  const args = [
    'release', 'changelog', version,
    '--projects', context.projectName,
    '--to', 'HEAD',
    '--git-commit', 'false',
    '--git-tag', 'false',
  ];
  if (fromSha) args.push('--from', fromSha);
  else args.push('--first-release');
  if (dryRun) args.push('--dry-run');
  const res = rec
    ? rec.time(`node ${NX_BIN} ${args.join(' ')}`, () => sh(process.execPath, [NX_BIN, ...args], { cwd: context.root }))
    : sh(process.execPath, [NX_BIN, ...args], { cwd: context.root });
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

/**
 * Single-package backfill on a cache MISS: calls the SAME
 * `reconcile-core.js` logic the standalone `reconcile` task uses, in-process
 * (no nx sub-invocation), scoped to just this one package. Writes the
 * resulting entry into `published-state.json` (concurrency-safe — see
 * `lib/published-state.js`) before returning it, so the caller's decision
 * below always has an authoritative entry to compare against (or `null` if
 * the package genuinely isn't published yet — `reconcilePackage`'s
 * `'pending'` status).
 *
 * @param {import('@nx/devkit').ExecutorContext} context
 * @param {string} name
 * @param {string} version
 * @param {string} distDir
 * @param {import('../../../lib/metrics').MetricsRecorder} rec
 * @returns {Promise<{entry: {version:string,normalizedHash:string,publishedIntegrity:string}|null, error?: string}>}
 */
async function backfillOnMiss(context, name, version, distDir, rec) {
  const workDir = join(context.root, 'tmp', 'nx-build-version-backfill', context.projectName);
  try {
    const result = rec.time('reconcilePackage (npm view/pack, offline pack, maybe tar)', () =>
      reconcilePackage({ name, version, distDir, workDir })
    );
    for (const label of describeNetworkCalls(result)) rec.network(label);
    if (result.status === 'pending') return { entry: null };
    if (result.status === 'error') return { entry: null, error: result.error };
    await updatePublishedState(context.root, (state) => {
      state[name] = result.entry;
      return state;
    });
    return { entry: result.entry };
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // best-effort scratch cleanup
    }
  }
}

async function run(options, context) {
  return withMetrics('version', context, (rec) => runVersion(options, context, rec));
}

async function runVersion(options, context, rec) {
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

  // ZERO-NETWORK read: the committed published-state cache.
  let cached = readState(context.root)[name];
  rec.phase('readState');

  if (!cached) {
    // Cache MISS — do NOT silently pass. Backfill just THIS package from npm
    // (in-process call into reconcile-core.js's reconcilePackage; the exact
    // same logic `nx run <project>:reconcile` uses), then decide from the
    // now-populated entry. This is the ONLY network this task ever performs,
    // and it costs exactly one package, never the whole graph.
    console.error(`version: ${name} not in published-state.json — backfilling from npm (single-package, cache miss)…`);
    const backfill = await backfillOnMiss(context, name, version, distDir, rec);
    if (backfill.error) {
      console.error(`version: backfill FAILED for ${name}: ${backfill.error} — leaving version as-is (verify manually).`);
      const sync = await reconcileOwnInternalRanges(context, dryRun);
      return { success: sync.success };
    }
    cached = backfill.entry; // null if genuinely not yet published (see below)
  }

  if (!cached) {
    console.error(`version: ${name}@${version} not yet on npm — release pending, no bump.`);
    const sync = await reconcileOwnInternalRanges(context, dryRun);
    return { success: sync.success };
  }

  if (cached.version !== version) {
    // Source is already ahead of the cache's last known published version —
    // a bump is already pending publish (mirrors the legacy "source version
    // not yet on npm" branch, without a live `npm view` — the cache always
    // holds the LATEST known published version, kept current by `publish`'s
    // write-through, Deliverable 3).
    console.error(
      `version: ${name}@${version} not yet on npm (published-state cache is at ${cached.version}) — release pending, no bump.`
    );
    const sync = await reconcileOwnInternalRanges(context, dryRun);
    return { success: sync.success };
  }

  // ZERO-NETWORK decision: compare the freshly built local dist's normalized
  // hash against the cache's PUBLISHED normalized hash. This holds whether
  // or not the package actually changed (Deliverable 2) — the network was
  // already spent, once, at backfill/write-through time, never here.
  const localHash = normalizedHash(distDir);
  rec.phase('normalizedHash');
  if (cached.normalizedHash === localHash) {
    console.error(`version: ${name}@${version} unchanged vs published (cache hit, zero network) — no bump.`);
    const sync = await reconcileOwnInternalRanges(context, dryRun);
    return { success: sync.success };
  }

  const next = bumpVersion(version, level);
  console.error(`version: ${name} changed since ${version} -> bumping to ${next} (${level}) [cache hit, zero network]`);
  if (dryRun) {
    console.error(`version: [dry-run] would write ${next} to ${relative(context.root, srcPkgPath)}`);
    writeChangelogEntry(context, projectRoot, next, true, rec);
    const sync = await reconcileOwnInternalRanges(context, dryRun);
    return { success: sync.success };
  }

  // Targeted replace of the version field only — preserve file formatting.
  const replaced = raw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`);
  if (replaced === raw) { console.error(`version: FAILED to rewrite version field in ${srcPkgPath}.`); return { success: false }; }
  writeFileSync(srcPkgPath, replaced);
  if (!writeChangelogEntry(context, projectRoot, next, false, rec)) return { success: false };
  // Own bump is applied; now reconcile dependency ranges against the
  // (topologically) already-settled versions of internal deps. Order is
  // safe either way — the fix only touches dependency-range fields, never
  // "version" — but doing it after keeps the log narrative in decision order.
  const sync = await reconcileOwnInternalRanges(context, dryRun);
  return { success: sync.success };
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
