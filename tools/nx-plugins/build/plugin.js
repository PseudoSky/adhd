'use strict';
/** createNodes: attach @adhd/nx-build executor-backed targets to every buildable project. No project.json edits. */
const { existsSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { hasBuildTarget, isPublishable } = require('./detect-target');
function skip(p) { return p === '.' || p.startsWith('node_modules/') || p.includes('/node_modules/') || p.startsWith('dist/') || p.includes('/dist/') || p.startsWith('tmp/') || p.includes('/tmp/'); }
exports.createNodes = ['**/package.json', (pkgPath, _o, ctx) =>
{
  const projectRoot = dirname(pkgPath);
  if (skip(projectRoot)) return {};
  if (!existsSync(join(ctx.workspaceRoot, projectRoot, 'project.json'))) return {};
  if (!hasBuildTarget(ctx.workspaceRoot, projectRoot)) return {};
  // Private packages have no published artifact to verify/ship.
  if (!isPublishable(ctx.workspaceRoot, projectRoot)) return {};
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
  return {
    projects: {
      [projectRoot]: {
        targets: {
          "version": { "executor": "@adhd/nx-build:version", "dependsOn": ["build", "assets", "^version"], "cache": false },
          "reconcile": { "executor": "@adhd/nx-build:reconcile", "dependsOn": ["build", "assets"], "cache": false },
          "dist-manifest": { "executor": "@adhd/nx-build:manifest", "dependsOn": ["build", "assets"], "cache": false },
          "verify-dist-load": { "executor": "@adhd/nx-build:verify", "dependsOn": ["build"], "cache": true },
          "publish-hygiene": { "executor": "@adhd/nx-build:hygiene", "dependsOn": ["dist-manifest"], "cache": true },
          "publish": { "executor": "@adhd/nx-build:publish", "dependsOn": ["test", "^test", "version", "dist-manifest", "verify-dist-load", "publish-hygiene"], "cache": false }
        }
      }
    }
  };
}];
