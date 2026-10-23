# QA test variance, tail: entrypoint/policy, entrypoint/backlog, tools/nx-plugins (qa-variance)

Continues `docs/discovery/qa-test-variance.md` (method, ranked table). Scope: the kept-unfixed files of that report under `entrypoint/policy/**`, `entrypoint/backlog/**` and `tools/nx-plugins/**`. No test, build, nx or tsc command was run; every change is **verification pending (tests not run per user)**. No production file was edited.

## Fixed

### F1. backlog: per-process schema template for every fresh real store
- New `entrypoint/backlog/src/test/helpers/schema-template.ts` (+ `schema-template.spec.ts`), used by `openTestIssueStore` (`open-test-issue-store.ts`) and `openTmpStore` (`tmp-store.ts`).
- Cause: ~15 spec files (transition, similar-view, similarity-scan, spec-revision.p7, uid-prefix, transition.superseded, markdown-format, citation, get-superseded-uid, c8-vocabulary, edge-batch, ...) open a fresh turso store per test and run the full `applySchema()` DDL (tables, indexes, FTS table, triggers). That cost scales with load.
- Fix: the schema is applied once per process into a template file (same adapter, `OPEN_TYPE_POLICY`, `applySchema()` calls the openers use), then copied per test.
- Safety, enforced in code: template used only if the closed template dir holds no non-empty sidecar; copy goes to a private staging name and is hard-linked into place, so it never replaces an existing `dbPath` (cross-process tests that reopen the same path keep their file) and no reader sees a half file; `:memory:` skipped; any failure falls back to the original cold open; `applySchema()` still runs after seeding (it is `IF NOT EXISTS` throughout, so the seeded file is verified, not trusted); the production vocabulary assertion in `openGraphBacklogStore` still runs.
- New spec covers: `:memory:` declined, seed + production opener accepts it and no staging file left, existing path untouched, two seeded stores independent.
- Not done: sharing one populated store across tests. Every spec examined mutates (setUid, issues created per test, transitions), so a shared store would couple tests.
- Verify later: `npx nx affected -t test` for `backlog`. If turso leaves state in a form copy cannot carry, the sidecar guard returns false and behaviour is unchanged.

### F2. backlog: contract-anchors.spec.ts
- Each `(file.ts:NNN)` anchor re-read and re-split its source file; now one read per cited file (`linesOf`). Assertions unchanged. Header added.

### F3. nx-plugins: lib/metrics.spec.mjs
- Two CPU-guard tests ("guard runs even when ADHD_NX_METRICS=0", "thrown task error is NOT masked") used a 30 ms wall-clock busy loop; wall time stretches under load. They now inject CPU through the file's existing `withFakeCpuUsage` (1e6 ms), so the guard trips regardless of load. The real-measurement trip stays covered by the untouched busy-loop teeth test. Note: in the thrown-error path `withMetrics` never calls `checkCpuGuard` (lib/metrics.js catch block), so that test passes either way; unchanged semantics.
- `MetricsRecorder.phase` accumulation test compared `a >= b*0.5` across two separately timed real timers, which a stalled `b` interval can break (latent flake). Now asserts `a` grew past its own first value.
- Header fields added (guards/tier/cites/teeth).

### F4. nx-plugins: check-lane-reachability.spec.mjs
- Fixture workspaces were never removed (leaked `lane-reach-*` dirs in the OS temp dir). Now tracked and removed in a file-level `after`. Header added.

## Production-cause (no production edit; evidence by reading)

- `entrypoint/policy/src/wrapper/ir.ts` `extractPolicyOperations` -> `inspectBakedIr`: every in-process `adhd-policy` CLI call (`runPolicyCli` -> `buildPolicyPackage`, `wrapper/package.ts:42`) reads and parses the baked artifact and `surfaceDigest()` (ir.ts:89-105) walks and sha256-hashes every `.d.ts` of policy-core-client; with no artifact it does a full live ts-morph extraction (`ir-live`). Nothing is memoised per process, so every `runCli` test (s5-narrow, s3-run-bin, review-fixes-entrypoint) pays directory IO or seconds of extraction that scales with load. Fix belongs in production: memoise per process keyed by distDir.
- `entrypoint/policy/src/test/functional/http-entry.spec.ts`: each case does `vi.resetModules()` and re-imports `src/entry/http.ts`, which rebuilds the package (the file's own comment: cold live extraction takes seconds). Same root as above.
- `tools/nx-plugins/test/executors/wiring/check-skip-expiry.mjs` `listTestFiles` (line 231) and `gitHead` (line 214): `collectSkipExpiry` spawns `git ls-files` (and `git rev-parse`) on every call with no injection seam, so ~25 in-process cases of `check-skip-expiry.spec.mjs` each pay a cold child spawn (medians 73-106 ms, p95 300-450 ms). A seam (injectable file lister / head reader) would let the pure cases run without a spawn; the git-behaviour cases (AC3, b87dcea0) must keep the real git.
- Carried from the first report: `published-state.js:45` `LOCK_POLL_MS` / `file-lock.js:64` (not in this scope; unchanged).

## Kept-unfixed (cause, and how far the file was read)

Read in full or in the relevant part, cause identified, nothing deterministic left to change in the test:
- `entrypoint/backlog/src/mcp-discoverability-real-ops.spec.ts`: not a store test (prior report's cause was wrong). Cost is a new `Ajv` plus `compile()` of large composed schemas per case; a shared Ajv could collide on schema ids and cannot be proven safe unrun; the 905 ms tail is first-compile warm-up.
- `entrypoint/backlog/src/server.tracing-required.spec.ts`: not a store test (prior cause wrong). `beforeEach` runs `initTelemetry({otel:true})` + `otelReady()`; the p95 is cold OTel init in the first case of the file.
- `entrypoint/backlog/src/env.spec.ts`: opens stores via production `openGraphBacklogStore` per test; helper seeding does not apply (the test builds its own env paths). Cost: store open under load.
- `entrypoint/backlog/src/query/edge-batch.spec.ts`: already `beforeAll`; carries a skip-expiry pragma (8752d7d5) noting the 60-issue seed times out under load. Seed volume is inherent to what it measures (bounded statement count over 60 issues); the template shaves only the schema part.
- backlog store specs that mutate per test (transition, transition.superseded, similar-view, similarity-scan, spec-revision.p7, uid-prefix, markdown-format, citation, get-superseded-uid, c8-vocabulary): covered by F1; per-test project/issue seeding remains because tests mutate or count rows.
- `entrypoint/policy/src/test/functional/s8-serve-handshake-and-precedence.spec.ts`: read in part (first 130 lines): fake timers and `settle()` barriers, no wall clock; temp dirs via `withTmpDir` (mkdir/rm/rmdir of a root shared across parallel workers). IO spikes only.
- `s7-mcp-json.spec.ts`, `s7-serve.spec.ts`, `s5-narrow.spec.ts`, `s3-run-bin.spec.ts`, `review-fixes-entrypoint.spec.ts`: headers and fixtures read, bodies sampled only (not read in full): `withTmpDir` IO, plus `runCli` for s5/s3 (production-cause above).
- nx-plugins tier-P specs: `test-report.spec.mjs`, `check-skip-expiry.spec.mjs` (read in full), `run-gates.spec.mjs` (read first 90 lines), `check-agent-lane-spawn.spec.mjs` (no spawn in the unit under test; cold fs glob in the first case): real `node` child spawns are the purpose of the tier P cases; converting them to in-process calls would weaken what they prove (process exit status, stdio split) and was refused.
- Not read beyond head/grep (remaining): `sync-global.spec.mjs` (1441 lines; temp fixtures, injected fakes, all fixtures removed), `publish/impl.spec.mjs`, `version/impl.spec.mjs` (2355 lines, 39 spawn sites), `changed-set.spec.mjs`, `ci-hygiene.spec.mjs` (14 git sites), `generate-manifest.spec.mjs`, `bug-nxassets-001...spec.mjs`, `manifest-backstop.spec.mjs`, `bug-026-assets-output-scope.spec.mjs`, `deps/executors/sync/impl.spec.mjs`, `release-manifest.spec.mjs`. publish/impl already uses injected fake clocks (no real sleep). Evidence so far: no real sleeps, no shared paths.

## Tests obsoleted
None.

## Out-of-scope observed
- `.githooks/git-env-leak.spec.mjs` header lacks standard fields (baselined legacy), per the first report.
- A sibling's pre-commit (`nx affected --target=lint`) held `index.lock` in this worktree for over ten minutes during this run; commits needed retries.
