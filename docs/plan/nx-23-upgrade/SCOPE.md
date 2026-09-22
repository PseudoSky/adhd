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
| O3 | Vite is at the **highest supported version** | `vite@8.3.0` (latest published) installed, building, **and its built CommonJS entrypoints load and run as real processes** |
| O4 | Test selection is **file-level and fail-safe** | A changed file selects only the specs covering it; a cross-package change still selects the dependent's specs; **zero selected is a hard failure** |
| O5 | Everything is **on one branch** | All work commits to `perf/nx-upgraded`; nothing pushed, merged to the default branch, or published |
| O6 | The cache hazard is **closed** | A sibling worktree's cached PASS cannot be replayed in this checkout |
| O7 | The toolchain bump is **self-contained** | Every version bump lands in the same commit as the change that keeps the built artifact working; no commit declares a bumped toolchain over a broken artifact |
| O8 | No public package is **stranded by the upgrade** | Every workspace package that publishes still builds, and no built bundle carries a bundler artifact that throws at load |

---

## 2. Scope boundaries — explicitly OUT of scope

Agents expand scope unless the door is closed. These are closed.

- **Landing.** No merge to `main`, no push, no publish, no version bump. `audit-final` is a hold.
- **`vitest@5`.** Not reachable: `@nx/vitest@23.2.1` peers `vitest: ^3.0.0 || ^4.0.0`. 4.1.9 is the ceiling. Recorded as an interface contract, not a task.
- **`pnpm@10` (TASK-002).** Blocked on Nx parsing the v9 lockfile. This upgrade *unblocks* it; it is not this plan's work.
- **Dropping `^build` from the test path.** Measured inconclusive for wall-clock and load-bearing for the four child-process projects. Stays.
- **Dropping `lint` from `test.dependsOn`.** Removes the publish gate (BUG-060); `main` already reverted this once. Stays.
- **The PreToolUse scope hook** (`check-nx-scope.sh`). A workflow-cost defect, its own ticket.
- **Framework churn beyond conformance** — Next 16, Jest 30, React API changes. Not forced by
  this upgrade. **React 19 is already installed on the branch** (`react@19.3.0`,
  `@types/react@19.3.0`, bumped by `chore(nx): upgrade Nx 18.3.4 -> 23.2.1`), so *type
  conformance to React 19* is in scope as a consequence of goal 1 — not framework churn, and
  not optional: it is what un-breaks `ui-react-base-hooks:build`. What stays out of scope is
  adopting React 19 *features* or changing runtime behaviour.
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
| `@types/react` | `19.3.0` (bumped from `18.2.33` by the Nx-23 commit) | `require('@types/react/package.json')`; `git show main:package.json` |
| Build health | `nx run-many -t build` over the 66 JS/TS projects: **exactly one** failing target, `ui-react-base-hooks:build` (4 type errors) | ran 2026-09-21; full output read |
| Empty-import-meta sweep | `{}.url` in built bundles: **1 hit**, a *comment* in the generated `generator.js`; 22 built CJS bundles carry the shim, 11 `.mjs` keep native `import.meta.url`, **0** `.mjs` carry the shim | `rg -a` over `**/dist/**` with `--no-ignore` |
| Vite bump (uncommitted) | `~6.4.3 → ^8.3.0`, staged in the working tree | `git diff HEAD -- package.json` |
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
- A6 — The in-flight CJS fix is complete across every CJS-emitting config, and committing it with the bump leaves no broken commit. *Owned by `vite-cjs-import-meta-repair`, whose guard asserts atomicity and loads the artifacts.*
- A7 — The browser package's bundles really do carry the empty-import-meta token once it builds. *Owned by `browser-cjs-umd-repair`; the state's first step re-confirms it, because the build failure made the token unobservable at authoring time.*
- A8 — A browser-valid repair exists that does not smuggle `require`/`__filename` into a browser chunk. *Owned by `browser-cjs-umd-repair`, whose guard asserts the node shim's absence.*

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
| D16 | A version bump is committed **only** in the same commit as the change that keeps the built artifact working — never on its own | **non-negotiable** |
| D17 | A guard for a bundling/packaging change must **execute the built artifact**; a version-string or declaration comparison is not evidence | **non-negotiable** |
| D18 | The node CJS shim is never applied to a `platform:browser` bundle — its `require`/`__filename` do not exist there | **non-negotiable** |
| D19 | React 19 type conformance is fixed in the source, never by downgrading `@types/react` or muting the diagnostics | **non-negotiable** |

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
| `upgrade-baseline` | intake | Freeze the measured baseline — the bump is measured and recorded as pending, **not** committed |
| `vite-cjs-import-meta-repair` | intake | Land the in-flight CJS `import.meta.url` fix **and** the vite bump in one commit; prove the built entrypoints load |
| `browser-package-build-repair` | intake | Make `ui-react-base-hooks` build again under the installed React 19 types |
| `browser-cjs-umd-repair` | intake | Remove the empty-import-meta token from the browser package's CJS/UMD bundles |
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
(`mutates` / `read_only`), and typed acceptance criteria. 19 states, 104 criteria,
15 DoD clauses, 5 audit holds.

**The intake phase is ordered by causality, not by convenience.** The two bump-safety fixes
land before anything else measures, merges, or triages — a plan that measures a bumped
toolchain before proving its artifacts still load is the shape that hid the defect.

---

## 6. Verification criteria

Each is checkable by a concrete probe; none is "reviewed by eye".

| Outcome | Probe | Fails when |
|---|---|---|
| O1 | `nx run-many -t build --projects=agent-base-types,data-query-engine,agent-core-policy` + an injected type error must turn it red | the build goes green with a dead type-checker |
| O2 | Manifest scan → zero shadowing executors; a real suite + a real build through the inferred target | an inferred target lost its options or its artifact |
| O3 | `vite` resolves to 8.3.0, `nx build data-query-engine` exits 0, **and** `node entrypoint/apigen-cli/dist/index.js --help` exits 0 while `entrypoint/backlog/dist/index.js --help` does too | the resolved version is not what `package.json` declares, or a built entrypoint throws at module load |
| O4 | `check-cross-package-selection.mjs` (dependent's specs selected) **and** `check-zero-selection.mjs` (zero ⇒ non-zero exit) | either half regresses — a selector that misses consumers, or one that passes having run nothing |
| O5 | `git rev-parse --abbrev-ref HEAD` = `perf/nx-upgraded`; no push/merge performed | work lands elsewhere |
| O6 | Relative cache directory declared and resolving inside the checkout | an absolute or pooled path is used |
| O7 | `git log -1 --format=%H -- tools/vite-plugins/import-meta-url-cjs.mjs` equals the same query for `package.json` | the bump and its fix are separable — i.e. a commit exists that bumps vite without the fix |
| O8 | `nx run-many -t build` reports no failing target, and the CJS/UMD bundles of `ui-react-base-hooks` contain neither `{}.url` nor `__filename` | a public package is left unbuildable or shipping a bundle that throws at load |

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
| The measured baseline (versions, counts, build-health sweep) in `BASELINE.md` | Whether the newest `@nx/*` patch moved since the baseline |
| The resolved conflict policy for absorbing sibling branches (`[fix:]` in `_shared.md`) | The exact conflict hunks git presents |
| The fast-path contract, in priority order (`[shape:fast-path-contract]`) | How the executor implements the wrapper |
| Evidence tier per criterion (already declared in `criteria.json`) | — |
| The empty-import-meta token, the shim's replacement expression, and the format gate (`[def:empty-import-meta]`) | How the browser package's bundle is repaired — two viable families, the executor picks and records |
| The four React-19 type-error sites and the reason `@types/react` must not be downgraded | The exact type-level edits that conform the sources |
| That the node shim must be **absent** from a browser bundle (criterion `browser-cjs-umd-repair.1`) | — |

**Tier rule.** The graph-remodel and fast-path states want a **strong** executor
(the "what" is pinned, the "how" is theirs). The reconcile and baseline states are
mechanical and tolerate a **weak** one. `browser-cjs-umd-repair` wants a **strong**
executor — the mechanism is genuinely open. `vite-cjs-import-meta-repair` is
verification-and-commit over work that already exists, so it tolerates a **medium** one
whose only real judgment is confirming the wiring is complete. No state pins live file
contents or API signatures — those are resolve-at-dispatch.

**Pinned facts are minimal and mutually consistent.** Where two pinned facts could
conflict, the conflict is named: the cache-isolation state pins both the
correctness requirement *and* the acknowledged tension with the upgrade's
headline benefit, so the executor records a trade rather than silently picking one.
