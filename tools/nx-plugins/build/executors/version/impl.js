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
 *   - cached version !== source version -> BUG-005: this is now a semver-
 *     DIRECTIONAL check, not a bare inequality. `semver.lt(source, cached)`
 *     (source is BEHIND the cache's recorded published version) is a
 *     REGRESSION — a hard error, never silently treated as pending (see the
 *     in-line comment at the call site for why silently proceeding would
 *     permanently poison `published-state.json`). Otherwise (source >
 *     cached), source is already ahead of what's recorded as published (a
 *     bump is already pending publish); leave as-is.
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
 * are already settled by the time this runs. DEBT-BUILD-VERSION-SYNCDEPS-
 * REDUNDANT-001: this used to ALSO delegate to the `deps` plugin's
 * `sync-deps` (fix) / `sync-deps-check` (read-only, dryRun) executors — an
 * uncached, in-process, SECOND invocation of the full `@nx/dependency-checks`
 * ESLint rule per project per `version` run. That second call was provably
 * redundant: `version`'s own `dependsOn: ["build", "assets", "^version"]`
 * means `build` — whose own `dependsOn: ["^build", "lint"]`, whose own
 * `dependsOn: ["sync-deps"]` — has ALREADY run `sync-deps` for this exact
 * project earlier in the same task-graph invocation, unconditionally, for
 * every caller. `reconcileOwnInternalRanges` now delegates SOLELY to
 * `reconcileInternalRangesFromDisk` below, which reads every dependency's
 * on-disk `package.json` directly, bypassing the (possibly stale, since it's
 * computed once up front for the whole run) in-memory project graph the
 * ESLint rule instead consults — the one thing that CAN genuinely drift
 * mid-run (a sibling's own `version` task bumping its package.json between
 * when `lint`'s cached-graph `sync-deps` ran and now). It writes ONLY this
 * project's own package.json, never a sibling's. It never causes a spurious
 * bump of its own: compare-published.js's `normalizeManifest` strips
 * internal `@adhd/*` ranges before diffing (see compare-published.spec.mjs),
 * so a range-only edit here is invisible to the NEXT run's change-detector —
 * no cascade. This step is zero-network — it only ever reads on-disk
 * `package.json` files, never the registry.
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
 * whole task, same as a range-reconciliation failure does below.
 */
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { join, relative } = require('node:path');
// semver is a transitive dep of nx, resolved from the workspace root
// node_modules (confirmed: `require.resolve('semver')` from this exact file
// location resolves cleanly — no vendoring/inline-compare fallback needed).
const semver = require('semver');
const { bumpVersion, normalizedHash } = require('./compare-published');
const { writeDistManifest } = require('../manifest/generate-manifest');
const { readState, updatePublishedState } = require('../../lib/published-state');
const { reconcilePackage, describeNetworkCalls } = require('../reconcile/reconcile-core');
const { withMetrics } = require('../../../lib/metrics');

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
 * STALE-GRAPH FIX (correctness — see the `dependsOn: [..., "^version"]` note
 * above): `syncInternalDeps`/`checkInternalDeps` (the `deps` plugin's
 * sync-deps executors) delegate to the REAL `@nx/dependency-checks` ESLint
 * rule, which resolves each internal `@adhd/*` dependency's "correct"
 * version through NX'S OWN PROJECT GRAPH. That graph is computed ONCE, up
 * front, for the whole `nx run-many -t version` invocation and is never
 * refreshed mid-run — so if a dependency's OWN `version` task already
 * bumped its `package.json` earlier in THIS SAME run (guaranteed by the
 * `^version` topological ordering above), the graph the ESLint rule
 * consults can still report that dependency's PRE-bump version, producing
 * a false `versionMismatch` against a dependent that's actually already
 * correct — or silently leaving a genuinely stale range unfixed.
 *
 * The filesystem, unlike the in-memory graph snapshot, is always current by
 * the time this runs (that's exactly what `^version` guarantees). This
 * function re-reconciles every declared internal `@adhd/*` range directly
 * against each dependency's ON-DISK `package.json`, bypassing the cached
 * graph entirely. Missing/obsolete-dependency detection and external
 * (non-`@adhd/*`) version-mismatch checks are NOT this function's concern —
 * neither has a mid-run-staleness problem (an external package never gets
 * bumped by this same `run-many`, and a missing/obsolete dependency doesn't
 * change mid-run either), so they're left entirely to the upstream
 * `sync-deps` target that `version`'s own `dependsOn` chain (`build` ->
 * `lint` -> `sync-deps`) already guarantees ran for this exact project
 * earlier in the same task-graph invocation (see
 * DEBT-BUILD-VERSION-SYNCDEPS-REDUNDANT-001 above `reconcileOwnInternalRanges`).
 *
 * @param {import('@nx/devkit').ExecutorContext} context
 * @param {boolean} dryRun never writes; only logs what would change
 * @returns {{success: boolean}}
 */
function reconcileInternalRangesFromDisk(context, dryRun) {
  const projectRoot = context.projectsConfigurations.projects[context.projectName].root;
  const pkgPath = join(context.root, projectRoot, 'package.json');
  let raw;
  try {
    raw = readFileSync(pkgPath, 'utf8');
  } catch (err) {
    console.error(`version: [internal-range] could not read ${pkgPath}: ${err.message}`);
    return { success: false };
  }
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    console.error(`version: [internal-range] could not parse ${pkgPath}: ${err.message}`);
    return { success: false };
  }

  // BUG DEBT-002 #5 FIX: `desiredRanges` used to be keyed ONLY by `depName`,
  // and the (global) regex replace below rewrote EVERY textual occurrence of
  // `"<depName>": "..."` across the WHOLE file — including in a DIFFERENT
  // dependency field than the one the desired-prefix computation came from.
  // A dep declared with different range prefixes in, say, `dependencies`
  // (`^1.2.3`) vs `peerDependencies` (`~1.2.3`) would have BOTH forced onto
  // whichever field's entry happened to populate the map first (`desiredRanges.
  // has(depName)` dedup — same bug, opposite symptom). Fixed by scoping both
  // the computation AND the replace by `(field, depName)`: the desired-range
  // map is now keyed `"<field>::<depName>"`, and the replace is applied only
  // within THIS field's own `{ ... }` block of the raw text — never spilling
  // into a sibling field that happens to share a dependency name.
  const depFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  const desiredRanges = new Map(); // "<field>::<depName>" -> desired range string
  for (const field of depFields) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [depName, currentRange] of Object.entries(deps)) {
      if (!depName.startsWith('@adhd/')) continue;
      const depProjectName = depName.slice('@adhd/'.length);
      const depProject = context.projectsConfigurations.projects[depProjectName];
      if (!depProject) continue; // not a workspace project — leave whatever's there alone
      const depPkgPath = join(context.root, depProject.root, 'package.json');
      let depVersion;
      try {
        depVersion = JSON.parse(readFileSync(depPkgPath, 'utf8')).version;
      } catch {
        continue; // dependency has no readable on-disk package.json — nothing to reconcile against
      }
      if (!depVersion) continue;
      const prefix = /^[\^~]/.test(currentRange) ? currentRange[0] : '^';
      desiredRanges.set(`${field}::${depName}`, `${prefix}${depVersion}`);
    }
  }

  let next = raw;
  let changed = false;
  for (const field of depFields) {
    if (!pkg[field]) continue;
    // Locate THIS field's own `{ ... }` block in the current text. Dependency
    // collections are flat string maps (no nested `{}` in a well-formed
    // package.json), so a non-nested `[^}]*` match safely captures the whole
    // block without spilling into the next field.
    const fieldRegex = new RegExp(`("${field}"\\s*:\\s*\\{)([^}]*)(\\})`);
    const fieldMatch = fieldRegex.exec(next);
    if (!fieldMatch) continue; // field present in the parsed object but not found as expected in raw text — leave untouched
    const blockStart = fieldMatch.index + fieldMatch[1].length;
    const blockContent = fieldMatch[2];
    let updatedBlock = blockContent;
    for (const depName of Object.keys(pkg[field])) {
      const key = `${field}::${depName}`;
      if (!desiredRanges.has(key)) continue;
      const desiredRange = desiredRanges.get(key);
      const escaped = depName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`("${escaped}"\\s*:\\s*")[^"]*(")`);
      updatedBlock = updatedBlock.replace(pattern, (match, pre, post) => {
        const already = match.slice(pre.length, match.length - post.length);
        if (already === desiredRange) return match;
        changed = true;
        console.error(
          `version: [internal-range] ${dryRun ? 'would fix' : 'fixing'} ${context.projectName}'s "${field}.${depName}" ` +
          `${already} -> ${desiredRange} (direct on-disk read, bypassing cached project graph)`
        );
        return `${pre}${desiredRange}${post}`;
      });
    }
    if (updatedBlock !== blockContent) {
      next = next.slice(0, blockStart) + updatedBlock + next.slice(blockStart + blockContent.length);
    }
  }

  if (!changed) return { success: true };
  if (dryRun) return { success: true };

  try {
    writeFileSync(pkgPath, next);
  } catch (err) {
    console.error(`version: [internal-range] FAILED to write ${pkgPath}: ${err.message}`);
    return { success: false };
  }
  return { success: true };
}

/**
 * Reconcile THIS package's own declared internal `@adhd/*` dependency ranges
 * to the current workspace versions of those dependencies, by delegating
 * solely to `reconcileInternalRangesFromDisk` above (direct on-disk read,
 * bypassing any cached project graph). `dryRun` is forwarded straight
 * through — `reconcileInternalRangesFromDisk` itself never writes when
 * `dryRun` is true.
 *
 * @param {import('@nx/devkit').ExecutorContext} context
 * @param {boolean} dryRun
 * @returns {Promise<{success: boolean}>}
 */
async function reconcileOwnInternalRanges(context, dryRun) {
  // DEBT-BUILD-VERSION-SYNCDEPS-REDUNDANT-001: this used to ALSO invoke the
  // deps plugin's full @nx/dependency-checks ESLint rule (syncInternalDeps/
  // checkInternalDeps) here, a SECOND time per project per `version` run —
  // entirely uncached, since this was a direct in-process function call,
  // never routed through `nx run <project>:sync-deps[-check]`, so the
  // target-level cache:true on those targets (tools/nx-plugins/deps/
  // plugin.js) never applied to it. That second invocation is PROVABLY
  // redundant: version's own dependsOn:["build","assets","^version"]
  // (tools/nx-plugins/build/plugin.js) means build — whose own
  // dependsOn:["^build","lint"], whose own dependsOn:["sync-deps"]
  // (nx.json targetDefaults) — has ALREADY run sync-deps for THIS EXACT
  // project earlier in the SAME task-graph invocation, unconditionally, for
  // every caller. Had that upstream sync-deps failed, lint/build would
  // already have failed the whole graph and version would never execute.
  // Missing/obsolete-dependency and external-version-mismatch findings
  // cannot change between that upstream run and this one. The one thing
  // that CAN drift mid-run — internal @adhd/* ranges, via a sibling's own
  // version task bumping its package.json after lint's cached-graph
  // sync-deps ran — is exactly what reconcileInternalRangesFromDisk below
  // already exists to catch, reading every dependency's on-disk
  // package.json directly. Nothing is lost by no longer ALSO re-running the
  // full ESLint check here; only the redundant ~1s-per-project engine
  // invocation (measured live by this item) is removed.
  return { success: reconcileInternalRangesFromDisk(context, dryRun).success };
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

  // BUG-BUILD-PUBLISH-DISTMANIFEST-CLOBBERED-001: re-stamp dist/package.json
  // BEFORE hashing it below — `dist-manifest` is a sibling of THIS task in
  // `publish`'s dependsOn (both depend only on build+assets, neither on the
  // other), and `@nx/js:tsc`'s `build` can (re)materialize its own un-rebased
  // package.json into `distDir` after `dist-manifest` already ran once. If
  // this task hashed that clobbered directory, `normalizedHash` would NEVER
  // match the cache's published hash (the published tarball's manifest WAS
  // correctly rebased) — producing a spurious "changed" verdict and an
  // unbounded re-bump loop on every single `version`/`publish` invocation,
  // even with zero real code changes. See generate-manifest.js's
  // `writeDistManifest` doc comment for the full mechanism.
  await writeDistManifest(context, pkgRoot, distDir);
  rec.phase('writeDistManifest');

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
    // BUG-005 (CRITICAL): a bare `!==` here cannot tell "source is ahead of
    // what's published" (the legitimate, common case — a bump already landed
    // locally, release pending) apart from "source is BEHIND what's already
    // published" (a REGRESSION — e.g. a revert, a bad merge, a stale branch
    // rebuilt after main already moved on and published further). The old
    // code silently treated BOTH as "release pending, no bump" — and for a
    // regression, that is actively dangerous: `publish`'s own existence check
    // (`cached.version === version`) would then MISS (source is behind, not
    // equal), so `publish` would attempt `npm publish` for the OLD version
    // and, on npm's "cannot publish over previously published version"
    // rejection, run its write-through-cache path — overwriting the cache's
    // `normalizedHash`/`publishedIntegrity` for the ALREADY-PUBLISHED newer
    // version with the CURRENT (older, regressed) dist's hash under the OLD
    // version number. That poisons `published-state.json` permanently (every
    // future run compares the wrong hash against the wrong version) and
    // silently stalls the real release. A regression must be a loud, hard
    // failure here — never silently reinterpreted as "pending".
    if (semver.lt(version, cached.version)) {
      console.error(
        `version: ERROR — ${name}'s source version (${version}) is BEHIND the published-state cache's ` +
        `recorded version (${cached.version}). This looks like a version REGRESSION (a revert, a stale ` +
        `branch, or a bad merge) rather than a pending release. Refusing to proceed: continuing would let ` +
        `'publish' attempt to (re-)publish the OLD version and, on npm's "already published" rejection, ` +
        `write-through-cache the CURRENT (regressed) dist's hash under the OLD version number — permanently ` +
        `poisoning published-state.json and silently stalling the real release. Fix the source version (it ` +
        `must be >= ${cached.version}) before re-running.`
      );
      return { success: false };
    }
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
// pure helpers) — lets tests exercise `reconcileOwnInternalRanges` /
// `reconcileInternalRangesFromDisk` / `lastChangelogCommit` /
// `writeChangelogEntry` directly. Not used by Nx (which only calls the
// default export). DEBT-BUILD-VERSION-SYNCDEPS-REDUNDANT-001: no longer
// exports `syncInternalDeps`/`checkInternalDeps` — this module never
// requires the `deps` plugin's executors anymore (see
// `reconcileOwnInternalRanges` above).
module.exports.__internals = { reconcileOwnInternalRanges, reconcileInternalRangesFromDisk, lastChangelogCommit, writeChangelogEntry };
