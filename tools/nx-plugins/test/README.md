# @adhd/nx-test

`test-wiring` — fails if a spec-bearing project has no `test` target, then
delegates to the lane-reachability check below.

`lane-reachability` (`executors/wiring/check-lane-reachability.mjs`) — the
machine check that keeps the push/CI gate's resource-heavy lane reachable and
cached. It is the canonical entry point invoked UNCONDITIONALLY by
`.githooks/pre-push` and both CI workflows (before the lanes), and registered as
`@adhd/source:lane-reachability` / `pnpm run check:lane-reachability`.

It fails when:

1. a project ships `src/**/*.e2e.ts` but declares no `e2e` target (dead config);
2. any `test.dependsOn` contains `e2e` (re-coupling the heavy lane into every
   `nx affected -t test`);
3. any `e2e` target is not `cache: true` with non-empty `inputs` containing
   `default` (the gate must reach it without an uncached re-run);
4. a publishable project's declared `e2e` disagrees with `publish` reaching
   `e2e` — i.e. the conditional in `tools/nx-plugins/build/plugin.js`
   (`hasE2e ? ["e2e"] : []`) is broken (verified by invoking the plugin's OWN
   `createNodes`, never a re-implementation);
5. either CI workflow (`.github/workflows/pull-request.yml`, `ci.yml`) fails to
   invoke every target in `GATE_TARGETS` (`tools/gate/lane-gate.mjs`); or
   `.githooks/pre-push` stops deriving its flags from `.githooks/lib/pre-push-flags.mjs`
   (GATE_TARGETS minus `e2e`), drops `test`, or runs `e2e`;
6. any project with a `tsconfig.spec.json` has no compiling target over it
   (ratcheted via `executors/wiring/lane-reachability.baseline.json`, which may
   only shrink).

Exit code is the only signal (0 = wired, 1 = gap). See the file header for the
full rationale and `check-lane-reachability.spec.mjs` for the per-rule negative
controls.

## Test metrics (`metrics/`) — the history behind G5 and G7

Two reporters write one JSON record per test (and one per run) to
`~/.adhd/test-timings/test-metrics.jsonl` (`ADHD_TEST_TIMINGS_DIR` moves the directory, as for the pre-push
timing logs; `ADHD_TEST_METRICS_FILE` names the file; `ADHD_TEST_METRICS=0` turns recording off). The store is in the
home directory, not a checkout, because G5 and G7 compare across runs and a worktree's files are deleted with it.

- **vitest** — `metrics/vitest-reporter.mjs`, attached to every project that installs `nxViteTsPathsPre()` (68 of the
  73 configs with a `test` block; `tools/vite-plugins/test-metrics.mjs` is the hook). It runs beside `default`, so the
  printed output and the pre-push timing capture are unchanged. A `--reporter` command-line flag replaces the list.
- **node:test** — `metrics/node-test-reporter.mjs`, paired with the `spec` reporter in the root `test:build-tools` script.
- Each record carries project, file, full test name, tier (the file header's `tier:` line; `tierSource: inferred` when
  a legacy file has none, by the file-name rule of `docs/standards/testing.md`), outcome (pass, fail, skip, todo),
  `durationMs`, `retryCount`, `runId`, git sha, `dirty`, branch, `mainline`, timestamp and the load average at start.
- Recording never fails a run: a write error is a warning. A cached nx task executes nothing and records nothing.

```
node tools/nx-plugins/test/metrics/test-report.mjs summary            # p50/p95 per tier and project, suite wall time
node tools/nx-plugins/test/metrics/test-report.mjs offenders [--check] # tests over their tier budget
node tools/nx-plugins/test/metrics/test-report.mjs flaky [--check]     # both outcomes on the same code, retries
node tools/nx-plugins/test/metrics/test-report.mjs history <test>
node tools/nx-plugins/test/metrics/test-report.mjs g7                  # gate G7 (stages D, E via run-gates)
node tools/nx-plugins/test/metrics/test-report.mjs g5                  # gate G5 (stages E, F via run-gates)
node tools/nx-plugins/test/metrics/test-report.mjs repeat --times 5 -- npx vitest run   # one repeat group
```

Exit 0 is a report (or `insufficient history`), 1 a gate violation, 65 a usage error. See the header of
`metrics/test-report.mjs` and `metrics/analysis.mjs` for the definitions (run, same code, mainline, nearest-rank
percentile). The two gates run only on demand; no hook or CI job calls them yet.
