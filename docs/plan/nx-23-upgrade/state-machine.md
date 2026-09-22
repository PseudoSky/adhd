# Nx 23 / Vite 8 upgrade, task-graph remodel, and file-level test selection — State Machine

> A **human-readable render of `dag.json`**. `dag.json` is the machine source of
> truth for topology; `state.json` is the live runtime instance. **This file is
> hand-maintained** — the plan-state-machine skill ships no renderer for it
> (`templates/state-machine.template.md` is a template, not a generator), so
> re-check it against `dag.json` after every structural change.

**Plan kind:** brownfield · **Terminal:** `done` · **States:** 19 · **Phases:** intake → reconcile → config → graph → tests → final

---

## States

Identity is the **slug** (immutable). Order below is a topological render of
`dag.json` — a view, not the source. Inserting a state never renumbers another.

| # | Slug | Kind | Phase | Guard |
|---|---|---|---|---|
| 1 | `upgrade-baseline` | work | intake | `test -f docs/plan/nx-23-upgrade/BASELINE.md && ./node_modules/.bin/nx --version \| rg -q "Local: v23\.2\.1" &&…` |
| 2 | `vite-cjs-import-meta-repair` | work | intake | `test -f tools/vite-plugins/import-meta-url-cjs.mjs && test "$(git log -1 --format=%H -- tools/vite-plugins/imp…` |
| 3 | `browser-package-build-repair` | work | intake | `./node_modules/.bin/nx build ui-react-base-hooks && test -f packages/ui-react/ui-react-base-hooks/dist/index.j…` |
| 4 | `browser-cjs-umd-repair` | work | intake | `./node_modules/.bin/nx build ui-react-base-hooks && ./node_modules/.bin/vitest run --config packages/ui-react/…` |
| 5 | `gate-triage-absorbed` | work | intake | `test -f docs/plan/nx-23-upgrade/TRIAGE-VERDICTS.md && rg -q "apigen-cli" docs/plan/nx-23-upgrade/TRIAGE-VERDIC…` |
| 6 | `config-repair-absorbed` | work | reconcile | `./node_modules/.bin/nx show projects \| rg -q "data-query-engine" && node -e "const d=require(\"./nx.json\").t…` |
| 7 | `test-resolution-absorbed` | work | reconcile | `test -f tools/vite-plugins/source-resolution.mjs && node -e "if(!require(\"./nx.json\").namedInputs.sharedGlob…` |
| 8 | `audit-reconcile` | audit | reconcile | `python3 docs/plan/nx-23-upgrade/scripts/guard_audit_reconcile.py` |
| 9 | `tsconfig-shim-removal` | work | config | `node -e "const c=require(\"./tsconfig.base.json\").compilerOptions;for(const k of [\"strict\",\"types\",\"esMo…` |
| 10 | `cache-isolation` | work | config | `node -e "const c=require(\"./nx.json\").cacheDirectory;if(c!==\".nx/cache\")process.exit(1)" && ./node_modules…` |
| 11 | `audit-config` | audit | config | `python3 docs/plan/nx-23-upgrade/scripts/guard_audit_config.py` |
| 12 | `graph-test-build-inferred` | work | graph | `./node_modules/.bin/nx show project data-query-engine --json \| rg -q "\"test\"" && ./node_modules/.bin/nx sho…` |
| 13 | `graph-js-tsc-inferred` | work | graph | `./node_modules/.bin/nx show projects \| rg -q "agent-core-policy" && node -e "const fs=require(\"fs\"),path=r…` |
| 14 | `graph-release-eslint-inferred` | work | graph | `./node_modules/.bin/nx show projects \| rg -q "apigen-plugin-jsonschema" && node -e "const fs=require(\"fs\")…` |
| 15 | `audit-graph` | audit | graph | `python3 docs/plan/nx-23-upgrade/scripts/guard_audit_graph.py` |
| 16 | `test-selection-revalidated` | work | tests | `test -f docs/plan/nx-23-upgrade/TEST-SELECTION-PROBE.md && rg -q "D1" docs/plan/nx-23-upgrade/TEST-SELECTION-P…` |
| 17 | `test-changed-optin` | work | tests | `node -e "const s=require(\"./package.json\").scripts;if(!s[\"test:changed\"]\|\|!s[\"test:related\"])process.e…` |
| 18 | `audit-tests` | audit | tests | `python3 docs/plan/nx-23-upgrade/scripts/guard_audit_tests.py` |
| 19 | `audit-final` | audit | final | `python3 docs/plan/nx-23-upgrade/scripts/guard_audit_final.py` |

**Audit states are mandatory hold points.** `audit-reconcile`, `audit-config`,
`audit-graph`, `audit-tests` and `audit-final` block their successors. Each runs every
criterion of its phase **plus all prior phases**, so an earlier regression re-blocks a
later gate. There are no deferrable items in any audit state.

---

## Topology

```text
[intake]
  upgrade-baseline          <- —
  vite-cjs-import-meta-repair     <- upgrade-baseline
  browser-package-build-repair    <- vite-cjs-import-meta-repair
  browser-cjs-umd-repair          <- browser-package-build-repair
  gate-triage-absorbed            <- browser-cjs-umd-repair
        |
[reconcile]
  config-repair-absorbed    <- gate-triage-absorbed
  test-resolution-absorbed  <- config-repair-absorbed
  audit-reconcile           <- test-resolution-absorbed
        |
[config]
  tsconfig-shim-removal     <- audit-reconcile
  cache-isolation           <- tsconfig-shim-removal
  audit-config              <- cache-isolation
        |
[graph]
  graph-test-build-inferred     <- audit-config
  graph-js-tsc-inferred         <- graph-test-build-inferred
  graph-release-eslint-inferred <- graph-js-tsc-inferred
  audit-graph                   <- graph-release-eslint-inferred
        |
[tests]
  test-selection-revalidated    <- audit-graph
  test-changed-optin            <- test-selection-revalidated
  audit-tests                   <- test-changed-optin
        |
[final]
  audit-final                   <- audit-tests
        |
        v
      done
```

The graph is **deliberately linear**. Every state mutates a shared config surface
(`nx.json`, `package.json`, `tsconfig.base.json`, `.githooks/pre-commit`) or a
project-graph-wide target set, so parallel states would be a write-conflict
generator rather than a speedup. Edges live in `dag.json` (`depends_on`); this
diagram renders them.

The intake chain is ordered by **causality**: the toolchain is measured first, then the
bump is landed atomically with the fix that keeps built artifacts loadable, then the
browser package is made buildable and its bundles made valid, and only then is the
post-bump triage verdict consumed — on a tree whose artifacts actually load.

---

## Transitions and guards

| From (slug) | Guard verifies | Unlocks |
|---|---|---|
| `upgrade-baseline` | `BASELINE.md` exists; the repo-local Nx reports 23.2.1; the declared pins match the measured baseline (the bump is measured here, **not** committed) | `vite-cjs-import-meta-repair` |
| `vite-cjs-import-meta-repair` | the plugin exists **and** its last-touching commit is `package.json`'s last-touching commit (bump/fix atomicity); both built CJS entrypoints load and print their usage; neither bundle carries the empty-import-meta token | `browser-package-build-repair` |
| `browser-package-build-repair` | `nx build ui-react-base-hooks` exits 0 and emits `index.js`, `index.umd.js`, `index.mjs` | `browser-cjs-umd-repair` |
| `browser-cjs-umd-repair` | the build succeeds, the browser acceptance spec passes, and neither browser CJS/UMD bundle carries the empty-import-meta token or the node-only shim | `gate-triage-absorbed` |
| `gate-triage-absorbed` | `TRIAGE-VERDICTS.md` exists and covers apigen-cli, apigen-plugin-java-javalin and backlog; the project graph loads | `config-repair-absorbed` |
| `config-repair-absorbed` | the graph loads; `test.dependsOn` includes `lint` and `^build`; the agent packages carry no `build` script | `test-resolution-absorbed` |
| `test-resolution-absorbed` | `source-resolution.mjs` exists; `namedInputs.sharedGlobals` names it; the generator project resolves | `audit-reconcile` |
| `audit-reconcile` | **audit** — `python3 …/guard_audit_reconcile.py` | `tsconfig-shim-removal` |
| `tsconfig-shim-removal` | none of the five shim keys remain in `tsconfig.base.json`; three representative builds type-check | `cache-isolation` |
| `cache-isolation` | `nx.json cacheDirectory` is `.nx/cache`; the graph loads; the record exists | `audit-config` |
| `audit-config` | **audit** — `python3 …/guard_audit_config.py` | `graph-test-build-inferred` |
| `graph-test-build-inferred` | `data-query-engine` still has a `test` target, `data-base-transforms` a `build` target; no manifest declares a shadowing `@nx/vitest:test`/`@nx/vite:build` executor | `graph-js-tsc-inferred` |
| `graph-js-tsc-inferred` | the graph loads; no manifest declares `@nx/js:tsc` | `graph-release-eslint-inferred` |
| `graph-release-eslint-inferred` | the graph loads; no manifest declares `@nx/js:release-publish` or `@nx/eslint:lint` | `audit-graph` |
| `audit-graph` | **audit** — `python3 …/guard_audit_graph.py` | `test-selection-revalidated` |
| `test-selection-revalidated` | `TEST-SELECTION-PROBE.md` records D1, D2, D3; the repo-local Nx is 23.2.1 | `test-changed-optin` |
| `test-changed-optin` | `test:changed` and `test:related` exist; the graph loads; `TEST-SELECTION.md` exists | `audit-tests` |
| `audit-tests` | **audit** — `python3 …/guard_audit_tests.py` | `audit-final` |
| `audit-final` | **audit** — `python3 …/guard_audit_final.py` | `done` |

---

## File model

| File | Role | Mutated when |
|---|---|---|
| `dag.json` | **Structure** — nodes (slug → phase, depends_on, guard, artifacts, context) | Reordering, adding/splitting/retiring a state. Edit one file. |
| `state.json` | **Runtime** — current_state, per-slug status+timestamps, logs | Every session, via `state-transition.js` only |
| `contexts/<slug>.md` | Work order per state | The state is authored or amended |
| `contexts/_shared.md` | Centralized definitions + the merge-conflict policy | A shared definition changes (once) |
| `references.json` | Reference-pattern catalog (`[ref:]` idioms as data) | An idiom is added or its rule changes |
| `interfaces.json` | External interface contracts (`[iface:]`) | A third-party contract is resolved or drifts |
| `scripts/criteria.json` | Declarative audit criteria, interpreted by `run-audit.js` | A criterion is added or edited |
| `state-machine.md` | **Render only** — hand-maintained; no generator exists | Any structural change to `dag.json` |

---

## Rollback

| Change | Rollback |
|---|---|
| Bump/fix atomicity | The bump and the fix are one commit — reverting that commit reverts both, and there is no broken intermediate to bisect into |
| CJS `import.meta.url` shim | Delete `tools/vite-plugins/import-meta-url-cjs.mjs` and its 54 wirings (one commit) |
| Browser bundle repair | Revert that state's commit; the package returns to its prior (broken) bundle |
| React-19 type conformance | Revert the three source files (one commit) |
| Compiler-shim removal | Restore the five keys in `tsconfig.base.json` (one revert commit) |
| Cache isolation | Delete `cacheDirectory` from `nx.json` (one line) |
| Target deletions (phase 2a/2b/2c) | Revert that phase's commit — each phase is one commit, by design |
| Absorbed sibling branches | Revert the merge commit; the sibling branches are untouched and still local-only |
| Fast-path wrapper | Revert `package.json` scripts; the default path was never changed, so nothing else moves |

Every change above is independently revertible. Nothing in this plan pushes,
merges to the default branch, or publishes.

---

## Runtime status

`current_state`: `upgrade-baseline`

| Slug | Status |
|---|---|
| `upgrade-baseline` | pending |
| `vite-cjs-import-meta-repair` | pending |
| `browser-package-build-repair` | pending |
| `browser-cjs-umd-repair` | pending |
| `gate-triage-absorbed` | pending |
| `config-repair-absorbed` | pending |
| `test-resolution-absorbed` | pending |
| `audit-reconcile` | pending |
| `tsconfig-shim-removal` | pending |
| `cache-isolation` | pending |
| `audit-config` | pending |
| `graph-test-build-inferred` | pending |
| `graph-js-tsc-inferred` | pending |
| `graph-release-eslint-inferred` | pending |
| `audit-graph` | pending |
| `test-selection-revalidated` | pending |
| `test-changed-optin` | pending |
| `audit-tests` | pending |
| `audit-final` | pending |

Advance with `state-transition.js` — never by hand-editing `state.json`.
