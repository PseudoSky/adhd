# Nx 23 / Vite 8 upgrade, task-graph remodel, and file-level test selection — State Machine

> A **human-readable render of `dag.json`**. `dag.json` is the machine source of
> truth for topology; `state.json` is the live runtime instance. Regenerate after any
> structural change so the three never drift.

**Plan kind:** brownfield · **Terminal:** `done` · **States:** 16 · **Phases:** intake → reconcile → config → graph → tests → final

---

## States

Identity is the **slug** (immutable). Order below is a topological render of
`dag.json` — a view, not the source. Inserting a state never renumbers another.

| # | Slug | Kind | Phase | Guard |
|---|---|---|---|---|
| 1 | `upgrade-baseline` | work | intake | `test -f docs/plan/nx-23-upgrade/BASELINE.md && ./node_modules/.bin/nx --version \| rg -q "Loc…` |
| 2 | `gate-triage-absorbed` | work | intake | `test -f docs/plan/nx-23-upgrade/TRIAGE-VERDICTS.md && rg -q "apigen-cli" docs/plan/nx-23-upgr…` |
| 3 | `config-repair-absorbed` | work | reconcile | `./node_modules/.bin/nx show projects \| rg -q "data-query-engine" && node -e "const d=require…` |
| 4 | `test-resolution-absorbed` | work | reconcile | `test -f tools/vite-plugins/source-resolution.mjs && node -e "if(!require(\"./nx.json\").named…` |
| 5 | `audit-reconcile` | audit | reconcile | `python3 docs/plan/nx-23-upgrade/scripts/guard_audit_reconcile.py` |
| 6 | `tsconfig-shim-removal` | work | config | `node -e "const c=require(\"./tsconfig.base.json\").compilerOptions;for(const k of [\"strict\"…` |
| 7 | `cache-isolation` | work | config | `node -e "const c=require(\"./nx.json\").cacheDirectory;if(c!==\".nx/cache\")process.exit(1)" …` |
| 8 | `audit-config` | audit | config | `python3 docs/plan/nx-23-upgrade/scripts/guard_audit_config.py` |
| 9 | `graph-test-build-inferred` | work | graph | `./node_modules/.bin/nx show project data-query-engine --json \| rg -q "\"test\"" && ./node_mo…` |
| 10 | `graph-js-tsc-inferred` | work | graph | `./node_modules/.bin/nx show projects \| rg -q "agent-core-policy" && node -e "
const fs=requi…` |
| 11 | `graph-release-eslint-inferred` | work | graph | `./node_modules/.bin/nx show projects \| rg -q "apigen-plugin-jsonschema" && node -e "
const f…` |
| 12 | `audit-graph` | audit | graph | `python3 docs/plan/nx-23-upgrade/scripts/guard_audit_graph.py` |
| 13 | `test-selection-revalidated` | work | tests | `test -f docs/plan/nx-23-upgrade/TEST-SELECTION-PROBE.md && rg -q "D1" docs/plan/nx-23-upgrade…` |
| 14 | `test-changed-optin` | work | tests | `node -e "const s=require(\"./package.json\").scripts;if(!s[\"test:changed\"]\|\|!s[\"test:rel…` |
| 15 | `audit-tests` | audit | tests | `python3 docs/plan/nx-23-upgrade/scripts/guard_audit_tests.py` |
| 16 | `audit-final` | audit | final | `python3 docs/plan/nx-23-upgrade/scripts/guard_audit_final.py` |

**Audit states are mandatory hold points.** `audit-reconcile`, `audit-config`,
`audit-graph`, `audit-tests` and `audit-final` block their successors. Each runs every
criterion of its phase **plus all prior phases**, so an earlier regression re-blocks a
later gate. There are no deferrable items in any audit state.

---

## Topology

```text
[intake]
  upgrade-baseline   <- —
  gate-triage-absorbed   <- upgrade-baseline
        |
[reconcile]
  config-repair-absorbed   <- gate-triage-absorbed
  test-resolution-absorbed   <- config-repair-absorbed
  audit-reconcile   <- test-resolution-absorbed
        |
[config]
  tsconfig-shim-removal   <- audit-reconcile
  cache-isolation   <- tsconfig-shim-removal
  audit-config   <- cache-isolation
        |
[graph]
  graph-test-build-inferred   <- audit-config
  graph-js-tsc-inferred   <- graph-test-build-inferred
  graph-release-eslint-inferred   <- graph-js-tsc-inferred
  audit-graph   <- graph-release-eslint-inferred
        |
[tests]
  test-selection-revalidated   <- audit-graph
  test-changed-optin   <- test-selection-revalidated
  audit-tests   <- test-changed-optin
        |
[final]
  audit-final   <- audit-tests
        |
        v
      done
```

The graph is **deliberately linear**. Every state mutates a shared config surface
(`nx.json`, `package.json`, `tsconfig.base.json`, `.githooks/pre-commit`) or a
project-graph-wide target set, so parallel states would be a write-conflict
generator rather than a speedup. Edges live in `dag.json` (`depends_on`); this
diagram renders them.

---

## Transitions and guards

| From (slug) | Guard verifies | Unlocks |
|---|---|---|
| `upgrade-baseline` | test -f docs/plan/nx-23-upgrade/BASELINE.md && ./node_modules/.bin/nx --version | rg -q "Local: v23\.2\.1" && node -e "const d=require(\"./package.… | `gate-triage-absorbed` |
| `gate-triage-absorbed` | test -f docs/plan/nx-23-upgrade/TRIAGE-VERDICTS.md && rg -q "apigen-cli" docs/plan/nx-23-upgrade/TRIAGE-VERDICTS.md && rg -q "apigen-plugin-java-ja… | `config-repair-absorbed` |
| `config-repair-absorbed` | ./node_modules/.bin/nx show projects | rg -q "data-query-engine" && node -e "const d=require(\"./nx.json\").targetDefaults.test.dependsOn;if(!d.inc… | `test-resolution-absorbed` |
| `test-resolution-absorbed` | test -f tools/vite-plugins/source-resolution.mjs && node -e "if(!require(\"./nx.json\").namedInputs.sharedGlobals.join(\"|\").includes(\"source-res… | `audit-reconcile` |
| `audit-reconcile` | **audit** — python3 docs/plan/nx-23-upgrade/scripts/guard_audit_reconcile.py | `tsconfig-shim-removal` |
| `tsconfig-shim-removal` | node -e "const c=require(\"./tsconfig.base.json\").compilerOptions;for(const k of [\"strict\",\"types\",\"esModuleInterop\",\"ignoreDeprecations\",… | `cache-isolation` |
| `cache-isolation` | node -e "const c=require(\"./nx.json\").cacheDirectory;if(c!==\".nx/cache\")process.exit(1)" && ./node_modules/.bin/nx show projects | rg -q "backl… | `audit-config` |
| `audit-config` | **audit** — python3 docs/plan/nx-23-upgrade/scripts/guard_audit_config.py | `graph-test-build-inferred` |
| `graph-test-build-inferred` | ./node_modules/.bin/nx show project data-query-engine --json | rg -q "\"test\"" && ./node_modules/.bin/nx show project data-base-transforms --json … | `graph-js-tsc-inferred` |
| `graph-js-tsc-inferred` | ./node_modules/.bin/nx show projects | rg -q "agent-core-policy" && node -e "
const fs=require(\"fs\"),path=require(\"path\");
function walk(d,o=[]… | `graph-release-eslint-inferred` |
| `graph-release-eslint-inferred` | ./node_modules/.bin/nx show projects | rg -q "apigen-plugin-jsonschema" && node -e "
const fs=require(\"fs\"),path=require(\"path\");
function walk… | `audit-graph` |
| `audit-graph` | **audit** — python3 docs/plan/nx-23-upgrade/scripts/guard_audit_graph.py | `test-selection-revalidated` |
| `test-selection-revalidated` | test -f docs/plan/nx-23-upgrade/TEST-SELECTION-PROBE.md && rg -q "D1" docs/plan/nx-23-upgrade/TEST-SELECTION-PROBE.md && rg -q "D2" docs/plan/nx-23… | `test-changed-optin` |
| `test-changed-optin` | node -e "const s=require(\"./package.json\").scripts;if(!s[\"test:changed\"]||!s[\"test:related\"])process.exit(1)" && ./node_modules/.bin/nx show … | `audit-tests` |
| `audit-tests` | **audit** — python3 docs/plan/nx-23-upgrade/scripts/guard_audit_tests.py | `audit-final` |
| `audit-final` | **audit** — python3 docs/plan/nx-23-upgrade/scripts/guard_audit_final.py | `done` |

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

---

## Rollback

| Change | Rollback |
|---|---|
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
