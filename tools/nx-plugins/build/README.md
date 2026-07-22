# @adhd/nx-build

Build-lifecycle plugin: `manifest`, `verify-dist-load`, `publish-hygiene`, `publish`, `link` executors + `detect-target` util. Targets are inferred onto every buildable project; wiring lives in plugin.js/targetDefaults, never in project.json.

## Publish-from-dist model

Each package publishes from its **built artifact** directory `{projectRoot}/dist` — `nx-release-publish` packs from `packageRoot: {projectRoot}/dist`. Versioning still targets the **source** `package.json` (`release.version.generatorOptions.packageRoot: {projectRoot}`); the source is the version source of truth.

### `dist-manifest` — "version the dist at build"

`nx run <project>:dist-manifest` (executor `@adhd/nx-build:manifest`, `dependsOn:["build"]`, **not cached**) (over)writes `{projectRoot}/dist/package.json` into a resolved, dist-root publishable manifest via [`executors/manifest/generate-manifest.js`](executors/manifest/generate-manifest.js):

- **entry paths rebased** source-relative → dist-root (`./dist/index.js` → `./index.js`; tsc's `./dist/src/index.js` → `./src/index.js`) — dist is the package root.
- **internal `@adhd/*` ranges resolved** to concrete `^<version>` from a live snapshot of every workspace package's version. Because the build reads the *final* version of every sibling, this is correct **regardless of the order packages are versioned in** — the guarantee nx's own `updateDependents` fails to give (it versions non-topologically, leaving a dependency bumped *after* its dependent stale — `BUG-RELEASE-PIPELINE-UNFIT-FOR-FULL-PUBLISH-001` Defect C). Also repairs `workspace:*` (npm never substitutes it) and bare `*` internal ranges.
- **drops** `devDependencies`, `scripts`, `nx`, and the source `files` allowlist; copies `CHANGELOG.md` into dist.

Pure transform tests: `pnpm test:build-tools`.

The publish gate chain is `build → dist-manifest → verify-dist-load → publish-hygiene → nx-release-publish` (wired in `plugin.js` + `nx.json` targetDefaults).
