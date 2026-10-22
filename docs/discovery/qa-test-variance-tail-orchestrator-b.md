# QA test variance: agent-engine-orchestrator tail, second half (qa-variance, dispatch-1014)

Scope: second alphabetical half of the unread orchestrator test files in `docs/discovery/qa-test-variance.md`. `model-call-tracing-seams.test.ts` is owned by the first-half agent (committed there) and is excluded here. No test, build, nx or tsc command was run for this work; every change is **verification pending (tests not run per user)**. No production code was changed.

## Cause found (differential, from `~/.adhd/test-timings/test-metrics.jsonl`)

Three files quiesce latch-driven async work with fixed loops of 20 to 50 `setImmediate` turns. Within each file the tests that use the loop have median 10 to 43 ms and p95 140 to 270 ms; the same file's loop-free tests run at 0.7 to 1 ms (for example `tool-call-concurrency` "default limit" 0.7 ms vs "limit 2 over 5 calls" 42.9 ms median / 266 ms p95). The engine, registry and limiter schedule no timers and no I/O (`rg setImmediate|setTimeout` over `engine/`, `clients/registry.ts` is empty), so their chains are microtask-only and are quiescent after one turn; the remaining turns only pay scheduler latency under load.

## Dispositions

| file | disposition | change |
|---|---|---|
| `tool-limiter.test.ts` | fixed | 30-turn `settle` replaced by `settleUntilStable(probe)`; header added |
| `tool-call-concurrency.test.ts` | fixed | 50-turn `settle` replaced (4 sites) with probes over started/in-flight/peak/settled state; header added |
| `registry-connect.test.ts` | fixed | 20-turn `flush` replaced by `settleUntilStable` over the connect log; header cites qa-variance |
| `fixtures/settle.ts` | new helper | yields until the probed state is unchanged for 3 consecutive turns (cap 200, above the old 50); no clock read. Negative assertions are still taken only after observed quiescence |
| `plugins-loader-defaults.test.ts` | fixed | `findConfigFile` probed cwd and the developer's real `~/.adhd/agent-mcp` and `~/.agent-mcp` configs; calls now pin `overrides.configPath` to an empty config in the file's temp dir (machine-dependent time, and the "installs nothing" case failed on hosts with a global plugin config) |
| `web-fetch-extract.test.ts` | fixed (minor) | 4000-case oracle loop built a message and matcher per case; now `isDeepStrictEqual` fast path, `expect` with the same message only on mismatch. Remaining cost is CPU-bound extraction on 1 MB inputs |
| `sse-client-wire.test.ts` | kept-unfixed | real loopback SSE server is the point of the test (ephemeral port, closed in afterEach); spike is socket setup under load |
| `r10-w1-shell-guidance-claudecli.test.ts` | kept-unfixed | tier P by header with a stated fidelity gap: real loopback bridge plus real MCP client |
| `tool-limiter-hitl.test.ts` | kept-unfixed | no settle loop; the 10 s timer is a deadlock guard cleared in `finally`; first-test cold Orchestrator import (18.6 ms median) |
| `native-tooling-hitl-gate.test.ts` | kept-unfixed | fully scripted, no timers; single-run spike |
| `tool-annotations-wire.test.ts` | kept-unfixed | provider `wire.fetch` seam, no socket; cold SDK construction only |
| `tool-naming.test.ts` | kept-unfixed | pure resolution plus SDK stub; cold SDK construction only |
| `shell-exit-status.test.ts` | kept-unfixed | scripted engine loop, `child_process` mocked; single-run spike |
| `model-call-tracing-seams.test.ts` | out of scope | first-half agent (tokenizer warm-up) |
| `anthropic-base-url.test.ts`, `plugins-loader-preloaded.test.ts` | out of scope | do not exist on this branch (metrics from other branches) |

## Production cause

None found. `plugins/loader.ts` `findConfigFile` reads real home paths by design when no `configPath` is given (not edited; tests now pin it).

## Tests obsoleted

None.

## Out of scope observed (same `setImmediate` loop pattern, for the dispatcher)

`tool-order-engine.test.ts:81` (50 turns), `tool-order-providers.test.ts:69` (50), `claudecli-bridge-concurrency.test.ts:57` (50), `factory-bypass-emit-order.test.ts:21` (30), `fixtures/fake-clock.ts:46,53`. The prior report kept `tool-order-engine` as a scheduler stall; the differential above suggests the same cause and fix (`settleUntilStable`). Migrating them is a mechanical follow-up. Also: `loadExternalPlugins` callers in `plugins-loader-failure-surfacing.test.ts` and `plugins-loader-budget.test.ts` should be checked for the same real-home config probe.

## Verify later

`npx nx affected -t test` (dependents of agent-engine-orchestrator), then lint/typecheck/typecheck-spec. Red runs are pending for all edits.
