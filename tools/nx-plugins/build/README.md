# @adhd/nx-build

Build-lifecycle plugin: `manifest`, `version`, `reconcile`, `verify-dist-load`, `publish-hygiene`, `publish`, `link` executors + `detect-target` util. Targets are inferred onto every buildable project; wiring lives in plugin.js/targetDefaults, never in project.json.

## The `published-state.json` cache (PUBLISHED-STATE-CACHE-001)

`<workspaceRoot>/published-state.json` is a **committed, source-controlled**
snapshot of what's actually on npm for every publishable package — the
"published-reference" — keyed by npm package name:

```json
{
  "@adhd/agent-base-types": {
    "version": "2.1.3",
    "normalizedHash": "sha256:3047b58894f912c498cc45ead72e7ee62095c20230950fc2c57fc89988555122",
    "publishedIntegrity": "sha512-nb47j7ArW8qAde3pNJcxt9trjPl3Cgj2oQgCxAH/vmhlcwXDq2m3xp9ldZrCcvKrAKERKtMmOmCcuCK1PrrsAw=="
  }
}
```

- **`version`** — the last version this cache KNOWS is on the registry.
- **`normalizedHash`** — [`compare-published.js`](executors/version/compare-published.js)'s
  `normalizedHash(dir)`: a `sha256` over `stableStringify(normalizeManifest(package.json))`
  concatenated with every other file's path+bytes (in `listFiles()`'s sorted
  order) — the EXACT SAME primitives `comparePublishedToLocal` uses, so a
  cache-hash comparison is provably equivalent to the legacy per-file/
  per-manifest diff (see `compare-published.spec.mjs`'s "normalizedHash
  equivalence" suite — both directions, incl. the range-only and real-content
  cases). This is the PUBLISHED content's hash, computed once at
  backfill/publish time.
- **`publishedIntegrity`** — the packument's own `dist.integrity` (sha512) for
  that version, used by the integrity gate below to skip a tarball pull when
  a fresh local pack already matches what's published.

**Why:** the pre-cache `version` task fetched + extracted a full tarball from
npm for EVERY publishable package, on EVERY run, just to decide bump/no-bump —
real, measured network+CPU cost that scales with the workspace (53 packages ×
`npm view` + `npm pack` + `tar` = the whole cost of "did anything change?").
The cache makes that decision **zero-network on the happy path**: `version`
reads this file and compares a locally-computed `normalizedHash` against the
cached one — no registry call, no tarball, whether or not the package
actually changed. See the root-level task report / CHANGELOG for the measured
before/after numbers.

### `reconcile` — network-light cache backfill (the ONLY tarball puller besides `publish`'s write-through)

`nx run <project>:reconcile` / `nx run-many -t reconcile` (executor
`@adhd/nx-build:reconcile`, `dependsOn: ["build", "assets"]`, **not cached** —
it reads live registry state) rebuilds/refreshes THIS package's cache entry
from npm, using an **integrity gate** ([`executors/reconcile/reconcile-core.js`](executors/reconcile/reconcile-core.js))
to avoid a tarball pull whenever possible:

1. Pack the **local** dist **offline** (`npm pack <local-dir>` never contacts
   the registry) and hash that tarball's bytes.
2. Fetch **only** the packument's `dist.integrity` for `name@version`
   (`npm view name@version dist.integrity` — metadata, ~KB, never the tarball).
3. **Match** → local dist is byte-identical to what's published → cache
   `normalizedHash(localDist)` + the confirmed integrity. **No tarball pull.**
4. **Diverge** (or integrity unavailable) → pull the real published tarball,
   extract it, and cache `normalizedHash` computed from the **extracted
   published content** — so the cached signal stays exact even though local
   and published currently differ.

This is sound because `npm pack` is **content-deterministic** — verified
empirically against this workspace's pinned npm version: identical file
bytes always produce a byte-identical tarball, independent of file mtimes —
so a local-pack integrity match can only happen when the underlying content
is truly identical, never as a timestamp coincidence.

### Cache MISS: single-package backfill, never a silent pass

If `version` finds a package absent from `published-state.json`, it does
**not** silently assume "unchanged" or "pending" — it calls the exact same
`reconcile-core.js` logic **in-process** (no nx sub-invocation) to backfill
**just that one package**, writes the result into the cache, then decides.
This is the *only* network `version` ever performs, and it costs exactly one
package — never a graph-wide re-backfill. Once a package's entry exists, every
future `version` run for it is zero-network, whether or not it changed (the
network was already spent once, at backfill/write-through time).

### Concurrency-safe writes (`lib/published-state.js`)

Both `reconcile` and `publish`'s write-through (below) can run in parallel
across many projects (`nx run-many -t reconcile` / `-t publish`, one process
per project). [`lib/published-state.js`](lib/published-state.js) guards every
read-modify-write with an exclusive, portable filesystem lock (atomic
`O_CREAT|O_EXCL` create as the mutex, with stale-lock recovery so a crashed
holder can never deadlock every future writer) — proven under real parallel
load in `lib/published-state.spec.mjs` (N concurrent writers, zero lost
updates) and `executors/publish/impl.spec.mjs`.

### `publish`'s existence-check + write-through

`publish` answers "is `name@version` already released?" from this cache
FIRST — zero network on a hit. Only a cache miss falls through to a real `npm
publish` attempt (which needs the network anyway — that IS the release
action). On success — or on npm's "cannot publish over previously published
version" (treated as already-published/success, the read-lag case where the
cache was stale but the registry had already caught up) — `publish` writes
this package's entry from the dist it **just packed locally** (offline,
`packLocalDir` + `tarballIntegrity`), never a re-fetch: authoritative and
immune to npm's own read-after-write propagation lag. See
[`executors/publish/impl.js`](executors/publish/impl.js).

### `published-state.json` is committed

Like a lockfile, this file is source-controlled — it's the durable,
diffable record of "what did we last confirm is published, and what did that
content hash to". A release that runs `reconcile`/`publish` and commits the
resulting `published-state.json` diff keeps the cache authoritative for the
next contributor/CI run without anyone paying the backfill cost again.

## `version` — topological dependent-range sync (BUILD-TOOLING-VERSION-SYNC-DEPS-001)

`nx run <project>:version` (executor `@adhd/nx-build:version`, `dependsOn: ["build", "assets", "^version"]`, **not cached**):

1. **Decides its own bump** — see [`executors/version/impl.js`](executors/version/impl.js) header: now cache-driven (`published-state.json` above) instead of a live tarball fetch, but the DECISION is provably identical (see `compare-published.spec.mjs`'s normalizedHash-equivalence suite). Registry-driven, no git tags.
2. **`^version` (new):** runs a package's internal `@adhd/*` dependencies' `version` tasks FIRST (Nx topological ordering), so by the time a package's own `version` runs, every dependency it declares has already settled its version for this run.
3. **Reconciles its own declared internal ranges (new, every run, regardless of step 1's outcome):** after the bump decision, `version` reconciles THIS package's declared internal `@adhd/*` dependency ranges to the workspace's now-settled versions — by calling `reconcileInternalRangesFromDisk` (see `impl.js`), which reads every declared internal `@adhd/*` dependency's ON-DISK `package.json` directly, bypassing Nx's own (possibly-stale-mid-run) project graph. It writes **only this project's own** `package.json`, never a sibling's. (DEBT-BUILD-VERSION-SYNCDEPS-REDUNDANT-001: this step used to ALSO invoke `tools/nx-plugins/deps/executors/sync/impl.js` (fix) / `.../check/impl.js` (read-only, dryRun) — the full `@nx/dependency-checks` ESLint rule — a second, uncached time per project per `version` run. That was provably redundant: `version`'s own `dependsOn: ["build", "assets", "^version"]` guarantees `build` -> `lint` -> `sync-deps` already ran that exact check for this project earlier in the same task-graph invocation. Removed; `reconcileInternalRangesFromDisk` alone now covers the one thing that can genuinely drift mid-run — internal `@adhd/*` ranges.)

**Why this doesn't cascade a bump through the graph:** `compare-published.js`'s `normalizeManifest` (used by step 1's diff) already strips `version` and every internal `@adhd/*` dependency range from BOTH sides before comparing (see `compare-published.spec.mjs`, `"only an internal @adhd/* dep RANGE differs -> NOT changed"`). So step 3's range-only edit is invisible to the *next* run's change-detector: a package's own version bumps only when ITS code/external deps/metadata actually changed, never merely because a dependency's version moved (a caret range already absorbs that at install time, and `dist-manifest` resolves published ranges from a live snapshot independent of source-side sync order — see the publish-from-dist section below). This also means `^version` never needs a *cascade* re-bump of dependents: it keeps SOURCE ranges consistent, nothing more.

**What this replaces:** previously, after a batch of version bumps, dependents' declared internal ranges could drift out of sync with the actual bumped versions until someone ran `sync-deps` manually. `^version`'s topological ordering plus this reconciliation step makes that self-healing as part of `version` itself.

Tests: `tools/nx-plugins/build/executors/version/impl.spec.mjs` (the orchestration/composition — cache hit/miss, backfill, reuse, dry-run routing, bump/sync independence, failure propagation), `compare-published.spec.mjs` (the pure change-detector + `normalizedHash` equivalence proof), `executors/reconcile/reconcile-core.spec.mjs` (the integrity-gated backfill core), `executors/publish/impl.spec.mjs` (existence-check + write-through + concurrency), and `lib/published-state.spec.mjs` (the cache's concurrency-safe I/O). Run: `pnpm test:build-tools`.

> ⚠️ **`--dryRun` alone does not cover `^version`'s dependency tasks** — see the schema
> description on `dryRun` in [`executors/version/schema.json`](executors/version/schema.json)
> and `PUBLISHING.md`'s "Scoped/single-project `--dryRun`…" callout. Set
> `ADHD_NX_VERSION_DRY_RUN=1` too whenever you're not running the full, unscoped
> `nx run-many -t version --dryRun`. `impl.spec.mjs` has a dedicated regression test for
> this (`ADHD_NX_VERSION_DRY_RUN=1 env var forces dry-run…`).

## Publish-from-dist model

Each package publishes from its **built artifact** directory `{projectRoot}/dist` — `@adhd/nx-build:publish` (`executors/publish/impl.js`) runs `npm publish {projectRoot}/dist` directly. npm treats that directory itself as the package root: anything outside it — including a source-root README.md — is invisible to that publish. There is no "ships from the source root" path for this executor; **`{projectRoot}/dist` must be doc-complete before `publish` runs.** Versioning still targets the **source** `package.json` — the source is the version source of truth; only the built artifact is what actually gets packed and published.

### `dist-manifest` — "version the dist at build"

`nx run <project>:dist-manifest` (executor `@adhd/nx-build:manifest`, `dependsOn:["build","assets"]`, **not cached**) (over)writes `{projectRoot}/dist/package.json` into a resolved, dist-root publishable manifest via [`executors/manifest/generate-manifest.js`](executors/manifest/generate-manifest.js):

- **entry paths rebased** source-relative → dist-root (`./dist/index.js` → `./index.js`; tsc's `./dist/src/index.js` → `./src/index.js`) — dist is the package root.
- **internal `@adhd/*` ranges resolved** to concrete `^<version>` from a live snapshot of every workspace package's version. Because the build reads the *final* version of every sibling, this is correct **regardless of the order packages are versioned in** — the guarantee nx's own `updateDependents` fails to give (it versions non-topologically, leaving a dependency bumped *after* its dependent stale — `BUG-RELEASE-PIPELINE-UNFIT-FOR-FULL-PUBLISH-001` Defect C). Also repairs `workspace:*` (npm never substitutes it) and bare `*` internal ranges.
- **drops** `devDependencies`, `scripts`, `nx`, and the source `files` allowlist. Does **not** touch README.md/CHANGELOG.md — that's `assets`' job (below), which `dist-manifest` depends on.

### `assets` — "make dist doc-complete" (`@adhd/nx-assets`, `tools/nx-plugins/assets/`)

`nx run <project>:assets` (executor `@adhd/nx-assets:copy`, `dependsOn:["build"]`, cached) copies `README.md` + `CHANGELOG.md` (if present) + any files declared in the package's own `package.json` `"assets"` array into `{projectRoot}/dist`, flattening every destination to its basename (so a nested source path like `src/schema.json` still lands at `dist/schema.json`, matching where a runtime consumer looks for it beside `index.js`). See [`tools/nx-plugins/assets/README.md`](../assets/README.md).

**Everything downstream that needs a doc-complete dist depends on it:** `version`/`reconcile` (their bump/backfill decisions hash `dist/` against the published content — without `assets`, a bare `build` alone is missing README/CHANGELOG that the already-published tarball has, producing a false "changed" on every package) and `dist-manifest` (whose consumers, `publish-hygiene` and `publish`, inherit the dependency transitively). If you add a new target that reads or packs `{projectRoot}/dist`, it needs `assets` in its `dependsOn` too — this is not automatic just because `build` ran.

Pure transform tests: `pnpm test:build-tools`.

## Target chain summary

`build → assets → { version (^version topological) | reconcile | dist-manifest → verify-dist-load → publish-hygiene → publish }` (wired in `plugin.js`). `version` and `reconcile` both read/populate the same `published-state.json` cache; `publish`'s existence-check reads it too, and its write-through keeps it current after every real publish. `reconcile` and `publish`'s write-through are the ONLY tasks that ever pull a tarball from npm — and `reconcile` only for a package whose local dist has actually diverged (integrity gate). `nx-release-publish` is Nx's own native task name, used only by the retired `nx release publish` command — this repo's real pipeline never invokes it (see `PUBLISHING.md`).
