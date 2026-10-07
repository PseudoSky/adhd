'use strict';
/** createNodes: attach @adhd/nx-build executor-backed targets to every buildable project. No project.json edits. */
const { existsSync, readFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { hasBuildTarget, isPublishable } = require('./detect-target');
const { isScratchPath } = require('../lib/scratch-root');
/**
 * cache-dag item 3: fields of a publishable project's own package.json that the
 * release (`version` phase / `sync-deps`) rewrites WITHOUT any code change: the
 * `version` field and every internal `@adhd/*` dependency RANGE (dependencies,
 * devDependencies, peerDependencies, optionalDependencies). Excluding exactly
 * these from the `manifest` named input (workspace default in nx.json, which
 * `default` includes) keeps build/test/lint/typecheck/typecheck-spec caches HIT
 * across the version phase for unchanged packages, while any real dependency
 * change (an external dep, a NEW or REMOVED internal dep, `exports`, `bin`,
 * `scripts`, ...) still changes the hash — a removed/added internal dep changes
 * the excluded-field SET, which is derived from the on-disk key list.
 * @param {string} workspaceRoot
 * @param {string} projectRoot
 * @returns {string[]} excludeFields for the nx `{json}` input
 */
function releaseRewrittenFields(workspaceRoot, projectRoot) {
  let pkg = {};
  try { pkg = JSON.parse(readFileSync(join(workspaceRoot, projectRoot, 'package.json'), 'utf8')); } catch { return ['version']; }
  const fields = ['version'];
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(pkg[section] || {})) {
      if (name.startsWith('@adhd/')) fields.push(`${section}.${name}`);
    }
  }
  return fields;
}
function skip(p) { return p === '.' || p.startsWith('node_modules/') || p.includes('/node_modules/') || p.startsWith('dist/') || p.includes('/dist/') || isScratchPath(p); }
/**
 * npm package name -> Nx project name, built from every workspace `package.json` that sits
 * next to a `project.json`. The Nx project name comes from `project.json#name` (falling back
 * to the package name with its scope stripped only when `project.json` has no name), NEVER by
 * stripping `@adhd/`: `@adhd/environment` is the project `environment-core-node`.
 * @param {string} workspaceRoot
 * @param {string[]} configFiles workspace-relative package.json paths (createNodes matches)
 * @returns {Map<string, string>}
 */
function buildPackageNameIndex(workspaceRoot, configFiles) {
  const index = new Map();
  for (const pkgPath of configFiles) {
    const root = dirname(pkgPath);
    if (skip(root)) continue;
    const projectJson = join(workspaceRoot, root, 'project.json');
    if (!existsSync(projectJson)) continue;
    try {
      const pkgName = JSON.parse(readFileSync(join(workspaceRoot, pkgPath), 'utf8')).name;
      if (!pkgName) continue;
      const projName = JSON.parse(readFileSync(projectJson, 'utf8')).name || pkgName.replace(/^@[^/]+\//, '');
      index.set(pkgName, projName);
    } catch { /* unreadable manifest: not an indexable workspace project */ }
  }
  return index;
}
/**
 * Nx project names of the workspace packages a project needs at RUNTIME: its package.json
 * `dependencies`, `peerDependencies` and `optionalDependencies` that are workspace projects.
 * `devDependencies` are excluded on purpose: consumers never install them
 * (generate-manifest.js deletes them from the published manifest), yet Nx project-graph edges
 * carry no dependency kind, so `^version`/`^publish` would fan out over dev/test-only edges.
 * @param {string} workspaceRoot
 * @param {string} projectRoot
 * @param {Map<string, string>} nameIndex from buildPackageNameIndex
 * @param {string} selfProject this project's own Nx name (never its own dependency)
 * @returns {string[]} sorted, de-duplicated Nx project names
 */
function runtimeInternalProjects(workspaceRoot, projectRoot, nameIndex, selfProject) {
  let pkg = {};
  try { pkg = JSON.parse(readFileSync(join(workspaceRoot, projectRoot, 'package.json'), 'utf8')); } catch { return []; }
  const out = new Set();
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(pkg[section] || {})) {
      const proj = nameIndex.get(name);
      if (proj && proj !== selfProject) out.add(proj);
    }
  }
  return [...out].sort();
}
exports.buildPackageNameIndex = buildPackageNameIndex;
exports.runtimeInternalProjects = runtimeInternalProjects;
// publish does not depend on e2e (owner decision 2026-10-07); run e2e explicitly before a release.
// Nx 23 unified on the v2 plugin API: createNodes[1] receives the ARRAY of
// matched config files and returns [configFile, result] tuples.
exports.createNodes = ['**/package.json', (configFiles, _o, ctx) =>
{
  const nameIndex = buildPackageNameIndex(ctx.workspaceRoot, configFiles);
  return configFiles.map((pkgPath) =>
  {
    const projectRoot = dirname(pkgPath);
    if (skip(projectRoot)) return [pkgPath, {}];
    if (!existsSync(join(ctx.workspaceRoot, projectRoot, 'project.json'))) return [pkgPath, {}];
    if (!hasBuildTarget(ctx.workspaceRoot, projectRoot)) return [pkgPath, {}];
    // Private packages have no published artifact to verify/ship.
    if (!isPublishable(ctx.workspaceRoot, projectRoot)) return [pkgPath, {}];
    // Runtime-only ordering (see runtimeInternalProjects): explicit per-project dependsOn
    // objects replace `^version` / `^test` / `^publish`, which expand over EVERY project-graph
    // edge including devDependency and test/vite-config import edges. `build`/`test`'s own
    // `^build`, `affected`, cache hashing and lint boundaries keep using the full graph.
    let selfProject = null;
    try { selfProject = JSON.parse(readFileSync(join(ctx.workspaceRoot, projectRoot, 'project.json'), 'utf8')).name || null; } catch { /* name stays null */ }
    const runtimeDeps = runtimeInternalProjects(ctx.workspaceRoot, projectRoot, nameIndex, selfProject);
    const onDeps = (target) => runtimeDeps.map((projects) => ({ projects, target }));
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
    // `dependsOn: ["build", "assets", <runtime deps>:version]` — the runtime-dependency `version` tasks order versioning
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
          // Project-level override of the workspace `manifest` named input (nx.json):
          // see releaseRewrittenFields. A project-level named input replaces the
          // workspace one of the same name.
          namedInputs: {
            manifest: [{ json: '{projectRoot}/package.json', excludeFields: releaseRewrittenFields(ctx.workspaceRoot, projectRoot) }],
          },
          targets: {
            "version": { "executor": "@adhd/nx-build:version", "dependsOn": ["build", "assets", ...onDeps("version")], /*"cache": false */ },
            "reconcile": { "executor": "@adhd/nx-build:reconcile", "dependsOn": ["build", "assets"], /*"cache": false*/ },
            // cache-dag AC9: CACHED. The executor is a pure function of (this project's source
            // package.json, the versions of its workspace dependencies' package.json, its
            // CHANGELOG.md) — `generateDistManifest`/`assertResolvedInternalDeps` read nothing
            // else (no registry, clock or env). Those are exactly the declared inputs; build/assets
            // hashes fold in through `dependsOn`. A hit restores the two files it writes. The
            // earlier "impractical cache key" claim (sibling versions) is answered by the
            // `dependencies:true` package.json fileset. Experiment: negative controls in
            // docs/PIPELINE.md §4 provenance / the cache-dag report.
            "dist-manifest": {
              "executor": "@adhd/nx-build:manifest",
              "dependsOn": ["build", "assets"],
              "cache": true,
              "inputs": [
                "{projectRoot}/package.json",
                "{projectRoot}/CHANGELOG.md",
                { "fileset": "{projectRoot}/package.json", "dependencies": true },
                "sharedGlobals"
              ],
              "outputs": ["{projectRoot}/dist/package.json", "{projectRoot}/dist/CHANGELOG.md"]
            },
            // cache-dag AC2: CACHED (supersedes the BUG-004 "cache:false"). BUG-004's hazard was a
            // hit replaying a verdict although `dist/**` changed (dist is excluded from
            // `default`/`production`) or although the executor itself changed. Both are now in the
            // key: `dependentTasksOutputFiles` hashes the actual on-disk outputs of `build` +
            // `dist-manifest` (the dist being loaded) and, transitively, the code-bearing files of
            // the workspace dependencies' dists it resolves through node_modules; `sharedGlobals`
            // carries `tools/nx-plugins/build/**` (the executor + verify-dist-load.mjs); the probe
            // timeout env var and the node version are declared. The verdict is a pure function of
            // those (read-only spawn of `node` against dist/). The re-stamp it performs is
            // idempotent and re-run by publish itself.
            "verify-dist-load": {
              "executor": "@adhd/nx-build:verify",
              "dependsOn": ["build", "dist-manifest"],
              "cache": true,
              "inputs": [
                "sharedGlobals",
                "{projectRoot}/package.json",
                { "dependentTasksOutputFiles": "**/*", "transitive": false },
                { "dependentTasksOutputFiles": "**/*.{js,mjs,cjs,d.ts,d.mts,d.cts,node}", "transitive": true },
                { "env": "VERIFY_DIST_LOAD_TIMEOUT_MS" },
                { "runtime": "node --version" }
              ]
            },
            // BUG-004 (HIGH): NOT cached. nx's default `production`/`default`
            // inputs exclude `{projectRoot}/dist/**`, so the cache key for this
            // target never changes when dist content changes — a cache HIT would
            // replay a stale verdict from before the executor's BUG-001 re-stamp
            // fix without ever re-running it. The executor itself only shells
            // `npm pack --dry-run` against the already-built dist (cheap,
            // read-only, no network) — same rationale already applied to
            // `dist-manifest`/`version`/`publish` below, all of which read live
            // dist/registry state and are also `cache: false`.
            // cache-dag AC2: CACHED. The verdict is `npm pack --dry-run --json` over `dist/` +
            // check-publish-hygiene.mjs, a pure function of the dist content (hashed via
            // `dependentTasksOutputFiles` over the OWN `build`/`assets`/`dist-manifest` outputs — all three are
            // direct dependencies so a non-transitive glob sees the whole dist), the executor code (`sharedGlobals` includes
            // `tools/nx-plugins/build/**`) and the npm version. The BUG-004 stale-replay (executor
            // fixed, hit replays old verdict) is closed by `sharedGlobals`.
            "publish-hygiene": {
              "executor": "@adhd/nx-build:hygiene",
              "dependsOn": ["build", "assets", "dist-manifest"],
              "cache": true,
              "inputs": [
                "sharedGlobals",
                "{projectRoot}/package.json",
                { "dependentTasksOutputFiles": "**/*", "transitive": false },
                { "runtime": "npm --version" }
              ]
            },
            // BUG-002 (CRITICAL): the runtime-dependency `publish` tasks order publish TOPOLOGICALLY, mirroring
            // the `version` pattern above (see the long comment on
            // `version` at line 40-51 for the full rationale). Without it, nx is
            // free to publish a dependent before the internal @adhd/* dependency
            // it declares has itself landed on the registry — a consumer running
            // `npm install <dependent>` in that exact window resolves the
            // dependency's declared range against a version that isn't published
            // yet and hits ETARGET. Depending on each runtime dependency's `publish` guarantees every internal
            // dependency's publish task completes first, closing that window.
            // `publish` deliberately does NOT depend on `e2e` (owner decision,
            // c0bf141d): the resource-heavy lane is not a publish prerequisite.
            "publish": { "executor": "@adhd/nx-build:publish", "dependsOn": ["test", ...onDeps("test"), "version", ...onDeps("publish"), "dist-manifest", "verify-dist-load", "publish-hygiene", "release-reset-check"], "cache": false },
            // release-reset (FEAT-RELEASE-RESET-001): reads LIVE git/working-tree
            // state (HEAD vs working `package.json`/`CHANGELOG.md`) to detect a
            // partial/half-generated release step for THIS project and, with
            // `--live`, surgically revert only what it can prove is a pure
            // release-generated artifact. No build dependency — it never reads
            // `dist/`. `cache: false`: same rationale as `version`/`reconcile`
            // above — live state, no stable cache key, and a stale verdict here
            // would be actively dangerous (silently reporting "clean" against an
            // old snapshot). See tools/nx-plugins/build/lib/release-reset.js.
            "release-reset": { "executor": "@adhd/nx-build:release-reset", "cache": false },
            // release-reset-check (backlog df9de4da): the NON-MUTATING precondition
            // form of release-reset. ONLY `publish` depends on it (once per project
            // per release). `version` does NOT: version never reads the check's
            // verdict, and running it before version re-ran the identical check a
            // second time per project (63 + 61 runs per release). It fails iff a
            // genuinely half-applied release state exists (orphaned version bump vs
            // HEAD, or a phantom CHANGELOG entry that is a clean prepend); states
            // that only need human review are reported as warnings and listed in
            // the release receipt but never fail it (lib/release-reset.js).
            // Ordering: the check `dependsOn: ["version"]` (its OWN project's version
            // task), so a raw `nx run-many -t publish` / `nx run <p>:publish` can never
            // have the check read the half-written bump (package.json written before
            // CHANGELOG.md) that version is still producing. Acyclic: version does not
            // depend on the check. Consequence: running the check standalone also runs
            // `version` first (set ADHD_NX_VERSION_DRY_RUN=1 to keep that read-only).
            "release-reset-check": { "executor": "@adhd/nx-build:release-reset", "options": { "check": true }, "dependsOn": ["version"], "cache": false }
          }
        }
      }
    }];
  });
}];
