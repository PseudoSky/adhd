'use strict';
/** createNodes: attach @adhd/nx-build executor-backed targets to every buildable project. No project.json edits. */
const { existsSync, readFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { hasBuildTarget, isPublishable } = require('./detect-target');
const { isScratchPath } = require('../lib/scratch-root');
function skip(p) { return p === '.' || p.startsWith('node_modules/') || p.includes('/node_modules/') || p.startsWith('dist/') || p.includes('/dist/') || isScratchPath(p); }
// True if `{projectRoot}/project.json` declares a target of this name. Used to
// make `publish` conditionally reach the project's resource-heavy `e2e` lane.
// The heavy lane is deliberately NOT in `test.dependsOn` (2026-09-28,
// backlog-e2e-cache-separation) so `nx affected -t test` stays a fast default
// lane — which means `publish`, which used to inherit `e2e` through `test`, must
// now reach it DIRECTLY, or a broken heavy suite can be published green. Kept
// here (not in `nx.json` `targetDefaults`) because that key is target-name-only
// and cannot be scoped per project. A project with no `e2e` target gets an
// unchanged `publish.dependsOn`.
function declaresTarget(workspaceRoot, projectRoot, targetName) {
  const projectJsonPath = join(workspaceRoot, projectRoot, 'project.json');
  if (!existsSync(projectJsonPath)) return false;
  try { return Boolean(JSON.parse(readFileSync(projectJsonPath, 'utf-8')).targets?.[targetName]); }
  catch { return false; }
}
// Nx 23 unified on the v2 plugin API: createNodes[1] receives the ARRAY of
// matched config files and returns [configFile, result] tuples.
exports.createNodes = ['**/package.json', (configFiles, _o, ctx) =>
  configFiles.map((pkgPath) =>
{
  const projectRoot = dirname(pkgPath);
  if (skip(projectRoot)) return [pkgPath, {}];
  if (!existsSync(join(ctx.workspaceRoot, projectRoot, 'project.json'))) return [pkgPath, {}];
  if (!hasBuildTarget(ctx.workspaceRoot, projectRoot)) return [pkgPath, {}];
  // Private packages have no published artifact to verify/ship.
  if (!isPublishable(ctx.workspaceRoot, projectRoot)) return [pkgPath, {}];
  // Does this project own a resource-heavy `e2e` lane? If so, `publish` must
  // reach it directly (see declaresTarget above).
  const hasE2e = declaresTarget(ctx.workspaceRoot, projectRoot, 'e2e');
  // In-source dist ({projectRoot}/dist) + publish-from-source-root means pnpm resolves
  // @adhd/* natively via each package's own manifest (main → ./dist/…). The old `link`
  // target (symlink node_modules/@adhd/<name> → repo-root dist) is retired — it created
  // the per-package-source-link shadowing that broke @adhd builds (BUG-WORKSPACE-NO-LINKING-001).
  // CORRECTED (2026-07-22 — the previous version of this comment was WRONG and nearly
  // caused a real regression): `@adhd/nx-build:publish` (executors/publish/impl.js) runs
  // `npm publish {projectRoot}/dist` — npm treats that DIRECTORY ITSELF as the package
  // root. Anything outside it (including a source-root README.md/CHANGELOG.md) is
  // completely invisible to that publish — there is no "ships straight from the package
  // root" path. README.md/CHANGELOG.md (+ any package.json-declared extra assets) MUST
  // physically exist inside {projectRoot}/dist before publish packs it. That's what the
  // `assets` target (@adhd/nx-assets, tools/nx-plugins/assets/) does — every target that
  // needs a doc-complete dist (`dist-manifest`, and transitively `publish-hygiene` +
  // `publish` which depend on it; `version`, which diffs dist against the published
  // tarball) depends on it below.
  // `dist-manifest` versions the dist: it (over)writes {projectRoot}/dist/package.json
  // with the resolved, dist-root publishable manifest (see executors/manifest). It is
  // NOT cached (its correctness depends on every sibling's version, an impractical
  // cache key) and is authoritative over any manifest an earlier build step emitted.
  // Publishing packs from {projectRoot}/dist, so publish-hygiene and publish both
  // depend on it. verify-dist-load reads the source manifest against the same physical
  // dist/ files, so it needs only `build` and stays independently cacheable.
  // `version` bumps the SOURCE package.json iff the built dist differs from what's
  // published at its current version (registry as baseline — no tags). Runs before
  // publish in `pnpm release`; not cached (reads live registry, mutates source).
  // `dependsOn: ["build", "assets", "^version"]` — `^version` orders versioning
  // TOPOLOGICALLY: a package's own internal @adhd/* dependencies get their
  // `version` task run FIRST, so by the time THIS project's version task
  // runs, every dependency it declares has already settled its version. The
  // version executor's own final step (see executors/version/impl.js) then
  // reconciles this package's declared internal ranges against that now-
  // settled state — reusing the `deps` plugin's `sync-deps` logic verbatim,
  // never duplicating it. See tools/nx-plugins/build/README.md and
  // tools/nx-plugins/deps/README.md for the full composition + the
  // "no forced cascade bump" guarantee (compare-published.js already strips
  // internal @adhd/* ranges before diffing, so a range-only sync is never
  // itself a bump trigger).
  // `reconcile` (PUBLISHED-STATE-CACHE-001): (re)builds THIS package's entry
  // in the committed `published-state.json` cache from npm, integrity-gated
  // so it pulls a full tarball only when local dist actually diverges from
  // what's published (see executors/reconcile/reconcile-core.js). It is the
  // ONLY task (besides `publish`'s own write-through) that talks to the
  // registry on the `version`/`sync-deps` happy path — `version` reads the
  // cache this populates and falls back to a single-package in-process call
  // into the SAME reconcile-core logic on a cache miss, never re-implementing
  // it. `dependsOn: ["build","assets"]` mirrors `version`'s own dist
  // freshness/doc-completeness requirement; `cache:false` because it reads
  // live registry state with no stable cache key.
  // BUG-007: `verify-dist-load` now reads the REBASED `{projectRoot}/dist/
  // package.json` (the one `dist-manifest` writes — entry paths rewritten
  // dist-root-relative) and resolves its entries against `dist/` itself, to
  // match exactly what an installed consumer's `require`/`import`
  // resolution sees. The RAW build-only output is UN-rebased — its `main`
  // still reads `./dist/index.js` (relative to the SOURCE root, not `dist/`
  // itself) — so if `verify-dist-load` ran before `dist-manifest` rebased
  // it, resolution would double the `dist/` segment (`dist/dist/index.js`,
  // never on disk) and fail. `dependsOn` now includes `dist-manifest` to
  // guarantee the rebased manifest exists first (no cycle: `dist-manifest`
  // only depends on `build`+`assets`; `verify-dist-load` depends on
  // `build`+`dist-manifest`; `publish` depends on both of those plus
  // `verify-dist-load` itself). `cache: false` for the same reason as
  // `publish-hygiene` (BUG-004, below): its verdict now depends on the
  // rebased dist manifest, which — like all of `dist/**` — is excluded from
  // nx's default cache inputs, so a cache HIT would replay a stale verdict
  // without ever re-reading the current rebase. The executor itself is
  // cheap (require/import of a handful of entries), so leaving it uncached
  // costs nothing.
  return [pkgPath, {
    projects: {
      [projectRoot]: {
        targets: {
          "version": { "executor": "@adhd/nx-build:version", "dependsOn": ["build", "assets", "^version"], "cache": false },
          "reconcile": { "executor": "@adhd/nx-build:reconcile", "dependsOn": ["build", "assets"], "cache": false },
          "dist-manifest": { "executor": "@adhd/nx-build:manifest", "dependsOn": ["build", "assets"], "cache": false },
          "verify-dist-load": { "executor": "@adhd/nx-build:verify", "dependsOn": ["build", "dist-manifest"], "cache": false },
          // BUG-004 (HIGH): NOT cached. nx's default `production`/`default`
          // inputs exclude `{projectRoot}/dist/**`, so the cache key for this
          // target never changes when dist content changes — a cache HIT would
          // replay a stale verdict from before the executor's BUG-001 re-stamp
          // fix without ever re-running it. The executor itself only shells
          // `npm pack --dry-run` against the already-built dist (cheap,
          // read-only, no network) — same rationale already applied to
          // `dist-manifest`/`version`/`publish` below, all of which read live
          // dist/registry state and are also `cache: false`.
          "publish-hygiene": { "executor": "@adhd/nx-build:hygiene", "dependsOn": ["dist-manifest"], "cache": false },
          // BUG-002 (CRITICAL): `^publish` orders publish TOPOLOGICALLY, mirroring
          // the existing `^version` pattern above (see the long comment on
          // `version` at line 40-51 for the full rationale). Without it, nx is
          // free to publish a dependent before the internal @adhd/* dependency
          // it declares has itself landed on the registry — a consumer running
          // `npm install <dependent>` in that exact window resolves the
          // dependency's declared range against a version that isn't published
          // yet and hits ETARGET. `^publish` guarantees every internal
          // dependency's publish task completes first, closing that window.
          // `e2e` is inserted conditionally: the resource-heavy lane is no
          // longer reached through `test.dependsOn` (2026-09-28,
          // backlog-e2e-cache-separation — coupling it there ran the whole
          // heavy lane uncached on every `nx affected -t test`), so `publish`
          // must reach it here or a broken heavy suite publishes green. Only a
          // project that DECLARES an `e2e` target gets the dependency; every
          // other project's dependsOn is unchanged. The retired `nx release`
          // path cannot be made conditional (it has no per-project hook), so
          // entrypoint/backlog carries it in its own `nx-release-publish`
          // override; the LIVE gate is this `publish` target.
          "publish": { "executor": "@adhd/nx-build:publish", "dependsOn": ["test", "^test", ...(hasE2e ? ["e2e"] : []), "version", "^publish", "dist-manifest", "verify-dist-load", "publish-hygiene"], "cache": false },
          // release-reset (FEAT-RELEASE-RESET-001): reads LIVE git/working-tree
          // state (HEAD vs working `package.json`/`CHANGELOG.md`) to detect a
          // partial/half-generated release step for THIS project and, with
          // `--live`, surgically revert only what it can prove is a pure
          // release-generated artifact. No build dependency — it never reads
          // `dist/`. `cache: false`: same rationale as `version`/`reconcile`
          // above — live state, no stable cache key, and a stale verdict here
          // would be actively dangerous (silently reporting "clean" against an
          // old snapshot). See tools/nx-plugins/build/lib/release-reset.js.
          "release-reset": { "executor": "@adhd/nx-build:release-reset", "cache": false }
        }
      }
    }
  }];
  }),
];
