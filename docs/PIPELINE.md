# Pipeline — `adhd`

**Schema:** `1` · **Last updated:** 2026-10-04 · **Owner:** devops

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
  (`targetDefaults["nx-release-publish"]`).
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
5. `e2e` (its own resource-heavy lane, `--parallel=1`)
6. `verify-dist-load` (loads the REAL built `dist/`, which `nx test` does not)
7. `publish` — `if: success() && (label 'publish' || closed-and-merged to main)`

The advance gate is `if: success()` plus nx `affected` membership. `.github/workflows/ci.yml` runs on
push to `main` **and** on `pull_request`: `nx format:check` **range-scoped to the event's own commit
range** (`--base`/`--head`, never the frozen `NX_BASE` — see §3), then the lane-reachability gate, then
`nx affected -t lint test build verify-dist-load`, then `e2e --parallel=1`. Locally,
`.githooks/pre-commit` mirrors the early stages (mass-deletion guard → secret-scan → `nx affected -t
lint` → staged-spec tests) and `.githooks/pre-push` adds the affected suite.

**External status checks (installed GitHub Apps, not workflow steps):** DeepSource is configured by
the committed `.deepsource.toml` and runs as the installed `deepsource-io` GitHub App check — no
workflow file is involved, so `rg -i deepsource .github/` = 0 is expected and is **not** evidence of an
unwired analyzer. The `claude`, `trigger-dev-app`, and `vercel` apps also post check suites.

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
  declared inputs, with `cache: true` on `@nx/vite:build`, `test`, and `typecheck`. Invalidation is
  input-hash drift (content), never time.
- **Release-decision cache** — `published-state.json`, content-addressed by `normalizedHash`
  (PUBLISHING.md §"The published-state.json cache — zero-network change detection"). It advances
  only on a *verified* publish (`publish/impl.js`), so a never-promoted version cannot poison it.
- **Rule** — nothing is keyed on a mutable tag or wall-clock; correctness outranks hit rate.

## 5. Release & versioning
- **Version** — independent per project (`nx.json` `release.projectsRelationship:"independent"`);
  the source `package.json` `version` IS the release version. Conventional commits decide each bump;
  unchanged packages are skipped (PUBLISHING.md §"Version").
- **Changelog** — per project `{projectRoot}/CHANGELOG.md`, `automaticFromRef:true`
  (`nx.json` `release.changelog`).
- **Tag** — `nx.json` `release.releaseTag.pattern = "{projectName}@{version}"`.
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
