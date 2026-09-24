# Nx Config Repair First, Nx 18.3.4 → 23.2.1 Upgrade Second (Data-Decided)

**Status:** DRAFT — revised 2026-09-18; requires human approval before execution
**Author:** architect agent (revision; supersedes the 2026-09-18 pre-falsification draft)
**Repo:** `/Users/nix/dev/node/adhd` (pnpm 8.15.9, Nx 18.3.4, Node v24.11.1)
**Upgrade target (conditional):** `nx@23.2.1` (five-major jump: 18 → 19 → 20 → 21 → 22 → 23)

> **This revision inverts the plan.** The previous draft made the Nx 18→23 migration the
> project and treated the ~4× warm-build win as its primary success criterion. New
> forensic evidence proves that win was **a configuration bug, not the Nx version** — it is
> recoverable on Nx 18.3.4 today. The plan is therefore re-ordered: **repair the config
> first, measure, then decide whether the upgrade is justified at all.**
>
> Nothing here has been applied to `main`. Analysis only — no builds, tests, or migrations
> were run in producing this revision.

---

## 0. What changed, and why the premise fell

The pre-revision plan's central claim was:

> *"Warm/cache build: ~4× faster — 49/58 → 58/58 cached; median 11.75s → 2.7s. This is the
> concrete business win and the primary success criterion."*

**That claim is falsified as a version claim.** The 9 build targets Nx 18 "failed to cache"
are not an Nx-18 limitation. Structural analysis using Nx's own
`createTaskGraph()` and a plugin-merge replay (`tmp/nx-perf/FANOUT-ANALYSIS.md` §3,
`tmp/nx-perf/replay-plugins.js`) isolates the exact mechanism:

1. `nx/core/package-json-workspaces` infers an `nx:run-script` `build` target from any
   `package.json` `scripts.build` entry.
2. It runs **after** `nx/core/target-defaults` (which sets `build.cache = true`,
   `inputs`, `dependsOn`).
3. The inferred `nx:run-script` executor is **incompatible** with the project's real
   `@nx/js:tsc` / `@nx/vite:build` executor; Nx's `mergeTargetConfigurations` discards the
   entire base for incompatible targets — so `cache:true`, `inputs`, and `dependsOn` are
   **thrown away**.
4. `nx/core/project-json` runs last and restores only the **executor**, never the cache fields.
   `dependsOn` is separately recovered at task-graph time by `getDependencyConfigs()`'s
   fallback; `cache` has no such fallback — which is why only caching is lost.

**Perfect 9/9 correlation across all 63 build projects** (cache lost ⇔ `scripts.build`
present). Stale cache, a missing flag, and project.json shape were each explicitly ruled out
(`NX_CACHE_PROJECT_GRAPH=false` replay; identical target shapes; `agent-generator-plugin`
with the same executor and no `scripts.build` caches correctly).

**Consequence:** deleting those 9 `scripts.build` entries should recover the cache **on Nx
18.3.4**. The entire *measured* benefit of the migration may be obtainable today for ~15
minutes of work. A separate agent is validating this **right now** — treat the outcome as a
**branch**, not a fact (§5.3, §16).

Everything else in the old plan that *was* load-independent survives, but is now correctly
labelled as **config debt on Nx 18**, not upgrade justification:

- The test task graph is structurally identical on both Nx versions (63 test projects,
  `test.dependsOn` identical, `test.cache=true` on all 63). **There is no Nx-attributable
  test-perf win.** (`ORCHESTRATION-LEDGER.md` Round 2.)
- Cold build: no measurable delta (baseline median 103.3s vs upgraded 83.7s; ranges overlap).
- The forced framework bumps (React 19 / Next 16 / ESLint 9 / Vitest 4 / Jest 30), not Nx,
  caused all three build regressions and the lint cascade.

---

## 1. Evidence base (read before acting)

| Source | What it establishes |
|---|---|
| `tmp/nx-perf/FANOUT-ANALYSIS.md` | Exact per-package fan-out + task counts (validated against measured 234/140); the 5 ranked config defects; the definitive 9-target root cause |
| `tmp/nx-perf/nx-invocations.tsv` (3,631 rows) + `tmp/nx-perf/ANALYSIS-OUT.txt` | Real nx invocation cost across 3,141 session logs |
| `tmp/nx-perf/ORCHESTRATION-LEDGER.md` | Probe protocol, measurements, the `.eslintrc.base.json` correction, and the resource-exhaustion incident |
| `docs/contributing/conventions/worktree-workflow.md` §2.3 | Nx 22.6+ worktree-aware cache (shared cache across worktrees) — the strongest remaining upgrade candidate |
| `.worktrees/nx-perf-upgraded` (branch `perf/nx-upgraded`) | Nx 23.2.1 spike: 142 files, +5510/−6870 — **not mergeable** (§8) |
| `.worktrees/nx-perf-baseline` (branch `perf/nx-baseline`) | Nx 18.3.4 A/B control — keep until the go/no-go is decided |

**Measured, load-independent facts (all on Nx 18.3.4):**

- `nx run-many -t test --all` cold = **234 tasks**, of which **114 (48.7%) are
  lint(57)+sync-deps(57)**. The standalone `nx affected -t lint` is 124 tasks — **~92% of the
  lint subgraph is duplicated inside the test run.**
- `workspace-base-vite-paths` one-file change = **218 test tasks, 104 of them lint/sync-deps.**
- 9 build targets never cache (root cause above) — ~8s on every warm build.
- `nx test` / `nx lint` **mutate tracked `package.json` files** (57–62 tasks/run) — a
  correctness hazard, not merely a cost (§7).
- A one-line edit to `tools/nx-plugins/build/plugin.js` affects **67 projects**; `lint/plugin.js`
  affects **63** — both are in `namedInputs.sharedGlobals`, so they invalidate test caches.

**Invocation forensics (`ANALYSIS-OUT.txt`):**

- `nx affected` is **75% of all nx time** (23.03h of ~30.6h total across 3,631 invocations).
- Dominant agent loop is `edit → nx affected → repeat` (**976 `affected→affected` transitions**).
- `affected` family: median 18.5s, p90 125.1s, max 10.1m. `test` family max 583.2s.
- `backlog` is the single heaviest project (360 invocations, max 583.2s) — but its test
  fan-out is **0** (21 tasks); that 583s is genuine test work, **not** over-declaration (§5.6).

---

## 2. ADR / hard-rule conformance

**Verified: the repo has no ADR catalog.** `docs/decisions/` does not exist (glob for
`docs/decisions/**`, `**/*ADR*.md`, `**/adr/**` all return nothing). The `ADR-0007` /
`ADR-0012` / `ADR-0013` / `ADR-0015` references in `AGENTS.md` are **cross-repo citations
from `sox-ecosystem`**, not decisions recorded in this repo. `docs/product/feature-research/
claude-workflow-on-agent-packages.md:30` independently states: *"No `docs/decisions/` ADR
catalog exists in this repo."*

Therefore **no locally-recorded ADR constrains this plan.** The de-facto decisions encoded in
`AGENTS.md` do, and this plan honours all of them:

- ✅ Never `--skip-nx-cache` — cache resets use `nx reset`.
- ✅ Never invoke `tsc` directly — type-check via `npx nx build <project>`.
- ✅ pnpm only; `packageManager: pnpm@8.15.9` held.
- ✅ Worktrees under `.worktrees/`; never `git reset --hard` / `git clean -fd` / `git stash`.
- ✅ No new root folders; no new packages in this plan; no env-var feature toggles.
- ✅ Ephemeral artifacts under `tmp/`.
- ✅ **ADR-0012 (parallel-process enabled) is the one binding cross-repo invariant** and is
  *reinforced* by this plan: §7 removes a file-mutating target from the read-only lint path,
  reducing concurrent-write exposure. No proposed change implies single-writer/single-process.

**Flags (conflicts / defects to surface, not design around):**

1. `AGENTS.md`'s hard rule mandates *"log it via `adhd-backlog` AND fix it"* for stale
   single-writer claims — but **the backlog store is degraded** (`0 items returned against a
   36 MB DB`, repeated `-shm` reconciliation; `upsert-project` write failures). Findings in
   this plan **cannot currently be filed**. Process conflict; needs ops triage (§11-R8).
2. `AGENTS.md` cites a local ADR catalog that does not exist. That is a documentation defect
   worth filing (once the store is back) and, separately, a reason to *create* the catalog —
   see the ADR proposal below.

**ADR proposal (do not write without approval):** `docs/decisions/0001-nx-toolchain-version-
policy.md` — a support-window + "measure before you migrate" rule. Creating `docs/decisions/`
is a new directory (under `docs/`, not repo root, so not a rule violation) but still needs
explicit sign-off. Draft on request; **write only after approval.**

---

## 3. The central decision (inverted): repair config first; upgrade only if data justifies it

### 3.1 Recommendation: **Phase A (config repair) first, upgrade decided by measurement**

Justification for the inversion:

1. **The only measured upgrade benefit has been re-attributed to config.** With the premise
   gone, there is no measured basis to spend ~9–15 days and take on ESLint-9 / plugin / peer
   risk.
2. **The config defects are on the critical path regardless.** Even after an upgrade, every
   one of the five defects persists (they are in *this repo's* `nx.json` / `package.json`, not
   in Nx). Fixing them is not optional work that the upgrade subsumes; it is prerequisite work
   the upgrade was wrongly credited for.
3. **The config fixes are ~1–2 days and independently reversible** (1–3 line edits), versus
   ~9–15 days and a five-major migration. Do the cheap, certain thing first.
4. **It converts an opinion into a measurement.** After repair, the residual pain (if any)
   is what the upgrade must beat — measured on a load-controlled box, not inferred.

### 3.2 The upgrade, if it proceeds, keeps the two-track isolation

- **Track B (Nx-only + peer-forced):** `nx` + all `@nx/*` → 23.2.1, which necessarily drags in
  **ESLint 9** (flat-config completion, `@typescript-eslint` 8) and **Vitest ≥3**, and — as
  newly proven — a **Vite 5→6 bump** (`vitest@4` requires vite `^6||^7||^8`; as-migrated the
  tree cannot run a single test). React 18, Next 14, Jest 29 are held.
- **Track C (optional ecosystem):** React 19 / Next 16 / Jest 30, each its own commit, only
  after Track B is green.

The full Track B/C procedure, dependency matrix, plugin adaptive port, ESLint-9 design, and
per-phase gates from the pre-revision draft remain valid **as the execution plan for Phase D,
if Phase C decides to proceed.** They are retained in §10 (condensed) and by reference to the
pre-revision draft; do not re-derive them.

---

## 4. Business case re-evaluation — measured vs documented-but-unmeasured

### 4.1 Measured Nx-attributable value: **zero, so far**

| Dimension | Baseline (18.3.4) | Upgraded (23.2.1) | Verdict |
|---|---|---|---|
| Cold build | median 103.3s | median 83.7s (ranges overlap 80–143s) | **No delta** |
| Warm/cache build | 49/58 cached, 10.7–12.8s | 58/58 cached, 2.2–3.2s | **Config bug — recoverable on 18.3.4** |
| Test task graph | 63 projects, `test.cache=true` | identical | **No delta** |
| Warm test (bounded, 17 projects) | 25/26 cached, 3.7–12.1s | 26/26, 2.4–2.5s | **Noise-level** |

The pre-revision plan's primary success criterion (58/58 cached) is **not evidence for the
upgrade** — it is evidence for §5.3.

### 4.2 Documented-but-unmeasured value (the only remaining candidates)

| Candidate | Claim | Why it could matter here | How to measure (post-repair) |
|---|---|---|---|
| **Cross-worktree cache sharing** (`~/.nx`, Nx 22.6+/23.2) | Nx reuses the same task cache across git worktrees | **Strongest candidate.** ~35 sibling worktrees exist; each currently has its own `.nx` cache, so identical builds re-run per worktree | Build a fixed project in worktree A (warm), then run the same target in worktree B; count cache-restore lines. Today ≈0 shared hits; measure the delta. |
| **Daemon memory** (~7× reduction per Nx 22.7) | Lower per-daemon RSS | The box ran at load 25–73 with two daemons ≈870 MB combined; ~35 worktrees ⇒ many daemons | `ps -o rss= -p <nx-daemon-pid>` per worktree, baseline vs upgraded. |
| **V8 compile cache** (Nx 21+) | Faster process warm-up | Every nx invocation pays CLI startup | Cold `nx show projects --json` / `nx graph` wall, repeated, on a quiet box. |
| **Native TS project-graph loading** (Nx 21+) | Faster graph computation | Graph build precedes every task | `nx graph` wall + `NX_VERBOSE_LOGGING` graph timings. |

### 4.3 What would have to be true to justify the migration

The migration should proceed **only if**, after Phase A, at least one of these holds on a
load-controlled box:

1. **Cross-worktree cache sharing** produces a material hit-rate increase (the primary test —
   this is the one benefit that is structural, not micro, and directly addresses the measured
   `edit → nx affected` loop across 35 worktrees); **or**
2. **Daemon memory** drops enough to matter at 35-worktree concurrency; **or**
3. a residual pain remains that is provably version-bound (not config-bound).

If none holds, the recommendation is **defer the upgrade** — the config repair is the fix.

> **Do not accept proxy evidence.** "Nx 22.7 release notes say daemons use less memory" is not
> a measurement. Each candidate above has a concrete observable; measure it or leave the
> upgrade deferred.

---

## 5. Phase A — config repair (each fix: file/line, change, delta, risk, gate, rollback)

**Constraint for every fix below:** never `--skip-nx-cache`; never invoke `tsc` directly;
verify task counts with Nx's own `createTaskGraph()` (non-executing —
`node tmp/nx-perf/nx-taskgraph.js all`) and cross-check affected sets with
`npx nx show projects --affected --files=<path>`.

> ⚠️ **`--dry-run` is not safe.** Nx 18 silently ignores an unknown `--dry-run` on
> `run-many` and **executes anyway** (observed: it ran `data-base-transforms:build`). No gate
> in this plan may rely on dry-run as a guard. (`FANOUT-ANALYSIS.md` §0.)
>
> ⚠️ **Do not run full-suite `nx run-many -t test --all` on this box.** It exhausted memory
> once already (SIGINT kill, `exit 130`). Bound every test measurement to ≤17 projects and
> prefer `--parallel=1`; interleave, never run two worktrees' suites at once.

### 5.1 Fix #3 — delete the 9 `scripts.build` entries (highest value, lowest risk)

- **Files / lines** (exact):
  - `packages/agent/agent-core-env/package.json:20`
  - `packages/agent/agent-core-policy/package.json:20`
  - `packages/agent/agent-core-provider/package.json:20`
  - `packages/agent/agent-engine-compiler/package.json:23`
  - `packages/agent/agent-engine-orchestrator/package.json:20`
  - `packages/agent/agent-store-prompts/package.json:20`
  - `packages/agent/agent-store-runtime/package.json:20`
  - `packages/agent/agent-store-tools/package.json:20`
  - `entrypoint/decompile-cli/package.json:13`
- **Change:** delete the `"build"` script from each (and the stale `"dev"` script where present).
  These scripts are redundant (`nx build <project>` is the interface) and self-referential;
  `agent-core-env`'s would recurse into itself if Nx ever scheduled the inferred target.
- **Expected delta:** 9 build targets become cacheable → **warm build 49/58 → 58/58**;
  **~8s off every warm build**; restores `production` input scoping (so a spec-file edit no
  longer invalidates a build it should not).
- **Risk:** LOW. Removing a script cannot affect the real `project.json` build target. Do
  **not** instead "fix" this by adding explicit `cache/inputs/dependsOn` to the 9
  `project.json` targets — deleting the scripts is the durable fix; the explicit-target variant
  leaves the footgun in place.
- **Verification gate:** for each of the 9, `npx nx show project <p> --json | jq '.targets.build.cache'`
  → `true`; then `nx reset` and build twice → second run reports **58/58 cached**.
- **Rollback:** restore the 9 script lines (one revert commit).
- **Independence:** ships entirely alone. **This is the fix that retires the migration's
  stated business case.**

### 5.2 Fix #1 — drop `lint` from `test.dependsOn` (already authored, unmerged)

- **File / line:** `nx.json:141` — `"dependsOn": ["lint", "^build"]` → `["^build"]`.
- **Companion:** `agent-engine-compiler` `project.json` `test.dependsOn` gains `"build"`
  (its specs spawn its own built `dist/src/cli/compile.js`, which `^build` — dependencies only
  — never covers). Plus a real race fix in `compile-cli.test.ts` (unconditional nested `nx
  build` collides with Nx's destructive cache-restore).
- **Expected delta:** `nx run-many -t test --all` **234 → 140 tasks (−94, −40.2%)**;
  `workspace-base-vite-paths` one-file change **218 → 134**.
- **Status:** authored on `fix/nx-test-task-graph` (`c0df5491`), **unmerged**; merge-base =
  `main` HEAD, so it applies cleanly. Companion doc edit: the stale `.githooks/pre-commit`
  Gate 3 comment.
- **Risk:** MEDIUM-LOW. Lint leaves the test path; lint remains an **independent gate**
  (`.github/workflows/pull-request.yml` and `.githooks/pre-commit` both run it). Walltime gain
  is not 1:1 with task count (lint/sync-deps parallelize); the certain win is task count,
  cache restores, and removing the mutation (§7).
- **Verification gate:** `node tmp/nx-perf/nx-taskgraph.js all` → 140; `nx affected -t test`
  on the branch's changeset green (bounded ≤17 projects).
- **Rollback:** `git revert` the merge commit.

### 5.3 Fix #2 — drop `lint` from `@nx/js:tsc` and generic `build` `dependsOn`

- **Files / lines:**
  - `nx.json:152` — `@nx/js:tsc`.dependsOn `["^build", "lint"]` → `["^build"]`
  - `nx.json:156` — `build`.dependsOn `["^build", "lint"]` → `["^build"]`
- **Why:** a build never consumes lint output. Because `test` pulls `^build`, and tsc builds
  pull `lint`, this is the **second, independent path** by which lint re-enters every test run
  — exactly why the branch's fixed 140-task graph still carries **10 lint + 10 sync-deps**.
- **Expected delta:** −20 tasks in the all-suite test closure (**140 → ~120**);
  `run-many -t build --all` **97 → 63 tasks (−34)**.
- **Risk:** MEDIUM. Lint no longer gates `build`; a build can go green while lint is red.
  Mitigated by the dedicated lint CI gate + pre-commit hook. `@nx/vite:build` already uses
  `["^build"]` only, so this makes the executors consistent.
- **Verification gate:** task counts above; `nx affected -t lint` still runs standalone and green.
- **Rollback:** restore `"lint"` in both arrays.
- **Independence:** independent of #1 (the two paths are distinct), but the full −114 is only
  realised with both.

### 5.4 Fix #4 — stop the read-only lint path from mutating `package.json` (correctness)

- **File / line:** `nx.json:170` — `"lint": { "dependsOn": ["sync-deps"] }` →
  `["sync-deps-check"]`.
- **Why:** `sync-deps` declares `outputs: ["{projectRoot}/package.json"]` and its executor
  (`@adhd/nx-deps:sync`) **rewrites `package.json`** (`tools/nx-plugins/deps/plugin.js:42-47`).
  The plugin already ships the read-only sibling `sync-deps-check` (`@adhd/nx-deps:check`,
  `:48-52`), which is the correct dependency for a check path. Because `test → lint`, `nx
  test` and `nx lint` currently rewrite tracked files (57–62 tasks/run).
- **Expected delta:** no task-count change; **eliminates tracked-file mutation** on test/lint.
- **Risk:** MEDIUM — `sync-deps-check` must detect the same drift `sync-deps` fixes. Prove with
  a negative control.
- **Verification gate:** negative control — introduce a dep drift in a project, run
  `nx run <project>:sync-deps-check`, confirm it **fails red**; restore the file in a `finally`
  block. Then `nx affected -t lint` leaves `git status --porcelain` clean.
- **Rollback:** restore `["sync-deps"]`.
- **See §7 — schedule on its own merits, independent of perf.**

### 5.5 Fix #5 — scope plugin sources out of `sharedGlobals` (needs architect review)

- **File / lines:** `nx.json:29-30` — remove `{workspaceRoot}/tools/nx-plugins/build/**/*` and
  `{workspaceRoot}/tools/nx-plugins/lint/**/*` from `namedInputs.sharedGlobals`; introduce a
  dedicated `buildToolingGlobals` namedInput referenced **only** by the `build` / `assets` /
  `lint` targets' `inputs`. Keep `tsconfig.base.json` global (path aliases genuinely affect all
  builds).
- **Why:** editing any build/lint plugin file currently invalidates **every** project's build
  **and test** cache. Measured: `build/plugin.js` → **67 projects**; `lint/plugin.js` → **63**.
  A test result does not depend on the build plugin's source.
- **Expected delta:** plugin-source edits stop invalidating 63–67 projects' test caches.
- **Risk:** MEDIUM — changes cache-key semantics. Must not *under*-invalidate: the `build`
  target still needs the plugin source in its own `inputs`. Architect review required before
  landing; this is the one fix flagged for design scrutiny.
- **Verification gate:** after edit, `nx show projects --affected --files=tools/nx-plugins/build/plugin.js`
  excludes test-only projects (or the affected set shrinks as designed); a build edit still
  invalidates the affected **build** targets.
- **Rollback:** restore the two `sharedGlobals` entries.

### 5.6 Fix #6 — drop `^test` from `publish.dependsOn` (release-only, lower urgency)

- **File / line:** `tools/nx-plugins/build/plugin.js:110` — `publish` `dependsOn` includes
  `"^test"`; drop it (keep own `test`, keep `^publish` for topological ordering — BUG-002).
- **Why:** dependency tests do not affect this package's artifact. Measured: `publish` for
  `backlog` = **204 tasks**; `nx-release-publish` (the path actually used) is fine at 8–25
  tasks/pkg — so this is release-path only, not on the agent-merge critical path.
- **Expected delta:** `backlog` publish **204 → ~22 tasks**.
- **Risk:** LOW-MEDIUM — confirm the release gate is satisfied by own `test` + `^publish`
  ordering.
- **Rollback:** restore `"^test"`.

### 5.7 Explicitly **not** a config defect

- **`backlog`'s 583s single-package test is genuine test work** — fan-out 0, 21 tasks, ~30
  spec files including `server.mcp`, `install.e2e`, `rag-e2e`. **Do not "fix" it with
  dependency surgery.** If addressed, it is test-suite strategy (split e2e into a separate
  target), not a graph edge.
- **`^build` is load-bearing — do not remove it.** Tests resolve `@adhd/*` via `node_modules`
  → `exports` → `dist`; `nxViteTsPaths.resolveId` is never invoked under vitest. Removing it
  also saves zero build tasks. (Cited from branch commit `c0df5491`; not re-executed.)
- **`nx-release-publish` is fine** (8–25 tasks/pkg). Only the unused `publish` target is
  over-declared.

---

## 6. Landing order & independence

| Order | Fix | Ships alone? | Why this position |
|---|---|---|---|
| A1 | **#3** delete 9 `scripts.build` | ✅ | Recovers the "4× warm win" on Nx 18. Cheapest, highest value, lowest risk. |
| A2 | **#1** `test.dependsOn` (branch `c0df5491`) | ✅ | Already authored; −94 tasks. Merge with its companion race fix. |
| A3 | **#2** drop `lint` from build/tsc | ✅ | Removes the residual 20 lint/sync-deps tasks. |
| A4 | **#4** `sync-deps` → `sync-deps-check` | ✅ | Correctness; independent of perf. See §7. |
| A5 | **#5** scope plugin inputs | ✅ (with review) | Cache-key semantics; land after the safe four. |
| A6 | **#6** drop `^test` from publish | ✅ | Release-only; any time. |

Each is a separate commit with its own gate and rollback. A1–A4 may land in one working
session. **A2's branch (`fix/nx-test-task-graph`) and the in-flight config worktrees
(`.worktrees/nx-cfgfix`, `.worktrees/nx-test-graph`) must be reconciled first** — do not
duplicate or overwrite an in-flight fix.

> **Blast radius note (honest limitation).** `gx` (GitNexus) **cannot** resolve any of these
> symbols: `hasBuildTarget`, `createNodes`, `isPublishable` all return `Target/Symbol not
> found`, and `nx.json` / `package.json` are indexed only as bare `File` stubs with no parsed
> keys or edges (confirmed by direct graph queries returning zero matching nodes). Blast radius
> was therefore enumerated **structurally**, from the project graph: per-package fan-out and
> task counts in `FANOUT-ANALYSIS.md` §1, affected-set cross-checks via
> `nx show projects --affected --files=`, and the plugin-merge replay. Executors must still run
> `gx impact` before editing any *resolvable* symbol.

---

## 7. The dependency-mutation hazard — schedule on its own merits

**This is a correctness fix, not a performance fix, and must not be justified by perf.**

`sync-deps` (executor `@adhd/nx-deps:sync`) rewrites `package.json`; it is wired as a
dependency of `lint`, which is wired as a dependency of `test`. So **`nx test` and `nx lint`
mutate tracked files** (57–62 tasks/run). Consequences: dirty worktrees, spurious diffs
mid-CI, and — given ~35 concurrent worktrees (ADR-0012's parallel-process invariant) —
avoidable concurrent-write exposure on shared tracked files.

**Fix:** `lint.dependsOn = ["sync-deps-check"]` (§5.4). `sync-deps` is reserved for the
explicit `nx run-many -t sync-deps` repair target.

**Schedule it independently of the perf work.** Even once #1 removes lint from the test path
(so `nx test` stops mutating), `nx affected -t lint` in CI still mutates — the hazard survives
#1 and must be closed on its own terms. It can land A4 in the order above, but if the perf
batch slips, this should still ship.

---

## 8. Disposition of the spike worktrees

### 8.1 `.worktrees/nx-perf-upgraded` (branch `perf/nx-upgraded`) — **NOT MERGEABLE**

Nx 23.2.1, **142 files, +5510/−6870**. It is a *migration spike*, not a candidate branch:

- Contains migration shims that must never reach `main`: `tsconfig.base.json`
  `strict:false` / `types:["*"]` / `esModuleInterop:false` / `ignoreDeprecations:"6.0"`.
- Contains framework churn unrelated to any accepted decision: Jest ESM→CJS, lockfile,
  `migrations.json`, `tools/ai-migrations/**`.
- **Cannot run a single test as-migrated** — `nx migrate` bumped `vitest` 1→4 but left
  `vite` at 5.0.13; vitest 4 needs vite `^6||^7||^8`. The spike only ran after a manual
  **vite 5→6** bump plus an `@nx/vitest` root-config workaround — both ad-hoc, neither a
  decision this repo has made.
- A review agent's mining pass found **zero** hidden source fixes
  (`git diff --name-only | rg '/src/'` → none): everything of value lives in `tools/`,
  `nx.json`, or the unmerged branch.

**Recommendation: MINE, then DISCARD.**

- **Mine (record, do not port the file):** (a) the shape-detecting `createNodes` shim design
  (correct on both 18.3.4 and 23.2.1; the worktree's v2-only form **throws on Nx 18** because
  Nx 18 calls the handler once per file with a *string*); (b) the latent
  `tools/nx-plugins/verify-dist-load/plugin.js` bug — it `require`s a non-existent
  `../shared/detect-build-target` (should be `../build/detect-target`) and is referenced in
  `nx-release-publish.dependsOn` but **not registered** in the `plugins` array (possible
  broken release path, `(unverified)`); (c) the vite/vitest coupling fact as upgrade-scope
  evidence.
- **Discard:** remove the worktree and its branch once (a)–(c) are captured in the plan /
  backlog. It will not be merged.

### 8.2 `.worktrees/nx-perf-baseline` (branch `perf/nx-baseline`) — **KEEP until go/no-go**

This is the Nx 18.3.4 A/B control. The Phase-C measurement (§4.2) needs it. Remove it only
after the upgrade decision is recorded.

---

## 9. The PreToolUse hook — separate concern (recommended), with a specific fix

`.claude/hooks/check-nx-scope.sh` denies two shapes: bare `nx test|build|lint <project>`, and
unscoped `nx run-many -t test|build|lint|publish`. Log forensics: **575/3,631 invocations
(15.8%) blocked**, concentrated in `test` (221/338), `build` (187/318), `lint` (158/190).
Because targeted commands are denied, agents fall back to the broad `nx affected` path —
which is **75% of all nx time (23.0h)** and whose dominant loop is `edit → nx affected →
repeat` (976 `affected→affected` transitions).

**Assessment: this is a workflow-cost defect, not a code defect — it belongs in its own small
ticket, not inside the Nx migration plan.** But it is a first-order cost driver and should be
sequenced immediately after Phase A.

The hook exists for a real reason (`DEBT-PROCESS-AFFECTED-TEST-001`; commit `a82ec947` landed
3 broken downstream suites via targeted `nx test`), so **do not simply delete it.** Options:

1. **Reword the deny to point at the correct scoped shape.** The hook already permits
   `nx affected -t <target> --files=<path>`, but its message tells agents to use
   `--uncommitted` (the whole changeset). Pointing at `--files=<path>` would keep enforcement
   while narrowing the pushed-to command.
2. **Relax to warn-not-deny** for the interactive Bash path, keeping the hard block in
   pre-commit + CI (where it already runs).
3. **Keep as-is**, accepting the cost — the config fixes (#1/#2) reduce the cost of the broad
   path, which is a partial mitigation.

**Recommendation:** (1) then (2) — reword first (zero enforcement loss), and consider relaxing
only if the measured cost persists after Phase A. Treat as its own ticket; do not bundle.

---

## 10. Phase D — the upgrade (conditional; retained from the pre-revision draft)

**Gated on §4.3.** If Phase C (measurement) justifies proceeding, execute the pre-revision
draft's Phases 0–6, which remain valid. Condensed:

- **D0** Decision gates & compat triage (no mutation).
- **D1** Plugin adaptive `createNodes` port — **land on `main` first**; a single
  shape-detecting `createNodes` export correct on both 18.3.4 and 23.2.1 (never export both
  `createNodes` and `createNodesV2`).
- **D2** Nx core bump + forced peers (Track B): ESLint 9, `@typescript-eslint` 8, Vitest ≥3,
  **and Vite 5→6** (newly required). Assert `package.json` bumped **and** `migrations.json`
  written after every `nx migrate` (pnpm failure mode #28991). `pnpm why @nx/devkit` → single
  23.2.1.
- **D3** ESLint 9 flat-config completion (~1 root config + ~14 real conversions; the 56
  project `.eslintrc.json` are mostly identical boilerplate; preserve `entrypoint/backlog`'s
  computed `ignoredDependencies` via the `tools/nx-plugins/deps/compute-real-deps.js` helper).
- **D4** Optional ecosystem bumps (Track C): React 19 / Next 16 / Jest 30.
- **D5** Third-party plugins: remove `@monodon/rust` (no Nx-23 line, **no Rust project
  exists**); `@nxlv/python` → 23.1.0.
- **D6** Verification, docs, cutover.

The pre-revision draft's target dependency matrix, per-phase gates, and rollback table are
retained by reference. **Add to that draft's known-gaps:** the vite/vitest coupling, and the
fact that the migration's primary success criterion is now §5.1, not D-anything.

---

## 11. Risk register

| # | Risk | Likelihood | Blast radius | Mitigation | Hard gate? |
|---|---|---|---|---|---|
| R1 | **#3 validation fails** (the in-flight agent finds the 9-script deletion does *not* recover the cache) | Medium | The config-first premise; the upgrade's case partially revives | Treat as a **branch**; re-run the plugin-merge replay + 9/9 correlation; do not proceed on assumption | **YES** |
| R2 | #2 weakens the build gate (lint no longer gates build) | Certain (by design) | A build can go green while lint is red | Dedicated lint CI gate + pre-commit already exist; assert both run | **YES** |
| R3 | #5 changes cache-key semantics (under/over-invalidation) | Medium | 63–67 projects' cache correctness | Architect review before landing; verify affected sets both ways | **YES** |
| R4 | `sync-deps-check` misses drift `sync-deps` fixes | Medium | Dependency correctness | Negative control (drift → red) required | **YES** |
| R5 | #1 branch (`c0df5491`) has a test race fix that regresses | Low | `agent-engine-compiler` tests | Bounded affected test run (≤17 projects) before merge | YES |
| R6 | Hook blocks validation commands during repair | High | Cannot run targeted commands | Use `nx affected -t <t> --files=<path>` (allowed); never rely on blocked shapes | NO |
| R7 | **Nx 18 ignores `--dry-run` on `run-many` and executes anyway** | Certain | Any "dry" validation actually runs | No gate may rely on dry-run; use `createTaskGraph` (non-executing) for counts | **YES** |
| R8 | Backlog store degraded → findings unfiled | Certain (observed) | Traceability only | Ops triage of `~/.adhd/backlog/production`; do not block repair on it | NO |
| R9 | Measurement contamination (load 25–73, ~35 worktrees) | High | Any wall-clock claim | Only structural metrics are load-independent; wall-clock needs a quiet box + interleaving | **YES** |
| R10 | Full-suite test exhausts machine memory (already happened) | Medium | Whole box | Bound test runs to ≤17 projects, `--parallel=1`, never two worktrees at once | **YES** |
| R11 | Upgrade-specific (retained, if D proceeds): 6 plugins on removed v1 `createNodes` | Certain | Whole project graph fails to load | Adaptive shim pre-landed on `main` (D1) | **YES** |
| R12 | Upgrade-specific: ESLint 9 flat-config incomplete | Certain | 16+ lint targets, cascades to build | Full D3; preserve type-aware parserOptions + per-project deps | **YES** |
| R13 | Upgrade-specific: 2 apigen tsc regressions (mechanism unknown) | High | 2 build targets | `debug` triage first; never `@ts-ignore`; never direct `tsc` | **YES** |
| R14 | Upgrade-specific: `nx migrate` bumps React/Next/Jest anyway | Medium | Reintroduces Track-C churn | Hand-hold versions between generate and install; diff `package.json` before install | **YES** |
| R15 | `.githooks/pre-commit` runs `nx affected -t lint/test` → broken graph blocks commits during any upgrade | High | Developer workflow | Land config fixes on `main` first; use `--no-verify` only for upgrade-branch commits | NO |

---

## 12. Effort & sequencing

| Phase | Effort | Depends on | Parallelizable with |
|---|---|---|---|
| **A — config repair** (A1–A4) | **0.5–1 d** | in-flight validation of #3 | — |
| A5 / A6 (scoped inputs / release) | 0.5 d | A1–A4 | each other |
| **B — hook ticket** | 0.25 d | A | — |
| **C — re-measure & decide** | **0.5–1 d** | A | — |
| **D — upgrade (conditional)** | **9–15 d** | C says go | — |
| **Total (config-only path)** | **≈ 1.5–2.5 d** | | |
| **Total (if upgrade proceeds)** | **≈ 11–18 d** | | |

**The config-only path is ~1.5–2.5 days and delivers the task-count + cache wins today.** The
upgrade adds ~9–15 days and only if Phase C proves a version-bound benefit.

---

## 13. Rollback

| Change | Rollback | Notes |
|---|---|---|
| #3 (9 scripts) | restore the 9 lines | Zero-risk; scripts are redundant |
| #1 (branch) | `git revert` merge commit | Includes the test race fix |
| #2 | restore `"lint"` in both arrays | Restores build→lint gate |
| #4 | restore `["sync-deps"]` | Re-introduces the mutation hazard |
| #5 | restore the two `sharedGlobals` entries | — |
| #6 | restore `"^test"` | — |
| Hook | revert the hook/settings change | Enforcement returns to full block |
| Upgrade (D) | dispose of the upgrade worktree | `main` untouched until merge; never `git reset --hard` / `git clean -fd` / `git stash` |

Every Phase-A change is a 1–3 line revert and independent of the others.

---

## 14. Hard gates

1. **G-count:** every Phase-A fix asserted with `createTaskGraph` counts (before/after) and
   `nx show projects --affected --files=` cross-checks.
2. **G-cache (#3):** all 9 targets report `build.cache === true`; two consecutive builds →
   **58/58 cached** on Nx 18.3.4.
3. **G-#1:** all-suite test task count **234 → 140**.
4. **G-#2:** test closure **−20**; `build --all` **97 → 63**.
5. **G-#4:** negative control red; `git status --porcelain` clean after `nx affected -t lint`.
6. **G-#5:** plugin edit no longer invalidates test caches; build invalidation preserved.
7. **G-hygiene:** no `--skip-nx-cache`; no direct `tsc`; no destructive git; worktrees under
   `.worktrees/`.
8. **G-decision:** upgrade proceeds **only** if §4.3 is satisfied by a real measurement.

---

## 15. Human decision points (with recommendations)

1. **Config repair first, upgrade deferred?** → **Recommend: yes.** The migration's only
   measured benefit is a config bug; repair it (~1.5–2.5 days), then decide.
2. **Proceed with the Nx 23 upgrade?** → **Recommend: not yet — decide by measurement.** Only
   if cross-worktree cache sharing (§4.2) or daemon memory proves material. Default: **defer.**
3. **Spike worktree `.worktrees/nx-perf-upgraded`?** → **Recommend: mine then discard**; it is
   not mergeable (§8.1). Keep `.worktrees/nx-perf-baseline` until go/no-go.
4. **The PreToolUse hook?** → **Recommend: its own ticket**, reword the deny to point at
   `nx affected -t <t> --files=<path>` (zero enforcement loss); consider relaxing to warn only
   if cost persists. Do not bundle into the Nx plan.
5. **`@monodon/rust`?** → **Recommend: leave it alone unless D proceeds** (no Rust projects
   exist; removal is zero-risk but only relevant to the upgrade).
6. **Record a toolchain-version-policy ADR?** → **Recommend: yes**, proposed as
   `docs/decisions/0001-nx-toolchain-version-policy.md`; needs approval before the directory
   or file is written.
7. **Backlog store?** → **Recommend: ops triage**; it is blocking traceability, not the repair.

---

## 16. Known gaps / unverified — do not treat as resolved

- **The #3 fix is NOT yet validated.** A separate agent is validating the 9-script deletion
  **right now**. Until it returns, "the config fix recovers the cache on Nx 18.3.4" is a
  **proven mechanism with a pending end-to-end confirmation**, not a confirmed result. Do not
  assume it works; gate on G-cache.
- **The walltime benefit of #1/#2 is unverified.** The task-count delta (234→140) is exact; the
  only same-session wall comparison was load-contaminated. Expect the wall win to be largest
  for warm/serial/contended runs.
- **Cross-worktree cache sharing, daemon memory, V8 compile cache, native TS loading are all
  documented-but-unmeasured** (§4.2). None may be cited as a benefit until measured.
- **#5 changes cache-key semantics** and is explicitly flagged for architect review.
- **`gx` cannot analyse any of these changes** — config files are `File` stubs with no parsed
  symbols; blast radius is structural, not graph-derived (§6).
- **`sync-deps` config-resolution failure** observed in the spike (`.eslintrc.base.json`
  "not found" despite the file being present) has an **unestablished** cause; it only matters
  if D proceeds (D3).
- **`verify-dist-load/plugin.js`** requires a non-existent module and is referenced but not
  registered — `(unverified)`, possible broken release path; mine it regardless of the upgrade.
- **Backlog findings remain unfiled** (store degraded). This plan's items exist only here until
  the store is triaged.
- **The `--dry-run` hazard** means any future validation must use non-executing graph
  computation, never a dry-run flag, on Nx 18.
