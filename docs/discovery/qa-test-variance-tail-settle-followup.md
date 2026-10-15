# qa-variance: settle follow-up (agent-engine-orchestrator)

Item: qa-variance (dispatch-1014). Follows f425ba1f (`fixtures/settle.ts`, `settleUntilStable`) and
`qa-test-variance-tail-orchestrator-b.md`. No tests, builds or nx were run for this change (user
instruction); every file carries `red: pending` in its header.

## Method

Each fixed `setImmediate` quiesce loop (30-50 turns) became `settleUntilStable(probe)` over the exact
state the next assertion reads. The engine, limiter and claudecli provider paths under these tests
are microtask-only up to the observed points, so the first event-loop turn drains them; three quiet
turns replace 30-50. Negative assertions ("the read has not started") are taken only after the probe
is unchanged across three consecutive turns.

## Dispositions

| file | site | disposition | probe |
|---|---|---|---|
| tool-order-engine.test.ts | AC1 read-after-edit | fixed | `order` (full start/landed sequence) |
| | AC2 delegation overlap (two flushes) | fixed | `started` |
| | AC6 queuedMs barrier wait | fixed | `pre.map(callId, queuedMs)`, so a read that started would change the probe |
| tool-order-providers.test.ts | AC1 [anthropic, openai] | fixed | `order` |
| claudecli-bridge-concurrency.test.ts | AC1 limit 2 (two sites) | fixed, strengthened | latch `twoStarted` awaited first, then `[started, inFlight, peak]` |
| | review-M1 cancel while queued | fixed | `invoked` |
| factory-bypass-emit-order.test.ts | review-6 emit holds spawn | fixed | `[emit call count, order]`; chat to emit is microtask-only (claudecli.ts `reportBuiltinBypass` precedes any fs or bridge work) |
| fixtures/fake-clock.ts | `flush` (5 turns), `settle` (50 x flush) | kept, not a safe drop-in | see below |
| plugins-loader-failure-surfacing.test.ts | both calls | no change needed | already pins `overrides.configPath` to `/nonexistent/none.json`; `findConfigFile` returns null on a truthy missing explicit path before any cwd/home probe (loader.ts findConfigFile) |
| plugins-loader-budget.test.ts | default-budget install | no change needed | already pins `configPath` to a nonexistent tmpdir file (same early return) |

## fake-clock.ts: why kept

`FakeClock.flush()` has no state probe to hand to `settleUntilStable`. The only clock-visible state
(`t`, waiter count, `sleeps`) does not reflect consumer-side progress after a waiter resolves, and the
consumers include stream and readline-driven claudecli replays (`flt-claudecli-faults*`,
`fixtures/claudecli-replay-harness.ts`) whose progress takes several event-loop turns with no
clock-visible change. A clock-state probe would stabilize after one turn and return early, silently
weakening those tests. Converting it needs each caller to pass its own probe: filed as remaining work,
not done here. `untilSleeping` is already a bounded condition wait.

## Observed, out of scope

`tools/nx-plugins/build/lib/changed-set.spec.mjs` had uncommitted modifications in this worktree that
are not mine; left untouched and uncommitted.
