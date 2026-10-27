# Publishing Playbook

How to version, build, and publish packages in this monorepo to npm.

> Pipeline definition (build graph, CI/CD stages, caching, secrets, budgets, provenance): [docs/PIPELINE.md](./docs/PIPELINE.md).

**This workflow does NOT use `nx release`** (see "Workflow" below — it's retired for this repo). Versioning and publishing are normal per-project **nx tasks** backed by custom executors (`@adhd/nx-build:version` / `@adhd/nx-build:publish`), driven by one command: `pnpm release`. The **npm registry is the source of truth** for what's released — no git tags, no `nx release` commit/tag side effects.

### Build & publish layout: in-source dist, **publish-from-dist**

Each buildable package builds **in-source** to `{projectRoot}/dist/`, and its _source_
`package.json` `main`/`module`/`types`/`exports`/`bin` point into `./dist/…` (so pnpm resolves
`@adhd/*` natively in-repo via each package's source manifest — no separate "link" step).

**Publishing packs the built `dist/` directory itself, not the source root.** `@adhd/nx-build:publish`
(`executors/publish/impl.js`) runs `npm publish {projectRoot}/dist` — npm treats that directory AS
the package root. Anything outside it (a source-root README.md, for instance) is completely
invisible to that publish; there is no path by which docs "ship from the source root" for this
executor. Concretely, `{projectRoot}/dist` needs, before `publish` ever runs:

- **A resolved dist-root manifest** — the `dist-manifest` target (executor `@adhd/nx-build:manifest`)
  (over)writes `{projectRoot}/dist/package.json`: entry paths rebased (`./dist/index.js` →
  `./index.js`), internal `@adhd/*` ranges resolved to concrete `^<version>` from a live workspace
  snapshot, `devDependencies`/`scripts`/`files` stripped. It does **not** touch README/CHANGELOG.
- **README.md + CHANGELOG.md (+ any package.json-declared extra files) physically copied into dist**
  — that's the `assets` target (executor `@adhd/nx-assets:copy`, `tools/nx-plugins/assets/`), which
  every doc-dependent downstream target (`version`, `dist-manifest` — and transitively
  `publish-hygiene`/`publish` through it) depends on.

See [`tools/nx-plugins/build/README.md`](tools/nx-plugins/build/README.md) and
[`tools/nx-plugins/assets/README.md`](tools/nx-plugins/assets/README.md) for the full target
breakdown.

### The `published-state.json` cache — zero-network change detection (PUBLISHED-STATE-CACHE-001)

A committed, source-controlled file at the workspace root,
`published-state.json` records `{ version, normalizedHash, publishedIntegrity }`
per package — a snapshot of what's actually on npm. `version` reads it to
decide bump/no-bump with **zero network calls** on the happy path (a hash
compare against the cache, not a live `npm view`/`npm pack`/tarball fetch);
`publish`'s existence-check reads it too before ever calling `npm publish`.
The **only** tasks that ever touch the registry for a tarball are `nx run-many
-t reconcile` (backfills/refreshes the cache, integrity-gated so it skips the
tarball pull whenever a local pack's content already matches what's
published) and `publish`'s own write-through (updates the cache from the dist
it just packed, after a real publish). A package missing from the cache
triggers a single-package, in-process backfill inside `version` itself — cost
is paid once per package, never on every subsequent run. See
[`tools/nx-plugins/build/README.md`](tools/nx-plugins/build/README.md)'s
"published-state.json cache" section for the full design, the equivalence
proof, and the concurrency-safe write-through mechanism.

`published-state.json` should be committed alongside version bumps (like a
lockfile) so the next contributor/CI run doesn't re-pay the backfill cost.

Consequences for releasing:

- **`version` bumps the REAL source `package.json`, never the dist copy.** The build step then
  re-stamps every dist manifest from the _final_ set of source versions (`dist-manifest`), so
  internal dependency ranges are correct **independent of versioning order** — this is what fixes
  the stale/unsatisfiable-range failure `nx release` itself couldn't (`BUG-RELEASE-PIPELINE-UNFIT-FOR-FULL-PUBLISH-001`,
  Defect C — the reason `nx release` was retired for this repo in the first place).
- **One command:** `pnpm release` (= `node tools/nx-plugins/build/executors/smoke-test/run-release.mjs`): the pending set from `pnpm release:pending`, a test gate, a build, `version` in dependency waves, `check-release-ranges`, `publish` in dependency waves, `sync-global`, then the clean-room smoke.
  Building first (proper dependency order) also sidesteps the composite-tsc cold-build parallelism
  race (`DEBT-BUILD-COMPOSITE-TSC-PARALLEL-001`).
- **Already-published, unchanged packages are skipped**, not republished — npm refuses to publish
  over an existing version. Only packages whose built `dist/` actually differs from what's on npm
  at their current version get bumped (see "Versioning model" below) and then publish.
- **Change detection is zero-network on the happy path** — `version` compares a locally-computed
  hash against the committed `published-state.json` cache instead of fetching a tarball from npm
  every run. See "The `published-state.json` cache" below.

---

## Approval & Authorization

**Pushing, merging to `main`, and publishing are pre-authorized for all agents** — no approval is needed; the Gates in `AGENTS.md` still apply and must be green first, unless otherwise explicitly directed by your prompt.

---

## Prerequisites

- `npm login` — confirm with `npm whoami`
- npm account must have 2FA enabled; use an **automation token** for CI (bypasses OTP), or have your authenticator app ready for local publishes

---

## Workflow — `publish` is a task; the registry is the source of truth

**`nx release` is retired for this repo.** It fought the monorepo at every layer (git-config XOR, `pnpm install --lockfile-only` 404 on unpublished internal deps, non-topological versioning that shipped stale interdependency ranges, `@nx/dependency-checks` failing the build on those same stale ranges — `BUG-RELEASE-PIPELINE-UNFIT-FOR-FULL-PUBLISH-001`). Versioning and publishing are now normal per-project **nx tasks** (`@adhd/nx-build:version` and `@adhd/nx-build:publish`); the **npm registry is the source of truth** for what's released (no git tags).

```bash
pnpm release:pending             # the projects that need a release, from git + the filesystem (no nx, no build, ~1–2 s)
pnpm release:dry                 # the same flow as `pnpm release` with version/publish in dry-run mode (writes/publishes nothing)
pnpm release                     # build + version changed packages + publish everything not on npm
npx nx run-many -t version --bump=minor    # bump changed packages minor instead of patch
npx nx run-many -t publish --otp=123456    # supply an npm one-time password (2FA)
npx nx run-many -t publish --projects=agent-mcp,apigen-cli   # a subset
npx nx run apigen-cli:publish              # a single package

npx nx run-many -t reconcile               # (re)build published-state.json from npm (integrity-gated; network-light)
npx nx run apigen-cli:reconcile            # backfill/refresh just one package's cache entry
```

> ⚠️ **Scoped/single-project `--dryRun` does NOT reach the runtime-dependency `version` tasks —
> use `ADHD_NX_VERSION_DRY_RUN=1` too.** `nx run-many -t version --projects=A,B --dryRun`
> (or even a single `nx run A:version --dryRun`) only applies the `--dryRun` CLI override
> to the projects you named — **not** to A/B's internal `@adhd/*` dependencies that
> the runtime-dependency `version` ordering pulls into the same run. Those dependency tasks get
> the schema _default_ (`dryRun: false`) and will really bump + write, despite the
> invocation looking read-only. (Confirmed live 2026-07-22 while verifying this feature:
> a 2-project `--dryRun` proof-of-topology run actually wrote real version bumps —
> including a real internal-range sync — to 10 unrelated dependency packages; caught and
> reverted immediately via `git restore`, no lasting effect, but a real near-miss. See
> `BUG-NX-RUNMANY-DRYRUN-NOT-PROPAGATED-TO-DEPENDENCY-TASKS-001` in `BACKLOG.md`.)
> **Always also set `ADHD_NX_VERSION_DRY_RUN=1`** when dry-running anything less than the
> full, unscoped `nx run-many -t version --dryRun` (which IS safe — every project is
> already explicitly targeted, nothing is dependency-pulled) — it's honored uniformly by
> every task in the invocation (nx's task workers inherit the parent process's env),
> unlike the CLI flag. `pnpm release:dry` already does this for you.

`pnpm release` runs two per-project tasks, `version` then `publish`, each in dependency waves over the pending set. Both are per-project and **not cached**:

- **`version`** (`dependsOn: [build, assets]`, inferred by `tools/nx-plugins/build/plugin.js`'s `createNodes`) bumps a package's SOURCE `version` **iff** it needs a new release: if the current version isn't on npm → a release is already _pending_ → leave it; if it IS on npm → compare the built `dist` against the **published tarball** (ignoring the version field and internal `@adhd/*` ranges) → **changed → bump** (patch by default, `--bump=minor|major` to override), **identical → leave**. The `build` + `assets` dependencies ensure `dist/` is fresh AND doc-complete before comparison (a bare `build` alone doesn't include README/CHANGELOG — comparing it against an already-published tarball that has them would falsely register as "changed" every time); `pnpm release` runs `version` in dependency waves (`release-waves.js`), so every internal dependency settles before its dependents. It writes the bump but does **not** commit (review `git diff`).
  - **Runtime-dependency `version` ordering — topological dependent-range sync (BUILD-TOOLING-VERSION-SYNC-DEPS-001):** the release script (`run-release.mjs`) runs `version` in dependency waves over the pending set, ordered by each package's `dependencies`/`peerDependencies`/`optionalDependencies` (never `devDependencies`, which consumers do not install), so a package's internal `@adhd/*` runtime dependencies' `version` tasks run FIRST, so by the time a package's own `version` task runs, every dependency it declares has already settled its version. After deciding its own bump (or not), `version`'s final step (`reconcileInternalRangesFromDisk`) reconciles the package's declared internal `@adhd/*` ranges in `dependencies`/`peerDependencies`/`optionalDependencies` to that now-settled state by reading each dependency's `package.json` off disk (`@adhd/*` names are mapped to Nx projects through each project's `package.json#name`, so `@adhd/environment` resolves to `environment-core-node`). It writes **only that package's own** `package.json`. **`devDependencies` ranges are not rewritten by `version`:** no `version` task is ordered before this one for a dev edge, so the on-disk version it would read may not be settled, consumers never install dev dependencies (the published manifest strips them), and no gate checks them (lint's dependency-checks does not flag a stale dev range). To refresh dev-edge ranges run `npx nx run <project>:sync-deps` (or `npx nx affected -t sync-deps`) after a version phase; skipping it is safe. This never forces a cascade bump: `compare-published.js`'s `normalizeManifest` already strips internal `@adhd/*` ranges before diffing, so a range-only edit is invisible to the next run's change-detector — a caret range absorbs a dependency's bump at install time, and `dist-manifest` (above) already resolves published ranges independent of source-side sync order. This eliminates the manual `sync-deps` pass previously needed after a batch of bumps to keep dependents' declared ranges from drifting.
- **`publish`** (`dependsOn: [test, version, dist-manifest, verify-dist-load, publish-hygiene, release-reset-check]`: this project's own tasks only) runs this project's own tests, refuses to publish while an internal `@adhd/*` range is ahead of what `published-state.json` records as published (`internal-deps-published.js`; dependency order is enforced by the release waves plus this guard), rebuilds anything `version` bumped (a version change invalidates its build cache), re-stamps its `dist/package.json` (internal `@adhd/*` ranges resolved to concrete versions from a live snapshot), and `npm publish`es the `dist` **iff** `name@version` isn't already on the registry. Already-published = no-op skip (no "cannot publish over", no republish).


**Ordering across projects is not in the task graph.** `plugin.js` gives `version` and `publish` no edge to any dependency's tasks (an edge pulls every unchanged dependency's `test`/`version`/`publish`/dist tasks into each release: `backlog:publish` was 210 tasks, now 50). Two things hold the guarantee instead:

1. `run-release.mjs` runs `version` and then `publish` in topological waves over the pending set only; all version waves settle before `check-release-ranges`, and a failed publish wave stops the later waves.
2. The `publish` executor refuses any package whose internal `@adhd/*` ranges are ahead of what `published-state.json` records as published (`lib/internal-deps-published.js`, `BUG-RELEASE-ATOMICITY-DEP-RANGE-AHEAD-OF-TARGET-PUBLISH-001`), so a caller that bypasses the waves gets a refusal, not an uninstallable package. A dry run publishes nothing and skips this check.

Never run a bare `nx run-many -t version|publish` for a release: it has no dependency order and writes no release manifest.

**Measured cost (2026-10-27, warm Nx cache, machine load average 30–60, dry run):**

| Case | Old task edges | New flow |
| --- | --- | --- |
| `backlog:publish` graph | 210 tasks, 204 run, 17.8 s wall, 56.6 s CPU, exit non-zero (dependency publishes refused in dry run) | 50 tasks, 5.0 s wall, 10.3 s CPU, exit 0 |
| every publishable project pending (69 of 69) | 762 tasks in one `nx` invocation: 129 s wall, 331 s CPU | 7 version waves + 7 publish waves + test gate + build (about 17 `nx` invocations): 231 s wall, 828 s CPU |

The new flow wins when a few projects are pending and loses when everything is, because each wave pays Nx startup and
input hashing again. A cold cache (`nx reset`) made the old graph take 518 s wall and 2,354 s CPU, so cold and warm numbers must
not be compared with each other.

Exit code is the gate: `0` = everything versioned/published or skipped; non-zero = a task failed (nx names the project).

**Versioning model:** automatic, registry-driven. A package bumps only when its own built artifact differs from what's published (external-dep/metadata/code changes count; a dependency's version moving does **not** — caret ranges absorb that at install time). Brand-new packages publish at their current version. To force a level, `--bump=minor|major`; to version one package, `nx run <project>:version`.

> **OTP + parallelism:** `nx run-many` publishes in parallel. If your npm 2FA rejects a reused OTP across parallel publishes, serialize with `--parallel=1` (or use an npm **automation token**, which needs no OTP).

> **Related, but not a publish step — `lint` is now self-healing for dependency-range drift**
> (BUILD-TOOLING-VERSION-SYNC-DEPS-001). Every project's `lint` target `dependsOn: ["sync-deps"]`
> (`nx.json` `targetDefaults`), so a stale/undeclared internal `@adhd/*` dependency range gets
> fixed on disk automatically before `@nx/dependency-checks` ever runs — `lint` no longer hard-fails
> on that specific, fixable class of drift; it self-heals instead. **This is a deliberate gate-
> semantics change**, accepted knowingly: the dependency-check portion of `lint` moves from "hard
> gate" to "self-healing." See [`tools/nx-plugins/deps/README.md`](tools/nx-plugins/deps/README.md)
> and [`tools/nx-plugins/build/README.md`](tools/nx-plugins/build/README.md) for the full write-up,
> the `node_modules`-absent no-op guard, and how `.githooks/pre-commit` handles the resulting
> working-tree mutation (it never auto-stages — see that file's header).

**After publishing:** the `version` task (and `reconcile`/`publish`'s cache write-through) left any bumps + `published-state.json` updates uncommitted (`DEBT-BUILD-VERSION-NO-AUTOCOMMIT-001`, addressed by an OPT-IN step, never automatic) —

```bash
pnpm release:commit:dry   # preview exactly what would be staged + the commit message; commits nothing
pnpm release:commit       # stage + commit ONLY the bumped package.json + CHANGELOG.md + published-state.json
```

`release-commit` (`tools/nx-plugins/build/executors/publish/release-commit.mjs`) stages explicit pathspecs only — never `git add -A`/`.` — so unrelated concurrent work in the tree is never swept in. Then `git push`. No tag push is needed; the registry itself records what's released. (Leaving them uncommitted is still coherent — next release sees source == npm/cache and re-detects from the artifact — but committing keeps git, npm, and the cache aligned for the next contributor/CI run.)

**Step 3.5 — global-CLI sync (runs inside `pnpm release`; NOT advisory).** After publish (and before GATE 2), `sync-global.mjs` reconciles every global install of this workspace's bin-shipping entrypoints. It enumerates every global root (`discoverGlobalRoots`): the **pnpm** global bin dir (`pnpm config get global-bin-dir` → `~/Library/pnpm`), the **npm** global prefix (`npm prefix -g`), and **every NVM node version** (`{NVM_DIR||~/.nvm}/versions/node/*/{bin,lib/node_modules}`) — so a stale/broken CLI installed by nvm's npm is no longer invisible (DEBT `ab4d0864`).

For each `(package, root)` pair it:

1. **Detects** stale source-link shims — content that execs local workspace source (the `pnpm link -g` shape) — under ANY name the package is known by: its declared `bin` names, the names recorded in the root's installed manifest, or a **legacy** name whose content references this package (the production `backlog` shim for a package that now declares `adhd-backlog`; BUG `f1dece41`). Detection is by the **entrypoint path in the shim content** (`.../entrypoint/<dir>/dist/...`), so a shim execing a **sibling worktree** or the main checkout — not just the checkout the release runs from — is also caught (review HIGH-1); the old `content.includes(workspaceRoot)` test missed exactly that.
2. **Asserts currency from the INSTALLED tree only** — `current` requires the root's `<modulesDir>/<pkg.name>/package.json` to be readable, its path NOT to resolve into a source worktree, AND its version to equal the source version. A `<modulesDir>/<pkg.name>` symlink into a worktree is a dev link, not an install, and is repaired rather than reported `current` (review MEDIUM-3). A shim that EXISTS but is unreadable, or a shim present with a missing/unreadable manifest, is `unverifiable` — never a false `current` (BUG `bea4bfe1`; review LOW-7). Every summary row prints `installed=` and `target=` in **separate** columns so the two can never be conflated in one, and a `not-installed` row carries no `installed=` value at all (review LOW-8).
3. Gates on the exact version being on the registry, then on the BUG-004 content hash, **backs up** each stale shim to `<shim>.pre-sync-<ts>`, runs the **root's manager install** (`pnpm add -g <name>@<ver>` for pnpm roots; `npm i -g <name>@<ver>` with the root's `npm_config_prefix`/PATH for npm & NVM roots), and **re-verifies** the package's **declared** bin names (shim no longer references a workspace source tree, the store is not a source link, AND the root's store version matches). **Which bins are verified vs left pending:** only the package's DECLARED bin names are ever rewritten and verified — the manager install cannot touch any other name. A **legacy**-named stale shim is therefore left pending and reported as its own unresolved state (next paragraph). On any failure of a declared-bin verification every backup is restored.

**Per-manager repair.** If the release reports a package stale/unresolved, repair the root it names, not a hand-picked one:

```bash
pnpm add -g <name>@<version>    # pnpm root  (summary label pnpm:…)
npm  i  -g <name>@<version>    # npm prefix / NVM root (labels npm:… / nvm:…)
```

For an NVM root, activate that node first (or run `<nvm-node>/bin/npm i -g …`) so `npm_config_prefix` targets that version's store rather than the caller's.

**Legacy bin-name quarantine (WARN + FAIL).** A **legacy** shim — e.g. the bare `backlog`, left over from before the package declared `adhd-backlog` — **cannot be repaired by a manager install**: `pnpm add -g` / `npm i -g` only ever write the package's CURRENT declared name (`adhd-backlog`), so the old shim survives and keeps shadowing. `sync-global` prints a `WARNING` naming the legacy shim(s) **and reports that row as `legacy-pending` with `verified:false` — which fails Step 3.5** (review HIGH-2). It never claims them fixed; they must be **quarantined (renamed)** after human approval — e.g. `mv ~/Library/pnpm/backlog ~/Library/pnpm/backlog.quarantined-<date>` — and any consumer that invokes the old name (`~/.claude.json`, `.mcp.json`) re-pointed at the canonical one. (A **dry-run** also reports `legacy-pending` so the preview cannot read as success, but a dry-run never fails the exit code — it changes nothing.)

**Exit code.** Unlike the old advisory step, Step 3.5 now fails the release (`computeExitCode`, folded into `run-release`'s compound verdict): a package ending `refused`, `unverifiable`, `legacy-pending`, or `synced` with `verified:false` is a non-zero exit (BUG-027 / review HIGH-2) — a release must never report success while the operator's global CLI is stale. Retry manually with `pnpm release:sync-global` (preview: `pnpm release:sync-global:dry`).

---

## Big-release pre-flight — run the resource lanes explicitly

A package's `e2e` lane — real subprocess spawns, bound-port HTTP/MCP servers, the real fastembed embedding model, CPU/memory hogs — is a **separate target/config** (e.g. `entrypoint/backlog`'s `src/**/*.e2e.ts`, collected by its `e2e` target and its `vitest.e2e.config.ts`). Whether it runs automatically is **per-package**, decided at the **gate level**. As of **2026-10-07 (owner decision),** `publish` does not depend on `e2e`, and packages' `test.dependsOn` must NOT include `e2e` — the resource-heavy lane is reached only through the **CI gate** (`tools/gate/lane-gate.mjs`). Run it explicitly before a release:

```bash
npx nx run-many -t e2e            # every package that declares an e2e target
npx nx run backlog:e2e            # one package — the per-project form
```

`e2e` is absent from `nx.json` `targetDefaults` (verified) — reachability is wired per-project, so do **not** add a global `targetDefaults.e2e`: it is keyed by target name only and cannot be scoped to one project.

## Installability gates (BUG-RELEASE-UNINSTALLABLE-AGENTMCP-001)

Neither gate below existed before; every prior gate (`dist-manifest`, `verify-dist-load`, `@nx/dependency-checks`/`sync-deps`, `publish-hygiene`) validates against the **local on-disk workspace**, never the real registry — so a range like `agent-store-tools: "^2.1.7"` can ship even when the registry's max published version is `2.1.6`. Full write-up + reconciliation matrix: [`tools/nx-plugins/build/lib/range-resolvability.js`](tools/nx-plugins/build/lib/range-resolvability.js).

**GATE 1 — pre-publish range-resolvability (offline, fast, blocks publish):**

```bash
pnpm run check:release-ranges
```

Asserts every intra-`@adhd/*` dependency range in the about-to-publish set resolves against `{registry-published versions}` ∪ `{versions this release will publish}`. One registry fetch per unique dependency name (parallel, not per-edge). Wired into `pnpm release`/`release:dry` — runs before `nx run-many -t publish`; non-zero exit stops the chain before anything is published. Core: `tools/nx-plugins/build/lib/range-resolvability.js`; tests: `range-resolvability.spec.mjs`.

**GATE 2 — post-publish clean-room smoke (end-to-end):**

```bash
pnpm run check:clean-room-smoke
```

For each publishable `bin`-shipping entrypoint (`agent-mcp`, `apigen-cli`, `backlog`, `decompile-cli`), `npm install <name>@latest` from the real registry into an ephemeral dir, then a bin smoke — in parallel, cleaned up after. Runs as the last step of `pnpm release`. Script: `tools/nx-plugins/build/executors/smoke-test/clean-room-smoke.mjs`; tests: `clean-room-smoke.spec.mjs`.

<details>
<summary>Retired: the former <code>nx release</code> workflow (kept for reference only — do not use)</summary>

### 1. Version (compute what changed, bump versions, generate changelogs)

```bash
# CHANGED-ONLY (the normal path): NO explicit specifier. Conventional commits
# decide each package's bump; packages with no commits since their tag are SKIPPED.
npx nx release version --dry-run   # preview — only changed packages bump
npx nx release version             # execute (no --dry-run)
```

> ⚠️ **`nx release patch|minor|major` does NOT mean "changed-only".** An **explicit**
> specifier (`patch`/`minor`/`major`) **force-bumps EVERY project in the release group**,
> bypassing change-detection entirely (verified by dry-run 2026-07-20). Use it only when
> you deliberately want to bump everything to the same level. For "only what changed since
> last publish", run the **bare** `npx nx release version` (or the top-level `npx nx release`)
> and let `specifierSource: conventional-commits` pick each package's bump. If you want to
> force a level on _only the changed_ packages, combine with `--projects` (see Selective).

**What happens (bare `nx release version`):**

- Scans git history from each project's **last git tag** forward. The tag pattern is
  **`{projectName}@{version}` — the UNSCOPED nx project name**, e.g. `agent-mcp@2.1.1`,
  `apigen-cli@0.1.0` (NOT `@adhd/agent-mcp@…`; the `@adhd/` scope is the npm name, not the tag).
- Projects with zero commits since last tag are **skipped** (`🚫 No changes were detected … Skipping`).
- Projects with commits use **conventional commit analysis** to determine bump: `fix()` → patch, `feat()` → minor, `BREAKING CHANGE` → major.
- Bumps `package.json` version in each affected project; generates per-project + workspace `CHANGELOG.md`.
- Tags each bumped project `{projectName}@{newVersion}` and updates internal cross-project dependencies (`updateDependents: "auto"`).

> **Baseline requirement (one-time):** change-detection needs a `{projectName}@{version}`
> tag per project as its diff baseline. With **no tags**, `currentVersionResolver:git-tag`
> falls back to disk and resolves bumps from the _entire_ history → the first release touches
> everything. Baseline tags for all 52 release-group projects were established locally at their
> current disk versions on 2026-07-20 (see `DEBT-RELEASE-BASELINE-TAGS-001`); **they are LOCAL
> until pushed** (`git push --tags`) — CI won't see changed-only until then.
> Bootstrapping a fresh clone instead: `npx nx release --first-release`.

### 2. Publish (build, test, verify-dist-load, push to npm)

> ⚠️ **Never call `npx nx release publish` directly when you're passing `--projects=`.** > `nx release publish --projects=<explicit list>` is a **confirmed upstream Nx bug**
> ([nrwl/nx#22720](https://github.com/nrwl/nx/issues/22720),
> [nrwl/nx#27749](https://github.com/nrwl/nx/issues/27749),
> [nrwl/nx#30552](https://github.com/nrwl/nx/issues/30552)) — it silently skips every
> project's `nx-release-publish.dependsOn` (`build`, `test`, `verify-dist-load`) and
> goes straight to `npm publish`. Reproduced directly in this repo 2026-07-20: with
> `apigen-plugin-mcp`/`apigen-plugin-openapi`'s dist bundles broken,
> `nx release publish --projects=apigen-plugin-mcp,apigen-plugin-openapi --dry-run`
> printed "Would publish" for both — zero build/test/verify-dist-load tasks ran. See
> `BACKLOG.md`/`CHANGELOG.md` `BUG-RELEASE-PUBLISH-GATE-BYPASS-001`. (Unfiltered
> `nx release publish`, with no `--projects`, does not have this problem — but use
> the wrapper below anyway so "which invocation is safe" lives in one place, not in
> every engineer's memory.)
>
> **Always publish through `tools/nx-plugins/build/executors/publish/release-publish.mjs`** — it routes a `--projects=`
> call through `nx run-many -t nx-release-publish` (which DOES honor `dependsOn`,
> proven both empirically and by the upstream issues above) and an unfiltered call
> through plain `nx release publish` (proven safe). Every other flag passes through
> unchanged, and the exit code is the real gate result — non-zero means nothing
> published.

```bash
node tools/nx-plugins/build/executors/publish/release-publish.mjs --dry-run   # preview (full release set)
node tools/nx-plugins/build/executors/publish/release-publish.mjs             # execute (no --dry-run)

node tools/nx-plugins/build/executors/publish/release-publish.mjs --dry-run --projects=agent-mcp,apigen-cli   # selective preview
node tools/nx-plugins/build/executors/publish/release-publish.mjs --projects=agent-mcp,apigen-cli            # selective execute
```

**What happens:** For each versioned project:

- Runs `build` target (clean rebuild from source)
- Runs `test` target
- Runs `verify-dist-load` gate (custom build artifact validation)
- Publishes to npm with metadata from CHANGELOG.md
- Git push of tags (if commit flag is enabled; currently set to `false` — manual push required)

If any of `build`/`test`/`verify-dist-load` fails for any selected project,
`tools/nx-plugins/build/executors/publish/release-publish.mjs` exits non-zero and **nothing is published** — that
includes the projects that passed; nx's task graph fails the whole run rather than
partially publishing.

#### Selective publishing

To version/publish only changed packages in a specific domain:

```bash
npx nx release patch --projects='agent-*' --dry-run
npx nx release patch --projects='agent-*'
node tools/nx-plugins/build/executors/publish/release-publish.mjs --projects='agent-*' --dry-run
```

### 3. Single-package workflow (for leaf packages with no dependents)

To release one package without cascading:

```bash
npx nx release patch --projects=<exact-project-name> --dry-run
npx nx release patch --projects=<exact-project-name>
node tools/nx-plugins/build/executors/publish/release-publish.mjs --dry-run
```

For packages that depend on the one you just released, they are **not** automatically versioned.
Use `updateDependents: "auto"` (already configured) to cascade when needed — re-run version for
the base package to bump all consumers.

### 4. Manual versioning fallback (only if `nx release` is unavailable)

Do **not** use this unless absolutely necessary. It bypasses the build/test gates:

```bash
npx nx build <name> && npx nx test <name>
# Packages publish FROM their source root (packageRoot: {projectRoot}), gated by
# files:["dist","CHANGELOG.md"] + npm's always-included README — so publish the
# project dir itself, NOT a repo-root dist path:
npm publish <projectRoot> --access public   # e.g. packages/agent/agent-base-types
# If prompted for OTP: add --otp=<code>
```

</details>

---

## How "only what changed" is determined (CURRENT — `pnpm release`)

Scope is decided in **two stages**, and understanding the split is the difference
between a release that works and one that exits 0 having published nothing.

### Stage 1 — candidate scope (`pnpm release:pending`: cheap, no build, no nx)

`tools/nx-plugins/build/lib/release-pending.js` reads the publishable projects from the filesystem and, for
each, compares the working tree against the commit **that package** was last published from
(`publishedFromRef` in `published-state.json`; one `git diff` per distinct ref, ~1–2 s total, independent of
the nx cache or daemon). A project is pending when any of these holds:

| Reason | Meaning |
| --- | --- |
| `never-published` | no `published-state.json` entry |
| `version-drift` | on-disk version differs from the recorded published version |
| `source-changed` | a shipped file under the project changed since its ref: source, `package.json` (other than `version` and `@adhd/*` range values; adding or removing an internal dependency counts), `project.json`, the project's `README.md` and any `package.json` `assets` entry, untracked files |
| `global-input-changed` | a workspace build input changed: `tsconfig.base.json`, the shared vite plugins, the manifest generator, the asset copier, `tools/nx-plugins/build/plugin.js` |
| `dependency-changed` | it depends (`package.json` `@adhd/*`, transitively) on a pending project |
| `ref-unresolvable` | the recorded ref is gone and the commit that wrote it into `published-state.json` could not be found either |

Ignored: `dist`, `node_modules`, `test/`, spec and test files, test-only config (`tsconfig.spec.json`,
`vitest*.config.*`, `eslint.config.*`), other markdown, and `CHANGELOG.md` (the release itself writes it).
A ref that no longer resolves falls back to the commit that recorded it.

**It is a superset, not the exact list.** Measured against the real `version` dry-run over 67 projects
(2026-10-27): all 24 projects `version` would bump were in the pending set (0 missed), and the pending set held
67. The extra projects are over-reporting from stale baselines: a package verified unchanged by `version` keeps
its old `publishedFromRef`, so any later workspace-level change flags it again. Over-reporting costs a build and a
no-op `version`, never a wrong publish. Under-reporting would silently withhold a package, which is why Stage 2
stays authoritative and why a change to what counts as "shipped" must be re-validated against it.

### Stage 2 — content filter (exact, post-build)

`executors/version/impl.js` hashes each project's freshly-built `dist/`
(`normalizedHash`) and compares it to the hash recorded in `published-state.json`:

```
version: @adhd/foo@1.2.3 unchanged vs published (cache hit, zero network) — no bump.
```

Identical content ⇒ **no bump, no publish**, zero network calls. `normalizeManifest`
strips `version` and every `@adhd/*` dependency range before hashing, so the
comparison is stable across version bumps and internal-range churn — otherwise it
would be circular.

**Net effect:** the pending set → cached builds → only the packages whose shipped bytes
actually changed get bumped and published. A recent real run: 69 candidates, 96 no-bump
messages, 11 packages published.

### The baseline — the one thing that has actually broken a release

The baseline is **per package**: each package's own `publishedFromRef`, not one workspace-wide base ref.
`publishedFromRef` is written by `executors/publish/impl.js` **only after npm confirms a publish** (exit 0, or a
failure the registry itself contradicts), and never under `--dry-run`. A ref that no longer resolves (rebase,
squash, unpushed) falls back to the commit that recorded it in `published-state.json`; if that is gone too, the
package is pending as `ref-unresolvable`.

It is **advisory metadata only** — `normalizedHash` remains the sole authority for "is this already
published". That is why the cache survives rebases, worktrees, and publishes from other machines, and why a
missing ref is ordinary rather than an error. `RELEASE_BASE_REF` no longer affects `pnpm release`; it still
drives the older `changed-set.js` resolver.

> **⚠️ The failure this prevents.** A single workspace-wide base ref defaulted to `HEAD~1`, correct only when a
> release is exactly one commit ahead of the last publish. A 21-commit release diffed against its previous commit
> (which touched no publishable project), computed an **empty** changed-set, printed `nothing to release`, and
> **exited 0 having published nothing** while 10 packages had genuinely changed. Per-package baselines remove the
> shared reference point that failure depended on.

### Diagnosing a release that "succeeded" but shipped nothing

**Read this line first** — it is the one that tells you whether the run was ever
going to publish anything:

```
run-release: pending set (release:pending): N publishable project(s) in W wave(s):
```

- **N is 0 and you expected changes** → run `pnpm release:pending --json` and read each project's
  `reasons`. A package missing from `published-state.json`, or one whose recorded ref was
  rewritten away, shows up as `never-published` or `ref-unresolvable`; a changed file the
  ignore list drops (see Stage 1) shows nothing. Compare against `git diff --name-only <publishedFromRef> -- <projectRoot>`.
- **N is large (~all projects)** → normal when a workspace build input changed since the oldest
  baselines (`global-input-changed`). Let it run; stage 2 filters it.

**Never trust exit 0 as proof anything shipped.** `run-release` legitimately exits 0
when there is genuinely nothing to release, and the two states look identical from
the exit code. Verify against the registry:

```bash
npm view @adhd/<pkg> version      # must match the on-disk package.json
```

A release once reported success while three packages were silently withheld —
their publish tasks never ran because the task graph bailed upstream. The registry
is the only source of truth for what is published.

### `pnpm release:dry` is a preview, not a safety check

`pnpm release:dry` is `run-release.mjs --dry-run`: the same code path as `pnpm release` (pending set, test gate, build,
version waves, `check-release-ranges`, publish waves) with `ADHD_NX_VERSION_DRY_RUN=1` set before anything
spawns, `version` and `publish` run with `--dryRun`, and no `sync-global` or clean-room smoke. It
mints `RELEASE_RUN_TOKEN` and writes the release manifest exactly like `pnpm release`. It is still only a PREVIEW of
version/publish, so it is not proof a release works end-to-end. Use `pnpm release` for the real thing.

---

## How "only what changed" is determined (retired — historical, applied to `nx release`)

**Git tags are the source of truth.** When you run `nx release version`, it:

1. **Finds each project's last release tag:** Looks for the most recent tag matching `{projectName}@*` (e.g., `agent-mcp@1.2.3`)
2. **Scans commits since that tag:** Uses git log from that tag to HEAD
3. **Skips projects with zero commits:** If a project has no commits since its tag, it's not included in the release
4. **Analyzes commit type:** Uses the scope and type in conventional commits to determine version bump

**Example:**

- `agent-mcp@1.2.0` tag exists from 2 weeks ago
- Since then: 5 new commits to agent-mcp (2 `fix(...)`, 3 `feat(...)`)
- Result: agent-mcp is bumped to 1.3.0 (minor)

- `apigen-core-client@2.1.5` tag exists from 2 weeks ago
- Since then: zero commits to apigen-core-client
- Result: apigen-core-client is **skipped** in this release (no new version, no publish)

---

## CI publish (automated)

The `Publish` step (`.github/workflows/pull-request.yml`) publishes through the
SAME scoped pipeline as `pnpm release` — never a bare `nx affected -t version` /
`-t publish` (those can never publish; see below). In order it:

1. builds the affected libraries (`npx nx affected -t build`), then
2. runs `node tools/nx-plugins/build/executors/smoke-test/run-release.mjs --publish-only --configuration=production`.
   That one script mints the run token, takes the scope from the pending set (`release:pending`), WRITES
   `.adhd/tmp/release-manifest.json` (the manifest the `publish` executor's backstop requires,
   `tools/nx-plugins/build/lib/release-manifest.js`), then runs `version` and `publish` in dependency waves. The lane,
   test and build gates already ran in the steps above, so `--publish-only` skips them, and it exits with the publish
   result without `sync-global` or the clean-room smoke.

A bare `nx affected -t publish` / `nx run-many -t publish` / `nx run <p>:publish` works
on a clean checkout with no manifest: the `publish` executor decides by CONTENT against
the registry first (identical to what npm holds -> successful no-op; built content
differs or never published -> publish; same version but different content with no
bump -> fails loudly telling you to run `nx run <p>:version`). The release manifest
is now only an advisory scope note on a real publish; scoping a release (cost) and ordering it is
`run-release.mjs`'s job via `planRelease`. OTP: `NPM_CONFIG_OTP=<code> npx nx run <p>:publish`
(or `--otp=<code>`) is passed to npm through the environment, never logged. That required shape is asserted by
`tools/nx-plugins/build/ci-publish-wiring.spec.mjs`.

`tools/nx-plugins/build/executors/publish/release-publish.mjs` is RETIRED — its own
header (lines 7–13) forbids wiring new callers to it; do not point CI at it.

This requires `NPM_TOKEN` to be set as a GitHub Actions secret using an **automation token** (no OTP required).

To create an automation token: npmjs.com → Avatar → Access Tokens → Generate New Token → **Automation**.

---

## Post-publish checklist

After publishing any package, verify it works end-to-end:

- [ ] `npm view @adhd/<name>` shows the new version as `latest`
- [ ] `npx @adhd/<name>@latest --version` (for CLI packages) prints the correct version
- [ ] Verify git tags were created: `git tag | grep @adhd/<name>@` should show `{projectName}@{version}`
- [ ] Check the package's own publishing doc for integration smoke tests:

Each published package maintains a `PUBLISHING.md` in its source directory with
package-specific verification steps. Check there for the full smoke-test procedure.

| Package            | Publishing doc                                                               |
| ------------------ | ---------------------------------------------------------------------------- |
| `@adhd/agent-mcp`  | [`entrypoint/agent-mcp/PUBLISHING.md`](entrypoint/agent-mcp/PUBLISHING.md)   |
| `@adhd/apigen-cli` | [`entrypoint/apigen-cli/PUBLISHING.md`](entrypoint/apigen-cli/PUBLISHING.md) |

---

## Running a global CLI against local source (dev mode)

Sometimes you want the globally-installed `adhd-backlog` / `apigen` / `agent-mcp` binary to run **this
worktree's** code rather than the published artifact — to exercise a fix before it ships, or because
the published version is behind a commit you need. That is the `pnpm link -g` shape the
`sync-global` step calls a "stale link shim".

**It is a legitimate dev state, and it is deliberately temporary.**

```bash
# point the global bin at local source
npx nx build <project>                  # the shim execs dist/, so dist must exist and be current
cd <entrypoint-dir> && pnpm link --global

# confirm which build you are actually running
readlink -f "$(which <bin>)"            # or: cat "$(which <bin>)" | grep exec
<bin> --version
```

**Step 3.5 of `pnpm release` will undo this.** `sync-global.mjs` detects a shim whose content execs
local workspace source — **any** checkout's `entrypoint/<dir>/dist` (this worktree, a sibling
worktree, or the main checkout), in **any** discovered root (pnpm, npm prefix, or an NVM node
version) — and flips it back to the published artifact via that root's manager install (`pnpm add -g
<name>@<exact-version>` for a pnpm root, `npm i -g <name>@<exact-version>` for an npm/NVM root) —
that is its entire purpose (see Step 3.5 above). So after any release, a dev-mode link is gone and
the global CLI is on the registry build again (the release log names the root and the command it
ran). Re-link with the commands above if you still want local source. A **legacy**-named dev link
(e.g. a bare `backlog` for a package that now declares `adhd-backlog`) is the one case the install
cannot flip — it is reported `legacy-pending` and **fails Step 3.5**; quarantine it with human
approval, see Step 3.5.

**Know which build answered you.** The global bin and a repo-relative
`node <entrypoint>/dist/index.js` are _different artifacts_ and can be different versions while
writing to the same store. If an MCP server entry also points at one of them
(`~/.claude.json` vs a repo `.mcp.json`), the same tool name can resolve to two different builds —
see `BUG-BACKLOG-MCP-CLI-SPLIT-BRAIN-001`. When verifying a fix, state which binary you ran.

---

## Troubleshooting

(Current pipeline — `@adhd/nx-build:version`/`:publish`, no git tags, `tools/nx-plugins/build/executors/publish/release-publish.mjs` and everything referencing `nx release`/`updateDependents`/tag deletion belongs to the retired workflow above, not this one.)

| Error                                                                                                                              | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `You cannot publish over the previously published versions`                                                                        | `version`'s bump decision should have caught this — `isPublished(name, version)` in `publish/impl.js` also independently no-op-skips anything already on the registry, so this means the two disagree. Check `npm view @adhd/<name> versions` against the source `package.json` version; if they already match, `publish` should have skipped it silently (`already on npm — skipping`) rather than erroring — investigate why it tried to publish at all.                                                                                                                                                                                                                                                                                                      |
| `EOTP`                                                                                                                             | Need OTP from authenticator app (`nx run <project>:publish --otp=<code>`), or switch to an npm **automation token** (bypasses OTP).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `E401 Unauthorized`                                                                                                                | Run `npm login` first (`npm whoami` to confirm).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `version: no built dist at .../dist — this target dependsOn build.`                                                                | `version` (and `dist-manifest`, `assets`) all `dependsOn: ["build"]` — if you invoke one directly without the graph resolving its dependencies (rare; `nx run <project>:version` normally pulls `build` in automatically), run `npx nx build <project>` first and check for a real build error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `assets: no dist for <project> (build first)`                                                                                      | Same as above — `assets` also `dependsOn: ["build"]`; the target ran before a dist existed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `version` reports a spurious "changed" (`removed: README.md` / `removed: CHANGELOG.md`) on a package that has no real code changes | `version`'s `dependsOn` is missing `assets` for that target (should be `["build","assets", ...<runtime-dep version tasks>]` — see `tools/nx-plugins/build/plugin.js`). Without `assets` in the chain, a bare `build` doesn't include docs that the already-published tarball has, and `compare-published.js` reads that as a real diff. This is a graph-wiring bug, not a real package change — check `plugin.js`'s `dependsOn` arrays before trusting the bump.                                                                                                                                                                                                                                                                                                                     |
| `publish: npm publish failed` with the built package missing README/CHANGELOG                                                      | `dist-manifest` (and transitively `publish-hygiene`/`publish`) must `dependsOn` include `assets`, not just `build` — `@adhd/nx-build:publish` runs `npm publish {projectRoot}/dist` directly, so anything not physically copied into `dist/` (that's `assets`' job) never ships, regardless of what the source-root `package.json` `"files"` says.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm release` bumped a package you didn't expect                                                                                  | The bump is driven entirely by comparing the built `dist/`'s `normalizedHash` against the cached PUBLISHED hash in `published-state.json` (equivalent to the legacy per-file tarball diff — see `compare-published.spec.mjs`'s equivalence suite) — not by git commits or conventional-commit messages. Any real change to the built output (code, external deps, non-`@adhd/*` metadata) triggers a bump; only internal `@adhd/*` dependency RANGE changes are deliberately excluded (`normalizeManifest`). Unlike the retired tarball-diff flow, a cache-hit decision doesn't print a per-file `reasons` list — run `nx run <project>:reconcile` to refresh that package's entry and inspect `published-state.json`'s stored hash if you need to dig further. |
| `version` says "not in published-state.json — backfilling from npm" for a package you expected to already be cached                | Normal on the FIRST run after `published-state.json` is introduced, or for a brand-new package — `version` self-heals with a single-package backfill (network, one package only) and caches the result. If you see this repeatedly for the SAME already-published package, `published-state.json` isn't being committed/persisted between runs — commit it.                                                                                                                                                                                                                                                                                                                                                                                                     |
