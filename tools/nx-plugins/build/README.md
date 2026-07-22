# @adhd/nx-build

Build-lifecycle plugin: `manifest`, `version`, `verify-dist-load`, `publish-hygiene`, `publish`, `link` executors + `detect-target` util. Targets are inferred onto every buildable project; wiring lives in plugin.js/targetDefaults, never in project.json.

## `version` — topological dependent-range sync (BUILD-TOOLING-VERSION-SYNC-DEPS-001)

`nx run <project>:version` (executor `@adhd/nx-build:version`, `dependsOn: ["build", "^version"]`, **not cached**):

1. **Decides its own bump** — see [`executors/version/impl.js`](executors/version/impl.js) header and `compare-published.js` above: registry-driven, no git tags. Unchanged from before this section was added.
2. **`^version` (new):** runs a package's internal `@adhd/*` dependencies' `version` tasks FIRST (Nx topological ordering), so by the time a package's own `version` runs, every dependency it declares has already settled its version for this run.
3. **Reconciles its own declared internal ranges (new, every run, regardless of step 1's outcome):** after the bump decision, `version` reconciles THIS package's declared internal `@adhd/*` dependency ranges to the workspace's now-settled versions — by calling `tools/nx-plugins/deps/executors/sync/impl.js` (fix) or `.../check/impl.js` (read-only, only in `--dryRun`) **directly** (`require(...)`, not a subprocess re-implementation, not a copy — see `impl.js`'s `syncInternalDeps`/`checkInternalDeps`). It writes **only this project's own** `package.json`, never a sibling's.

**Why this doesn't cascade a bump through the graph:** `compare-published.js`'s `normalizeManifest` (used by step 1's diff) already strips `version` and every internal `@adhd/*` dependency range from BOTH sides before comparing (see `compare-published.spec.mjs`, `"only an internal @adhd/* dep RANGE differs -> NOT changed"`). So step 3's range-only edit is invisible to the *next* run's change-detector: a package's own version bumps only when ITS code/external deps/metadata actually changed, never merely because a dependency's version moved (a caret range already absorbs that at install time, and `dist-manifest` resolves published ranges from a live snapshot independent of source-side sync order — see the publish-from-dist section below). This also means `^version` never needs a *cascade* re-bump of dependents: it keeps SOURCE ranges consistent, nothing more.

**What this replaces:** previously, after a batch of version bumps, dependents' declared internal ranges could drift out of sync with the actual bumped versions until someone ran `sync-deps` manually. `^version`'s topological ordering plus this reconciliation step makes that self-healing as part of `version` itself.

Tests: `tools/nx-plugins/build/executors/version/impl.spec.mjs` (the orchestration/composition — reuse, dry-run routing, bump/sync independence, failure propagation) and `compare-published.spec.mjs` (the pure change-detector, including the range-only-doesn't-bump invariant). Run: `pnpm test:build-tools`.

> ⚠️ **`--dryRun` alone does not cover `^version`'s dependency tasks** — see the schema
> description on `dryRun` in [`executors/version/schema.json`](executors/version/schema.json)
> and `PUBLISHING.md`'s "Scoped/single-project `--dryRun`…" callout. Set
> `ADHD_NX_VERSION_DRY_RUN=1` too whenever you're not running the full, unscoped
> `nx run-many -t version --dryRun`. `impl.spec.mjs` has a dedicated regression test for
> this (`ADHD_NX_VERSION_DRY_RUN=1 env var forces dry-run…`).

## Publish-from-dist model

Each package publishes from its **built artifact** directory `{projectRoot}/dist` — `nx-release-publish` packs from `packageRoot: {projectRoot}/dist`. Versioning still targets the **source** `package.json` (`release.version.generatorOptions.packageRoot: {projectRoot}`); the source is the version source of truth.

### `dist-manifest` — "version the dist at build"

`nx run <project>:dist-manifest` (executor `@adhd/nx-build:manifest`, `dependsOn:["build"]`, **not cached**) (over)writes `{projectRoot}/dist/package.json` into a resolved, dist-root publishable manifest via [`executors/manifest/generate-manifest.js`](executors/manifest/generate-manifest.js):

- **entry paths rebased** source-relative → dist-root (`./dist/index.js` → `./index.js`; tsc's `./dist/src/index.js` → `./src/index.js`) — dist is the package root.
- **internal `@adhd/*` ranges resolved** to concrete `^<version>` from a live snapshot of every workspace package's version. Because the build reads the *final* version of every sibling, this is correct **regardless of the order packages are versioned in** — the guarantee nx's own `updateDependents` fails to give (it versions non-topologically, leaving a dependency bumped *after* its dependent stale — `BUG-RELEASE-PIPELINE-UNFIT-FOR-FULL-PUBLISH-001` Defect C). Also repairs `workspace:*` (npm never substitutes it) and bare `*` internal ranges.
- **drops** `devDependencies`, `scripts`, `nx`, and the source `files` allowlist; copies `CHANGELOG.md` into dist.

Pure transform tests: `pnpm test:build-tools`.

The publish gate chain is `build → dist-manifest → verify-dist-load → publish-hygiene → nx-release-publish` (wired in `plugin.js` + `nx.json` targetDefaults).
