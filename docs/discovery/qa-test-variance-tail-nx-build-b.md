# QA test variance, tail: tools/nx-plugins build/assets/deps/test-gates (qa-variance, part B)

Continues `docs/discovery/qa-test-variance-tail-policy-backlog-nx.md`. Scope: `build/executors/version/impl.spec.mjs`, `build/lib/changed-set.spec.mjs`, `build/ci-hygiene.spec.mjs`, `assets/bug-nxassets-001-chmod-survives-cache.spec.mjs`, `build/bug-026-assets-output-scope.spec.mjs`, `deps/executors/sync/impl.spec.mjs`, `test/gates/run-gates.spec.mjs` (all under `tools/nx-plugins/`). Every file was read in full except `version/impl.spec.mjs` (read lines 1-600, plus a grep of the whole file for sleeps, real spawns, clocks, and test titles). No test, build, nx or tsc command was run; every change is **verification pending (tests not run per user)**. Syntax of the edited files was checked with `node --check` only. No production file was edited. Timings below are from `~/.adhd/test-timings/test-metrics.jsonl` (17 runs per test, `durationMs`).

## Fixed

### F1. changed-set.spec.mjs
- Cause: each of the two `resolveBaseRefFromPublishedState` ordering cases built its own repo (`git init`, 3 `git config`, one `git commit` + one `git rev-parse` per commit, about 9 spawns each), and two more cases spawned `git rev-parse HEAD` in the checkout. Medians 46 ms (p95 218) for the computeChangedProjectSet case that shares the file's cold start, up to 218 ms+ tails; all spawn cost scales with load.
- Fix: one lazily built, read-only repo shared by both ordering cases (commits a<b by date, and c<d sharing one committer second with c the ancestor), a single `git init`, identity passed with `git -c` (no `git config` spawns), removed in a file-level `after`; `HEAD` sha read once (`realHead()`). Assertions are unchanged: same refs, same both key orders, same oldest-wins and same-second-ancestor-wins checks. The cases only read the repo (`git log`, `merge-base`), so sharing cannot couple them.
- Production reads `git log -1 --format=%ct` and `merge-base --is-ancestor` on only the refs named in the published state, so the extra commits in the shared repo do not affect the result.
- Header: failure mode, tier P, item qa-variance, red pending.

### F2. ci-hygiene.spec.mjs
- C-AC6 ("the CLI exits 0 on parity and 1 when behind"): it spawned a fresh `node --input-type=module -e` three times (median 216 ms, p95 819 ms, max 1050 ms) only to call the exported `runParity` and map `ok` to an exit code. Now imports the module once and calls `runParity({workspaceRoot})` in-process, mapping `ok ? 0 : 1` exactly as the removed wrapper did. `main()` in the module is entry-guarded (checked), `discoverReleaseSet` and the state read have no cache (checked), so each call sees the rewritten fixture. Same three assertions (equal 0, ahead 0, behind 1).
- C-AC7 `scratchRepo()`: `git config` x2 replaced by `git -c ...` on the commit (3 spawns instead of 5). The tree-clean CLI spawns stay: the exit codes of the real script are the claim.
- Header added.

### F3. bug-nxassets-001-chmod-survives-cache.spec.mjs
- Cause: no spawns; tails (p95 31 ms vs median 3 ms for a pure-config case) are the first `require` of `generate-manifest.js` and per-case fixture creation. The manifest module is now required at load time (not charged to a test body), and the three read-only plugin-shape cases share one fixture (removed in `after`; `createNodes` does not write). The behaviour case still builds its own tree because it mutates modes.
- Header added.

## Kept-unfixed (cause and evidence)

- `build/executors/version/impl.spec.mjs` (2355 lines, 32 tests): the "39 spawn sites" are sites of the `spawnSync` mock (`makeSpawnSyncMock`), not real child processes; there is no `git init` to template or share. Grep found no sleeps, no wall-clock reads, no real spawn (`execFileSync`, `spawn(`), no timers. Measured medians are 2-35 ms, p95 100-200 ms (for example "BUG-BUILD-ASSETS-CACHE-STALE..." 35 ms median, 203 ms p95; "cache HIT, integrity fast path..." 17 ms, 200 ms). Cause: per test, `mkdtemp` + dozens of `writeFileSync` + hashing of a dist dir + `rm -rf`, and `loadFreshImpl()` re-reads and re-compiles six modules (`impl.js`, `reconcile-core.js`, `npm-registry.js`, `published-state.js`, deps `sync`/`check`); all scale with machine load and nothing in the test is nondeterministic. Considered and refused unrun: a single file-level `spawnSync` shim delegating to a per-test handler so `impl.js` loads once. It is only sound if no module keeps state between tests (checked: `_nameIndexCache` is a per-context WeakMap, the rest holds none) and if the tests that do not call `installEslintCheckMock` still see a fresh `__internals` (they rely on the reload for that, and a stale mock would hide a regression in the "never reached" assertion). Changing this in a 2355-line file with no run available would risk weakening assertions for a gain of single-digit milliseconds at median. Follow-up when tests may be run: introduce the shim, reset `sync`/`check` `__internals` in `installEslintCheckMock`'s counterpart, and compare timings.
- `build/bug-026-assets-output-scope.spec.mjs`: one test; tail is the native `nx/src/native` glob/copy/remove over a temp tree (`expandOutputs`). No determinism left to buy; unchanged, no header edit.
- `deps/executors/sync/impl.spec.mjs`: `runDependencyCheck` is mocked, `child_process` mocked to throw. Max 38 ms. The only heavy case is the last one, the intentional smoke import of the real `eslint-check.mjs` (`loadEslintCheck`), an integration check whose point is the real module graph; kept. Unchanged.
- `test/gates/run-gates.spec.mjs` (tier P, read in full): the spawns of the real wrapper and the real workspace-standards engine are the purpose (stage selection, one report, worst-gate exit code). The command table cases take 229 ms median, p95 1.3 s (max 1.6 s); the slow ones run the engine over the real table (stage B runs real G2/G3 commands, the D/E/G cases run a `node -e` no-op per bound gate). Replacing the no-op with a cheaper shell builtin would change what the engine's command-word liveness check sees and the engine is outside the repo, so it was not done unrun. The 10 s tier ceiling holds with margin. Unchanged.
- `ci-hygiene.spec.mjs` C-AC5 (nested `npx nx run agent-core-env:test`, twice, the second unfiltered) and C-AC8 (`worktree-setup.sh` with a real offline `pnpm install`, median 5.9 s, p95 23.7 s): tier P, the real nx and pnpm process is the claim (vitest-reported file count; a real non-symlink `node_modules`). Variance is the nested tool's own startup and install under load. Kept.

## Production-cause (no edit)
- None new. `changed-set.js` `resolveBaseRefFromPublishedState` spawns `git log` once per distinct ref plus `merge-base` on ties with no batching; a single `git log --no-walk` over all refs would cut spawns, but it is a production change and was not made.

## Tests obsoleted
None.

## Out-of-scope observed
- `git status` in this worktree also shows uncommitted edits by sibling agents (entrypoint/policy specs and helpers, and the publish/manifest-backstop/sync-global/release-manifest specs under tools/nx-plugins); none were staged or committed by this run.

## Remaining
- Single-load `spawnSync` shim for `version/impl.spec.mjs` (needs a run to validate).
- Nothing else in scope is unread, except lines 600-2355 of `version/impl.spec.mjs`, which were scanned by title and grep only.
