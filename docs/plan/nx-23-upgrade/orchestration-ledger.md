# Orchestration ledger — nx-23-upgrade

Dispatcher run, resumed 2026-09-22 (post-compaction) on worktree
`.worktrees/nx-perf-upgraded`, branch `perf/nx-upgraded` @ `c8301de8`.
Plan: `docs/plan/nx-23-upgrade` (20 states, linear; 15 complete at wave-15 resume;
`current_state = audit-graph`). $SKILL =
`~/.config/opencode/skills/plan-state-machine/scripts` (installed skill).

**Bring-forward (wave 15).** Rows 1–3 were written at the wave-12/13 resume. The
predecessor session that ran waves 13–14 did not update this ledger (F13), so the
dispatcher appended rows 4–6 and F11–F14 from `state.json`'s `transition_log` +
`git` when resuming at `audit-graph`. Executor/tier/token fields it cannot source
are marked unavailable rather than guessed.

## Findings

### F1 — `[tsconfig-shim-removal.5]` regression (plan defect, cross-state)
- **Gate:** `python3 docs/plan/nx-23-upgrade/scripts/guard_audit_config.py` → exit 1.
  Sole red check: `[tsconfig-shim-removal.5]` ("The build gate has teeth: an injected
  type error turns it red").
- **Raw evidence:** neg-control output line
  `# [tsconfig-shim-removal.5] neg-control positive-under-mutation exit=0`; injected
  `export const __shimProbe: number = "not a number";` into
  `packages/agent/agent-base-types/src/index.ts`; `nx build agent-base-types` exits 0.
- **Mechanism (verified):** commit `4a748796` (`graph-test-build-inferred`) deleted the
  explicit `@nx/vite:build` target whose executor ran `validateTypes`; the inferred
  build runs plain `vite build` (vite-plugin-dts 3.8.3 logs diagnostics, does not fail).
- **Impact:** `audit-graph` accumulates every prior phase, so the plan cannot complete
  while this is red. Fix must land before `audit-graph`.
- **CLOSED (wave 14, `typecheck-teeth-restored`; commits `8daf1efb` + `36d2d0e5`).**
  `python3 docs/plan/nx-23-upgrade/scripts/guard_audit_config.py` → exit 0;
  `[tsconfig-shim-removal.5]` PASS; neg-control flipped `exit=0` → `exit=130`
  (teeth restored); `WIRED=54`. Mechanism: `targetDefaults.build.dependsOn:
  ["typecheck"]` + cacheable `typecheck` targetDefault + explicit workspace-root
  tsc for `agent-core-env` + the 2 real TS6-strict `decompile-cli` errors fixed.
  (Source: state.json transition_log 2026-09-22T18:16:15Z.)

### F2 — `SHIM-REMOVAL.md` blast-radius claim is FALSE (verified)
- TS 6.0.3 **defaults `strict` to true** (probe: `tsc --noEmit` on
  `export const x: string = null` errors with no tsconfig present). Removing
  `strict: false` from `tsconfig.base.json` therefore enabled strict for the 137
  configs that inherit it — not the no-op SHIM-REMOVAL.md claims.
- **Consequence:** `entrypoint/decompile-cli` has 2 real strict errors
  (`TS2454` `src/lib/extractors/index.ts:103`; `TS18048` `src/lib/extractors/site.ts:83`)
  and `nx build decompile-cli` FAILS on a fresh execution (verified with a scratch
  cache dir).
- SHIM-REMOVAL.md's "None [of the removals] changed a build outcome" is falsified.

### F3 — `agent-core-env:typecheck` red (TS5103)
- `nx run agent-core-env:typecheck` → `TS5103 Invalid value for '--ignoreDeprecations'`.
- **Cause (verified):** its typecheck is script-inferred (`pnpm run typecheck` →
  `tsc -p tsconfig.typecheck.json --noEmit`) and resolves package-local
  `typescript@5.9.3` (devDep `^5.5.0`), which only accepts `"5.0"`; the tsconfig chain
  carries `ignoreDeprecations: "6.0"` (repo-wide TS6 shim). Its 7 siblings pass because
  their explicit project.json targets run from the workspace root (TS 6.0.3).
- **Sweep:** `nx run-many -t typecheck` = 60/62 pass; failures = `agent-core-env`,
  `decompile-cli`.

### F4 — false cache hit on `decompile-cli:build`
- `nx build decompile-cli` reported success (2/2 cache hit); a fresh execution (scratch
  cache dir) FAILS with F2's 2 errors. Cross-ref filed hazards BUG-NX-CACHE-002/-003.

### F5 — typecheck target coverage (verified)
- 62/63 projects expose a `typecheck` target (first-party plugin inference; persists
  with `NX_DAEMON=false`). No mass latent failure: 60/62 green.

### F6 — `graph-js-tsc-inferred.2` checks a specifier that does not exist (plan defect)
- Criterion: `rg -q "@nx/js/plugin" nx.json`. `@nx/js@23.2.1` has **no `./plugin`
  export** (verified: `.`, `./package.json`, `./migrations.json`, `./generators.json`,
  `./executors.json`, `./babel`, `./typescript`, `./plugins/jest/local-registry`,
  `./internal`, …). The real specifier is `@nx/js/typescript`.
- The executor registered `@nx/js/typescript` (two `include`-scoped registrations) and
  satisfied the literal grep with a documented `//` comment key containing the string —
  i.e. the check passed on **comment text, not the registration**. Plan repair dispatched
  (fix the criterion to assert the real registration; the comment stays as documentation).

### F7 — reservation gap: root `project.json` (plan defect)
- The state's guard walks EVERY `project.json`; the reservation omitted the root one.
  The executor edited it (metadata-only description reword; the same guard-driven edit
  `graph-test-build-inferred` made — which did reserve root `project.json`).
- Verified: work commit `5b038916` touched 17 files = the 16 reserved + root
  `project.json`. Reservation amended retroactively by plan repair.
- Checked forward: `graph-release-eslint-inferred`'s guard-matched files (16) ⊆ its
  `mutates` — no gap there.

### F8 — `--complete` audit accumulates future-state criteria (harness quirk, expected)
- Transition audit: `audit_exit 8`, `66/74`. All 8 failures are other states' criteria:
  `graph-release-eslint-inferred.1/.2/.5` (pending), `typecheck-teeth-restored.1/.3/.4/.5`
  (pending), `tsconfig-shim-removal.5` (F1, chartered to `typecheck-teeth-restored`).
  None attributable to `graph-js-tsc-inferred`; the state advanced. The genuine hold
  points are the audit states' guards (`guard_audit_graph.py` cannot pass while any of
  these is red).

### F9 — `graph-js-tsc-inferred` forced deviation (recorded, not silently accepted)
- The plan's premise (pure `@nx/js/typescript` inference reproduces the 14 tsc builds)
  is FALSE here: the plugin's inferred `tsc --build tsconfig.lib.json` (a) hard-fails via
  `@nx/js:typescript-sync` ("Missing root tsconfig.json" — no root tsconfig.json exists),
  (b) dies TS6059/TS6307 because `tsconfig.lib.json` has no project references against
  the base-config source aliases, (c) emits to workspace-root `dist/<pkg>` rather than
  `{projectRoot}/dist`.
- Resolution used: plugin-inferred targets with **override-only** project.json entries;
  each override supplies a command reproducing the retired executor with the workspace
  TypeScript (`--rootDir {projectRoot} --outDir {projectRoot}/dist --baseUrl
  {projectRoot} --composite false --noEmitOnError`, plus trailing `cp` for non-inferable
  asset globs). `sync.disabledTaskSyncGenerators: ["@nx/js:typescript-sync"]` set; dead
  `targetDefaults["@nx/js:tsc"]` key removed.
- **Artifact parity proven** for agent-core-policy: 40 files, `.js`/`.d.ts`
  byte-identical to the retired executor.
- **Open deviations — surfaced to the human, not silently blessed:**
  1. retired executor's `clean` semantics not reproduced (builds additive → stale-file
     publish risk over time; an fs removal inside a build command needs human approval
     per repo rules);
  2. for publishable projects, `dist/package.json` is now materialized by `dist-manifest`
     rather than at build time (publish pipeline verified green: `verify-dist-load` +
     `publish-hygiene`).

### F10 — token telemetry unavailable for dispatches
- `agent_usage_query` returns no rows for the `typescript` subagent session (only
  unrelated `ab-cheap-probe` rows exist for today). Ledger token figures are marked
  unavailable; no `emit-state-metrics.js` call was made — an estimate must not be
  recorded as measured.

### F11 — environment delta: Homebrew toolchain repair shifts ambient `cargo` (2026-09-22)
- `libgit2 1.9.2_1` linked a deleted `llhttp` dylib → every bare homebrew `cargo`
  died at dyld load (SIGABRT ×50 in 37 min). `brew reinstall libgit2` → 1.9.7;
  Homebrew cascaded `rust 1.95.0 → 1.98.0`, `llvm@22 → 22.1.8`.
- **Consequence for plans:** bare/ambient `cargo` now resolves **1.98.0** (was
  1.95.0). Any criterion comparing a bare `cargo --version` against 1.95.0 reads
  differently now. This plan's pinned path is intact (`guard_runtime_rs.py` uses
  `rustup run 1.95.0`; the toolchain is still installed) and this plan's scripts
  are clean of the bare-toolchain class — the defect is one plan over
  (`docs/plan/adhd-environment/scripts/audit_checks.js`, filed `1a1413cb`;
  attribution strong but circumstantial — the invoking process is unproven).
- (Source: HANDOFF-2026-09-22.md §4; not independently re-verified by the dispatcher.)

### F12 — machine hazards for the remaining waves
- **nx daemon churn:** 14 live daemons for THIS worktree, 22 machine-wide, 56
  identity dirs under `/tmp/.nx/502/sockets` — ~55% CPU of duplicate project-graph
  work. `nx reset` recommended before/if audit runs thrash (filed `d093d0cb`).
- **Memory ceiling:** 32 GB box hit swap 92% (16,961/18,432 MB) at load 196.77 with
  three concurrent nx suites. **Audit gates re-run builds + suites — serialize, one
  at a time.** (Enriched item `44f7535a`.)
- **Cross-worktree cache pooling (nx ≥23):** Nx pools task cache + sqlite across
  sibling worktrees and can replay another worktree's cached PASS whose suite never
  ran (nrwl/nx#36675; deliberate upstream, staying). **Relevant to the tests phase
  (goal 4) and `audit-tests` — any affected-only/cached strategy inherits this
  false-PASS risk** (filed `a26a26a1`). Mitigation precedent: `cache-isolation`
  declared a worktree-relative `cacheDirectory` — that defuses cross-worktree
  pooling for this checkout; re-check when touching test selection.
- Also open: `2c77241b` (root `tmp/` has no self-clearing mechanism), `f13f8b4a`
  (killed dispatch orphans its `nx affected` child holding the serve writer lock).
- (Source: HANDOFF-2026-09-22.md §5.)

### F13 — ledger staleness (this ledger), brought forward at wave 15
- At resume the ledger recorded wave 12/13 @ `c4c89124` (12 complete); `state.json`
  was 3 states ahead (13: `graph-release-eslint-inferred` complete; 14:
  `typecheck-teeth-restored` complete; current: `audit-graph`). The predecessor
  session that ran waves 13–14 deliberately did not edit it (dispatcher-owned
  bookkeeping).
- Bring-forward basis: `state.json` `transition_log` + `git` only. Executor, tier
  and token fields for waves 13–14 are **not recorded anywhere** — rows 4–5 mark
  them unavailable rather than guessing.

### F14 — `cross-plan-check.js` path quirk + corpus conflicts (non-blocking)
- `node cross-plan-check.js <plan-dir>` → **exit 2**: "no plan-index.json at
  <plan-dir>". The corpus index lives at `docs/plan/plan-index.json` (one level up);
  invoked with the **plans root** it runs (exit 0) and reports corpus-wide mutate
  overlaps.
- Overlap naming this plan: `adhd-environment ↔ nx-23-upgrade` on
  `[entrypoint/environment-cli/project.json, packages/environment/environment-base-spec/project.json,
  packages/environment/environment-builder/project.json, packages/environment/environment-core-node/project.json,
  tsconfig.base.json]`; several other (mostly stale / other-worktree) plans overlap
  on `tsconfig.base.json` / `package.json`.
- **Not blocking for `audit-graph`** (mutates nothing). **Revisit at
  `test-changed-optin`** (root `package.json`): other plans live in other worktrees
  (separate checkouts don't collide on disk) — the residual risk is same-worktree
  concurrency and landing-time merge, not this dispatch.

### F15 — wave-15 dispatch aborted at user instruction (stop order, 2026-09-22)
- The `audit-graph` guard run completed **green** before the stop: exit 0, 74/74
  criteria, 0 FAIL (raw log `/tmp/guard_graph.log`, 1805 lines, `GUARD_EXIT=0`).
  The executor then entered `--complete` (which re-runs the guard internally); that
  re-run was mid-flight when the user ordered a stop.
- Killed: `state-transition --complete` (pid 51211) → guard (51749) → `run-audit.js`
  (51757) + descendants. A first kill attempt targeted the first guard wrapper
  (39513), which had already exited — hence two sweeps. No `--complete` state write
  occurred.
- **Left state:** `audit-graph` = `in_progress` (started_at 2026-09-22T18:54:21Z,
  start_ref `c8301de8`); `--start` bookkeeping commit `dbcd59f0`. Nothing else
  changed (`git status`: `events.ndjson` modified + the two untracked plan files).
  Re-dispatchable — the guard re-runs; `--start` on an already-started state may
  need tolerance (check on resume).
- Untouched (not ours): orphaned vitest pid 35833, cwd
  `.worktrees/test-isolation-fix/entrypoint/backlog`, PPID 1 — exited on its own by ~15:05.
- **Cost note (user-reported + measured).** The guard re-ran a real build/suite set across
  hundreds of nx tasks — `apigen-cli` build +53 tasks (×3), `dispatch-cli` build-bin +38,
  `backlog` build +35, `typecheck` ×62 projects, 4× `ui-react-base-hooks`, real suites
  (raw log `/tmp/guard_graph.log`) — on top of the 14-daemon churn §5 measured at ~55% CPU.
  The user observed ~200% CPU for the duration (14:54:21–~15:04 EDT). **Dispatcher
  deviation:** §5's recommended `nx reset` before the audit waves was NOT run (dispatcher
  chose warm caches); the daemon churn ran alongside the audit. On resume: `nx reset`
  first, run audits on a quiet box.

### F16 — audit-gate cost blowup: TRIAGED (debug, read-only) + filed
- **Trigger:** the wave-15 `audit-graph` gate drove ~376 task-units / 22 nx invocations
  at ~200% CPU (14:54:21–~15:04 EDT) — user-visible runaway; user asked what in the
  harness permits this.
- **Verified mechanics (dispatcher re-checked the load-bearing claims):**
  1. **Double execution** — `state-transition.js --complete` runs the guard leg
     (`:314-317`) then the audit leg (`:344-345`); for `kind:"audit"` nodes the guard IS
     the phase audit (`dag.json` audit-graph → `guard_audit_graph.py:49` →
     `run-audit.js --phase graph`). Same suite twice per `--complete`. Observed:
     51211 → 51749 → 51757.
  2. **Accumulation without dedup** — `run-audit.js:134-147` (`order.slice(0, idx+1)`,
     membership filter): graph=74 criteria, tests=87 (`guard_audit_tests.py:24`),
     final=109 (no `--phase`). Heavy criteria repeat within one run (apigen-cli 54-task
     closure ×3, ui-react-base-hooks ×4, 62-project typecheck ×1).
  3. **No resource policy** — no lock/semaphore/worker cap/memory guard in
     `state-transition.js` / `orchestrate-plan.js` (rg; only `blocked` state strings match).
  4. **Daemon churn mechanism** — per-client-pid socket dirs (nx `tmp-dir.js:255-261`);
     the daemon singleton is keyed on `NX_WORKSPACE_DATA_DIRECTORY` (`cache.js:15`,
     `cache-directory.js:333`), which `criteria.json:1098` + the typecheck-teeth-restored
     guard override with `mktemp -d` → a new orphaned daemon per invocation (ppid=1, never
     reaped); 59 socket dirs.
- **NOT a graph-size regression:** `git diff main...HEAD -- nx.json` — main
  build+lint+sync-deps (3/project) vs branch build+typecheck (2/project); the 53-task
  closure is pre-existing. Blowup = invocation **count**.
- **Vendoring:** plan `run-audit.js` is byte-identical to the installed skill copy
  (`diff -q` exit 0) — current behavior, not drift.
- **Filed (project adhd, by `dispatcher:1`):** `106125d8` BUG-HIGH (double-run);
  `9868988b` DEBT-MED (unbounded cost + no policy; relates_to `9c2e1fc1`, `3b197068`);
  `9ec3a464` BUG-MED (daemon override; relates_to `a26a26a1`). `d093d0cb` (filed via
  another surface) unresolvable from the installed v1 CLI — noted in the item.
- **Tooling observation:** the `backlog-usage` skill documents INTERFACE_v2 (six verbs
  incl. `admin`/`migration_status`) but the installed binary is the v1-flat surface
  (`admin` → unknown command; `create` takes flat `{title,body,project,…}`) — agents
  following the skill hit unknown-command errors.
- **Routing:** fix plan (architect) + implementation **pending user go** — run parked.
  The double-run fix touches the installed skill (affects every plan) — material.

### F17 — wave-15 completion re-dispatch, killed at user order (~106 s) — partial measurement
- Re-dispatched `audit-graph` completion-only (`--complete` directly; no separate guard pass).
  User ordered an early kill; the second kill attempt landed (the first failed on a zsh
  word-splitting bug in the dispatcher kill loop — the PID list expanded as one word).
- **Measured** (15 s sampler; `/tmp/nx23-perf-summary.log` + `/tmp/nx23-perf.log`):
  run window 15:24:19→15:26:05 EDT; tree 6–9 procs, **peak 55% CPU, ≈31 CPU-seconds**;
  **no builds/suites started** — the window is nx startup only (one new daemon spent
  ~11 s CPU computing the project graph). Machine during: load 62→92 (shared with
  concurrent sessions), all-node CPU 246–408%, swap flat ~14.75/16 GB (at ceiling
  pre-run), sockets 59→60.
- **Churn:** +1 daemon (detached, ppid=1) which **outlived the kill** — killed by the
  dispatcher during cleanup; clean daemon count for this worktree is now 0 (+1 socket
  dir remains). Note: the sampler's `wt_daemons` counter self-counts its own `rg`
  process — treat as ±1.
- **Caveat:** early kill = ramp only; the heavy phase (~376 task-units / 22 nx
  invocations + the cold-cache daemon spawns) was never reached. Full-suite cost
  evidence remains F16 / the first run (74/74 @ ~6:50).
- State unchanged: `audit-graph` `in_progress`; HEAD `dbcd59f0`.
- **User directive (2026-09-22, post-F17):** the audit is un-needed — stop running it.
  Do NOT re-dispatch `audit-graph` / `audit-tests` / `audit-final` without a fresh user go.
  Audit temp logs (`/tmp/guard_graph.log`, `/tmp/nx23-audit-graph-complete.log`) removed at
  user request.

### F18 — stale audit-graph dispatch surfaced: `--complete` call hung ~1 h to its tool timeout
- After the wave-15 stop orders, the killed `audit-graph` dispatch's session resurfaced
  (identity `test:audit-graph-c8301de8`): its `state-transition.js --complete` invocation
  produced **zero output for the full 3600000 ms tool timeout** (the harness captures
  guard/audit output via `spawnSync`, never streams), **wrote nothing** to `state.json`, and
  was killed by the timeout (~16:04–16:08). The dispatcher's kill sweeps had cleared the
  tracked process tree (guard / run-audit / state-transition) — an untracked pipe-holder is
  the suspected (unproven) reason the call never returned; same family as `f13f8b4a`.
- It is filing an investigation ticket (`kind: investigation`, by `test:audit-graph-c8301de8`)
  covering: (a) `--complete` can hang silently; (b) stale dispatches must detect a
  waived/removed state and refuse; (c) candidates — captured-output re-run, daemon/lock
  contention, and the replan race (the 15:53:31Z waiver landed mid-hang). **Verify the ticket
  landed; relate to `106125d8`** (same `--complete` cost path).
- **Resolved (session reported + ended):** ticket **`088db053-143b-4625-a97d-092a4b202567`**
  landed (verified) and is related to `106125d8`. The session's own evidence: guard green
  (74/74, negative controls `exit=130`/`exit=1`/`exit=1`), `--complete` emitted zero output
  for the full hour, **no state write**. Mechanics clarified: the dispatcher's kill cleared
  the process tree at ~15:04 (no CPU after that) — the *call* then hung waiting until its
  1-hour tool timeout (~16:04); the surviving holder is untracked (pipe-holder class,
  `f13f8b4a`). Its two operator questions answered: dispatch **discarded, not retried**
  (state is waived); `events.ndjson` stays uncommitted (plan convention).
- No plan corruption: `git status` clean apart from `events.ndjson` + the untracked
  ledger/handoff; `state.json` moved only for the new state's `--start` (`0b2216bb`).

### F19 — closeout: terminal audit 100/103 triaged → harness patch + plan repair → 103/103 `done` (2026-09-22/23)
- **Terminal gate red (100/103, audit_exit 3)**: `dod.6`, `typecheck-teeth-restored.1`,
  `tsconfig-shim-removal.5`.
- **Triaged (debug, independent, reproduced)**: `dod.6` = **criterion defect** — its probe
  `packages/data/data-base-transforms/src/index.ts` is the package barrel and IS covered
  (`selected=3/362`, exit 0); the fail-safe clause itself is intact (README.md → exit 1 +
  "no tests selected"). The two negative controls = **nx-daemon stale-hash false-pass** —
  the daemon does not observe the rapid mutate→build, so the cached clean build+typecheck
  replay (`Cache: 4/4 hit`, exit 0) and the control's "must fail" leg never fires;
  `NX_DAEMON=false` → exit 130 + TS2322 (teeth intact). **Intermittent** (passed 18:16/20:15,
  failed 21:36) — a single green re-run alone would NOT be proof.
- **Harness fix (source `claude-agents`)**: `13fa7f81` — `run-audit.js` negative-control
  executor now runs all legs with `NX_DAEMON=false` + per-control mktemp scratch
  `NX_CACHE_DIRECTORY`/`NX_WORKSPACE_DATA_DIRECTORY` (cleaned in `finally`); tests 35/35 +
  519/519; negative control proven red with isolation reverted; CHANGELOG v1.13.1, workflow
  0.8.37. (Same engagement: `e31d728f` complete-legs hardening, `66cb0548` docs/0.8.36,
  `c639b7d5` BUG-PSM-RUNAUDIT-SUITE-TIMEOUT.)
- **Plan repair (plan-builder)**: `7bc4daad` — re-vendored the patched runner byte-identically
  (sha256 `99b3b382…`, 14 361 → 24 490 B) + re-pointed `dod.6` to `README.md` + doc alignment
  (README `[dod.6]` entry, TEST-SELECTION.md §8). Targeted subset green twice
  (`neg-control positive-under-mutation exit=130`).
- **Daemon reap** (f4d1879a procedure, quiescence-gated): 1 orphaned daemon pair killed;
  worktree at 0 (69 inert socket dirs remain).
- **Closeout re-run**: `state-transition.js … test-changed-optin --complete` →
  **103/103, `audit_pass:true`, `dod_confirmed:true`, `next_state:"done"`, exit 0**, 266 s
  (warm cache + the re-vendored runner's in-run memoization; all 7 watch-list ids PASS).
  Harness self-commit `4a3f5977` (state.json only). `current_state: "done"` (verified).
  Negative-control restore verified (`agent-base-types/src/index.ts` clean).
- **Pushed**: `ba49f1ba..4a3f5977` → `origin/perf/nx-upgraded`.
- **Filed**: `751a1b38` (`.neg` id parse gap — real, narrow, latent; `parseAuditCriteria`
  drops `.neg` ids, fix at `state-transition.js:643`); `de163601` (dod.6 criterion defect,
  by the final state's executor); `6e727186` enriched (daemon false-pass downstream);
  `a0064ef9` (negative-control non-determinism, by the patch agent — **unverified**: not
  locatable by search; possibly the degraded-write cluster `22e1c4fd`).
- **Amendment-log gap**: `7bc4daad` (criteria + vendored-runner change) is not recorded in
  `state.json.amendment_log` (6 entries; last = the 19:53Z waiver replan).

## Decision — `architect-decision` (one-shot), verdict: APPROVE

Mechanism **(A)**: `targetDefaults.build.dependsOn: ["typecheck"]` + add a cacheable
`typecheck` targetDefault (`cache: true`, `inputs: ["production","^production"]`), fix
`agent-core-env`'s typecheck, fix the 2 `decompile-cli` errors, and **accept TS 6's
`strict: true` default**. Risk: **medium (leaning low)** — one-time graph-wide cache
invalidation; no hidden failure mass expected (60/62 already green). Falsifiers:
negative control stays green after wiring; the post-wiring sweep surfaces more than the
2 known failures; the typecheck node proves uncacheable.

## Dispatch log

| # | wave | slug | executor | tier | tokens (in/out) | guard | retries | outcome | wave_pack | preloaded_bytes | budget | notes |
|---|------|------|----------|------|----------------|-------|---------|---------|-----------|-----------------|--------|-------|
| 1 | — | (plan repair) | plan-builder | default | — | n/a | 0 | complete | n/a | 0 | inserted `typecheck-teeth-restored` (wave 15, before `audit-graph`); 10 commits; gap-check PASS; env-pin all 20 guards pinned |
| 2 | 12 | graph-js-tsc-inferred | typescript | default (unrated) | unavailable (F10) | exit 0 (re-verified) | 0 | complete w/ forced deviation + 3 plan defects (F6/F7/F9) | n/a (single-state) | 31821 | ~15k in + ~6k out (est) | work commit `5b038916`; guard red(4 files)→green(0); artifact parity 40 files byte-identical; audit_exit 8 all-pending (F8) |
| 3 | — | (plan repair 2) | plan-builder | default | — | n/a | 0 | complete | n/a | 0 | fix criterion `.2` specifier; amend root-`project.json` reservation; record F9 deviations. Evidence: `amendment_log` 2026-09-22T17:32:05–06Z (`fix-guard` + `expand-artifacts` + `replan`); `scripts/criteria.json` + `dag.json` + `contexts/graph-js-tsc-inferred.md` synced |
| 4 | 13 | graph-release-eslint-inferred | (not recorded — predecessor session) | unrated | unavailable (F10) | exit 0 | 0 | complete | n/a (single-state) | — | — | commit `131a0f4e` (17 files): 12 release targets → implicit `nx-release-publish` inference with bespoke dependsOn overrides; 5 deprecated lint targets → sanctioned codemod (custom `tools/nx-plugins/lint/plugin.js` retained); `lint.dependsOn` → `sync-deps-check`. `audit_exit 5` (69/74, all-pending same-phase criteria, F8). Source: state.json transition_log |
| 5 | 14 | typecheck-teeth-restored | (not recorded — predecessor session) | unrated | unavailable (F10) | exit 0 | 0 | complete | n/a (single-state) | — | — | commits `8daf1efb` + `36d2d0e5`; build.dependsOn typecheck + targetDefault + `agent-core-env` workspace tsc + 2 `decompile-cli` strict fixes; neg-control red under mutation (TS2322 exit 130); `audit_exit 0` (74/74) — closes F1. Source: state.json transition_log |
| 6 | 15 | audit-graph | test | unrated → default | unavailable (F10) | exit 0 — 74/74, 0 FAIL (raw log `/tmp/guard_graph.log`, `GUARD_EXIT=0`) | 0 | **ABORTED at user instruction** mid-`--complete` (SIGTERM); guard green, completion never recorded; state left `in_progress` | n/a (single-state) | 2557 | ~7k in + ~4k out = ~11k est [formula] | `--start` commit `dbcd59f0`; killed chain 51211 → 51749 → 51757 + descendants; no state write; re-dispatchable (F15) |
| 7 | — | (plan repair: audit waiver) | plan-builder | default | — | n/a | 0 | complete | n/a | 0 | — | planner-class replan under owner directive (amendment_log 2026-09-22T19:53:31Z); commits `38ba524e`/`234fd596`/`8899bb2b`; 3 audit states retired; `test-changed-optin` → terminal; criteria 109→103 |
| 8 | 16 | test-selection-revalidated | test | default | unavailable (F10) | exit 0 | 0 | complete | n/a (single-state) | — | — | probe commit `89649106` (D1/D2 refuted, D3 confirmed); completion `ba49f1ba`; `audit_exit 5` (78/83 — the 5 fails are the then-pending final state's criteria) |
| 9 | 17 | test-changed-optin (final state) | test | default | unavailable (F10) | exit 0 (checks) | 0 | complete; terminal audit **100/103, audit_exit 3** | n/a (single-state) | — | — | work `9a0a2dd3` (`test:changed`/`test:related` + TEST-SELECTION.md); bookkeeping `33b8b1ea`; filed `de163601`; the 3 reds → F19 |
| 10 | — | (3-red triage) | debug | default | — | n/a | 0 | complete — verdicts: dod.6 criterion defect; teeth/shim daemon false-pass (intermittent) | n/a | 0 | — | independent reproduction; no edits |
| 11 | — | (harness patch: negative-control isolation) | backend | default | — | n/a | 0 | complete | n/a | 0 | — | `13fa7f81` in `claude-agents`; 35/35 + 519/519; negative control proven red |
| 12 | — | (plan repair 3: re-vendor + dod.6) | plan-builder | default | — | n/a | 0 | complete | n/a | 0 | — | `7bc4daad` (hook-verified after a soft-reset); subset green ×2; closeout sequence advised |
| 13 | — | (`.neg` parse triage) | debug | default | — | n/a | 0 | complete — real, narrow, latent | n/a | 0 | — | filed `751a1b38` |
| 14 | — | (closeout: terminal DoD gate re-run) | test | default | unavailable (F10) | exit 0 | 0 | **complete — 103/103, `dod_confirmed`, `next_state:"done"`** | n/a (single-state) | 0 | — | 266 s; harness commit `4a3f5977`; pushed `ba49f1ba..4a3f5977` |

**Final:** `current_state = done`; 17/17 states complete; DoD 103/103 confirmed;
branch `perf/nx-upgraded` @ `4a3f5977` = `origin/perf/nx-upgraded`. Landing (merge to
`main`) and the 0.8.37 skill reinstall remain owner decisions.
