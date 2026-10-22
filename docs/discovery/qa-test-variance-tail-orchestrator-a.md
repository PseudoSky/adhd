# qa-variance tail: agent-engine-orchestrator, first half (dispatch-1014, bucket/qa-variance)

Scope: the alphabetically first half (13 of 25) of the `packages/agent/agent-engine-orchestrator/src/__tests__/` files that `qa-test-variance.md` lists as `kept-unfixed: not read within the dispatch budget`. The second half (`native-tooling-hitl-gate` through `web-fetch-extract`) belongs to a sibling agent. `plugins-loader-preloaded` and `anthropic-base-url` do not exist on this branch and are not in either half.

No test, build, nx or tsc command was run (user constraint). The analysis script `qa-test-variance.analysis.py` crashed on the live metrics file in this session (`StatisticsError: mean requires at least one data point`), so the per-test numbers below are copied from the ranked table in `qa-test-variance.md`, not re-derived. Every change is **verification pending (tests not run per user)**; no red run is recorded for any of them.

## What the data shows

Each of these tests has n=6 passing samples, a median of 6-90 ms and one p95 of 100-380 ms, with load-adjusted CV near or above 1 and rho(load) near zero: a single spike in six runs that machine load does not explain. A spike that lands on the same kind of test, once per file per run, is the signature of one-time work being charged to whichever test runs first in a worker.

## Fixed (8 files)

### F1. claudecli module graph: cold dynamic import charged to the first test (5 files)
- Files: `claudecli-bridge-governance`, `claudecli-builtin-bypass`, `claudecli-session-hardening`, `claudecli-session-resume`, `claudecli-worker-isolation` (`.test.ts`).
- Evidence read: each test body does `await import("../providers/claudecli.js")` (hardening and resume also `../providers/factory.js` and `claudecli-session.js`) with `child_process` mocked. The first call loads the provider, tool bridge, session registry and wire parsers. `claudecli-temp-root.test.ts` already documents and fixes the identical cost (`9ed453c1 HARD-H2`, `COLD_IMPORT_TIMEOUT_MS`), so the mechanism is established in this very directory.
- Fix: new fixture `__tests__/fixtures/warm-modules.ts` (`warmClaudeCliModules`, `COLD_IMPORT_TIMEOUT_MS`); each file awaits it in a `beforeAll` with a 60 s budget. `vi.mock` registrations in each file are per test file, so the warm-up honours them and later `import()` calls hit the module cache. No assertion was touched, none is weaker.
- Header: added per file (guards, tier S, cites qa-variance); `red: pending`.
- Variance rows covered: 56 (`session-hardening` AC4), 94/129/176/181 (`worker-isolation`), 125 (`bridge-governance` GOV-AC5), 126 (`builtin-bypass` AC3), 199 (`session-resume` AC1).

### F2. tokenizer warm-up (3 files)
- Files: `bk3-cache-breakpoints`, `bounded-token-count`, `model-call-tracing-seams` (`.test.ts`).
- Evidence read: all three drive `gpt-tokenizer` `encode` (bk3 and bounded-token-count directly and through `applyCacheBreakpoints`/`boundedTokenCount`; the tracing compaction test through the real Orchestrator over twelve 400 000-character messages). `bounded-token-count` rows: median 5.8 ms, p95 185 ms, which is a one-time cost on a ~6 ms test.
- Fix: `warmTokenizer()` (same fixture) in a `beforeAll`, which runs the first `encode` outside any test.
- Limit of the evidence: I did not open `gpt-tokenizer` to confirm the first-call cost is a lazy table decode rather than JIT warm-up. Both are one-time per-process costs, and `beforeAll` removes either from the tests, but the attribution is read-based and unmeasured.
- Variance rows covered: 51, 105, 131, 141 (`bk3`), 119 (`bounded-token-count`), 192 (`model-call-tracing-seams` TRC-AC26).

## Kept-unfixed (5 files, read)

- `anthropic-contract-fake.test.ts` (row 97, V1): offline, no clock, no socket, no timers; 546 lines of pure validators over a hand-built wire fake and the SDK. Nothing in the file is one-time work that belongs to a single test. The 221 ms is a single-run scheduler stall.
- `anthropic-pause.test.ts` (row 198, AC2 cap): header states "no clock, no sleep"; the retry clock is `now: () => 0, sleep: async () => undefined` (line 427) and aborts fire from inside the script. The test makes five SDK streaming requests against the fake, so it is CPU-bound work with a 9 ms median; the 107 ms sample is just above the 100 ms floor and unexplained by anything in the file.
- `claudecli-temp-root.test.ts` (row 113): already pre-warms the import (`beforeAll`, `COLD_IMPORT_TIMEOUT_MS`) and redirects `TMPDIR` into a private dir (`b941dcd3`). Remaining cost is real file-system writes and `chmod` checks the test exists to assert. rho(load)=0.54, so the spread is partly load-driven.
- `cp-cache-tool-determinism.test.ts` (row 205): pure canonicalisation plus one AnthropicProvider call through a fake fetch; no timers or I/O. Medians of 10 ms with a single 104 ms sample, 4 ms above the floor.
- `flt-claudecli-faults.test.ts` (row 173): the child is injected through `wire.spawn` and backoff runs on `FakeClock` (parks on a latch), so there is no wall-clock wait. The file statically imports `claudecli.js`, so no cold dynamic import is charged to a test. The 125 ms sample is unexplained by the file.

## Production cause

None found in these 13 files.

## tests-obsoleted

None.

## Out of scope observed

- The analysis script `docs/discovery/qa-test-variance.analysis.py` fails on the current `~/.adhd/test-timings/test-metrics.jsonl` with `statistics.StatisticsError: mean requires at least one data point` (a `statistics.mean` over an empty list; the file is live and a run with no qualifying tests triggers it). Not fixed here (shared artifact); the shared doc's numbers are unaffected.
- `claudecli-tool-bridge.e2e`, `claudecli-reap.e2e` and the other `*.e2e.test.ts` files spawn real processes and are out of the unit-lane variance data.

## Verify later

`npx nx test agent-engine-orchestrator` (all 13 files), then `npx nx affected -t test` for dependents. Re-rank variance after a few runs; expect the first-test spikes in rows 51, 56, 94, 105, 119, 125, 126, 129, 131, 141, 176, 181, 192 and 199 to disappear. If they do not, the cold-import / tokenizer attribution is wrong and these rows should be re-opened as scheduler noise.

## Per-file disposition

| file | disposition |
|---|---|
| anthropic-contract-fake | kept-unfixed (read) |
| anthropic-pause | kept-unfixed (read) |
| bk3-cache-breakpoints | fixed (F2) |
| bounded-token-count | fixed (F2) |
| claudecli-bridge-governance | fixed (F1) |
| claudecli-builtin-bypass | fixed (F1) |
| claudecli-session-hardening | fixed (F1) |
| claudecli-session-resume | fixed (F1) |
| claudecli-temp-root | kept-unfixed (read; already pre-warmed) |
| claudecli-worker-isolation | fixed (F1) |
| cp-cache-tool-determinism | kept-unfixed (read) |
| flt-claudecli-faults | kept-unfixed (read) |
| model-call-tracing-seams | fixed (F2) |
