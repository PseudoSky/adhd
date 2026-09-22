<!-- gap-check-mode: strict -->

# Nx 23 / Vite 8 upgrade, task-graph remodel, and file-level test selection

Land the Nx 23.2.1 + Vite 8 upgrade on `perf/nx-upgraded`, remodel the task graph
onto Nx-inferred targets, and deliver fail-safe file-level test selection.

**Status:** authored; GATE 2 approval recorded in `APPROVAL.md`; amended 2026-09-21 by the
repair pass that added the bump-safety states (`vite-cjs-import-meta-repair`,
`browser-package-build-repair`, `browser-cjs-umd-repair`) and `[dod.14]`/`[dod.15]`, and
2026-09-22 by the repair pass that added `typecheck-teeth-restored`, and 2026-09-22 by the
**audit waiver** that retired `audit-graph`, `audit-tests` and `audit-final` — see
`APPROVAL.md` § *Amendment 2026-09-21*, § *Amendment 2026-09-22 — typecheck-teeth restoration*
and § *Amendment 2026-09-22 — audit waiver*.
**Branch:** `perf/nx-upgraded` (worktree `.worktrees/nx-perf-upgraded`).
**Plans-root:** `docs/plan/` · **Registry:** `docs/plan/plan-index.json`.

---

## Consumer

A **monorepo developer on this repo** (human or agent) who is currently paying for
the Nx upgrade every time they touch a file: the commit gate re-runs whole package
suites, the task graph carries 136 targets that merely restate what Nx can infer,
and the shared compiler config carries migration shims that main does not have.

Secondary consumer: the **release path**, which reaches lint through the default
test target and would silently lose its dependency checks if that edge is dropped.

---

## Value delta

| | Before | After |
|---|---|---|
| Test selection | Per-project: any file in a package re-runs that package's whole suite | Per-file opt-in: only the specs that statically cover the changed file, with a hard failure when nothing is selected |
| Task graph | 136 explicit executor targets across ~62 projects shadowing registered plugins | Inferred targets, with the same artifacts and an equivalent task graph |
| Compiler config | Branch carries 5 migration shims main does not have | Byte-parity with main's shared compiler config, proven empirically |
| Task cache | Pooled across sibling worktrees (Nx 23 default) — a sibling's cached PASS can replay here | Each checkout owns its cache directory |
| Toolchain | Nx 18.3.4 / vite 5 / vitest 1.6.1 on main | Nx 23.2.1 / vite 8.3.0 / vitest 4.1.9 on the upgrade branch |
| Bump safety | `vite ^8.3.0` declared in a commit whose built CommonJS entrypoints throw at module load, and a public browser package that neither builds nor ships a loadable bundle | The bump and its fix are one commit; every built CJS entrypoint loads as a real process; the browser package builds and its bundles carry no empty-import-meta token |

---

## Execution model

1. **Parallel execution?** No. Every state mutates a shared config surface
   (`nx.json`, `package.json`, `tsconfig.base.json`, `.githooks/pre-commit`) or a
   project-graph-wide target set. The DAG is deliberately linear through the audit
   hold points; parallelism here would be a write-conflict generator.
2. **Which agent implements?** The `dispatcher`, driving one state at a time via
   `state-transition.js`. Graph and config states want a strong executor; the
   reconcile states are mechanical and tolerate a weaker one.
3. **Do agents review — who, and when?** Yes: the two surviving `audit-*` hold points
   (`audit-reconcile`, `audit-config`). Each re-runs every criterion of its phase plus
   all prior phases and cannot be skipped. The `graph`, `tests` and `final` hold points
   (`audit-graph`, `audit-tests`, `audit-final`) were **waived by owner directive on
   2026-09-22** — they re-executed the full accumulated build+suite set and were declared
   un-needed. The DoD is now confirmed inline at the terminal state, `test-changed-optin`
   (see *Amendment 2026-09-22 — audit waiver* in `APPROVAL.md`).
4. **Automatic dispatch?** No. This plan is handed off with the Dispatch line; the
   planner does not execute it.

**Landing is explicitly out of scope.** The terminal state is a hold, not a merge. No
state pushes, merges to the default branch, or publishes. With `audit-final` waived, no
state in this plan certifies the landing decision — a human must take it.

---

## Definition of Done

- `[dod.1]` **(structural)** The workspace runs the latest published Nx 23 line with the matching first-party plugin line, and the three test targets that failed the commit gate after the bump have a recorded verdict.
  - delivered-by: upgrade-baseline, gate-triage-absorbed

- `[dod.2]` **(structural)** The test runner sits at the highest major its Nx peer range permits, and the ceiling blocking the next major is recorded with the evidence that establishes it.
  - delivered-by: upgrade-baseline

- `[dod.3]` A developer can build any workspace package and the build still type-checks it.
  - entrypoint: `./node_modules/.bin/nx run-many -t build --projects=agent-base-types,data-query-engine,agent-core-policy`
  - observable: `BUILD_PASS is printed and the command exits 0`
  - negative-control: `printf '\n\nexport const __shimProbe: number = "not a number";\n' >> packages/agent/agent-base-types/src/index.ts && ./node_modules/.bin/nx build agent-base-types`
  - delivered-by: tsconfig-shim-removal

- `[dod.4]` **(structural)** No migration-only compiler relaxation remains in the shared compiler configuration.
  - delivered-by: tsconfig-shim-removal

- `[dod.5]` A developer can change one source file and run only the tests that actually cover it, instead of the whole package suite.
  - entrypoint: `pnpm run test:related -- packages/data/data-base-transforms/src/lib/date.ts`
  - observable: `a selected=N/M line is printed with N strictly below M, and the command exits 0`
  - negative-control: `printf '\n' >> packages/data/data-base-transforms/src/lib/date.ts`
  - delivered-by: test-changed-optin

- `[dod.6]` When a change selects no tests, the fast path fails loudly rather than reporting success.
  - entrypoint: `pnpm run test:related -- packages/data/data-base-transforms/src/index.ts`
  - observable: `a non-zero exit and a message reading no tests selected`
  - negative-control: `printf '\n' >> packages/data/data-base-transforms/src/index.ts`
  - delivered-by: test-changed-optin

- `[dod.7]` A developer can change a base package and the run still selects the tests of the packages that depend on it.
  - entrypoint: `pnpm run test:related -- packages/data/data-base-transforms/src/lib/date.ts`
  - observable: `a spec file belonging to a dependent package is selected and the command exits 0`
  - negative-control: `printf '\n' >> packages/data/data-base-transforms/src/lib/date.ts`
  - delivered-by: test-changed-optin

- `[dod.8]` **(structural)** The commit gate still covers downstream consumers and is not narrowed to the changed package, and the fail-open behaviour of the previous selection attempt is refuted or confirmed on the upgraded toolchain.
  - delivered-by: test-changed-optin, test-selection-revalidated

- `[dod.9]` **(structural)** Task targets that merely restated what Nx can already infer are gone, and the inferred equivalents still produce the same artifacts.
  - delivered-by: graph-test-build-inferred, graph-js-tsc-inferred, graph-release-eslint-inferred, typecheck-teeth-restored

- `[dod.10]` **(structural)** Each checkout owns its task cache, so a cached pass from a sibling worktree cannot be replayed here.
  - delivered-by: cache-isolation

- `[dod.11]` **(structural)** All of this work sits on the upgrade branch; nothing was pushed to or merged into the default branch.
  - delivered-by: test-changed-optin

- `[dod.12]` **(structural)** The two sibling work branches are absorbed into the upgrade branch, with the publish-gate restoration preserved and the test-time source resolution helper in place.
  - delivered-by: config-repair-absorbed, test-resolution-absorbed, audit-reconcile

- `[dod.13]` **(structural)** Every phase through `config` holds at an audit gate that re-proves the criteria of all phases before it. The `graph`, `tests` and `final` hold points (`audit-graph`, `audit-tests`, `audit-final`) were **waived by owner directive on 2026-09-22** and are not delivered; their guard scripts remain on disk. See `APPROVAL.md` § *Amendment 2026-09-22 — audit waiver*.
  - delivered-by: audit-reconcile, audit-config

- `[dod.14]` A developer can run the workspace's bundled command-line entrypoint and it starts, instead of crashing while it loads.
  - entrypoint: `node entrypoint/apigen-cli/dist/index.js --help`
  - observable: `the CLI prints its usage text and exits 0, then the APIGEN_CLI_LOADS_PASS marker is printed`
  - negative-control: `restore the Rolldown empty-import-meta token in entrypoint/apigen-cli/dist/index.js and re-run node entrypoint/apigen-cli/dist/index.js --help — it must exit non-zero`
  - delivered-by: vite-cjs-import-meta-repair

- `[dod.15]` A developer can build the browser hooks package and ship its bundles without an invalid-URL failure.
  - entrypoint: `packages/ui-react/ui-react-base-hooks/dist/index.js`
  - observable: `the CJS and UMD bundles carry no empty-import-meta token and no node-only shim, then the BROWSER_BUNDLES_CLEAN_PASS marker is printed`
  - negative-control: `inject the empty-import-meta token into packages/ui-react/ui-react-base-hooks/dist/index.js and re-run the check — it must fail`
  - delivered-by: browser-package-build-repair, browser-cjs-umd-repair

**DoD confirmation boundary (2026-09-22).** The DoD clauses are confirmed by the
terminal state's accumulated **final-phase** audit — `test-changed-optin`'s
`--complete` runs every Definition-of-Done clause check plus the `[ref:]`/`[iface:]`
conformance checks, and `state-transition.js` refuses `done` if any clause has no
executed PASS. The dedicated `audit-final` hold that used to carry this is retired, so
the confirmation is now **inline at the last work state** rather than at a separate hold
point. The DoD was NOT re-confirmed with the owner for this change; `state.json`'s
`dod_provenance` still records the original 13 clauses and has deliberately not been
re-stamped — the waiver is an owner directive, recorded in `APPROVAL.md`, not a
re-elicitation.

---

## Glossary

Terms this plan owns; declared here so the DoD vocabulary lint does not
misclassify them.

| Term | Meaning |
|---|---|
| inferred target | A task target Nx derives from a registered plugin + the project's files, rather than one declared explicitly in the project manifest |
| shadowing target | An explicit target whose name and executor duplicate what a registered plugin already infers, so the plugin's inference is never used |
| migration shim | A compiler-option relaxation added during the upgrade to make the tree compile, which the default branch does not carry |
| fail-safe selection | Default = run everything; the narrow fast path is explicit opt-in; zero selected is a failure, never a pass |
| fail-open selection | Default = run less; a forgotten override silently runs fewer tests and still reports success |
| upgrade branch | `perf/nx-upgraded` — the single branch all of this work lives on |

---

## Invariants

- **Never `--skip-nx-cache`.** A clean rebuild is `nx reset` or a changed input.
- **Never invoke `tsc` directly.** Type-checking goes through the project's Nx build target.
- **Never `git reset --hard`, `git stash`, or `git clean -fd`.** Discard one file with `git restore <path>`.
- **Never hand-edit `dag.json`/`state.json`.** Only `plan-scaffold.js` and `state-transition.js` mutate them.
- **`test.dependsOn` keeps `lint`.** Dropping it removes the publish gate (BUG-060) — main reverted exactly that once.
- **`^build` stays in the test path.** Measured inconclusive for speed, load-bearing for the four child-process projects.
- **A guard that selects zero tests is red, not green.**
- **No push, no merge to the default branch, no publish** from any state in this plan.

---

## Status

```bash
SKILL=~/.config/opencode/skills/plan-state-machine/scripts
node "$SKILL/orchestrate-plan.js" docs/plan/nx-23-upgrade --dispatch   # current state work order
node "$SKILL/state-transition.js" docs/plan/nx-23-upgrade <slug> --start
node "$SKILL/state-transition.js" docs/plan/nx-23-upgrade <slug> --complete --note '<what you did>'
node "$SKILL/plan-scaffold.js" status docs/plan/nx-23-upgrade
```

## Amending this plan

Classify every divergence: does it alter the dependency graph, the target-state
invariants, or final-audit coverage? **No** → executor-class amendment
(`--amend --class executor`). **Yes** → stop and escalate to the planner
(`--amend --class planner`). Never hand-edit `dag.json`/`state.json`.
