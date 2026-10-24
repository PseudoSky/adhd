# release-gate-fixes — WORK STATE

**Phase:** release · **Kind:** work · **Depends on:** search-cutover, plan-notes, fix-tripwire, fix-core-parsers, fix-core-lifecycle, fix-core-errors · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py release-gate-fixes`
**Executor:** executor=sonnet tier=sonnet · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The six release gates of main (`pnpm check:release-ranges`, `pnpm release:dry`, the AGENTS.md affected gate, `check-test-wiring`, `check-skip-expiry`, `check-lane-reachability`) all exit 0 because their four root causes are fixed, with no gate relaxed, and `pnpm release:dry` leaves the working tree exactly as it found it.

---

## Semantic Distillation

- **Primitive:** act only on the owned paths listed under Reservations; the evidence record is `docs/plan/stealth-browser/evidence/release-gate-fixes.md`. Fix each defect where it originates; never loosen a gate, never skip or delete a test, never add a project allow-list.

- **Reference Pattern:** `docs/plan/stealth-browser/evidence/release-readiness.md` and `docs/plan/stealth-browser/release-readiness/*.log.md` (the failing runs this state answers), `docs/standards/testing.md` and `AGENTS.md` on main (`git show main:<path>`), the sibling specs in `tools/nx-plugins/test/executors/wiring/` (`check-lane-reachability.spec.mjs` is the header and lane-wiring template: `guards:`, `tier: S`, `cites:` block in the first 60 lines, listed in the root `package.json` `test:build-tools` script), and `docs/plan/stealth-browser/contexts/_shared.md`.

- **Delta Spec:** root causes are already diagnosed; each item names the file and line to start from.

  1. `check-test-wiring` false positives [release-gate-fixes.1] [release-gate-fixes.2]. `tools/nx-plugins/test/executors/wiring/check-test-wiring.mjs:32-33` reads only the literal `targets.test` of each project.json, so `agent-store-runtime` and `agent-store-prompts`, whose `test` target is inferred by an Nx plugin (commit `c6d6e055f`, "rely on plugin inference"), are flagged although `nx run agent-store-runtime:test` runs. Fix: honour Nx-inferred targets through the project graph (one graph read for the whole scan, for example `nx graph --file=<tmp>.json` or the project-graph API, rather than one `nx show project <name> --json` per project, so the check stays fast) and keep flagging a project that has specs and truly no `test` target, literal or inferred. New spec `tools/nx-plugins/test/executors/wiring/check-test-wiring.spec.mjs`: header `guards:` / `tier: S` / `cites:` naming ticket `8468f7b1` and `[release-gate-fixes.1]`, a case where the target is plugin-inferred (not flagged), a negative control where a project with specs and no test target is still flagged (exit 1), listed in `test:build-tools` in package.json so `check-lane-reachability` stays 0.

  2. `release:dry` mutates tracked files [release-gate-fixes.3] [release-gate-fixes.4]. Root `package.json:11` sets `ADHD_NX_VERSION_DRY_RUN=1` only on the `version` run-many. The `publish` run-many depends on `version` (`tools/nx-plugins/build/plugin.js:318`) and re-runs the version executor (`tools/nx-plugins/build/executors/version/impl.js:638` reads the env) non-dry, which rewrote 64 tracked `package.json` / `CHANGELOG.md` files, created 2 new `CHANGELOG.md` files, and produced a transient extractor version `0.3.7` that broke the policy baked-artifact tests. Fix: make the `release:dry` script begin with `export ADHD_NX_VERSION_DRY_RUN=1 &&` so the build, version, range-check and publish steps all inherit it. New spec `tools/nx-plugins/test/executors/wiring/release-dry-clean.spec.mjs` (same header rules, cites `[release-gate-fixes.3]`, listed in `test:build-tools`): parse `scripts['release:dry']` from package.json and assert the export precedes and therefore covers every nx invocation of the chain, with a negative control on a script string that exports it only on the `version` run-many. The end-to-end proof is guard criterion .4: it runs `pnpm release:dry` with the variable NOT pre-set and requires exit 0 plus an unchanged `git status --porcelain` (it restores anything the run dirtied and caches a green run by code identity in `evidence/release-gate-fixes.dry.json`, which you do not write by hand).

  3. `decompile-cli:test` fixture path [release-gate-fixes.5]. `entrypoint/decompile-cli/test/unit/lib/validators/local/index.spec.ts:9` builds `fixturesDir` as `path.join(srcDir, 'tests', 'fixtures')` (the old layout); the fixtures live in `entrypoint/decompile-cli/test/fixtures` (13 tests fail with ENOENT on `src/tests/fixtures/*`). Fix the path in the spec; do not copy fixtures into `src/`.

  4. `backlog:test` failure inside the release run [release-gate-fixes.6]. `entrypoint/backlog/test/unit/c8-vocabulary.spec.ts` > "describeBacklogSurface enumerates the pinned verbs and assertSurfaceIsReal passes on the build" (it reads the built `dist/index.js`) failed twice inside the release run but `nx run backlog:test` passes alone (exit 0), so the cause is not established. Do not assume a missing build dependency: `entrypoint/backlog/project.json:38` already lists `build`, `assets` and `vocabulary-gate` in `test.dependsOn`. First, after fix 2 is in, re-run the backlog test inside the release chain and read the actual failure output. A non-dry `version` bump of `entrypoint/backlog/package.json` or a `dist` rewrite in the middle of the run (the `publish` -> `version` path of fix 2) is a candidate cause to confirm or rule out, not a conclusion. Fix it at the origin: the spec or `entrypoint/backlog/project.json` (touch project.json only if the root cause needs a target dependency or input; the dispatcher treats that path as conditional), and write `ROOT-CAUSE backlog: <the mechanism, at least 60 characters, naming the file and what raced or went stale>` into the evidence. If the cause lies outside the owned paths, stop and report it to the dispatcher with the evidence instead of editing outside them.

  5. Two things are deliberately NOT changed: the stale baked policy dist under `entrypoint/policy/dist` is never hand-edited (`nx run policy:test` passes alone, exit 0; the `0.3.7` extractor was a transient side effect of item 2), and `AGENTS.md:37`'s stale `--base=origin/main` is not edited (release-readiness uses the merge-base of HEAD with LOCAL main instead).

  6. Executor rules: no publish, no push, never run `pnpm release`. Run `pnpm release:dry` only after fixes 1, 2, 3 and 4 have landed, and if a dry run ever dirties the tree restore the mutated paths with `git restore <paths>` (remove only the new files the run created) before doing anything else. The guard run of criterion .4 is itself a full `release:dry`; expect minutes, not seconds.

- **Invariants:** [inv:shared-worktree] [inv:owned-paths-only] [inv:no-main-writes] [inv:no-ai-attribution] [inv:tests-cite] [inv:pnpm-only]. Commit only your own explicit paths, tag every commit `[psm:release-gate-fixes]`, never `git add -A`, never stash or hard-reset, commit with `--no-verify` as the previous states did.

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py release-gate-fixes` runs every acceptance criterion below (red until the work is done); `--only release-gate-fixes.N` runs one. Criteria .1-.3 and .5 are cheap; .4 and .6 run the heavy gates, and only after the cheap preconditions (the work product exists) hold.

---

## Evidence record

`docs/plan/stealth-browser/evidence/release-gate-fixes.md` (you create it) records, per fix, the failing command and exit before, the change, and the exit after (`EXIT <command>: <code>`), the `ROOT-CAUSE backlog: ...` line, and the `git status --porcelain` before and after one `pnpm release:dry`.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py release-gate-fixes --only release-gate-fixes.N`, loaded from `scripts/guards/amend_a.py`, text in `scripts/guards/amend-spec.json`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [release-gate-fixes.1] tools/nx-plugins/test/executors/wiring/check-test-wiring.spec.mjs exists with the testing-standard header (guards:, tier: S, cites:) citing 8468f7b1 and [release-gate-fixes.1], carries a plugin-inferred-target case and a negative control (a project with specs and no test target, literal or inferred, is still flagged), is listed in package.json `test:build-tools`, passes `node --test`, and check-lane-reachability exits 0.

- [release-gate-fixes.2] check-test-wiring.mjs honours Nx-inferred `test` targets through the project graph (no longer only the literal project.json `targets.test`), keeps its exit 1 for a project with specs and no test target, names no project, and `node tools/nx-plugins/test/executors/wiring/check-test-wiring.mjs` exits 0 on the tree (agent-store-runtime and agent-store-prompts are no longer flagged).
- [release-gate-fixes.3] package.json `release:dry` begins with `export ADHD_NX_VERSION_DRY_RUN=1 &&` so the build, version and publish run-many calls all inherit it, and tools/nx-plugins/test/executors/wiring/release-dry-clean.spec.mjs (header, cites 8468f7b1 and [release-gate-fixes.3], listed in `test:build-tools`) parses the script, asserts the export covers every nx invocation of the chain, passes `node --test`, and check-lane-reachability exits 0.
- [release-gate-fixes.4] `pnpm release:dry` (ADHD_NX_VERSION_DRY_RUN NOT pre-set) exits 0 on the fixed tree, does real dry work (not the 'nothing to version/publish' no-op) and leaves `git status --porcelain` identical before and after (plan bookkeeping paths ignored); run only once the fixes exist, cached by code identity in evidence/release-gate-fixes.dry.json.
- [release-gate-fixes.5] decompile-cli's validators/local/index.spec.ts builds fixturesDir from the current test/fixtures layout (not src/tests), entrypoint/decompile-cli/test/fixtures is populated, and `nx run decompile-cli:test --skip-nx-cache` exits 0.
- [release-gate-fixes.6] The backlog c8-vocabulary failure is fixed at its root cause: evidence/release-gate-fixes.md has a `ROOT-CAUSE backlog: <mechanism>` line, `nx run backlog:test --skip-nx-cache` exits 0, and the end-to-end release:dry run (release-gate-fixes.4) is green for the current code.
- [release-gate-fixes.7] Only owned paths changed by [psm:release-gate-fixes] commits (package.json, the wiring check and its two specs, the decompile-cli and backlog specs, backlog project.json, the state's evidence).

- [release-gate-fixes.8] The publish executor (tools/nx-plugins/build/executors/publish/impl.js) fails a package that is already on npm at the same version with different built content, unless options.dryRun is true AND process.env.ADHD_NX_VERSION_DRY_RUN === '1', where it logs that a bump would be required and returns success with the 'dry-run' outcome; impl.spec.mjs has three cases (dryRun + env + same version/different hash succeeds, dryRun without the env fails, non-dry fails), each citing 8468f7b1 and [release-gate-fixes.8], it passes `node --test`, and check-lane-reachability exits 0.
---

## Reservations

```text
read_only:  []
mutates:    ["package.json", "tools/nx-plugins/test/executors/wiring/check-test-wiring.mjs", "tools/nx-plugins/test/executors/wiring/check-test-wiring.spec.mjs", "tools/nx-plugins/test/executors/wiring/release-dry-clean.spec.mjs", "entrypoint/decompile-cli/test/unit/lib/validators/local/index.spec.ts", "entrypoint/backlog/test/unit/c8-vocabulary.spec.ts", "entrypoint/backlog/project.json", "tools/nx-plugins/build/executors/publish/impl.js", "tools/nx-plugins/build/executors/publish/impl.spec.mjs", "docs/plan/stealth-browser/evidence/release-gate-fixes.md", "docs/plan/stealth-browser/evidence/release-gate-fixes.dry.json"]
```

---

## Contract Promise

Modified or added: the owned paths above (`entrypoint/backlog/project.json` only if the backlog root cause needs it) and `evidence/release-gate-fixes.md`; `evidence/release-gate-fixes.dry.json` is written by the guard. Nothing else. No gate, baseline file, test or lane is relaxed or removed.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:release-gate-fixes]`:

- [ ] After each fix is green on its own criterion - commit that fix by explicit path.
- [ ] **After the guard passes** (mandatory) - commit the evidence (and `evidence/release-gate-fixes.dry.json`) and the `state.json` update together by explicit path.

---

## Notes for executor

executor=sonnet tier=sonnet; root-cause fixes for the release gates that were red: check-test-wiring inferred targets, release:dry mutating tracked files, decompile-cli fixture path, backlog c8-vocabulary load-dependence
