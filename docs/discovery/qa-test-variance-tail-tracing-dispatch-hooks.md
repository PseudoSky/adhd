# QA test variance tail: agent-plugin-tracing, dispatch-orchestrator, .githooks

Continues `docs/discovery/qa-test-variance.md` (method, load control and ranked table are defined there; this file covers only the "not read within the dispatch budget" rows in this scope). No test, build, nx or tsc command was run (user constraint). Every change is **verification pending (tests not run per user)**; `red: pending` in the headers.

## Scope and verdicts

| file | tests in table | verdict |
|---|---|---|
| `packages/dispatch/dispatch-orchestrator/src/test/orchestrator.spec.ts` | #66 `NEGATIVE CONTROL: no dag.session_id...` | fixed (D1) |
| `packages/dispatch/dispatch-orchestrator/src/test/process-guard.spec.ts` | #72 `a child over the memory ceiling is reaped...` | fixed (D2) |
| `packages/agent/agent-plugin-tracing/src/lib/model-call-completeness.test.ts` | #163 TRC-AC26 (2 tests) | kept-unfixed (T1) |
| `.githooks/pre-push-e2e.spec.mjs` | #35 AC2 | kept-unfixed (H1) |
| `.githooks/git-env-leak.spec.mjs` | #10, #15, #19, #21, #22 | kept-unfixed (H2) |

## Fixes

### D1. dispatch-orchestrator: guard fixtures no longer boot node
- File: `packages/dispatch/dispatch-orchestrator/src/test/orchestrator.spec.ts` (lines 72-75 constants, header lines 1-10).
- Cause (read, not inferred): `PASS_GUARD`/`FAIL_GUARD` were `node -e "process.exit(n)"`. The production executor (`defaultGuardExec`, `lib/orchestrator.ts:403-441`) is `child_process.exec`, i.e. `/bin/sh -c`. Every `orchestrateCycle` test that reaches the guard stage therefore paid a full node start-up (tens of ms idle, an order of magnitude more at the load averages of 30-150 recorded in the metrics). The flagged test (median 53 ms, p95 287 ms) is one of the ~20 tests that run a guard.
- After: `PASS_GUARD = 'exit 0'`, `FAIL_GUARD = 'exit 1'`. The same real `exec` -> `sh -c` -> exit-code path runs, and the same assertions (`guard_result` pass/fail, `guard_output === ''`, correction-milestone injection, `toBe(PASS_GUARD)` for the injected milestone) hold. No assertion was edited. The only output difference is the failing guard's appended `[guard exec error ...: Command failed: <cmd>]` text; I read every `guard_output` assertion in the file (lines 257, 434, 439) and none depends on the command string.
- Header added: failure mode, tier S, cites the original file's own scope; `red: pending`.
- Verify later: `npx nx affected -t test` (dispatch-orchestrator has dependents).
- Not changed (outside the assigned files, same pattern): `hitl-suspension.spec.ts:142`, `policy-dispatch-log.spec.ts:66`, `no-auto-create-dispatch.spec.ts:71`, `provider-binding-chain.spec.ts:53` still use `node -e "process.exit(0)"`; `orchestrator-cap-output.spec.ts` needs node for its output generators and must keep it. See remaining.

### D2. dispatch-orchestrator: process-guard reaper test waits for the spawn event, not `setTimeout(0)`
- File: `packages/dispatch/dispatch-orchestrator/src/test/process-guard.spec.ts`.
- Cause: the test slept `setTimeout(r, 0)` with the comment "let the spawn settle; ps needs the pid registered", then asserted `psRssBytes(pid)` is non-null. A zero-length timer is a race against the OS registering the child, not a synchronisation; under load it can lose and the `not.toBeNull()` assertion fails or the first sweep sees no rss.
- After: `await spawnedUp(child)` where `spawnedUp` resolves on the child's `'spawn'` event (rejects on `'error'`). Node emits `spawn` once the process has been created, which is exactly the precondition the comment names. Listener is attached synchronously after `spawn()` in the same tick, so the event cannot be missed. All assertions unchanged.
- Header added (failure mode, tier P, `red: pending`).

## Kept-unfixed (read, with reason)

### T1. `model-call-completeness.test.ts` (tracing)
Read in full. No sleep, wall-clock wait, shared port (loopback server binds port 0 in `beforeAll`) or shared path (`mkdtempSync` per test, `_resetTelemetryForTest` before and after). The two variable TRC-AC26 tests are pure hook emissions: their cost is `createPlugin().install()` (awaits `otelReady()`, `plugin.ts:111`, which builds the OTel provider each time `makeLogDir()` resets telemetry), `makeEnv` DDL, and `plugin.dispose()` closing the sink (`plugin.ts:136-145`). That is real telemetry construction/teardown under load (rho(load) 0.14 / -0.09, single-run spikes), the thing the test exists to exercise through the real plugin. A warm-up cannot remove it because telemetry is reset per test on purpose. Not changed.

### H1. `.githooks/pre-push-e2e.spec.mjs`
Read in full. Tier P by design: AC2 executes the hook's own `flags=$(...)` line through `sh` which starts `node` (`hookFlags`, line 40-48). No sleep, no shared path (AC4 uses a `mkdtempSync` workspace per case, 56 KB copy), no ordering dependence. rho(load) = -0.01: the spread is process-start scheduling, not load-tracking. Memoising `hookFlags()` across AC1/AC2 would cut one spawn but couple two tests through shared state; rejected.
Note (observation, not a defect): AC3 asserts `git diff --quiet HEAD -- .github tools/gate/lane-gate.mjs`, so it is red whenever those paths are dirty in the working tree. That is its documented purpose, but it makes the test depend on tree state.

### H2. `.githooks/git-env-leak.spec.mjs`
Read in full (514 lines) together with the guard under test, `.githooks/lib/git-env-guard.sh`. Tests are sequential (`node --test`), share the one fixture repo `R`, and every mutating test restores `R` in a `finally` (`repair()` / `update-ref -d` / `worktree remove`), so there is no cross-test ordering dependence. There is no sleep. The variance is process-fork count: one `runGuard` call runs `guard_snapshot` + `guard_verify`, each ~15 child processes (`git rev-parse`, `git config` x3, `git worktree list`, `git for-each-ref`, `awk`, `grep`, `sed`, `mktemp`, `sort`, `diff`), plus the test-side `snapshot()`/`assertPristine()` (6 git spawns) and `headSha` / `commit-tree`. At load average 30-150 (p95 2-4 s vs median 0.4-0.8 s) fork latency dominates. Hoisting `headSha`/`commit-tree` into `before()` would remove 2 of ~40 spawns per test (~5 percent), not enough to move the distribution, and the guard's own spawns are the product under test. Not changed. The prior report's note stands: the header lacks the standard fields (baselined legacy).

## production-cause

None found in this scope.

## tests-obsoleted

None suspected.

## out-of-scope-observed

- Four sibling dispatch-orchestrator specs repeat the `node -e "process.exit(0)"` guard fixture (D1 list above).
- `process-guard.spec.ts` cross-process test spawns `node --experimental-strip-types` per run; correct as written (the real second process is the point), no assertion on time.

## remaining

- Apply the D1 change to the four sibling specs listed above (guard string only), after the owner of those files is confirmed.
- Run, when the user permits: `npx nx affected -t test` for dispatch-orchestrator and agent-plugin-tracing, `node --test .githooks/pre-push-e2e.spec.mjs .githooks/git-env-leak.spec.mjs`, then re-extract variance from `test-metrics.jsonl` to confirm the D1/D2 tests left the highly-variable set.
