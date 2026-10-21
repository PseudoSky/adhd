# QA test variance, tail: tools/nx-plugins/build, group A (qa-variance)

Continues `docs/discovery/qa-test-variance-tail-policy-backlog-nx.md` (method, shared constraints). Scope: `sync-global.spec.mjs`, `publish/impl.spec.mjs`, `publish/manifest-backstop.spec.mjs`, `lib/release-manifest.spec.mjs`, `manifest/generate-manifest.spec.mjs`, each read in full. Timing evidence: `~/.adhd/test-timings/test-metrics.jsonl` (17 runs per test in these files). No test, build, nx or tsc command was run; every change is **verification pending (tests not run per user)**. No production file was edited.

## Fixed

### F1. sync-global.spec.mjs: stamped baseline hash computed once per distinct dist content
- Cause: every `makeFixture()` / `makeBinKeyingFixture()` (about 40 per run) called `stampedDistHashOf`, which did `mkdtemp`, a recursive copy of the dist, `generateDistManifest`, `normalizedHash` and `rmSync`. That filesystem work scales with disk and CPU load and is the file's repeated per-test cost (tail rows: BUG-004 (d) p95 189 ms vs median 57 ms; BUG-027 refused p95 186 ms; HIGH-1 p95 174 ms).
- Fix: `stampedDistHashOf` now memoises on a content key (every dist file's relative path and bytes plus the source manifest). The REAL `generateDistManifest` and `normalizedHash` still produce the value, once per distinct content. `normalizedHash` (`version/compare-published.js:140`) hashes only normalised manifest plus relative path and bytes, so it is independent of temp path and mtime and the memo is exact. Distinct content (`stampedHashWithCode` with other code) gets its own key, so the mismatch baselines stay genuinely different (the `notEqual` sanity assertion at BUG-004 (a) still has teeth).
- Assertions: unchanged. Header added.

### F2. release-manifest.spec.mjs: ambient release env pinned
- Cause (ordering/shared state): `writeReleaseManifest` defaults `runToken` to the ambient `process.env.RELEASE_RUN_TOKEN` (`lib/release-manifest.js:115`). Most tests in the file write manifests without an explicit token, so a shell or CI run that exports the release env changes the manifests under test (for example the case that expects `runToken: null`).
- Fix: file-level `before`/`after` pins `RELEASE_RUN_TOKEN`, `RELEASE_FORCE_FULL_PUBLISH`, `RELEASE_FORCE_REASON` to unset and restores the ambient values after. The one test that manages its own token keeps doing so. Assertions unchanged. Header added.

### F3. publish/impl.spec.mjs and publish/manifest-backstop.spec.mjs: same ambient release env pin
- Cause: the real executor reaches `checkPublishAllowed`, whose default env is `process.env` (`release-manifest.js:199`, reads at `:203`, `:205`, `:258`), and `makeProject`/`writeReleaseManifest` pick up the ambient token. Tests (a), (b), the dist-manifest and concurrency tests assume them unset without enforcing it.
- Fix: same file-level pin. Assertions unchanged. Headers added (failure mode, tier, item qa-variance, red pending).

## Kept-unfixed (cause, and why)

- `publish/impl.spec.mjs` "concurrency: N parallel publish tasks" (median 304 ms, p95 480 ms, max 1238 ms): twelve in-process `run()` calls racing for the REAL lockfile of `lib/published-state.js`, which polls at `LOCK_POLL_MS = 40` (line 45, `pollMs` at line 104). The contention is the property under test (no lost update); wall time is production-caused, see below. The test already uses no sleep and no timing assertion.
- `publish/impl.spec.mjs` "cache HIT" (p95 346 ms) and `manifest-backstop.spec.mjs` "(a) NO manifest at all" (p95 414 ms): each is the first test of its file; the cost is the cold `require` of `impl.js` and its transitive modules (and the first metrics write). Inherent per-process warm-up.
- Per-test module reload (`loadFreshImpl` deleting `require.cache` for impl, npm-registry, reconcile-core, published-state): needed because those modules capture the mocked `spawnSync` at load. Replacing it with one file-level dispatching mock could not be proven safe without running the suite (module-level lock/state in `published-state.js`), so it was not attempted.
- `generate-manifest.spec.mjs`: read in full. Pure functions plus three `writeDistManifest` cases on a `mkdtemp` root removed in `finally`. Tail rows (p95 137 ms, median 28.7 ms) are the first-use lazy `require` of the assets `copy`/`chmod-bin` executors (`generate-manifest.js:345-359`) and temp-dir IO. No wall clock, no spawn, no leak, no shared state. Not edited (no header added because the file is unchanged).
- `sync-global.spec.mjs` other cost: `mkdtemp` per fixture and plain file writes. Cleanup is in `finally` for every fixture (including the `chmodSync` restore in LOW-7). A per-file shared fixture is not possible: tests mutate shims, store dirs and published-state.
- Tier-P tests whose point is spawning: none in this group (all five files are tier S; `spawnSync` is mocked in the publish pair and `npmView`/`pnpmAdd`/`install` are injected in sync-global).

## Production-cause (no production edit)

- `tools/nx-plugins/build/lib/published-state.js:45` `LOCK_POLL_MS = 40` with the lock acquired at `:104`: a lock waiter sleeps in 40 ms steps, so the concurrency test's wall time grows with the number of racing writers and with scheduler load. A smaller or backoff poll, or an injectable poll interval for tests, would remove it. (Already carried in the first report; the evidence here is the 17-run timing spread of the concurrency test.)
- `tools/nx-plugins/build/lib/release-manifest.js:115`: `writeReleaseManifest` silently defaults `runToken` from `process.env`. This is the seam that made the specs ambient-dependent; passing the env explicitly (as `checkPublishAllowed` already allows with `opts.env`) would remove the need for the spec-side pin.
- `tools/nx-plugins/build/executors/sync-global/sync-global.mjs:755` and `:808` call `spawnSync` for `npm view` and the install in the default seams; the spec never reaches them (all injected), so they are not a variance source here.

## Tests obsoleted
None.

## Out-of-scope observed
- The worktree carries uncommitted edits from sibling dispatches (`entrypoint/policy/...`, `ci-hygiene.spec.mjs`, `changed-set.spec.mjs`, `bug-nxassets-001...spec.mjs`); they were not touched or staged here.
- `manifest-backstop.spec.mjs` never calls `publishVerify.__resetReadVersion()` after its tests (impl.spec.mjs does); harmless per-process because each spec file runs in its own `node --test` process, noted for completeness.

## Remaining
- The variance fixes need one run to confirm: `node --test` on the five files (user has not authorised running). Expected: same pass counts, no assertion change.
- Optional production follow-ups above (lock poll injection, explicit env for `writeReleaseManifest`).
