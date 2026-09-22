# USE_CASES — `nx-23-upgrade`

Derived from `SCOPE.md`. Each is a concrete scenario with real inputs and an
observable expected outcome — no schema-described placeholders. Tags:
`(happy)` · `⚠️ (edge)` · `🛟 (recovery)`.

Package names, file paths and version numbers below are the real ones measured on
`perf/nx-upgraded` at `f03b9aef`.

---

## A. Landability — the upgrade must not disable the type-checker (O1)

**UC-01 (happy) — A package still builds and type-checks after the shims go.**
Actor: a developer on the branch. Input: `./node_modules/.bin/nx run-many -t build --projects=agent-base-types,data-query-engine,agent-core-policy`.
Expected: exit 0; three build tasks report success; no compiler-option relaxation
present in `tsconfig.base.json`.

**UC-02 (edge) — The build gate still has teeth.**
Actor: an auditor. Input: append `export const __shimProbe: number = "not a number";`
to `packages/agent/agent-base-types/src/index.ts`, then run
`./node_modules/.bin/nx build agent-base-types`.
Expected: **non-zero exit** with a TS2322 diagnostic. If it exits 0, the
type-checker is dead and O1 is unmet. The probe file is restored afterwards.

**UC-03 (edge) — A config that inherited `strict` from base is unaffected.**
Actor: an auditor. Input: inspect `entrypoint/decompile-cli/tsconfig.json` — it sets
neither `strict` nor `types`, so before the change it inherited base's values.
Expected: after removal it falls back to TypeScript's defaults, which are the same
values; its build outcome is byte-identical.

**UC-04 (edge) — The deprecation suppressor is the one that might bite.**
Actor: a developer. Input: remove `ignoreDeprecations` from `tsconfig.base.json` and
run the representative build.
Expected: exit 0, **or** a deprecation diagnostic naming the offending option. If
the latter, the state records which option and why — it does not reinstate the shim
silently.

**UC-05 (🛟 recovery) — A shim turns out to be load-bearing.**
Actor: an executor. Input: the representative build goes red after removal.
Expected: the executor does **not** reinstate the shim, does not weaken the guard,
and does not add `@ts-ignore`. It records the failing diagnostic in `SHIM-REMOVAL.md`,
raises a planner-class amendment, and stops.

---

## B. Task-graph remodel (O2)

**UC-06 (happy) — A test target is inferred rather than declared.**
Actor: a developer. Input: `./node_modules/.bin/nx show project data-query-engine --json`
after the explicit `@nx/vitest:test` target is deleted.
Expected: the JSON still contains a `test` target, now contributed by the
registered vitest plugin.

**UC-07 (happy) — A build target is inferred rather than declared.**
Actor: a developer. Input: `./node_modules/.bin/nx build data-query-engine` after the
explicit `@nx/vite:build` target is deleted.
Expected: exit 0 and `packages/data/data-query-engine/dist/index.js` exists.

**UC-08 (happy) — A suite still runs through the inferred target.**
Actor: a developer. Input: `./node_modules/.bin/nx run data-base-transforms:test`.
Expected: exit 0 with the package's specs executed (not "no tests found").

**UC-09 (⚠️ edge) — A tsc-built project does not silently lose its build.**
Actor: an auditor. Input: `./node_modules/.bin/nx show project agent-core-policy --json`
after the tsc target is converted.
Expected: a `build` target still present. If the js plugin were not registered, this
would return no `build` target at all — the state's whole reason for existing.

**UC-10 (⚠️ edge) — Non-inferable options survive the conversion.**
Actor: an auditor. Input: build `agent-core-policy` and inspect its `dist/`.
Expected: the `drizzle/**/*` assets declared by the original target are still
emitted; the artifact shape is unchanged.

**UC-11 (⚠️ edge) — The bespoke second-pass compile is not treated as a shadow.**
Actor: an auditor. Input: `./node_modules/.bin/nx run dispatch-cli:build-bin`.
Expected: `dist/bin/cli.js` and `dist/src/` are produced, and the main `build`
output is **not** wiped (the target's additive-only output setting is preserved).

**UC-12 (⚠️ edge) — The release chain survives inference.**
Actor: a release engineer. Input: `./node_modules/.bin/nx show project apigen-plugin-jsonschema --json`.
Expected: `nx-release-publish` still present and still depends on the test and
artifact-verification targets. Losing that chain would make releases stop gating.

**UC-13 (⚠️ edge) — Lint stops rewriting tracked manifests.**
Actor: a developer. Input: `./node_modules/.bin/nx run apigen-plugin-ts-types:lint`
then `git status --porcelain`.
Expected: exit 0 and **no** modified `package.json`. Today the lint path depends on
a target that rewrites it, which dirties the worktree mid-CI.

**UC-14 (🛟 recovery) — A conversion changes the artifact.**
Actor: an executor. Input: the parity check shows a converted target emitting a
different file set than before.
Expected: the executor restores that one target to explicit and records why, rather
than shipping a changed artifact behind a green task count.

---

## C. Vite / toolchain ceiling (O3, D-`vitest@5`)

**UC-15 (happy) — Vite is at the highest supported version.**
Actor: a developer. Input: `node -e "console.log(require('vite/package.json').version)"`.
Expected: `8.3.0` — equal to the latest published — and `nx build data-query-engine`
exits 0 on it.

**UC-16 (⚠️ edge) — The vitest ceiling is a fact, not a preference.**
Actor: a developer trying to upgrade vitest. Input:
`node -e "console.log(require('@nx/vitest/package.json').peerDependencies.vitest)"`.
Expected: `^3.0.0 || ^4.0.0`. Installing `vitest@5.0.1` is therefore out of scope,
and the reason is recorded with its evidence rather than rediscovered.

**UC-17 (🛟 recovery) — A dependency resolves to an unexpected version.**
Actor: an executor. Input: the installed vite does not match what `package.json`
declares.
Expected: the executor re-runs the install and re-measures, and records the resolved
version in `BASELINE.md`. It does not adjust the declaration to match a stale install.

---

## D. File-level test selection (O4)

**UC-18 (happy) — One changed file selects only its covering specs.**
Actor: a developer editing `packages/data/data-base-transforms/src/lib/date.ts`.
Input: `pnpm run test:related -- packages/data/data-base-transforms/src/lib/date.ts`.
Expected: exit 0, a `selected=N/M` line with N strictly below M, and `date.spec.ts`
among the selected files.

**UC-19 (happy) — A cross-package change still covers the dependent.**
Actor: a developer editing the same file. Input: the same command.
Expected: the output names `data-query-engine` — a package that imports
`data-base-transforms`. On the default branch this selected **zero** and exited 0.

**UC-20 (⚠️ edge) — A change nothing covers fails loudly.**
Actor: a developer editing something untested. Input:
`pnpm run test:related -- packages/data/data-base-transforms/README.md`.
Expected: **non-zero exit** and a message naming zero selected. Exiting 0 here is the
measured fail-open hazard and is the single most important behaviour in this plan.

**UC-21 (⚠️ edge) — A dynamic import is invisible, and that is documented.**
Actor: a developer. Input: a source file reached only via `import(variable)`.
Expected: the selector does not select it; the limitation is written down in
`TEST-SELECTION.md` rather than discovered as a surprise later.

**UC-22 (⚠️ edge) — The full suite is still the default.**
Actor: an auditor. Input: inspect `nx.json`'s test target configuration and the
commit gate.
Expected: no `changed` option in the default target configuration; the commit gate
still runs `nx affected --target=test`. Five-plus invocation sites must not have
inherited a narrowed default.

**UC-23 (🛟 recovery) — A narrowed default leaks in.**
Actor: an auditor. Input: a CI run on a clean tree.
Expected: the suite runs in full. If a run reports success having executed nothing,
the criterion `test-changed-optin.3` fails and the state is red.

---

## E. Cache hazard (O6)

**UC-24 (⚠️ edge) — A sibling worktree's cached pass cannot be replayed here.**
Actor: a developer in `.worktrees/nx-perf-upgraded`. Input: run a test target whose
identical hash was just executed and passed in a *different* sibling worktree.
Expected: this checkout executes its own run (or restores only from its own cache).
It does not report a cached PASS belonging to another worktree whose suite never ran.

**UC-25 (🛟 recovery) — The cache directory resolves outside the checkout.**
Actor: an auditor. Input: resolve the declared cache directory against the repo root.
Expected: it resolves **inside** the checkout. An absolute path (or an unset one)
re-pools every worktree and re-opens the hazard.

---

## F. Branch hygiene (O5)

**UC-26 (happy) — All work is on the upgrade branch.**
Actor: an auditor. Input: `git rev-parse --abbrev-ref HEAD` and `git log --oneline main..HEAD`.
Expected: `perf/nx-upgraded`, and the plan's commits appear only there.

**UC-27 (⚠️ edge) — The absorb merges do not regress the publish gate.**
Actor: an auditor after absorbing `perf/nx-cfgfix`. Input: read the default test
target's dependency list.
Expected: it still includes `lint`. The absorbed branch had dropped it, which
silently disables dependency checks on every release.

**UC-28 (🛟 recovery) — A merge conflict on the shared config.**
Actor: an executor absorbing a sibling branch. Input: `nx.json` conflicts on
`sharedGlobals`, the test dependency list, and `plugins`.
Expected: the globals and plugin lists are unioned, and the test dependency list is
resolved to the restored form — by intent, never by "ours"/"theirs".

---

## Coverage check

| Outcome | Use cases |
|---|---|
| O1 landability | UC-01 … UC-05 |
| O2 task graph | UC-06 … UC-14 |
| O3 vite / ceiling | UC-15 … UC-17 |
| O4 test selection | UC-18 … UC-23 |
| O6 cache hazard | UC-24, UC-25 |
| O5 branch hygiene | UC-26 … UC-28 |

28 use cases · 10 happy · 15 edge · 6 recovery. Every one is observable from a
command's exit code or its stdout — none requires reading the executor's intent.
