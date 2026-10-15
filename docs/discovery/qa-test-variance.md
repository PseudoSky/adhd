# QA test variance analysis (dispatch-1014, bucket/qa-variance)

Source: `~/.adhd/test-timings/test-metrics.jsonl` (56,120 lines, 8,092 distinct tests, 315 runs). No test, gate or nx command was run for this work (user constraint); every fix is **verification pending (tests not run per user)**.

## Method

Script: `docs/discovery/qa-test-variance.analysis.py` (run: `python3 docs/discovery/qa-test-variance.analysis.py ~/.adhd/test-timings/test-metrics.jsonl out.json`).

- Identity `(project, file, name)`; records deduped per `(runId, identity)`; durations from `pass` outcomes only; minimum sample **n>=5**.
- **Load control.** Every run in the data had loadAvgStart/cpus >= 1.44 (no idle baseline), so load cannot be bucketed. Instead each run gets a common-mode factor (median over its tests of duration/test-median, tests with median >= 20 ms) and `load-adj CV` is the CV after dividing by it. `rho(load)` is the Spearman correlation of a test's duration with loadAvgStart/cpus.
- **Highly variable (timing)** = n>=5, median>=5 ms, p95>=100 ms (below 100 ms spread is scheduler noise), CV>0.5, p95/median>3, load-adj CV>0.7 and rho(load)<0.6 (spread not explained by load, so intrinsic to the test).
- **Load-sensitive** (reported, not a nondeterminism defect; 311 tests): same gates but rho>=0.6 or 0.5<load-adj CV<=0.7: duration tracks machine load, i.e. CPU-bound work. Not in the table.
- **Flaky** = more than one distinct outcome (pass/fail) at the same gitSha, or retryCount>0. 10 tests have a fail record; all 10 are listed first.

Result: 191 timing-variable tests in 88 files, 10 flaky tests. Verdicts: kept-unfixed=201.

## Fix summary

_Fix batches pending._

## Ranked table

Flaky tests first, then by p95 descending. `flip` = same-sha outcome flips (fails in parentheses).

| # | test (file :: name) | n | median ms | p95 ms | CV | load-adj CV | rho(load) | flip | verdict |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `extract-source-files.spec.ts` :: extract() reports the files it read (39c4e00c) > [AC1] an ordinary tree: entry plus tra... | 4 | 11989.7 | 17724.8 | 0.51 | None | 1.0 | 1 (1) | kept-unfixed |
| 2 | `citation.cross-repo.spec.ts` :: citations verify against the repo that contains the cited path > (a) an absolute path i... | 4 | 1518.5 | 1846.8 | 0.21 | None | -0.8 | 1 (1) | kept-unfixed |
| 3 | `citation.cross-repo.spec.ts` :: citations verify against the repo that contains the cited path > (a) an absolute path i... | 4 | 1470.5 | 1779.2 | 0.15 | None | 0.4 | 1 (1) | kept-unfixed |
| 4 | `citation.cross-repo.spec.ts` :: citations verify against the repo that contains the cited path > (c) a repo-relative pa... | 4 | 1194.9 | 1341.0 | 0.13 | None | -0.6 | 1 (1) | kept-unfixed |
| 5 | `citation.cross-repo.spec.ts` :: citations verify against the repo that contains the cited path > (b) a sha present in n... | 4 | 890.0 | 1289.6 | 0.23 | None | -0.6 | 1 (1) | kept-unfixed |
| 6 | `plugins-loader-preloaded.test.ts` :: loadExternalPlugins — preloadedModules (bundled host) > installs an unresolvable specif... | 1 | 785.0 | 785.0 | 0 | None | None | 1 (1) | kept-unfixed |
| 7 | `contract-anchors.spec.ts` :: CONTRACT.md line-reference anchors are not stale (DEBT 1e12507f) > every (file.ts:NNN) ... | 12 | 42.7 | 244.3 | 1.16 | 0.47 | 0.51 | 1 (1) | kept-unfixed |
| 8 | `anthropic-base-url.test.ts` :: Anthropic provider endpoint (anthropic-base-url) > AC1: sends the request to the config... | 1 | 193.7 | 193.7 | 0 | None | None | 1 (1) | kept-unfixed |
| 9 | `edge-batch.spec.ts` :: 2267eaf9 — batched edge pseudo-field reads (real store) > issues a bounded number of st... | 4 | 38.0 | 186.2 | 1.02 | None | 0.4 | 1 (1) | kept-unfixed |
| 10 | `r10-m2-startup-stamps.test.ts` :: R10 M2 [openai]: the dispatching tool stamps sessionMs and queueWaitMs > R10 M2 AC3 [op... | 5 | 59.5 | 105.3 | 0.7 | 0.46 | 0.6 | 1 (1) | kept-unfixed |
| 11 | `transition.spec.ts` :: transition — status change (SPEC.md §6.3.4, real store) > StaleSupersedeError against a... | 12 | 789.5 | 5344.9 | 1.32 | 0.78 | 0.49 | 0 (0) | kept-unfixed |
| 12 | `similar-view.spec.ts` :: C9 AC6 — similarTo / hasSimilar filter dimensions > similarTo resolves the SOURCE side;... | 12 | 870.6 | 5228.6 | 1.64 | 0.76 | 0.59 | 0 (0) | kept-unfixed |
| 13 | `git-env-leak.spec.mjs` :: 50e8c966 AC3: guard_verify exits non-zero with a named GIT-ENV-LEAK message when a spec... | 15 | 689.1 | 4697.9 | 1.82 | 1.52 | 0.37 | 0 (0) | kept-unfixed |
| 14 | `similarity-scan.spec.ts` :: C9 AC7 — cosine alone is never sufficient cross-project > high-cosine boilerplate with ... | 12 | 595.8 | 4435.6 | 1.93 | 0.93 | 0.53 | 0 (0) | kept-unfixed |
| 15 | `transition.spec.ts` :: transition — status change (SPEC.md §6.3.4, real store) > an untyped caller sending an ... | 12 | 515.6 | 4428.7 | 1.48 | 0.75 | 0.59 | 0 (0) | kept-unfixed |
| 16 | `similar-view.spec.ts` :: C9 — view:'similar' additive cluster block > an UNSCOPED view:similar keeps the existin... | 12 | 624.3 | 4208.8 | 1.38 | 0.78 | 0.41 | 0 (0) | kept-unfixed |
| 17 | `transition.spec.ts` :: transition — status change (SPEC.md §6.3.4, real store) > §2 requiredFields: a project ... | 12 | 626.5 | 3626.4 | 1.34 | 0.71 | 0.56 | 0 (0) | kept-unfixed |
| 18 | `transition.spec.ts` :: transition — status change (SPEC.md §6.3.4, real store) > §2 requiredFields: a project ... | 12 | 553.5 | 3321.1 | 1.23 | 0.8 | 0.57 | 0 (0) | kept-unfixed |
| 19 | `git-env-leak.spec.mjs` :: 50e8c966 AC3: guard_verify passes (exit 0) when nothing leaked | 15 | 456.0 | 3243.7 | 1.94 | 1.61 | 0.38 | 0 (0) | kept-unfixed |
| 20 | `transition.spec.ts` :: transition — status change (SPEC.md §6.3.4, real store) > InvalidArgumentError on missi... | 12 | 588.3 | 3208.8 | 1.37 | 0.71 | 0.41 | 0 (0) | kept-unfixed |
| 21 | `spec-revision.p7.spec.ts` :: spec-append mode amend\|replace (a9966c3f, P7-L) > a9966c3f AC5 (P7-L-AC010) — storage ... | 12 | 698.4 | 2793.0 | 0.87 | 0.91 | 0.52 | 0 (0) | kept-unfixed |
| 22 | `transition.spec.ts` :: transition — status change (SPEC.md §6.3.4, real store) > IssueNotFoundError for a uid ... | 12 | 428.2 | 2790.4 | 1.24 | 0.89 | 0.56 | 0 (0) | kept-unfixed |
| 23 | `production-gate.verbs.spec.ts` :: 31b37c54 A-AC13 — production gate names the real verb for every write verb > 31b37c54 A... | 12 | 547.1 | 2677.5 | 1.03 | 1.18 | 0.34 | 0 (0) | kept-unfixed |
| 24 | `git-env-leak.spec.mjs` :: f2836e29 AC2: guard_verify names a NEW ref created during the run | 15 | 440.2 | 2111.6 | 1.34 | 1.04 | 0.42 | 0 (0) | kept-unfixed |
| 25 | `uid-prefix.spec.ts` :: uid resolution by exact match or UNIQUE prefix (real store) > an AMBIGUOUS prefix is re... | 12 | 576.7 | 2021.9 | 0.83 | 0.82 | 0.58 | 0 (0) | kept-unfixed |
| 26 | `git-env-leak.spec.mjs` :: f2836e29 AC2: guard_verify names a MOVED ref (an unchecked-out branch tip changed) | 15 | 532.2 | 2013.0 | 0.82 | 0.77 | 0.38 | 0 (0) | kept-unfixed |
| 27 | `transition.superseded.spec.ts` :: 7ef53d55 SUPERSEDED reason + successor edge > 7ef53d55 A-AC6 an unresolvable successor ... | 12 | 489.9 | 1942.2 | 1.09 | 0.72 | 0.57 | 0 (0) | kept-unfixed |
| 28 | `production-gate.verbs.spec.ts` :: 31b37c54 A-AC13 — production gate names the real verb for every write verb > 3bd99d24 A... | 12 | 558.2 | 1925.3 | 0.8 | 0.96 | 0.37 | 0 (0) | kept-unfixed |
| 29 | `git-env-leak.spec.mjs` :: 50e8c966 AC3: guard_verify does not blame a user.email that pre-existed the run | 15 | 346.4 | 1862.8 | 1.33 | 1.06 | 0.38 | 0 (0) | kept-unfixed |
| 30 | `markdown-format.spec.ts` :: query — format:"markdown" (real store) > view:"stale" also supports format:"markdown" (... | 12 | 494.8 | 1791.2 | 0.82 | 0.74 | 0.53 | 0 (0) | kept-unfixed |
| 31 | `c8-vocabulary.spec.ts` :: C8 — closed primitives, readable catalogs, self-describing surface > AC2 — the catalog ... | 12 | 393.4 | 1567.0 | 0.82 | 0.74 | 0.46 | 0 (0) | kept-unfixed |
| 32 | `c8-vocabulary.spec.ts` :: C8 — closed primitives, readable catalogs, self-describing surface > AC5 — the kind cas... | 12 | 372.4 | 1556.2 | 0.87 | 0.98 | 0.34 | 0 (0) | kept-unfixed |
| 33 | `test-report.spec.mjs` :: repeat > NEGATIVE CONTROL: a command whose outcome never changes exits 0 | 15 | 312.2 | 1420.5 | 1.04 | 0.76 | 0.42 | 0 (0) | kept-unfixed |
| 34 | `c8-vocabulary.spec.ts` :: C8 — closed primitives, readable catalogs, self-describing surface > AC1 — the generate... | 12 | 152.6 | 1329.5 | 1.34 | 0.86 | 0.41 | 0 (0) | kept-unfixed |
| 35 | `citation.spec.ts` :: citation verbs + update diff (real store) > addCitation refuses a missing issue and bla... | 13 | 325.8 | 1243.6 | 0.88 | 0.73 | 0.54 | 0 (0) | kept-unfixed |
| 36 | `get-superseded-uid.spec.ts` :: get rejects a superseded uid and names the issue's current uid > a genuinely unknown ui... | 12 | 144.0 | 1220.8 | 1.46 | 0.71 | 0.58 | 0 (0) | kept-unfixed |
| 37 | `spec-revision.p7.spec.ts` :: spec-append mode amend\|replace (a9966c3f, P7-L) > a9966c3f AC6 (P7-L-AC011) — mode is ... | 12 | 196.6 | 1198.6 | 1.1 | 0.76 | 0.59 | 0 (0) | kept-unfixed |
| 38 | `test-report.spec.mjs` :: exit codes as a process > offenders --check exits 1 and names the over-budget test; wit... | 15 | 190.4 | 1024.7 | 1.09 | 0.77 | 0.46 | 0 (0) | kept-unfixed |
| 39 | `mcp-discoverability-real-ops.spec.ts` :: [mcp-discoverability.real-ops] synthesized examples validate against REAL repo schemas ... | 12 | 25.1 | 905.1 | 1.45 | 0.98 | 0.48 | 0 (0) | kept-unfixed |
| 40 | `anthropic-echo-session.test.ts` :: R9-hist S6 AC2: persistence across a store reopen and the session-idle TTL > R9-hist S6... | 6 | 144.4 | 593.5 | 0.91 | 0.73 | 0.31 | 0 (0) | kept-unfixed |
| 41 | `s8-serve-handshake-and-precedence.spec.ts` :: Safety-relevant failure paths - serve refuses an upstream that is not an MCP server > @... | 9 | 19.6 | 586.3 | 2.04 | 1.51 | -0.03 | 0 (0) | kept-unfixed |
| 42 | `exporter-failure.test.ts` :: a throwing exporter never breaks a task > R10 S5 AC2: a real parent -> worker dispatch ... | 5 | 90.5 | 584.2 | 1.16 | 0.72 | 0.3 | 0 (0) | kept-unfixed |
| 43 | `sse-client-wire.test.ts` :: c536ce29 FIX-L1 SSE MCP client uses the wire fetch for POSTs as well as the stream > ev... | 6 | 65.6 | 568.5 | 1.09 | 0.92 | 0.09 | 0 (0) | kept-unfixed |
| 44 | `s7-serve.spec.ts` :: Wrap an unmodified MCP server - serve > @S7.2 the allowed call reaches the upstream wit... | 9 | 35.2 | 560.5 | 1.2 | 0.79 | 0.57 | 0 (0) | kept-unfixed |
| 45 | `published-state.spec.mjs` :: updatePublishedState: concurrency-safe — N parallel writers each merge their own key wi... | 15 | 100.1 | 536.5 | 0.97 | 0.78 | 0.12 | 0 (0) | kept-unfixed |
| 46 | `anthropic-echo-session.test.ts` :: R9-hist S6 AC3: pause_turn > R9-hist S6 AC3: 2 pauses then end_turn complete as ONE ass... | 6 | 103.5 | 481.9 | 1.1 | 0.74 | 0.54 | 0 (0) | kept-unfixed |
| 47 | `s5-narrow.spec.ts` :: Feature: Hand a sub-agent less authority - narrow > @S5.3 a request that would widen au... | 9 | 46.8 | 480.1 | 1.41 | 0.81 | 0.55 | 0 (0) | kept-unfixed |
| 48 | `s7-serve.spec.ts` :: Wrap an unmodified MCP server - serve > @S7.1 the entry mcp-json wrote is a serve comma... | 9 | 48.7 | 469.7 | 1.57 | 0.9 | -0.02 | 0 (0) | kept-unfixed |
| 49 | `r10-dispatch-trace.test.ts` :: R10 S5 [anthropic worker] > R10 S5 AC5 [anthropic]: counters reflect the mode of each c... | 5 | 16.8 | 429.0 | 1.68 | 1.28 | 0.1 | 0 (0) | kept-unfixed |
| 50 | `s7-serve.spec.ts` :: Review fix E5 - serve ends with its host and leaves no orphan > E5 the upstream exiting... | 9 | 29.1 | 421.0 | 1.38 | 0.84 | -0.2 | 0 (0) | kept-unfixed |
| 51 | `check-skip-expiry.spec.mjs` :: T32.AC1 — a marker without a tracking item and a date fails > T32.AC1 todo option with ... | 15 | 90.9 | 407.3 | 0.88 | 0.82 | 0.54 | 0 (0) | kept-unfixed |
| 52 | `bk3-cache-breakpoints.test.ts` :: ae62e6b0 AC3.1: the real AnthropicProvider puts the breakpoints on the wire > ae62e6b0 ... | 6 | 63.6 | 381.8 | 1.23 | 1.5 | -0.03 | 0 (0) | kept-unfixed |
| 53 | `s3-run-bin.spec.ts` :: Put a policy in front of any command - run bin: > @S3.1 a forced policy set reaches the... | 9 | 34.2 | 375.1 | 1.6 | 0.96 | 0.25 | 0 (0) | kept-unfixed |
| 54 | `s7-mcp-json.spec.ts` :: Review fix E8 - mcp-json init flags > E8 a relative --spec is stored relative to the .m... | 9 | 24.6 | 374.1 | 1.27 | 0.77 | 0.53 | 0 (0) | kept-unfixed |
| 55 | `check-skip-expiry.spec.mjs` :: T32 — exit codes > an unreadable baseline is exit 65, not a pass | 15 | 83.8 | 348.0 | 0.74 | 0.74 | 0.28 | 0 (0) | kept-unfixed |
| 56 | `check-skip-expiry.spec.mjs` :: T32.AC1 — a marker without a tracking item and a date fails > T32.AC1 it.todo naming an... | 15 | 100.5 | 343.8 | 0.86 | 0.78 | 0.44 | 0 (0) | kept-unfixed |
| 57 | `s8-serve-handshake-and-precedence.spec.ts` :: Safety-relevant failure paths - attribute sources do not merge (D-06) > @S8.3 run: attr... | 9 | 69.5 | 337.6 | 1.06 | 0.76 | 0.47 | 0 (0) | kept-unfixed |
| 58 | `claudecli-session-hardening.test.ts` :: 95ee2a24 AC4: sessions that cannot be resumed are not retained > 95ee2a24 AC4: createPr... | 6 | 88.4 | 333.0 | 0.94 | 0.87 | 0.54 | 0 (0) | kept-unfixed |
| 59 | `http-entry.spec.ts` :: adhd-policy-http entry (src/entry/http.ts) in process > E6 a bad ADHD_POLICY_HTTP_PORT ... | 9 | 21.9 | 328.9 | 1.91 | 1.18 | 0.45 | 0 (0) | kept-unfixed |
| 60 | `s8-serve-handshake-and-precedence.spec.ts` :: Safety-relevant failure paths - serve refuses an upstream that is not an MCP server > @... | 9 | 17.5 | 322.6 | 1.87 | 0.89 | 0.0 | 0 (0) | kept-unfixed |
| 61 | `ephemeral-task-session.test.ts` :: runEphemeralTask — session id persistence (BUG: ephemeral tasks lost session_id) > pers... | 6 | 72.8 | 319.8 | 1.07 | 0.87 | -0.09 | 0 (0) | kept-unfixed |
| 62 | `usage-query-projections.test.ts` :: 8333f755: usage_query exposes the columns/fields the CLI-parity experiments had to read... | 6 | 15.0 | 310.6 | 1.26 | 1.17 | 0.54 | 0 (0) | kept-unfixed |
| 63 | `check-skip-expiry.spec.mjs` :: T32.AC1 — a marker without a tracking item and a date fails > T32.AC1 a skip-expiry pra... | 15 | 71.5 | 306.1 | 0.83 | 0.74 | 0.45 | 0 (0) | kept-unfixed |
| 64 | `sync-global.spec.mjs` :: BUG-027: an installed-but-not-upgradable (content-refused) global install is reported r... | 15 | 46.5 | 300.0 | 1.56 | 1.47 | -0.29 | 0 (0) | kept-unfixed |
| 65 | `r10-w1-shell-guidance-claudecli.test.ts` :: R10 W1 x claudecli: the ordering sentence is in the shell description the CLI reads > R... | 6 | 89.3 | 294.9 | 0.82 | 0.72 | 0.54 | 0 (0) | kept-unfixed |
| 66 | `s7-mcp-json.spec.ts` :: Review fix E2 - mcp-json --undo only restores a file init wrote > E2 a file edited afte... | 9 | 27.4 | 293.5 | 1.53 | 0.77 | 0.07 | 0 (0) | kept-unfixed |
| 67 | `s8-serve-handshake-and-precedence.spec.ts` :: Safety-relevant failure paths - attribute sources do not merge (D-06) > @S8.3 run: a fl... | 9 | 48.6 | 286.4 | 1.18 | 0.84 | 0.58 | 0 (0) | kept-unfixed |
| 68 | `claudecli-model-resolution.test.ts` :: 79aebb26 BK8 AC8.2: a resolved id with no rate card is unpriced, never priced at anothe... | 6 | 11.2 | 282.1 | 1.6 | 1.37 | 0.14 | 0 (0) | kept-unfixed |
| 69 | `s7-serve.spec.ts` :: serve --name - operation ids use the alias the user chose, never the upstream's own nam... | 9 | 17.3 | 281.0 | 1.27 | 0.74 | 0.38 | 0 (0) | kept-unfixed |
| 70 | `task-list-contract.test.ts` :: task_list / result contract (f2b004eb + df109078) > resultTool without projection keeps... | 6 | 29.0 | 275.3 | 1.22 | 1.52 | -0.49 | 0 (0) | kept-unfixed |
| 71 | `tool-order-engine.test.ts` :: R10 S2 AC2: reads and delegation stay parallel (real engine) > R10 S2 AC2: a long-runni... | 6 | 18.5 | 273.2 | 1.48 | 1.26 | -0.03 | 0 (0) | kept-unfixed |
| 72 | `anthropic-echo-session.test.ts` :: R9-hist S6 AC2: persistence across a store reopen and the session-idle TTL > R9-hist S6... | 6 | 53.1 | 267.7 | 1.12 | 0.74 | 0.14 | 0 (0) | kept-unfixed |
| 73 | `s7-mcp-json.spec.ts` :: Wrap an unmodified MCP server - mcp-json init and --undo > @S7.1 a second init is a byt... | 9 | 22.4 | 267.6 | 1.83 | 0.99 | -0.4 | 0 (0) | kept-unfixed |
| 74 | `impl.spec.mjs` :: DEBT-002 #2: defaults --access from the dist manifest's publishConfig.access when no ex... | 15 | 20.4 | 266.4 | 1.33 | 1.38 | 0.15 | 0 (0) | kept-unfixed |
| 75 | `check-skip-expiry.spec.mjs` :: T32.AC1 — a marker without a tracking item and a date fails > T32.AC1 todo option with ... | 15 | 80.4 | 265.5 | 0.66 | 0.73 | -0.09 | 0 (0) | kept-unfixed |
| 76 | `s7-mcp-json.spec.ts` :: Wrap an unmodified MCP server - mcp-json init and --undo > @S7.1 usage errors: init wit... | 9 | 18.1 | 260.6 | 1.99 | 1.14 | 0.48 | 0 (0) | kept-unfixed |
| 77 | `s3-run-bin.spec.ts` :: Put a policy in front of any command - run bin: > @S3.2 a refused call never starts the... | 9 | 43.4 | 256.7 | 1.27 | 1.04 | -0.23 | 0 (0) | kept-unfixed |
| 78 | `check-lane-reachability.spec.mjs` :: rule 5 RED: resolved pre-push targets include e2e or drop test | 15 | 7.3 | 247.2 | 2.28 | 1.92 | -0.26 | 0 (0) | kept-unfixed |
| 79 | `ci-hygiene.spec.mjs` :: 420a7051 C-AC6: no publishable project is behind published-state.json (real tree) | 15 | 51.6 | 241.5 | 1.1 | 0.95 | 0.14 | 0 (0) | kept-unfixed |
| 80 | `s7-mcp-json.spec.ts` :: Review fix E2 - mcp-json --undo only restores a file init wrote > E2 --undo --force res... | 9 | 21.3 | 241.5 | 2.05 | 1.18 | 0.35 | 0 (0) | kept-unfixed |
| 81 | `usage-query-projections.test.ts` :: 8333f755: usage_query exposes the columns/fields the CLI-parity experiments had to read... | 6 | 33.4 | 241.1 | 1.36 | 1.2 | 0.43 | 0 (0) | kept-unfixed |
| 82 | `s7-mcp-json.spec.ts` :: Wrap an unmodified MCP server - mcp-json init and --undo > @S7.1 undo restores the orig... | 9 | 44.2 | 241.0 | 1.2 | 0.96 | -0.2 | 0 (0) | kept-unfixed |
| 83 | `orchestrator-echo.test.ts` :: R9-hist S5a AC1: load and replay across tasks > R9-hist S5a AC1: only the assistant ids... | 6 | 31.4 | 239.6 | 1.02 | 0.89 | 0.43 | 0 (0) | kept-unfixed |
| 84 | `changed-set.spec.mjs` :: computeChangedProjectSet: includes a git-diff-affected project, includes a published-st... | 15 | 38.6 | 237.6 | 1.01 | 0.76 | -0.05 | 0 (0) | kept-unfixed |
| 85 | `s7-serve.spec.ts` :: Wrap an unmodified MCP server - serve > @S7.2 an unknown tool is a protocol error and a... | 9 | 27.9 | 237.2 | 1.17 | 0.73 | -0.12 | 0 (0) | kept-unfixed |
| 86 | `usage-provenance.test.ts` :: UsagePlugin cost provenance write path > 1f1c8598 FS1-AC1: task_usage.response_model re... | 6 | 36.4 | 236.8 | 1.24 | 0.83 | 0.43 | 0 (0) | kept-unfixed |
| 87 | `anthropic-echo-live.test.ts` :: R9-hist S7 -- offline controls for the gated live test (no network) > S7 rig mechanics:... | 6 | 47.6 | 229.8 | 0.88 | 0.76 | 0.09 | 0 (0) | kept-unfixed |
| 88 | `check-lane-reachability.spec.mjs` :: rule 7 RED: an imported vite-plugin factory missing from the plugins array | 15 | 9.2 | 229.3 | 1.9 | 1.65 | 0.46 | 0 (0) | kept-unfixed |
| 89 | `s7-mcp-json.spec.ts` :: Review fix E8 - mcp-json init flags > E8 an entry already wrapped under a different spe... | 9 | 18.7 | 227.4 | 1.53 | 1.22 | 0.48 | 0 (0) | kept-unfixed |
| 90 | `exporter-failure.test.ts` :: a throwing exporter never breaks a task > R10 S5 AC2: a throwing hook handler on the ne... | 5 | 39.0 | 226.2 | 1.18 | 1.05 | 0.3 | 0 (0) | kept-unfixed |
| 91 | `claudecli-worker-isolation.test.ts` :: 98f9da19 AC4 / 9ed453c1 BRIDGE AC-3 — the loop never answers tool_use; claude's stdin c... | 6 | 29.9 | 226.1 | 1.39 | 1.16 | 0.54 | 0 (0) | kept-unfixed |
| 92 | `orchestrator-echo.test.ts` :: R9-hist S5a AC5: a rejected replay degrades once and heals the session > R9-hist S5a AC... | 6 | 16.0 | 224.4 | 1.62 | 1.29 | 0.26 | 0 (0) | kept-unfixed |
| 93 | `s8-serve-handshake-and-precedence.spec.ts` :: Safety-relevant failure paths - serve refuses an upstream that is not an MCP server > @... | 9 | 21.2 | 222.5 | 1.79 | 1.08 | -0.15 | 0 (0) | kept-unfixed |
| 94 | `anthropic-contract-fake.test.ts` :: R9-hist AC12 V1: every client tool_use has a tool_result in the next user turn > R9-his... | 6 | 29.0 | 220.8 | 1.27 | 0.94 | 0.31 | 0 (0) | kept-unfixed |
| 95 | `tool-call-concurrency.test.ts` :: 35768ae8 R3-PAR-ENG bounded same-turn tool-call fan-out (real engine) > 35768ae8 AC2 R3... | 6 | 42.9 | 220.2 | 1.19 | 0.98 | 0.37 | 0 (0) | kept-unfixed |
| 96 | `dispatch-completed.test.ts` :: R10 S5 AC5 — dispatch:completed is emitted once per completed dispatch > R10 S5 AC5: a ... | 6 | 37.1 | 216.9 | 1.11 | 0.72 | 0.43 | 0 (0) | kept-unfixed |
| 97 | `s3-run-bin.spec.ts` :: Put a policy in front of any command - run bin: > @S3.2 a refused call never starts the... | 9 | 15.9 | 214.4 | 1.16 | 1.15 | 0.2 | 0 (0) | kept-unfixed |
| 98 | `usage-grain.test.ts` :: usageQueryByGrain — task/session/turn (DEBT-AGENTMCP-ACCOUNTING-001, DESIGN.md §2-§4) >... | 6 | 9.3 | 214.2 | 1.4 | 1.16 | -0.2 | 0 (0) | kept-unfixed |
| 99 | `sync-global.spec.mjs` :: multi-root + manager dispatch: one row per (pkg, root); a pnpm root installs via pnpm, ... | 15 | 55.8 | 213.9 | 1.12 | 1.12 | 0.27 | 0 (0) | kept-unfixed |
| 100 | `bk3-cache-breakpoints.test.ts` :: ae62e6b0 AC3.1: blocks that never carry a breakpoint > ae62e6b0 AC3.1: a trailing think... | 6 | 11.3 | 211.0 | 1.81 | 1.94 | -0.03 | 0 (0) | kept-unfixed |
| 101 | `tool-result-tokens.test.ts` :: d89e20f4 AC1 orchestrator drive: 1,000,000-char run never reaches the tokenizer in full... | 6 | 38.0 | 204.8 | 1.14 | 0.73 | 0.43 | 0 (0) | kept-unfixed |
| 102 | `web-fetch-extract.test.ts` :: cbad68d4 AC1: extraction work is linear on 1 MB adversarial input > cbad68d4 AC1 / bc79... | 6 | 29.9 | 203.5 | 0.98 | 0.77 | 0.54 | 0 (0) | kept-unfixed |
| 103 | `plugins-loader-defaults.test.ts` :: loadExternalPlugins — default entries (5339c2e5) > installs a DEFAULT entry even with z... | 6 | 37.0 | 198.4 | 1.22 | 0.89 | 0.54 | 0 (0) | kept-unfixed |
| 104 | `claudecli-temp-root.test.ts` :: c536ce29 S8B-AC2 claudecli temp files land under the injected namespaced temp root > c5... | 6 | 37.5 | 195.6 | 1.0 | 0.77 | 0.54 | 0 (0) | kept-unfixed |
| 105 | `s7-mcp-json.spec.ts` :: Wrap an unmodified MCP server - mcp-json init and --undo > @S7.1 init wraps the stdio e... | 9 | 46.3 | 193.2 | 1.22 | 0.82 | -0.48 | 0 (0) | kept-unfixed |
| 106 | `task-list-contract.test.ts` :: task_list / result contract (f2b004eb + df109078) > filters by session_ids[] (plural) —... | 6 | 13.3 | 191.8 | 1.26 | 1.53 | -0.71 | 0 (0) | kept-unfixed |
| 107 | `impl.spec.mjs` :: ADHD_NX_VERSION_DRY_RUN=1 env var forces dry-run behavior even when options.dryRun is N... | 15 | 34.7 | 190.2 | 1.14 | 1.11 | 0.4 | 0 (0) | kept-unfixed |
| 108 | `sync-global.spec.mjs` :: BUG-004 (d): published-state cache MISS (no entry) -> backfill seam consulted; backfill... | 15 | 56.7 | 187.4 | 0.78 | 0.81 | -0.27 | 0 (0) | kept-unfixed |
| 109 | `s7-serve.spec.ts` :: serve --name - operation ids use the alias the user chose, never the upstream's own nam... | 9 | 33.8 | 187.0 | 1.05 | 0.83 | 0.28 | 0 (0) | kept-unfixed |
| 110 | `s5-narrow.spec.ts` :: Feature: Hand a sub-agent less authority - narrow > @S5.3 a request that would widen au... | 9 | 42.1 | 186.3 | 0.88 | 0.78 | 0.32 | 0 (0) | kept-unfixed |
| 111 | `generate-manifest.spec.mjs` :: writeDistManifest integration: refuses to write a manifest with a surviving "workspace:... | 15 | 28.7 | 186.0 | 1.33 | 1.39 | 0.39 | 0 (0) | kept-unfixed |
| 112 | `bounded-token-count.test.ts` :: ea8f6f92-d0db-426e-bf9d-bd7ba2fdd5ca AC1: boundedTokenCount > ea8f6f92 AC1: exact (== e... | 6 | 5.8 | 185.1 | 1.75 | 1.52 | 0.26 | 0 (0) | kept-unfixed |
| 113 | `sync-global.spec.mjs` :: MEDIUM-3: verifyShim rejects a store path that resolves into a source worktree (version... | 15 | 34.6 | 179.2 | 1.04 | 0.98 | 0.2 | 0 (0) | kept-unfixed |
| 114 | `sync-global.spec.mjs` :: HIGH-1: a legacy shim execing a SIBLING worktree is detected (not not-installed) and re... | 15 | 27.9 | 176.1 | 1.05 | 0.98 | 0.24 | 0 (0) | kept-unfixed |
| 115 | `claudecli-peak-context.test.ts` :: 7ead5eaa BK4 (BK8 follow-up): usage_query's turn grain re-prices a multi-model response... | 6 | 10.9 | 175.0 | 1.72 | 1.5 | -0.14 | 0 (0) | kept-unfixed |
| 116 | `claudecli-bridge-governance.test.ts` :: f9dadeaa GOV-AC5: CLI built-ins cannot bypass the gate > f9dadeaa GOV-AC5: agent-spec m... | 6 | 21.3 | 172.1 | 1.09 | 1.01 | 0.14 | 0 (0) | kept-unfixed |
| 117 | `claudecli-builtin-bypass.test.ts` :: e0d71436 AC3: agent-spec mode > e0d71436-943e-4072-b210-a728cff402fe AC3: spec `tools:`... | 6 | 14.4 | 170.0 | 1.4 | 1.18 | 0.49 | 0 (0) | kept-unfixed |
| 118 | `bug-nxassets-001-chmod-survives-cache.spec.mjs` :: BEHAVIOUR: a cache-restored dist whose bin lost its executable bit is repaired by write... | 15 | 21.3 | 169.7 | 1.16 | 0.92 | -0.27 | 0 (0) | kept-unfixed |
| 119 | `impl.spec.mjs` :: DEBT-002 #5: a dep declared with DIFFERENT range prefixes in `dependencies` (^) vs `pee... | 15 | 28.5 | 168.1 | 1.42 | 1.26 | -0.01 | 0 (0) | kept-unfixed |
| 120 | `usage-cache-write-1h.test.ts` :: b726a987 cache-write 1h tier through the real accounting path > b726a987 AC5: the usage... | 6 | 13.9 | 167.6 | 1.63 | 1.55 | 0.09 | 0 (0) | kept-unfixed |
| 121 | `manifest-backstop.spec.mjs` :: (run-scoped) a 2-hour-old TOKENED manifest with NO token in env is advisory only (check... | 15 | 14.7 | 166.5 | 1.44 | 1.41 | 0.16 | 0 (0) | kept-unfixed |
| 122 | `claudecli-worker-isolation.test.ts` :: 98f9da19 AC4 / 9ed453c1 BRIDGE AC-3 — the loop never answers tool_use; claude's stdin c... | 6 | 48.8 | 165.9 | 0.99 | 0.89 | 0.49 | 0 (0) | kept-unfixed |
| 123 | `usage-peak-context.test.ts` :: 7ead5eaa AC4.5: compaction uses the true per-response context > 7ead5eaa AC4.5: a genui... | 6 | 26.0 | 165.5 | 1.18 | 1.45 | -0.2 | 0 (0) | kept-unfixed |
| 124 | `bk3-cache-breakpoints.test.ts` :: ae62e6b0 AC3.1: blocks that never carry a breakpoint > ae62e6b0 AC3.1: a final entry th... | 6 | 19.1 | 163.0 | 1.36 | 1.66 | -0.31 | 0 (0) | kept-unfixed |
| 125 | `claudecli-first-turn-context.test.ts` :: debd934d: claudecli first-turn context and per-turn breakdown > debd934d AC3: peakConte... | 6 | 18.0 | 162.0 | 1.41 | 1.61 | -0.09 | 0 (0) | kept-unfixed |
| 126 | `s8-serve-handshake-and-precedence.spec.ts` :: Safety-relevant failure paths - serve refuses an upstream that is not an MCP server > @... | 9 | 11.2 | 162.0 | 1.37 | 0.91 | 0.23 | 0 (0) | kept-unfixed |
| 127 | `sync-global.spec.mjs` :: BUG-027 (RED without the fix): a normal (non-link) global install on an OLDER version i... | 15 | 11.9 | 159.5 | 1.25 | 1.06 | -0.03 | 0 (0) | kept-unfixed |
| 128 | `impl.spec.mjs` :: BUG-BUILD-PUBLISH-DISTMANIFEST-CLOBBERED-001: a CORRUPTED dist/package.json (as `build`... | 15 | 31.8 | 155.7 | 1.54 | 1.35 | -0.12 | 0 (0) | kept-unfixed |
| 129 | `tool-limiter.test.ts` :: ea8f6f92-d0db-426e-bf9d-bd7ba2fdd5ca AC1: one limiter bounds map() and run() together >... | 6 | 32.5 | 154.8 | 1.2 | 1.07 | -0.14 | 0 (0) | kept-unfixed |
| 130 | `registry-connect.test.ts` :: R10 S3 AC1: concurrent connect > R10 S3 AC1: the second connect starts before the first... | 6 | 19.6 | 154.3 | 1.42 | 1.36 | 0.26 | 0 (0) | kept-unfixed |
| 131 | `tool-result-tokens.test.ts` :: d89e20f4 AC1 estimator bounds tokenizer input > scaled estimate is within 15% of the ex... | 6 | 36.8 | 153.9 | 1.06 | 0.82 | 0.03 | 0 (0) | kept-unfixed |
| 132 | `model-call-completeness.test.ts` :: c536ce29 TRC-AC25 — every model call is traced through the real factory + orchestrator ... | 5 | 14.6 | 153.0 | 1.51 | 1.03 | 0.5 | 0 (0) | kept-unfixed |
| 133 | `bk3-cache-breakpoints.test.ts` :: ae62e6b0 AC3.1: per-breakpoint minimum-prefix guard > ae62e6b0 AC3.1: the same ~2k-toke... | 6 | 9.2 | 152.0 | 1.54 | 1.74 | 0.09 | 0 (0) | kept-unfixed |
| 134 | `env.spec.ts` :: scope isolation — real Environment instances, real temp filesystem roots > db.busyTimeo... | 12 | 12.0 | 148.7 | 1.42 | 1.06 | 0.53 | 0 (0) | kept-unfixed |
| 135 | `impl.spec.mjs` :: dry run: reconciliation is read-only on-disk, NEVER writes package.json, and never invo... | 15 | 13.0 | 148.5 | 1.45 | 1.22 | -0.06 | 0 (0) | kept-unfixed |
| 136 | `one-shot-snapshot-declarative.test.ts` :: runEphemeralTask — the session snapshot is DECLARATIVE (B1, ADR-0008 D4/D8) > NEGATIVE ... | 6 | 30.2 | 146.6 | 0.86 | 1.06 | -0.77 | 0 (0) | kept-unfixed |
| 137 | `native-tooling-hitl-gate.test.ts` :: f5abca83 FIX 2 — synchronous (non-answerable) ask fails closed, never suspends > AC2b: ... | 6 | 5.8 | 145.2 | 1.31 | 1.14 | -0.09 | 0 (0) | kept-unfixed |
| 138 | `impl.spec.mjs` :: BUG-BUILD-ASSETS-CACHE-STALE-AFTER-CLEAN-001: a dist/ MISSING README.md (as a stale `as... | 15 | 34.5 | 143.2 | 1.01 | 0.79 | 0.11 | 0 (0) | kept-unfixed |
| 139 | `usage-provenance.test.ts` :: UsagePlugin cost provenance write path > 1f1c8598 FS1-AC1: response_model is NULL when ... | 6 | 21.2 | 143.0 | 1.1 | 1.0 | 0.43 | 0 (0) | kept-unfixed |
| 140 | `impl.spec.mjs` :: cache HIT, integrity fast path used at backfill time is directly consumable later with ... | 15 | 15.6 | 141.9 | 1.33 | 1.2 | -0.14 | 0 (0) | kept-unfixed |
| 141 | `s7-mcp-json.spec.ts` :: Review fix E2 - mcp-json --undo only restores a file init wrote > E2 an old backup with... | 9 | 15.8 | 141.1 | 1.6 | 0.91 | 0.1 | 0 (0) | kept-unfixed |
| 142 | `r10-m2-startup-stamps.test.ts` :: R10 M2 [anthropic]: the dispatching tool stamps sessionMs and queueWaitMs > R10 M2 AC4 ... | 6 | 8.7 | 140.7 | 1.61 | 1.4 | 0.26 | 0 (0) | kept-unfixed |
| 143 | `task-list-contract.test.ts` :: task_list / result contract (f2b004eb + df109078) > default (no projection) still retur... | 6 | 6.2 | 138.7 | 1.7 | 1.45 | -0.6 | 0 (0) | kept-unfixed |
| 144 | `s8-serve-handshake-and-precedence.spec.ts` :: Safety-relevant failure paths - attribute sources do not merge (D-06) > @S8.3 run: a ba... | 9 | 18.5 | 138.4 | 1.01 | 0.94 | 0.17 | 0 (0) | kept-unfixed |
| 145 | `dispatch-completed.test.ts` :: R10 S5 AC5 — dispatch:completed is emitted once per completed dispatch > R10 S5 AC5: ta... | 6 | 15.5 | 138.3 | 1.36 | 1.2 | -0.2 | 0 (0) | kept-unfixed |
| 146 | `task-list-contract.test.ts` :: task_list / result contract (f2b004eb + df109078) > summary:true drops the bulk prompt/... | 6 | 8.6 | 137.3 | 1.43 | 1.12 | 0.03 | 0 (0) | kept-unfixed |
| 147 | `impl.spec.mjs` :: backfill failure (network error reconciling a cache miss) leaves version untouched and ... | 15 | 25.6 | 136.5 | 1.42 | 1.34 | 0.1 | 0 (0) | kept-unfixed |
| 148 | `tool-annotations-wire.test.ts` :: R10 S2 AC5: annotations never reach a wire or a hash > R10 S2 AC5: the names-mode promp... | 6 | 15.6 | 136.5 | 1.2 | 1.0 | -0.09 | 0 (0) | kept-unfixed |
| 149 | `impl.spec.mjs` :: published (cache miss, backfill) + range-only drift vs published tarball: does NOT bump... | 15 | 14.1 | 136.4 | 1.37 | 1.46 | -0.29 | 0 (0) | kept-unfixed |
| 150 | `usage-readpath.test.ts` :: usage read path (S4b): unpriced accounting > 1f1c8598 FS1-AC3: an unknown model at turn... | 6 | 25.0 | 135.0 | 1.13 | 1.02 | 0.09 | 0 (0) | kept-unfixed |
| 151 | `sync-global.spec.mjs` :: syncGlobalShims: verify failure -> shims restored from backup and reported verified:fal... | 15 | 22.1 | 134.4 | 1.03 | 0.97 | -0.05 | 0 (0) | kept-unfixed |
| 152 | `tool-order-engine.test.ts` :: R10 S2 AC1: the read observes the edit (real engine) > R10 S2 AC1: [edit_file, read_tex... | 6 | 21.6 | 133.6 | 1.24 | 0.98 | -0.14 | 0 (0) | kept-unfixed |
| 153 | `tool-result-tokens.test.ts` :: d89e20f4 AC1 estimator bounds tokenizer input > a4235310 AC1 NEGATIVE CONTROL: a head+t... | 6 | 29.3 | 131.8 | 1.1 | 0.78 | 0.43 | 0 (0) | kept-unfixed |
| 154 | `r10-m2-startup-stamps.test.ts` :: R10 M2 [claudecli]: the dispatching tool stamps sessionMs and queueWaitMs > R10 M2 AC1/... | 6 | 14.0 | 131.5 | 1.31 | 1.35 | 0.54 | 0 (0) | kept-unfixed |
| 155 | `shell-exit-status.test.ts` :: 61358b6f AC8 engine records exitStatus (native loop) > a shell_execute result carrying ... | 6 | 17.4 | 129.8 | 1.24 | 0.86 | 0.09 | 0 (0) | kept-unfixed |
| 156 | `review-fixes-entrypoint.spec.ts` :: Decision D-06 - attribute precedence, never merged, files re-read on every call > D-06 ... | 9 | 5.3 | 129.8 | 2.17 | 1.64 | 0.07 | 0 (0) | kept-unfixed |
| 157 | `s7-mcp-json.spec.ts` :: Wrap an unmodified MCP server - mcp-json init and --undo > @S7.1 init then undo then in... | 9 | 30.2 | 129.5 | 0.85 | 1.03 | 0.42 | 0 (0) | kept-unfixed |
| 158 | `http-entry.spec.ts` :: adhd-policy-http entry (src/entry/http.ts) in process > E6 a port that is already taken... | 9 | 22.2 | 129.0 | 1.28 | 0.81 | 0.53 | 0 (0) | kept-unfixed |
| 159 | `usage-query.test.ts` :: usageQuery — group_by aggregation (BUG-ORCH-009 follow-up) > folds uncachedInputTokens/... | 6 | 16.9 | 127.8 | 1.31 | 0.9 | -0.09 | 0 (0) | kept-unfixed |
| 160 | `background-ephemeral-task.test.ts` :: P2 background tasks_batch > P2 AC-bg-batch: background:true returns one pending task pe... | 6 | 15.4 | 126.4 | 1.29 | 1.19 | 0.2 | 0 (0) | kept-unfixed |
| 161 | `impl.spec.mjs` :: BUG-005 boundary: source version AHEAD of the cache's recorded version is the legitimat... | 15 | 13.9 | 126.1 | 1.18 | 1.19 | 0.31 | 0 (0) | kept-unfixed |
| 162 | `flt-claudecli-faults.test.ts` :: de6bee5d FLT-AC1: usage-window and rate-limit results > FLT-AC1: a transient 429 result... | 6 | 33.4 | 125.2 | 0.96 | 0.86 | 0.43 | 0 (0) | kept-unfixed |
| 163 | `usage-readpath.test.ts` :: usage read path (S4b): backward compatibility > 1f1c8598 FS1-AC4: existing keys and val... | 6 | 13.4 | 125.0 | 1.37 | 1.15 | 0.54 | 0 (0) | kept-unfixed |
| 164 | `sync-global.spec.mjs` :: multi-root: a root with no installation of the package reports not-installed (verified:... | 15 | 37.5 | 123.2 | 0.73 | 0.74 | -0.01 | 0 (0) | kept-unfixed |
| 165 | `impl.spec.mjs` :: DEBT-002 #2: no publishConfig.access declared and no option override -> unchanged defau... | 15 | 15.9 | 122.9 | 1.73 | 1.44 | 0.09 | 0 (0) | kept-unfixed |
| 166 | `release-manifest.spec.mjs` :: writeReleaseManifest writes a well-formed manifest at tmp/release-manifest.json, readab... | 15 | 7.7 | 121.9 | 1.68 | 1.66 | 0.16 | 0 (0) | kept-unfixed |
| 167 | `claudecli-worker-isolation.test.ts` :: 98f9da19 AC2 — --tools allowlist > 98f9da19 AC2: --tools is not passed in systemPromptI... | 6 | 14.0 | 120.9 | 1.12 | 1.09 | 0.54 | 0 (0) | kept-unfixed |
| 168 | `background-ephemeral-task.test.ts` :: P2 resultToolWait on a real task store > P2 AC-wait: wait_ms unset or 0 is an immediate... | 6 | 12.1 | 120.3 | 1.38 | 1.06 | 0.54 | 0 (0) | kept-unfixed |
| 169 | `dispatch-completed.test.ts` :: R10 S5 AC2 — an observer failure never fails or alters a dispatch > R10 S5 AC2: a dispa... | 6 | 14.1 | 118.5 | 1.13 | 0.8 | 0.49 | 0 (0) | kept-unfixed |
| 170 | `s7-mcp-json.spec.ts` :: Review fix E8 - mcp-json init flags > E8 --only wraps just the named entry and reports ... | 9 | 9.4 | 117.6 | 2.0 | 0.88 | -0.58 | 0 (0) | kept-unfixed |
| 171 | `impl.spec.mjs` :: BUG-BUILD-PUBLISH-DISTMANIFEST-CLOBBERED-001: publish re-stamps dist/package.json from ... | 15 | 17.6 | 117.3 | 1.02 | 1.12 | -0.26 | 0 (0) | kept-unfixed |
| 172 | `claudecli-worker-isolation.test.ts` :: 98f9da19 AC4 / 9ed453c1 BRIDGE AC-3 — the loop never answers tool_use; claude's stdin c... | 6 | 13.4 | 117.3 | 1.33 | 1.1 | 0.54 | 0 (0) | kept-unfixed |
| 173 | `impl.spec.mjs` :: changelog scrub: a declared-but-BROKEN policy fails the task loudly (never silently shi... | 15 | 16.8 | 116.7 | 1.21 | 1.42 | -0.19 | 0 (0) | kept-unfixed |
| 174 | `impl.spec.mjs` :: changelog generation failure fails the whole version task, rolls the bump back, and nev... | 15 | 27.0 | 114.6 | 0.87 | 0.94 | -0.2 | 0 (0) | kept-unfixed |
| 175 | `tool-naming.test.ts` :: OpenAIProvider resolves a bare tool call (DEBT-004 consumer) > resolves a bare `task` a... | 6 | 8.3 | 114.4 | 1.7 | 1.9 | -0.09 | 0 (0) | kept-unfixed |
| 176 | `background-ephemeral-task.test.ts` :: P2 resultToolWait on a real task store > P2 AC-wait: a non-terminal task is polled in 1... | 6 | 8.1 | 114.3 | 1.51 | 1.44 | 0.09 | 0 (0) | kept-unfixed |
| 177 | `mcp-discoverability-real-ops.spec.ts` :: [mcp-discoverability.real-ops] synthesized examples validate against REAL repo schemas ... | 12 | 15.2 | 113.7 | 1.76 | 0.85 | 0.41 | 0 (0) | kept-unfixed |
| 178 | `r10-s5b-engine-trace.test.ts` :: R10 S5b [anthropic worker] > R10 S5b AC3 [anthropic]: a tasks_batch names its own call | 5 | 24.9 | 113.6 | 0.83 | 0.72 | 0.2 | 0 (0) | kept-unfixed |
| 179 | `mcp-discoverability-real-ops.spec.ts` :: [mcp-discoverability.real-ops] synthesized examples validate against REAL repo schemas ... | 12 | 14.2 | 112.4 | 1.13 | 0.84 | 0.17 | 0 (0) | kept-unfixed |
| 180 | `r10-m2-startup-stamps.test.ts` :: R10 M2 [openai]: the dispatching tool stamps sessionMs and queueWaitMs > R10 M2 AC1 [op... | 6 | 14.9 | 112.3 | 1.36 | 1.25 | 0.49 | 0 (0) | kept-unfixed |
| 181 | `model-call-tracing-seams.test.ts` :: c536ce29 TRC-AC26: compaction model call is tagged purpose:'compaction' > c536ce29 TRC-... | 6 | 14.5 | 111.5 | 1.35 | 0.94 | -0.09 | 0 (0) | kept-unfixed |
| 182 | `sync-global.spec.mjs` :: detectStaleShims: a package without a bin field is never reported stale | 15 | 17.9 | 110.4 | 1.3 | 1.14 | 0.18 | 0 (0) | kept-unfixed |
| 183 | `impl.spec.mjs` :: DEBT-002 #1 (corrected): a surviving "workspace:*" range on an @adhd/* dependency absen... | 15 | 24.3 | 110.3 | 0.96 | 0.84 | 0.44 | 0 (0) | kept-unfixed |
| 184 | `orchestrator-echo.test.ts` :: R9-hist S5a AC2: store and reopen > R9-hist S5a AC2: a tier S pair over maxMessageBytes... | 6 | 23.7 | 109.1 | 0.85 | 0.77 | -0.2 | 0 (0) | kept-unfixed |
| 185 | `sync-global.spec.mjs` :: BUG-004 (e): the content gate hashes the STAMPED dist, not the raw one — a build-clobbe... | 15 | 17.4 | 108.8 | 1.21 | 0.9 | 0.14 | 0 (0) | kept-unfixed |
| 186 | `tool-limiter-hitl.test.ts` :: ea8f6f92 AC4 (review B2-M3): HITL-gated calls never wait on, or occupy, a limiter slot ... | 6 | 17.4 | 107.6 | 1.21 | 0.84 | 0.54 | 0 (0) | kept-unfixed |
| 187 | `anthropic-pause.test.ts` :: R9-pause AC2: the cap fails loudly > boundary: 4 pauses then end_turn completes with 4 ... | 6 | 9.4 | 107.4 | 1.41 | 1.27 | 0.2 | 0 (0) | kept-unfixed |
| 188 | `claudecli-session-resume.test.ts` :: b31e1fe5 AC1: a follow-up task resumes the retained CLI session > two sessions never sh... | 6 | 6.9 | 107.3 | 1.56 | 1.26 | 0.49 | 0 (0) | kept-unfixed |
| 189 | `impl.spec.mjs` :: cache HIT, changed: ZERO network calls, still bumps correctly | 15 | 20.7 | 106.5 | 0.94 | 0.77 | -0.29 | 0 (0) | kept-unfixed |
| 190 | `server.tracing-required.spec.ts` :: backlog is a REQUIRED, adhd-namespaced tracing consumer (FEAT-APIGEN-TRACING) > the con... | 12 | 7.3 | 105.6 | 2.31 | 1.19 | 0.43 | 0 (0) | kept-unfixed |
| 191 | `env.spec.ts` :: scope isolation — real Environment instances, real temp filesystem roots > BUG-002: ADH... | 12 | 14.4 | 105.3 | 1.17 | 0.72 | 0.39 | 0 (0) | kept-unfixed |
| 192 | `sync-global.spec.mjs` :: discoverPackageBins: unions declared + installed-declared + content-referencing names | 15 | 16.3 | 103.6 | 1.32 | 1.27 | -0.38 | 0 (0) | kept-unfixed |
| 193 | `impl.spec.mjs` :: changelog scrub: a package declaring `changelogVocabulary` has its GENERATED CHANGELOG.... | 15 | 33.5 | 103.6 | 0.79 | 0.8 | -0.15 | 0 (0) | kept-unfixed |
| 194 | `cp-cache-tool-determinism.test.ts` :: 9ed453c1 CACHE AC4: anthropic request body is identical across two tasks of the same ag... | 6 | 10.4 | 103.6 | 1.32 | 0.99 | -0.31 | 0 (0) | kept-unfixed |
| 195 | `manifest-backstop.spec.mjs` :: (c) RELEASE_FORCE_FULL_PUBLISH + RELEASE_FORCE_REASON bypasses the backstop even with N... | 15 | 15.1 | 103.1 | 1.52 | 1.19 | -0.27 | 0 (0) | kept-unfixed |
| 196 | `check-agent-lane-spawn.spec.mjs` :: clean workspace is silent [5b839b90 AC2] | 15 | 9.1 | 102.7 | 1.83 | 1.9 | 0.13 | 0 (0) | kept-unfixed |
| 197 | `sync-global.spec.mjs` :: LOW-8: a not-installed row carries installedVersion:null even when the store manifest i... | 15 | 15.5 | 101.8 | 1.22 | 1.26 | -0.18 | 0 (0) | kept-unfixed |
| 198 | `dispatch-completed.test.ts` :: R10 S5 AC5 — dispatch:completed is emitted once per completed dispatch > R10 S5 AC5: a ... | 6 | 11.0 | 101.2 | 1.14 | 0.98 | 0.14 | 0 (0) | kept-unfixed |
| 199 | `claudecli-failed-run-usage.test.ts` :: afa37093: usage of failed claudecli runs > afa37093 AC4: usage_query (task and turn gra... | 6 | 16.7 | 101.1 | 1.17 | 0.92 | 0.2 | 0 (0) | kept-unfixed |
| 200 | `sync-global.spec.mjs` :: syncGlobalShims: real sync path — fake pnpmAdd rewrites the shim and lands the global s... | 15 | 12.0 | 100.5 | 1.1 | 1.17 | -0.24 | 0 (0) | kept-unfixed |
| 201 | `claudecli-usage-attempts.test.ts` :: afa37093 AC3 / M1: every billed attempt of a retried request is counted > afa37093 AC3:... | 6 | 13.8 | 100.4 | 1.33 | 1.04 | -0.49 | 0 (0) | kept-unfixed |

## Verdict reasons by file

- `packages/apigen/apigen-core-client/src/test/extract-source-files.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `entrypoint/backlog/src/write/citation.cross-repo.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/plugins-loader-preloaded.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `entrypoint/backlog/src/write/contract-anchors.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/anthropic-base-url.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `entrypoint/backlog/src/query/edge-batch.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/r10-m2-startup-stamps.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `entrypoint/backlog/src/write/transition.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `entrypoint/backlog/src/query/similar-view.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `.githooks/git-env-leak.spec.mjs` - **kept-unfixed**: not read within the dispatch budget
- `entrypoint/backlog/src/write/similarity-scan.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `entrypoint/backlog/src/write/spec-revision.p7.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `entrypoint/backlog/src/write/production-gate.verbs.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `entrypoint/backlog/src/query/uid-prefix.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `entrypoint/backlog/src/write/transition.superseded.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `entrypoint/backlog/src/query/markdown-format.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `entrypoint/backlog/src/c8-vocabulary.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `tools/nx-plugins/test/metrics/test-report.spec.mjs` - **kept-unfixed**: not read within the dispatch budget
- `entrypoint/backlog/src/write/citation.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `entrypoint/backlog/src/query/get-superseded-uid.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `entrypoint/backlog/src/mcp-discoverability-real-ops.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/anthropic-echo-session.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `entrypoint/policy/src/test/functional/s8-serve-handshake-and-precedence.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-plugin-tracing/src/lib/exporter-failure.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/sse-client-wire.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `entrypoint/policy/src/test/functional/s7-serve.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `tools/nx-plugins/build/lib/published-state.spec.mjs` - **kept-unfixed**: not read within the dispatch budget
- `entrypoint/policy/src/test/functional/s5-narrow.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-plugin-tracing/src/lib/r10-dispatch-trace.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `tools/nx-plugins/test/executors/wiring/check-skip-expiry.spec.mjs` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/bk3-cache-breakpoints.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `entrypoint/policy/src/test/functional/s3-run-bin.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `entrypoint/policy/src/test/functional/s7-mcp-json.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/claudecli-session-hardening.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `entrypoint/policy/src/test/functional/http-entry.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/ephemeral-task-session.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/usage-query-projections.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `tools/nx-plugins/build/executors/sync-global/sync-global.spec.mjs` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/r10-w1-shell-guidance-claudecli.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/claudecli-model-resolution.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/task-list-contract.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/tool-order-engine.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `tools/nx-plugins/build/executors/publish/impl.spec.mjs` - **kept-unfixed**: not read within the dispatch budget
- `tools/nx-plugins/test/executors/wiring/check-lane-reachability.spec.mjs` - **kept-unfixed**: not read within the dispatch budget
- `tools/nx-plugins/build/ci-hygiene.spec.mjs` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/orchestrator-echo.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `tools/nx-plugins/build/lib/changed-set.spec.mjs` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/usage-provenance.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/anthropic-echo-live.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/claudecli-worker-isolation.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/anthropic-contract-fake.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/tool-call-concurrency.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/dispatch-completed.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/usage-grain.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/tool-result-tokens.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/web-fetch-extract.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/plugins-loader-defaults.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/claudecli-temp-root.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `tools/nx-plugins/build/executors/version/impl.spec.mjs` - **kept-unfixed**: not read within the dispatch budget
- `tools/nx-plugins/build/executors/manifest/generate-manifest.spec.mjs` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/bounded-token-count.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/claudecli-peak-context.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/claudecli-bridge-governance.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/claudecli-builtin-bypass.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `tools/nx-plugins/assets/bug-nxassets-001-chmod-survives-cache.spec.mjs` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/usage-cache-write-1h.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `tools/nx-plugins/build/executors/publish/manifest-backstop.spec.mjs` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/usage-peak-context.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/claudecli-first-turn-context.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/tool-limiter.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/registry-connect.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-plugin-tracing/src/lib/model-call-completeness.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `entrypoint/backlog/src/env.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/one-shot-snapshot-declarative.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/native-tooling-hitl-gate.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/tool-annotations-wire.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/usage-readpath.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/shell-exit-status.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `entrypoint/policy/src/test/functional/review-fixes-entrypoint.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/usage-query.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/background-ephemeral-task.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/flt-claudecli-faults.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `tools/nx-plugins/build/lib/release-manifest.spec.mjs` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/tool-naming.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-plugin-tracing/src/lib/r10-s5b-engine-trace.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/model-call-tracing-seams.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/tool-limiter-hitl.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/anthropic-pause.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/claudecli-session-resume.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `entrypoint/backlog/src/server.tracing-required.spec.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/cp-cache-tool-determinism.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `tools/nx-plugins/test/executors/wiring/check-agent-lane-spawn.spec.mjs` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/claudecli-failed-run-usage.test.ts` - **kept-unfixed**: not read within the dispatch budget
- `packages/agent/agent-engine-orchestrator/src/__tests__/claudecli-usage-attempts.test.ts` - **kept-unfixed**: not read within the dispatch budget
