# SCOPE — `nx-23-upgrade`

**Branch:** `perf/nx-upgraded` · **Worktree:** `.worktrees/nx-perf-upgraded`
**Base:** `f03b9aef` (3 ahead / 0 behind `main`)
**Plan kind:** brownfield · **Plans-root:** `docs/plan/`

> Authored in `build` mode. This is a **plan-state-machine** plan
> (`dag.json` + `state.json`), not a design memo. The prior art at
> `docs/plan/nx-23-upgrade/UPGRADE-PLAN.md` (main working tree, untracked) is a
> *recommendation to defer the upgrade*; the human has decided to proceed, so
> that document is treated as evidence, never as the plan. Two of its claims are
> provably stale and are corrected below.

---

## 1. Outcomes (observable end-state)

Each is a falsifiable signal, not prose intent.

| # | Outcome | Signal |
|---|---|---|
| O1 | The upgrade is **landable** | `tsconfig.base.json` carries no key `main` does not carry, and a representative build still type-checks (proven by a negative control) |
| O2 | The task graph is **remodelled** | Zero explicit executor targets that shadow a registered plugin; a real build and a real suite still pass through the inferred targets |
| O3 | Vite is at the **highest supported version** | `vite@8.3.0` (latest published) installed and building |
| O4 | Test selection is **file-level and fail-safe** | A changed file selects only the specs covering it; a cross-package change still selects the dependent's specs; **zero selected is a hard failure** |
| O5 | Everything is **on one branch** | All work commits to `perf/nx-upgraded`; nothing pushed, merged to the default branch, or published |
| O6 | The cache hazard is **closed** | A sibling worktree's cached PASS cannot be replayed in this checkout |

---

## 2. Scope boundaries — explicitly OUT of scope

Agents expand scope unless the door is closed. These are closed.

- **Landing.** No merge to `main`, no push, no publish, no version bump. `audit-final` is a hold.
- **`vitest@5`.** Not reachable: `@nx/vitest@23.2.1` peers `vitest: ^3.0.0 || ^4.0.0`. 4.1.9 is the ceiling. Recorded as an interface contract, not a task.
- **`pnpm@10` (TASK-002).** Blocked on Nx parsing the v9 lockfile. This upgrade *unblocks* it; it is not this plan's work.
- **Dropping `^build` from the test path.** Measured inconclusive for wall-clock and load-bearing for the four child-process projects. Stays.
- **Dropping `lint` from `test.dependsOn`.** Removes the publish gate (BUG-060); `main` already reverted this once. Stays.
- **The PreToolUse scope hook** (`check-nx-scope.sh`). A workflow-cost defect, its own ticket.
- **Framework churn** — React 19 / Next 16 / Jest 30. Not forced by this upgrade.
- **`docs/decisions/` ADR catalog creation.** Proposed in the prior art; needs separate sign-off.
- **Removing `@monodon/rust`.** No Rust project exists; zero value without the upgrade, and the upgrade does not need it.
- **`test:changed` as a *global* default.** Refuted by measurement (fail-open). Only the opt-in form ships.

### Adjacent, deliberately in scope (consequences, not new goals)

- **`lint` must not rewrite tracked manifests.** `lint.dependsOn: ["sync-deps"]` and `sync-deps` rewrites `package.json`. Goal 2 is *"remodel the task graph correctly"* — a check path that mutates tracked files is not correct. One criterion enforces the check-only sibling. **Flagged for confirmation at GATE 2.**

---

## 3. Constraints / assumptions

**Verified on the branch today** (re-verify before relying on any of it):

| Fact | Value | How verified |
|---|---|---|
| Nx / `@nx/*` | `23.2.1` = latest published | `npm view nx version`; `nx --version` |
| vite | `8.3.0` installed; latest published `8.3.0` | `require('vite/package.json')`; `npm view vite version` |
| vitest | `4.1.9`; latest `5.0.1`; ceiling `^3\|\|^4` | `@nx/vitest/package.json` peerDependencies |
| TypeScript | `6.0.3` | `./node_modules/.bin/tsc --version` |
| Projects | 68 | `nx show projects` |
| Explicit targets | 57 `test`, 47 `build`, 15 `tsc`, 12 `release-publish`, 5 `lint` | per-manifest scan |
| `@nx/js/plugin` | **NOT registered** in `nx.json` | `rg '@nx/js' nx.json` |
| `nx.json cacheDirectory` | **unset** | `rg cacheDirectory nx.json` |
| Root `vitest.config.ts` | `projects: ['**/*/vite.config.ts', ...]` | file read |
| pnpm / lockfile | `8.15.9` / `lockfileVersion: '6.0'` | `package.json`, `pnpm-lock.yaml` |

**Constraints:**

- Node ≥ 22.12 (vitest 5 requirement, informational); vitest 4 needs vite ≥ 6.
- `test.dependsOn` is `["lint", "^build"]` and stays that way.
- Worktrees live under `.worktrees/`; ~35 exist concurrently.
- The `test` target's cache key is the whole project (`namedInputs.default` = every file), so Nx's cache is project-granular regardless of what selection does.
- Guards must be environment-pinned (repo-local binary or `python3 <script>.py`).

**Assumptions (each falsifiable, each owned by a state):**

- A1 — Removing the compiler shims does not break the build. *Owned by `tsconfig-shim-removal`, which proves it with a negative control.*
- A2 — The absorbed config-repair branch's other commits are safe. *Owned by `config-repair-absorbed`.*
- A3 — The absorbed source-resolution fix works on this branch's newer vite. *Owned by `test-resolution-absorbed`.*
- A4 — The three post-bump gate failures have a real verdict. *Owned by `gate-triage-absorbed`.*
- A5 — A relative `cacheDirectory` actually isolates checkouts. *Owned by `cache-isolation`.*

---

## 4. Prior decisions

Labeled `non-negotiable` (architecture/compliance) vs `advisory` (preferred pattern).
Advisory decisions must not perpetuate a wrong earlier choice.

| # | Decision | Class |
|---|---|---|
| D1 | Never `--skip-nx-cache`; a clean rebuild is `nx reset` or a changed input | **non-negotiable** |
| D2 | Never invoke `tsc` directly; type-checking goes through the Nx build target | **non-negotiable** |
| D3 | Never `git reset --hard` / `git stash` / `git clean -fd`; discard one file with `git restore <path>` | **non-negotiable** |
| D4 | Never hand-edit `dag.json`/`state.json`; only the plan-state-machine scripts mutate them | **non-negotiable** |
| D5 | `test.dependsOn` keeps `lint` — `publish` reaches lint only through `test` | **non-negotiable** |
| D6 | `^build` stays in the test path | **non-negotiable** |
| D7 | A zero-selection test run is a FAILURE, never a success | **non-negotiable** |
| D8 | The narrow fast path is opt-in; the default stays full-suite | **non-negotiable** |
| D9 | The commit gate keeps its consumer-covering behaviour | **non-negotiable** |
| D10 | All work lands on `perf/nx-upgraded`; no push/merge/publish | **non-negotiable** |
| D11 | Absorb the two sibling branches rather than stacking them | **non-negotiable** (human decision) |
| D12 | Remodel all five executor families, phased with audit holds | **non-negotiable** (human decision) |
| D13 | Delete all five compiler shims; prove parity empirically | **non-negotiable** (human decision) |
| D14 | Convert targets family-by-family with a real build/test proof per phase | advisory |
| D15 | Resolve `nx.json` conflicts by intent (union globals, restored lint edge) | advisory |

### Corrections to inherited claims

Two claims in the prior art are **stale** and must not be inherited:

1. **§8.1** — *"Cannot run a single test as-migrated"* (vite left at 5.0.13). Fixed
   2026-09-19; the branch builds and tests run.
2. **§5.2** — *drop `lint` from `test.dependsOn`*. `main` reverted this ~42 minutes
   after that document was written, for BUG-060. Following it re-breaks the publish gate.

Two claims in the **plan context** are also corrected here, with measurement:

3. *"Merging as-is disables strict type checking repo-wide."* **Not supported by the
   config.** `main` sets none of these keys, and every value the branch adds is
   either a TypeScript default (`strict: false`, `esModuleInterop: false`,
   `noUncheckedSideEffectImports: false`, `types: ["*"]`) or a diagnostics
   suppressor (`ignoreDeprecations`). Measured reach: `strict` is inherited by ~14
   of the 62 base-extending configs (48 set it themselves, which overrides base);
   `types` by ~57. The shims are **far less load-bearing than their reputation** —
   but the one that suppresses real diagnostics can bite, so removal is proven
   empirically rather than asserted. **Still removed** (D13): parity with `main`
   is the goal, and a shim nobody can justify is debt.
4. *"The executor counts are 56/46/15/12/5."* Measured today: **57/47/15/12/5**.

---

## 5. Task breakdown (bounded units → plan states)

Phases: `intake` → `reconcile` → `config` → `graph` → `tests` → `final`.

| State | Phase | Bounded unit |
|---|---|---|
| `upgrade-baseline` | intake | Commit the staged vite bump; freeze the measured baseline |
| `gate-triage-absorbed` | intake | Consume the in-flight triage verdict for 3 failing targets |
| `config-repair-absorbed` | reconcile | Absorb `perf/nx-cfgfix`; keep the publish gate |
| `test-resolution-absorbed` | reconcile | Absorb `perf/test-resolve-fix` |
| `audit-reconcile` | reconcile | **Hold** |
| `tsconfig-shim-removal` | config | Remove 5 shims; prove the tree still type-checks |
| `cache-isolation` | config | Pin a relative cache directory |
| `audit-config` | config | **Hold** |
| `graph-test-build-inferred` | graph | Delete 104 shadowing test/build targets |
| `graph-js-tsc-inferred` | graph | Register the js plugin; convert 15 tsc targets |
| `graph-release-eslint-inferred` | graph | Convert 12 release + 5 lint targets |
| `audit-graph` | graph | **Hold** |
| `test-selection-revalidated` | tests | Re-run the 3-defect probe on the new toolchain |
| `test-changed-optin` | tests | Deliver the fail-safe opt-in fast path |
| `audit-tests` | tests | **Hold** |
| `audit-final` | final | **Pre-landing hold** — proves every DoD clause |

Every state has a deterministic red→green guard, an explicit reservation
(`mutates` / `read_only`), and typed acceptance criteria. 82 criteria, 13 DoD
clauses, 5 audit holds.

---

## 6. Verification criteria

Each is checkable by a concrete probe; none is "reviewed by eye".

| Outcome | Probe | Fails when |
|---|---|---|
| O1 | `nx run-many -t build --projects=agent-base-types,data-query-engine,agent-core-policy` + an injected type error must turn it red | the build goes green with a dead type-checker |
| O2 | Manifest scan → zero shadowing executors; a real suite + a real build through the inferred target | an inferred target lost its options or its artifact |
| O3 | `vite` resolves to 8.3.0 and `nx build data-query-engine` exits 0 | the resolved version is not what `package.json` declares |
| O4 | `check-cross-package-selection.mjs` (dependent's specs selected) **and** `check-zero-selection.mjs` (zero ⇒ non-zero exit) | either half regresses — a selector that misses consumers, or one that passes having run nothing |
| O5 | `git rev-parse --abbrev-ref HEAD` = `perf/nx-upgraded`; no push/merge performed | work lands elsewhere |
| O6 | Relative cache directory declared and resolving inside the checkout | an absolute or pooled path is used |

**Evidence tiers.** Behavioral clauses are proven at tier 3 (drive the real
command, assert the real observable). Structural clauses ("the shims are gone",
"the targets are gone") are proven by grep/AST — correctly, since they assert
absence rather than an interaction.

**Non-functional criteria — the 80% failure zone.** Pinned explicitly, not left
to the executor: determinism (no wall-clock gating), no timing-based concurrency
proof, exit codes over stdout, a test must not leave artifacts behind, and a
mutation must restore in a `finally` (the negative control restores with
`git restore <path>`).

---

## 7. Pinned-vs-resolve partition

The efficient-context contract for the executors this plan dispatches.

| PIN in the work-order (provide verbatim) | LET the executor RESOLVE at dispatch time |
|---|---|
| The falsifiable acceptance signal per state (the guard command) | Current file contents of every reserved file |
| Architectural invariants: `test.dependsOn` keeps `lint`; `^build` stays; zero-selection fails | Which exact lines to edit inside a manifest |
| Non-goals: no landing, no vitest 5, no `^build` removal | Which additional manifests also carry a shadowing target |
| The measured baseline (versions, counts) in `BASELINE.md` | Whether the newest `@nx/*` patch moved since the baseline |
| The resolved conflict policy for absorbing sibling branches (`[fix:]` in `_shared.md`) | The exact conflict hunks git presents |
| The fast-path contract, in priority order (`[shape:fast-path-contract]`) | How the executor implements the wrapper |
| Evidence tier per criterion (already declared in `criteria.json`) | — |

**Tier rule.** The graph-remodel and fast-path states want a **strong** executor
(the "what" is pinned, the "how" is theirs). The reconcile and baseline states are
mechanical and tolerate a **weak** one. No state pins live file contents or API
signatures — those are resolve-at-dispatch.

**Pinned facts are minimal and mutually consistent.** Where two pinned facts could
conflict, the conflict is named: the cache-isolation state pins both the
correctness requirement *and* the acknowledged tension with the upgrade's
headline benefit, so the executor records a trade rather than silently picking one.
