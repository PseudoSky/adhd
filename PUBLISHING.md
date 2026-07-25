# Publishing Playbook

How to version, build, and publish packages in this monorepo to npm.

**This workflow does NOT use `nx release`** (see "Workflow" below — it's retired for this repo). Versioning and publishing are normal per-project **nx tasks** backed by custom executors (`@adhd/nx-build:version` / `@adhd/nx-build:publish`), driven by one command: `pnpm release`. The **npm registry is the source of truth** for what's released — no git tags, no `nx release` commit/tag side effects.

### Build & publish layout: in-source dist, **publish-from-dist**

Each buildable package builds **in-source** to `{projectRoot}/dist/`, and its *source*
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
  re-stamps every dist manifest from the *final* set of source versions (`dist-manifest`), so
  internal dependency ranges are correct **independent of versioning order** — this is what fixes
  the stale/unsatisfiable-range failure `nx release` itself couldn't (`BUG-RELEASE-PIPELINE-UNFIT-FOR-FULL-PUBLISH-001`,
  Defect C — the reason `nx release` was retired for this repo in the first place).
- **One command:** `pnpm release` (= `pnpm run build && npx nx run-many -t version && npx nx run-many -t publish`).
  Building first (proper dependency order) also sidesteps the composite-tsc cold-build parallelism
  race (`DEBT-BUILD-COMPOSITE-TSC-PARALLEL-001`).
- **Already-published, unchanged packages are skipped**, not republished — npm refuses to publish
  over an existing version. Only packages whose built `dist/` actually differs from what's on npm
  at their current version get bumped (see "Versioning model" below) and then publish.
- **Change detection is zero-network on the happy path** — `version` compares a locally-computed
  hash against the committed `published-state.json` cache instead of fetching a tarball from npm
  every run. See "The `published-state.json` cache" below.

---

## Prerequisites

- `npm login` — confirm with `npm whoami`
- npm account must have 2FA enabled; use an **automation token** for CI (bypasses OTP), or have your authenticator app ready for local publishes

---

## Workflow — `publish` is a task; the registry is the source of truth

**`nx release` is retired for this repo.** It fought the monorepo at every layer (git-config XOR, `pnpm install --lockfile-only` 404 on unpublished internal deps, non-topological versioning that shipped stale interdependency ranges, `@nx/dependency-checks` failing the build on those same stale ranges — `BUG-RELEASE-PIPELINE-UNFIT-FOR-FULL-PUBLISH-001`). Versioning and publishing are now normal per-project **nx tasks** (`@adhd/nx-build:version` and `@adhd/nx-build:publish`); the **npm registry is the source of truth** for what's released (no git tags).

```bash
pnpm release:dry                 # build + show what would version + publish (writes/publishes nothing)
pnpm release                     # build + version changed packages + publish everything not on npm
npx nx run-many -t version --bump=minor    # bump changed packages minor instead of patch
npx nx run-many -t publish --otp=123456    # supply an npm one-time password (2FA)
npx nx run-many -t publish --projects=agent-mcp,apigen-cli   # a subset
npx nx run apigen-cli:publish              # a single package

npx nx run-many -t reconcile               # (re)build published-state.json from npm (integrity-gated; network-light)
npx nx run apigen-cli:reconcile            # backfill/refresh just one package's cache entry
```

> ⚠️ **Scoped/single-project `--dryRun` does NOT reach `^version`'s dependency tasks —
> use `ADHD_NX_VERSION_DRY_RUN=1` too.** `nx run-many -t version --projects=A,B --dryRun`
> (or even a single `nx run A:version --dryRun`) only applies the `--dryRun` CLI override
> to the projects you named — **not** to A/B's internal `@adhd/*` dependencies that
> `^version`'s topological ordering pulls into the same run. Those dependency tasks get
> the schema *default* (`dryRun: false`) and will really bump + write, despite the
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

`pnpm release` = `pnpm run build && npx nx run-many -t version && npx nx run-many -t publish`. Two tasks, both per-project and **not cached**:

- **`version`** (`dependsOn: [build, assets, ^version]`, inferred by `tools/nx-plugins/build/plugin.js`'s `createNodes`) bumps a package's SOURCE `version` **iff** it needs a new release: if the current version isn't on npm → a release is already *pending* → leave it; if it IS on npm → compare the built `dist` against the **published tarball** (ignoring the version field and internal `@adhd/*` ranges) → **changed → bump** (patch by default, `--bump=minor|major` to override), **identical → leave**. The `build` + `assets` dependencies ensure `dist/` is fresh AND doc-complete before comparison (a bare `build` alone doesn't include README/CHANGELOG — comparing it against an already-published tarball that has them would falsely register as "changed" every time); `^version` ensures all internal dependencies settle first. It writes the bump but does **not** commit (review `git diff`).
  - **`^version` — topological dependent-range sync (BUILD-TOOLING-VERSION-SYNC-DEPS-001):** `^version` runs a package's internal `@adhd/*` dependencies' `version` tasks FIRST, so by the time a package's own `version` task runs, every dependency it declares has already settled its version. After deciding its own bump (or not), `version`'s final step reconciles the package's declared internal `@adhd/*` ranges to that now-settled state — reusing the `deps` plugin's `sync-deps` (fix, real runs) / `sync-deps-check` (read-only, `--dryRun`) executors directly (see [`tools/nx-plugins/deps/README.md`](tools/nx-plugins/deps/README.md)), never a duplicated reimplementation. It writes **only that package's own** `package.json`. This never forces a cascade bump: `compare-published.js`'s `normalizeManifest` already strips internal `@adhd/*` ranges before diffing, so a range-only edit is invisible to the next run's change-detector — a caret range absorbs a dependency's bump at install time, and `dist-manifest` (above) already resolves published ranges independent of source-side sync order. This eliminates the manual `sync-deps` pass previously needed after a batch of bumps to keep dependents' declared ranges from drifting.
- **`publish`** (`dependsOn: [test, ^test, version, dist-manifest, verify-dist-load, publish-hygiene]`) runs this project's own tests and its dependencies' (`test`/`^test` — the gate that was missing before `pnpm release`'s `nx run-many -t publish` path was made to depend on it), rebuilds anything `version` bumped (a version change invalidates its build cache), re-stamps its `dist/package.json` (internal `@adhd/*` ranges resolved to concrete versions from a live snapshot), and `npm publish`es the `dist` **iff** `name@version` isn't already on the registry. Already-published = no-op skip (no "cannot publish over", no republish).

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
`release-commit` (`tools/nx-plugins/build/executors/publish/release-commit.mjs`) stages explicit pathspecs only — never `git add -A`/`.` — so unrelated concurrent work in the tree is never swept in. Then `git push` (human-approved). No tag push is needed; the registry itself records what's released. (Leaving them uncommitted is still coherent — next release sees source == npm/cache and re-detects from the artifact — but committing keeps git, npm, and the cache aligned for the next contributor/CI run.)

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
> force a level on *only the changed* packages, combine with `--projects` (see Selective).

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
> falls back to disk and resolves bumps from the *entire* history → the first release touches
> everything. Baseline tags for all 52 release-group projects were established locally at their
> current disk versions on 2026-07-20 (see `DEBT-RELEASE-BASELINE-TAGS-001`); **they are LOCAL
> until pushed** (`git push --tags`, human-approved) — CI won't see changed-only until then.
> Bootstrapping a fresh clone instead: `npx nx release --first-release`.

### 2. Publish (build, test, verify-dist-load, push to npm)

> ⚠️ **Never call `npx nx release publish` directly when you're passing `--projects=`.**
> `nx release publish --projects=<explicit list>` is a **confirmed upstream Nx bug**
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

> ⚠️ **This section previously described intended behavior, not actual behavior —
> corrected 2026-07-20.** The CI workflow (`.github/workflows/pull-request.yml`,
> `Publish` step) does **not** call `nx release` at all. It calls the **legacy**
> `nx affected -t version` / `-t publish` targets (the `version`/`publish`
> `targetDefaults` in `nx.json`, which predate the `nx release` migration), and
> those targets' production configuration hardcodes `npm publish dist/libs/core` —
> a path with no corresponding project anywhere in this workspace. If this job
> ever actually ran with affected libraries present, it would fail outright. It
> gets **none** of the `verify-dist-load` gating this doc describes above. See
> `BACKLOG.md` `BUG-CI-PUBLISH-STALE-TARGETS-001` — rewiring CI's `Publish` step to
> call `node tools/nx-plugins/build/executors/publish/release-publish.mjs` is filed but not yet done (it's a live
> npm-publishing job gated by the `NPM_TOKEN` secret; needs explicit human sign-off
> before changing).
>
> **Until that's fixed, do not rely on CI to publish correctly.** Publish locally
> via `node tools/nx-plugins/build/executors/publish/release-publish.mjs` (§2 above) and verify the dry-run output
> yourself.

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

| Package | Publishing doc |
|---|---|
| `@adhd/agent-mcp` | [`entrypoint/agent-mcp/PUBLISHING.md`](entrypoint/agent-mcp/PUBLISHING.md) |
| `@adhd/apigen-cli` | [`entrypoint/apigen-cli/PUBLISHING.md`](entrypoint/apigen-cli/PUBLISHING.md) |

---

## Troubleshooting

(Current pipeline — `@adhd/nx-build:version`/`:publish`, no git tags, `tools/nx-plugins/build/executors/publish/release-publish.mjs` and everything referencing `nx release`/`updateDependents`/tag deletion belongs to the retired workflow above, not this one.)

| Error | Fix |
|---|---|
| `You cannot publish over the previously published versions` | `version`'s bump decision should have caught this — `isPublished(name, version)` in `publish/impl.js` also independently no-op-skips anything already on the registry, so this means the two disagree. Check `npm view @adhd/<name> versions` against the source `package.json` version; if they already match, `publish` should have skipped it silently (`already on npm — skipping`) rather than erroring — investigate why it tried to publish at all. |
| `EOTP` | Need OTP from authenticator app (`nx run <project>:publish --otp=<code>`), or switch to an npm **automation token** (bypasses OTP). |
| `E401 Unauthorized` | Run `npm login` first (`npm whoami` to confirm). |
| `version: no built dist at .../dist — this target dependsOn build.` | `version` (and `dist-manifest`, `assets`) all `dependsOn: ["build"]` — if you invoke one directly without the graph resolving its dependencies (rare; `nx run <project>:version` normally pulls `build` in automatically), run `npx nx build <project>` first and check for a real build error. |
| `assets: no dist for <project> (build first)` | Same as above — `assets` also `dependsOn: ["build"]`; the target ran before a dist existed. |
| `version` reports a spurious "changed" (`removed: README.md` / `removed: CHANGELOG.md`) on a package that has no real code changes | `version`'s `dependsOn` is missing `assets` for that target (should be `["build","assets","^version"]` — see `tools/nx-plugins/build/plugin.js`). Without `assets` in the chain, a bare `build` doesn't include docs that the already-published tarball has, and `compare-published.js` reads that as a real diff. This is a graph-wiring bug, not a real package change — check `plugin.js`'s `dependsOn` arrays before trusting the bump. |
| `publish: npm publish failed` with the built package missing README/CHANGELOG | `dist-manifest` (and transitively `publish-hygiene`/`publish`) must `dependsOn` include `assets`, not just `build` — `@adhd/nx-build:publish` runs `npm publish {projectRoot}/dist` directly, so anything not physically copied into `dist/` (that's `assets`' job) never ships, regardless of what the source-root `package.json` `"files"` says. |
| `pnpm release` bumped a package you didn't expect | The bump is driven entirely by comparing the built `dist/`'s `normalizedHash` against the cached PUBLISHED hash in `published-state.json` (equivalent to the legacy per-file tarball diff — see `compare-published.spec.mjs`'s equivalence suite) — not by git commits or conventional-commit messages. Any real change to the built output (code, external deps, non-`@adhd/*` metadata) triggers a bump; only internal `@adhd/*` dependency RANGE changes are deliberately excluded (`normalizeManifest`). Unlike the retired tarball-diff flow, a cache-hit decision doesn't print a per-file `reasons` list — run `nx run <project>:reconcile` to refresh that package's entry and inspect `published-state.json`'s stored hash if you need to dig further. |
| `version` says "not in published-state.json — backfilling from npm" for a package you expected to already be cached | Normal on the FIRST run after `published-state.json` is introduced, or for a brand-new package — `version` self-heals with a single-package backfill (network, one package only) and caches the result. If you see this repeatedly for the SAME already-published package, `published-state.json` isn't being committed/persisted between runs — commit it. |
