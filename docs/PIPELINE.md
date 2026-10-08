# Pipeline — `adhd`

**Schema:** `1` · **Last updated:** 2026-10-07 · **Owner:** devops

Single source of truth for the path from a commit to a published `@adhd/*` artifact. Where a rule
already lives in a committed document, this doc **cites it** rather than restating it — the cited
source is authoritative, and this doc is the index that keeps the pieces together.

> A budget or gate this pipeline cannot actually run does not belong here. Known gaps are marked
> **GAP** and left visible rather than papered over.

## 1. Build graph
- **Task graph** — `nx.json` (`targetDefaults` + `plugins`); custom executors live under
  `tools/nx-plugins/{build,lint,assets,deps,test}/plugin.js`. Key edges: `build` →
  `dependsOn: ["^build","typecheck"]`; `test` → `["lint","^build"]`; `lint` → `["sync-deps-check"]`;
  `publish` → `["build","assets","test","dist-manifest","verify-dist-load","publish-hygiene"]`
  (`targetDefaults["nx-release-publish"]`). The inferred `version`/`publish` targets
  (`tools/nx-plugins/build/plugin.js`) order after each RUNTIME dependency's `version`/`publish`/`test`
  via explicit per-project `{projects, target}` entries built from `dependencies`,
  `peerDependencies` and `optionalDependencies` (npm name mapped to Nx project name through
  `project.json#name`); `devDependencies` are excluded because Nx graph edges carry no dependency
  kind and a graph-wide `^version`/`^publish` would fan out over devDependency and test-import edges.
  `build`/`test` keep `^build` over the full graph, so `affected` is unchanged by that ordering.
- **Runtime-closure cache inputs (build, typecheck)** — for each publishable project
  `tools/nx-plugins/build/plugin.js` computes the workspace projects whose SOURCE can reach the built
  artifact (`tools/nx-plugins/build/lib/input-closure.js`): declared `dependencies`/`peerDependencies`/
  `optionalDependencies`, positive `implicitDependencies`, and any project imported from non-test
  production source (a devDependency imported from `src` is bundled into `dist`, so it stays hashed),
  transitively; projects negated with `!name` are excluded. It emits that set as the per-project
  `depsProduction` named input (literal `{workspaceRoot}/<root>/...` globs expanded from `nx.json`'s own
  `production`/`manifest` definitions) and tags the project `inputs:runtime-closure`; the filtered
  `nx.json` `targetDefaults` entries for `build`, `typecheck` and `@nx/vite:build` select
  `["production","depsProduction"]` for tagged projects instead of `["production","^production"]`.
  A named input cannot hold `^production` or `{input, projects}`, and `targetDefaults` outrank
  plugin-inferred `inputs`, hence the tag + filter. `test` keeps `^production`: tests execute
  dev-dependency source. Projects whose `typecheck`/`build` declare their own `inputs` in `project.json`
  are untouched.
- **`workspace-base-vite-paths`** — every `vite.config.*` imports it by relative path, which Nx reads as
  a static edge that put its `build`+`typecheck` into every project's `^build`. The build plugin emits
  `implicitDependencies: ["!workspace-base-vite-paths"]` for projects that reference it only from config
  files; its `src` is hashed workspace-wide through `sharedGlobals` instead, so a change to it still
  invalidates every cache and still marks every project affected (measured with
  `nx show projects --affected --files=…`).
- **"Affected by a change"** — nx `affected` against `defaultBase: "main"` (`nx.json`); the matched
  inputs are the declared `namedInputs` (`default`, `production`, `sharedGlobals`).
- **Artifact per target** — `build` emits each project's `dist/`; `publish` publishes that `dist/`
  (PUBLISHING.md §"Build & publish layout: in-source dist, publish-from-dist"). The release flow's
  external artifact is the npm tarball `npm publish` uploads from `dist/`.

## 2. CI/CD stages
Ordered stages and the gate that advances each (`.github/workflows/pull-request.yml`):
1. `secret-scan` (independent hard job; `SECRET_SCAN_REQUIRE_GITLEAKS=1`, scanner pinned + checksum-verified)
2. `lint` (`nx affected -t lint`)
3. lane-reachability (`tools/nx-plugins/test/executors/wiring/check-lane-reachability.mjs`)
4. `test` (`nx affected -t test --parallel=5`)
5. `e2e` (its own resource-heavy lane, `--parallel=1`; every subprocess / real-server suite lives here and is excluded from `test` — `docs/decisions/0009-test-lanes-unit-vs-e2e.md`; the agent-family spawn gate is lane-reachability rule 8)
6. `verify-dist-load` (loads the REAL built `dist/`, which `nx test` does not)
7. `publish` — `if: success() && (label 'publish' || closed-and-merged to main)`

The advance gate is `if: success()` plus nx `affected` membership. `.github/workflows/ci.yml` runs on
push to `main` **and** on `pull_request`: `nx format:check` **range-scoped to the event's own commit
range** (`--base`/`--head`, never the frozen `NX_BASE` — see §3), then the lane-reachability gate, then
`nx affected -t lint test build verify-dist-load`, then `e2e --parallel=1`. Locally,
`.githooks/pre-commit` mirrors the early stages (mass-deletion guard → secret-scan → `nx affected -t
lint` → staged-spec tests) and `.githooks/pre-push` adds the affected `test` suite (`GATE_TARGETS` minus `e2e`, resolved by `.githooks/lib/pre-push-flags.mjs`; `e2e` is deliberately CI-only — run it locally on demand with `nx affected -t e2e --parallel=1`).

**External status checks (installed GitHub Apps, not workflow steps):** the `claude`, `trigger-dev-app`,
and `vercel` apps post check suites; none gates a merge. DeepSource is **not used**: its config
(`.deepsource.toml`) was never invoked by any workflow and its analyzer check sat red on `main`
(backlog `47d0f713`), so the file was deleted (backlog `8c0c314e`). Static analysis is owned by the
`nx lint` lane above.

## 3. Reproducibility
- **Pinned toolchain** — pnpm `8.15.9` (`package.json` `packageManager`), Corepack enabled in CI,
  Node `22` floor (`pull-request.yml`), lockfile `pnpm-lock.yaml` committed.
- **Hermetic inputs** — nx cache inputs are only the declared `namedInputs`; the daemon is off
  (`nx.json` `useDaemonProcess:false`).
- **Release entry** — `pnpm release` = `node tools/nx-plugins/build/executors/smoke-test/run-release.mjs`
  (`package.json`), which computes the changed set, runs a structural scoped `build`, `version`,
  GATE 1, scoped `publish`, sync-global, GATE 2, then the receipt.
- **CPU-only runner** — CI sets `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` (`ci.yml` `main` job,
  `pull-request.yml` `test` job) so `onnxruntime-node` does not download the CUDA execution provider
  on a runner with no `libcublasLt.so.12`; the CPU EP is the reproducible choice, and the flag
  provisions it rather than gating a test.
- **`format:check` scope** — `nx format:check` is range-scoped to the event's commit range, not the
  `NX_BASE` that `nrwl/nx-set-shas` pins to the last **successful** run. Consuming that env in
  `format:check` makes the range grow on every red push and the gate self-locks (backlog `f1ddfb0c`).
- **GAP** — there is no double-build hash check and no committed base-image digest check; the
  container lane (`.github/workflows/build-docker.yml`) and the npm tarball are the surfaces that
  would need one.

## 4. Caching
- **nx cache** — `nx.json` `cacheDirectory: ".nx/cache"`; the key is the content hash of the task's
  declared inputs. **Requirement (owner, AC9):** two identical runs of `nx affected -t build` or
  `-t test` in a row — dependency tasks included — end in `Cache: N/N hit` AND exit 0; there is no
  recorded exception.
- **Cached targets** (all `cache: true`): `build`, `typecheck`, `typecheck-spec`, `lint`,
  `sync-deps-check`, `test`, `assets`, `build-bin`, `vocabulary-gate`, `traceability`, backlog `build`
  (vite + `ir-artifact` bake, formerly uncached), `dispatch-cli:generate-cli` (declared
  `apigen-cli:build` dependency, outputs `dist/entrypoint/dispatch-cli/cli`), `dist-manifest`
  (inputs: own `package.json`/`CHANGELOG.md` + the `package.json` of each declared RUNTIME workspace
  dependency + `sharedGlobals`; outputs
  `dist/package.json`, `dist/CHANGELOG.md`), `verify-dist-load` and `publish-hygiene` (inputs: the
  on-disk outputs of `build`/`dist-manifest` via `dependentTasksOutputFiles`, `sharedGlobals` so an
  executor change invalidates a stale verdict, node/npm version, `VERIFY_DIST_LOAD_TIMEOUT_MS`).
- **Deliberately uncached** (one-line proofs): `version` (reads the live registry + git, writes
  tracked `package.json`/`CHANGELOG.md`), `reconcile` (live registry), `release-reset`/
  `release-reset-check` (live git/working-tree state), `publish` (registry mutation),
  `chmod-bin` (a hit leaves a bin that lost its executable bit non-executable: nx's "existing
  outputs match the cache, left as is" compares content, not mode — measured), `serve` (including `agent-mcp:serve`, `serve-status`, `serve-stop`: long-running live-reload dev server that never builds; `entrypoint/agent-mcp/README.md` Local dev server), `bench`.
  The bin mode is instead guaranteed by `writeDistManifest` (the re-stamp run by dist-manifest,
  version, verify-dist-load, publish-hygiene, publish), and `chmod-bin` is no longer a dependency
  of `assets`.
- **`test` input rule** — `targetDefaults.test` hashes upstream outputs with
  `dependentTasksOutputFiles` restricted to code-bearing extensions (`js,mjs,cjs,d.ts,d.mts,d.cts`).
  A `**/*` glob also hashed `dist/package.json`/README/CHANGELOG that `assets`/`dist-manifest`
  rewrite concurrently, which made 29 of 67 `test` tasks miss on a second identical run.
- **Release-written fields are not code inputs** — the `default` named input excludes
  `{projectRoot}/package.json` and `{projectRoot}/CHANGELOG.md` and includes the `manifest` named input
  instead: `{json: "{projectRoot}/package.json", excludeFields: ["version"]}` at workspace level, and a
  per-project override emitted by `tools/nx-plugins/build/plugin.js` that additionally excludes every
  internal `@adhd/*` dependency range (`dependencies|devDependencies|peerDependencies|optionalDependencies.<name>`).
  The `version` phase rewrites exactly those fields (version, internal ranges, CHANGELOG.md) for
  packages whose code did not change, which used to invalidate build/test/lint/typecheck/
  typecheck-spec between the `version` and `publish` invocations. Anything else in `package.json`
  (an external dependency, a new or removed internal dependency, `exports`, `bin`, `scripts`) and
  every source file still invalidates. `assets` declares `CHANGELOG.md`/`README.md` as explicit
  inputs because it copies them into `dist/`; `dist-manifest` keeps its own raw `package.json`
  inputs. Evidence: the cache-dag report, "Item 3".
- **`@adhd/nx-plugins:test` is cached** (formerly `cache:false`). Its `inputs` are the read set
  measured by an fs/child_process trace of a full `test:build-tools` run (tools/**, `.githooks/**`,
  `.github/**`, the root wiring files, every project's `project.json`/`package.json`/`tsconfig*`/
  `vite.config.*`/`executors.json`/`schema.json`, every spec/test/e2e file, the agent-core-env project
  a spec runs nested, toolchain versions, the git facts specs read, and the env vars the build
  tooling reads). `.nxignore` hides `docs/`, `.claude/` and `entrypoint/apigen-cli/src/test/fixtures`
  from nx's file hasher entirely (a glob input there matches nothing), so the files specs read from
  those trees are hashed by `git hash-object` runtime inputs (nx-plugins:test and the apigen-cli
  `test`/`e2e`/`generate-api` targets).
- **Release-decision cache** — `published-state.json`, content-addressed by `normalizedHash`
  (PUBLISHING.md §"The published-state.json cache — zero-network change detection"). It advances
  only on a *verified* publish (`publish/impl.js`), so a never-promoted version cannot poison it.
- **Rule** — nothing is keyed on a mutable tag or wall-clock; correctness outranks hit rate. Every
  cached target above has a recorded negative control (a real input change misses, the revert hits).
- **GAP** — `version` re-executes in the publish phase (uncached, idempotent; it reads the live
  registry). `nx-plugins:test` inputs are an audited snapshot: a NEW kind of file a spec starts reading
  must be added to `tools/nx-plugins/project.json` (the lane-reachability gate does not check this).

## 5. Release & versioning
- **Version** — independent per project (`nx.json` `release.projectsRelationship:"independent"`);
  the source `package.json` `version` IS the release version. Conventional commits decide each bump;
  unchanged packages are skipped (PUBLISHING.md §"Version").
- **Changelog** — per project `{projectRoot}/CHANGELOG.md`, `automaticFromRef:true`
  (`nx.json` `release.changelog`).
- **Tag** — `nx.json` `release.releaseTag.pattern = "{projectName}@{version}"`.
- **Half-applied release guard** — `release-reset-check` (non-mutating; `lib/release-reset.js`) is a
  dependency of `publish` ONLY (once per project per release; `version` never read its verdict, so it
  no longer depends on it — previously 63 + 61 runs per release). It FAILS the release only for a
  genuinely half-applied state: `package.json` `version` differs from HEAD's with no matching
  CHANGELOG entry, or a phantom CHANGELOG top entry that is a clean prepend over HEAD. A range-only /
  dependency-sync edit (version equal to HEAD's) is not a version bump even when the CHANGELOG top is
  behind the version at HEAD. States that cannot be proven half-applied (a phantom-shaped entry over
  other hand edits; changelog drift on a range-only edit) are REPORTED — a warning in the task log
  and a "RELEASE-RESET REVIEW REQUIRED" block in the release receipt — and never fail the release.
  `--live` revert stays strict (refuses anything that is not a clean prepend / version-only diff).
  Ordering: the check `dependsOn` its own project's `version` task (acyclic — `version` does not depend
  on it), so raw `nx run-many -t publish` / `nx run <p>:publish` never reads a half-written bump.
  Standalone `nx run <p>:release-reset-check` therefore runs `version` first (use
  `ADHD_NX_VERSION_DRY_RUN=1` for a read-only check). `run-release.mjs`'s explicit version phase is still
  needed: it fixes the topological bump order and the GATE 1 range check before any publish starts.
- **What publishes what** — the `publish` nx target (`tools/nx-plugins/build/executors/publish/impl.js`)
  uploads `dist/` to npm; `run-release.mjs` orchestrates the whole run. Changesets are NOT used
  (no `.changeset/`).

## 6. Deploy & rollback
- **Deploy** = `npm publish` of each changed project's `dist/` to the public npm registry, in the
  promotion order of the publish target's `dependsOn` (§1).
- **Approval boundary** — outside the pipeline operator: a `publish` PR label or a merge to `main`
  (`pull-request.yml` `publish` step). The operator's global CLI is reconciled afterward by
  `sync-global.mjs`.
- **Rollback** — a published version is immutable: npm refuses to publish over an existing version
  (`publish/impl.js` `isAlreadyPublishedError`). The tested path back is to publish a new patch that
  supersedes the bad version; `pnpm release:dry` previews without touching the registry
  (PUBLISHING.md §"`pnpm release:dry` is a preview").
- **GAP** — no dedicated rollback runbook exists beyond "publish a new version".

## 7. Secrets
- **Store** — GitHub Actions secrets (`NPM_TOKEN`, injected only into the `test`/`publish` job env in
  `pull-request.yml`); local npm auth is via the tracked `.npmrc`, which carries no `_authToken`/
  `npmAuth` (checked). Only the publish stage reads `NPM_TOKEN`.
- **Enforcement** — `.githooks/pre-commit` and the CI `secret-scan` job both run
  `@adhd/nx-secret-scan:scan` (wrapping `.githooks/check-no-credentials.js`) plus `.gitleaks.toml`;
  the scanner is pinned and checksum-verified in CI.
- **Rule** — no secret is committed or echoed into a log; a missing scanner is a hard failure, never a
  silent pass (`.githooks/README.md`).

## 8. Budgets & observability
- **Recorded** — every `withMetrics`-wrapped executor appends one record to the gitignored
  `metrics.json`: `{task, project, t, success, durationMs, cpuPercent, phases, subprocess, network}`
  plus an optional `outcome` (`tools/nx-plugins/lib/metrics.js`).
- **Enforced threshold** — the CPU guard: `ADHD_NX_METRICS_MAX_CPU_PCT` (`0` = disabled by default)
  fails a task whose measured CPU exceeds the cap (`metrics.js` `checkCpuGuard`).
- **Receipt** — `run-release.mjs` prints a per-task, per-package receipt at the end of EVERY run
  (`tools/nx-plugins/build/executors/smoke-test/task-report.mjs`): tasks × project × duration from
  `metrics.json`, and per package PUBLISHED vs SKIPPED from the publish executor's own `outcome`
  (never a registry re-read).
- **Coverage** — `metrics.json` covers `withMetrics` executors only (version, publish,
  publish-hygiene, dist-manifest, verify-dist-load, sync-deps-check, secret-scan, assets-*); plain nx
  build/test timings live in `.nx/workspace-data`.
- **GAP** — the CPU guard is the only enforced budget and is off by default; no committed wall-clock
  or artifact-size threshold fails a build today.

## 9. Provenance
- **Schema version** — `1` (this header).
- **Release provenance** — `published-state.json` records `{version, normalizedHash,
  publishedIntegrity, publishedFromRef}` per package; per-project `CHANGELOG.md`; git tag
  `{projectName}@{version}`; `release-commit.mjs` cuts the release commit.
- **Every edit to this doc** — what changed and why, below.

## Provenance
- `2026-10-07` — Added `agent-mcp:serve` / `serve-status` / `serve-stop` (run `dispatch-2026-10-06-48dc`, branch `feat/agent-mcp-serve-48dc`). Why: the dispatcher needs a local agent-mcp server over HTTP that reloads on dist rebuilds without being registered in any MCP client config; uncached, no `dependsOn` so it cannot trigger a build.
- `2026-10-07` — Graph pass 2 (run `dispatch-2026-10-06-48dc`, branch `fix/graph2-48dc`; backlog `0b9505ff`, `c916591c`, `13c35ae0`, `e44c9080`, `dbdcb2cb`). §1 gains the runtime-closure input rule and the `workspace-base-vite-paths` edge removal; §4 `dist-manifest` inputs name each declared runtime dependency's `package.json` instead of `{fileset, dependencies: true}`. Why: Nx graph edges carry no dependency kind, so `^production` and `dependencies: true` hashed dev-only closures (`agent-plugin-tracing:build` 485 input files to 192, `dispatch-orchestrator` 526 to 212, `dispatch-cli` 1117 to 794; 52 of 63 publishable projects unchanged) and `workspace-base-vite-paths` build+typecheck sat in every project's task graph (`agent-plugin-tracing:test` 32 tasks to 30, `agent-mcp:test` 69 to 65). Also: the inert top-level `targetDependencies` key was removed from `nx.json` (absent from the nx schema, read by nothing); the `version` executor no longer rewrites `devDependencies` ranges (their dependency's `version` task is not ordered before it, and no gate checks them).
- `2026-10-07` — Publish/version graph narrowed to runtime dependencies (run `dispatch-2026-10-06-48dc`, branch `fix/graph-48dc`). §1 documents the per-project `{projects, target}` ordering that replaced `^version`/`^test`/`^publish` in `plugin.js`. Why: `agent-plugin-tracing:publish` expanded to 193 tasks / 15 projects through devDependency and test-import edges; it is now 53 tasks, `:version` 61 to 35, `apigen-plugin-tracing:publish` 52 to 41. The `version` executor now maps `@adhd/*` names to projects through each project's `package.json#name` (`@adhd/environment` is `environment-core-node`), so its internal ranges are reconciled.
- `2026-10-07` — Cache audit part 2 (run `dispatch-2026-10-06-48dc`, owner follow-up). §4: `nx-plugins:test` cached with audited inputs (was `cache:false`); `default` named input no longer hashes release-written `version`/internal ranges/`CHANGELOG.md` (`manifest` named input + per-project override), so the version phase no longer invalidates unchanged packages' caches; apigen-cli fixtures hashed by runtime input (`.nxignore` hid them). §5: `release-reset-check` moved from `version`+`publish` to `publish` only, made HEAD-aware (range-only edits are not orphan version bumps), review-only states warn and appear in the receipt instead of failing; the `safe = true` override was removed because it only let `--live` clobber hand-edited changelogs. `bug-nxassets-001` spec rewritten to the post-chmod-bin wiring. Evidence: the cache-dag report.
- `2026-10-07` — Cache audit (run `dispatch-2026-10-06-48dc`, branch `fix/cache-dag-48dc`). §4 rewritten from measurements: backlog `build`, `dist-manifest`, `verify-dist-load`, `publish-hygiene`, `generate-cli` cached with declared inputs/outputs; `chmod-bin` removed from `assets`' dependsOn (bit guaranteed in `writeDistManifest`); `test` upstream-output glob narrowed to code files. Why: the previous text claimed `cache: true` on `@nx/vite:build`, `test`, `typecheck` only, and a second identical `build`/`test` run missed 29+ tasks. Evidence and negative controls: the cache-dag report.
- `2026-10-06` — Deleted `.deepsource.toml` and rewrote the §2 external-checks paragraph (backlog `8c0c314e`, phase-6 bucket C). Why: the config was wired to no workflow and its check was chronically red; keeping an unwired, failing external gate is worse than none. Revert path: `git revert` the commit and re-install the app.
- `2026-10-07` — Landing the NAT_TOOL_LIVE docs contract (backlog `8963c3cb`, `90d07610`): e2e stays out of the local push gate (owner decision "do not run e2e by default, yes remove from push") via main's `pre-push-flags.mjs` mechanism (one mechanism; the competing `PUSH_TARGETS`/`--push` variant was dropped); AGENTS.md's push-gate command now uses `pre-push-flags.mjs`; `nat-tool-live-docs.spec.mjs` machine-checks the env-gated live-suite gate tables and rides `check-lane-reachability.spec.mjs` (`test:build-tools`). Why: the push-time e2e run took 40+ min and corrupted shared repo state.
- `2026-10-06` — Agent-family e2e lane (backlog `5b839b90`, base `a49d4fbe`). §2 stage 5 now states the lane contract and cites `docs/decisions/0009-test-lanes-unit-vs-e2e.md`; lane-reachability gained rule 8 (`check-agent-lane-spawn.mjs`); `packages/agent/{agent-core-env,agent-engine-compiler,agent-engine-orchestrator}`, `entrypoint/agent-mcp`, `entrypoint/dispatch-cli` each gained an `e2e` target. Why: subprocess suites ran in the unit lane at `--parallel=5` and timed out under load.
- `2026-10-05` — Corrected-and-synced while fixing cluster 12 (`8c0c314e`, CI chronically red) at
  revision `4bbf87d2`. (1) `ci.yml` `main` + `pull-request.yml` `test` set
  `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` — root cause of the red real-fastembed e2e lane
  (`libonnxruntime_providers_cuda.so` needs the absent `libcublasLt.so.12`); recorded in §3.
  (2) `ci.yml` `format:check` now takes explicit `--base`/`--head` from the event, not the frozen
  last-green `NX_BASE` — the self-locking range of `f1ddfb0c`; recorded in §2/§3. (3) §2 now records
  DeepSource as an installed GitHub App check configured by `.deepsource.toml`; the audit's
  "configured, never run" premise (`rg -i deepsource .github/` = 0) was false — the commit's
  check-suites include `deepsource-io`.
- `2026-10-04` — Created `docs/PIPELINE.md` (schema 1). Why: no single committed document carried all
  required pipeline sections (equivalence test failed), so the definition was created rather than
  adopted. Every section cites its existing source (`nx.json`, `PUBLISHING.md`,
  `.github/workflows/*.yml`, `.githooks/*`, `package.json`, `tools/nx-plugins/lib/metrics.js`).
  Same change added the release receipt to `run-release.mjs` and the publish executor's
  machine-readable `outcome` (backlog item 636e70ad) — see §5 and §8.
