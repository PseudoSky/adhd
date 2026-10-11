# Instrument spec: CLI-parity round-5 (buckets R0-R9)

Status: SPEC ONLY. Nothing implemented, no model arms run. Owner answers of 2026-10-11 are folded in (EXPERIMENT-LOG section 7, entry "OWNER DECISIONS recorded" plus the follow-up answers on runs, valid iteration, quality, scope and web).
Repo: /Users/nix/dev/node/adhd. Evidence root SP = /private/tmp/claude-502/-Users-nix-dev-node-adhd/f118b5b4-5fc4-458b-9f31-9ac647bb0cab/scratchpad
Notation: P = /Users/nix/dev/node/adhd/entrypoint/agent-mcp. LOG = /Users/nix/dev/node/adhd/docs/agent/parity/EXPERIMENT-LOG.md.

## 0. Summary

Move the throwaway round-4 instrument (SP/round4: drive.mjs, oracle.mjs, lib.mjs, fixtures.mjs, info-server.mjs, dryrun fakes, ledger) INSIDE the existing package `entrypoint/agent-mcp`, in an unpublished directory `P/parity/`, with its tests in the package's existing unit and e2e lanes. No new package, no new Nx project, no tsconfig.base.json change. On that base: fix the oracle (R1); a web-path preflight and silent-egress detector (R2); one identical task prompt with each arm on its own shipped tools only (R3); a metric model that gates cost, duration and quality at +2% of native and reports turns, tool calls and peak context (R4); a blind-judge quality score (R5); a repeated-tool-error defect signal (R6); a grid (R7); a duration slot driven by the debug finding (R8); and a product fix for the tasks_batch strict parse (R9).

This spec does NOT promise that no model run ever fails. Model variance stays a red result.

## 1. Verified facts (read, not assumed)

* The repo's existing "parity-harness" (packages/apigen/apigen-engine-runtime/src/test-support/parity-harness.ts, tsconfig.base.json:99; backlog 1f903927 resolved, b18099f7 resolved) is the apigen golden-fixture transport harness (captureGolden / assertParity / proveNegativeControl). It is a different domain and is NOT reusable here. b18099f7 shows its negative-control escaped scratch and ran git against the real repo (CRITICAL, resolved), so we do not borrow it. We reuse its precedent only: a cross-package test-only import goes through a tsconfig.base.json path, which we avoid by not sharing test code across packages.
* Reusable, already in repo: `resolveNativeTooling` (packages/agent/agent-core-native-tooling/src/lib/resolver.ts:398; the catalog is the single producer of the shell launch literal, ADR-0008 D2); `@modelcontextprotocol/sdk` Client + StdioClientTransport (already used by drive.mjs loadSdk); `AgentDefinition.nativeWebTools?: boolean` (packages/agent/agent-base-types/src/domain.ts:585, `false` removes server-side web_search/web_fetch; negative control in entrypoint/agent-mcp/src/__tests__/integration/native-web-tools.e2e.test.ts). NOT reusable: `RpcClient` and the parentProxy stub inside shell-egress.e2e.test.ts (file-local, not exported); use the SDK client, and write a ~25-line local parentProxy stub in P/parity (duplication accepted over cross-package test imports; extraction is an optional later item).
* R4 ledger SP/round4/ledger/model-runs.json is at 6/6 (cap spent). R5 needs a fresh per-round ledger.
* Backlog ACs (verbatim sources): 25ce70b8 AC1 driver/fixtures/oracle+README in repo, AC2 oracle defects fixed with tests, AC3 BK5 gate text (OUT OF SCOPE here: depends on owner decision FC7; 625b611e), AC4 tests cite uid+AC. 90758419 AC1 q_rate separates recall from re-use, AC2 preflight fails loudly, AC3 s1/x3 fixes with red-then-green cases, AC4 self-check cites uid+AC. 50e21ed9 AC2 web-symmetry definition + egress preflight implemented and tested. 0ba70e47 AC1 curl via shell_execute returns the page under srt (live), AC2 exit status visible (PENDING upstream, F32, not in this spec). 1207765d and 9063acac have NO ACs; tests cite them with the bucket AC id as `1207765d (bucket B0.AC4)`.

* Publication path: `P/package.json` `files` = dist, CHANGELOG.md, llms.txt, AGENTS.md, docs; PUBLISHING.md: publish packs `P/dist` only. `P/project.json` build = `tsc -p tsconfig.lib.json --outDir dist` then `cp P/*.md P/LICENSE dist/` and `cp -R P/docs dist/`. `P/tsconfig.lib.json` include = `src/**/*.ts`, exclude `src/**/*.test.ts`, `*.spec.ts`, `__tests__`. So a directory `P/parity/` that is not named `docs`, holds no `*.md` at the package root and is outside `src` cannot reach dist.
* Lanes (ADR-0009, `tools/vite-plugins/e2e-globs.mjs`, `P/vite.config.ts:61`): unit include `src/**/*.{test,spec}.{js,mjs,cjs,ts,...}`, excludes `**/*.e2e.test.ts` and `**/*.e2e.ts`; e2e include is only `src/**/*.e2e.ts` and `src/**/*.e2e.test.ts` and runs with isolated cwd and fake HOME. `check-agent-lane-spawn.mjs` scans only `src/**`. Hence instrument code lives outside `src` and its tests live in `P/src/parity-instrument/`.
* Prompt facts (SP/round4/fixtures.mjs prompts()): the phase-1 text is identical for every arm and names no web tool, but says "fetch it yourself if you have a way to" and the JSON key says "or null if you could not fetch it". The ticket says `see https://example.com`. The curl allowlist is NOT prompt-driven: `SHELL_ALLOW` (drive.mjs:69, contains `curl`) is applied to B and C by `agentDef` (drive.mjs:262) and the srt policy pre-write adds example.com (SRT_EXTRA_DOMAINS, drive.mjs:70/234, "F29"); arm A fetches by unrestricted Bash curl (`A_TOOLS` has no WebFetch); arm C runs server-side web_search/web_fetch at the product default. `webCapability()` (drive.mjs:469) feeds only the oracle.
* The oracle has no quality score: FIELDS carry kind content/process/format and the summary ratio is content items passed (oracle.mjs:316).
* R4 numbers (RESULT.md): wall A 92 s, B 130 s (+41%), C 163 s (+77%). Billed cost A 0.2088, B 0.2211 (+5.9%), C 0.1935 (-7.3%); common-card cost medians A 0.1877, B 0.1886, C 0.1935. A1 12/17 vs A2 17/17.
* tasks_batch rejection (R4 C1): the model sent `concurrency` "2" (string) and a stringified prompts array; `P/src/server.ts:595-597` runs strict `tasksBatchInputSchema.parse(args)`, which rejected it (3 failed turns, about 9-10 s). The schema is `packages/agent/agent-engine-orchestrator/src/validation/task.ts:179` (`concurrency: z.number().int().positive().max(64).optional()`, `prompts: z.array(z.string().min(1)).min(1)`).

## 2. Location and guaranteed non-publication

Layout (all inside P, none in `src/` except tests):
```
P/parity/ drive.mjs oracle.mjs lib.mjs fixtures.mjs info-server.mjs ledger.mjs gate.mjs
          metrics.mjs quality.mjs judge.mjs detectors.mjs preflight.mjs grid.mjs
          README.md  (not at package root, so the build's `cp P/*.md` skips it)
          golden/{legacy,r4}/**   ledger/<round>.json (tracked)   dryrun/**
P/src/parity-instrument/*.test.mjs          (unit lane, spawns nothing)
P/src/parity-instrument/*.e2e.test.ts       (e2e lane, isolated cwd + fake HOME)
tmp/agent-mcp/parity/<round>/**             (raw output, gitignored; AGENTS.md section 10)
```
Every parity/*.mjs has line 1 `// PARITY-INSTRUMENT-ONLY`. Guarantee (structural): `parity/` is not in `tsconfig.lib.json` include, not in the build `cp` list, not in `package.json` files, not under `P/docs`, and no `.md` for it sits at the package root. Verification: the e2e test `no-publish.e2e.test.ts` (spawn, so e2e; e2e `dependsOn` already builds) walks `P/dist` and asserts no path contains `parity` and no file contains the marker, then runs `npm pack --dry-run --json` in `P/dist` and asserts the same on the file list; its negative control copies dist to a temp dir, injects `parity/x.mjs` and requires the walker to go red. Published `P/AGENTS.md` and `P/docs` get no instrument text.

## 3. Rules the instrument enforces (owner answers)

* Runs: one run per arm per round (A, B, C), ledger cap 3. A fourth or further run needs a documented reason in LOG before it is reserved. Arm order: A runs first, then B and C; B and C alternate order between rounds; the order is recorded in the ledger.
* Valid iteration: if arm A fails the task (any content item red, INVALID, or a defect signal), the iteration is void and unscored: B and C are not run, nothing enters the grid as a score, LOG records the void. Quality is assessed only for groups that genuinely succeeded.
* Success of a variant: every content item passes (automatic oracle), not INVALID, no defect signal. One red variant makes the round red.
* Compared goal metrics, each of B and C against A of the same iteration: cost (billed, authoritative; common-card shown beside it) <= 1.02 x A, duration (wall) <= 1.02 x A, quality (R5) >= 0.98 x A, where quality is the mean of the 8 R5 scores for each arm compared to A's mean on the same run; per-quality scores are reported but not gated. Faster, cheaper, better pass. With n=1 per arm this cannot separate noise from regression; the verdict is a fixed threshold, not a significance claim. The threshold is a function argument, never an env switch.
* Reported only, never gating: turns, tool calls, peak context. Repeated tool errors in a run are a defect signal (R6), read as a probable test or code bug.
* Tools: arm A uses native tools only (no instrument-added path); B and C use only agent-mcp tools or MCP servers provided as shipped. The curl allowlist and the srt example.com entry (F29) are removed from the instrument unless they are a shipped default. An arm that cannot fetch the page fails w1_web, and that is recorded as a product finding.
* Task prompt: byte-identical text for every arm, naming no tool or method. Scope may change per round; every change is a LOG entry before the round starts (R0.AC7).

## 4. Buckets (each: done-state, ACs, tests)

### R0 Relocate the instrument, unpublished; ledger and gate (REPLACES B0 63c8aba2; 25ce70b8 AC1/AC2/AC4, 1207765d)
Done: on a clean checkout `node P/parity/drive.mjs --self-check` exits 0; the R3-red/R4-green oracle cases are unit tests; nothing references SP.
* R0.AC1 faithful behavior-preserving port as plain `.mjs`; `rg -n "private/tmp|scratchpad" P/parity` has no hit; README covers scenario, arm definitions, criteria history, commands, cost basis, tmp convention.
* R0.AC2 the four R4 oracle fixes (w2 null, s2 double count, h2_empty over-spec, x3 HEDGE) proven against the frozen R3 oracle copied verbatim to `P/parity/golden/legacy/` (lint-ignored): legacy RED on the named fields, current GREEN.
* R0.AC3 R4 records captured BEFORE the scratchpad is touched: `observation`, `expected`, `score` per run to `P/parity/golden/r4/<run>.json` with the sha256 of the source record.json.
* R0.AC4 ledger: tracked `P/parity/ledger/<round>.json`, cap 3, lock, atomic write, corrupt file fails closed; fields `runs[]`, `approvedBy` (the owner message quoted), `extraRunReason` (required for run 4+), `judgeCalls[]`, `scenarioSha`, `scopeChanges[]`. `--live` without non-empty `approvedBy` refuses (a further live round must be asked for).
* R0.AC5 NON-PUBLICATION structural guarantee of section 2.
* R0.AC6 NON-PUBLICATION verified by `no-publish.e2e.test.ts`, including the negative control.
* R0.AC7 scope-change gate: `gate.mjs` computes `scenarioSha` over prompts() + ticketText() + fixtures expectations; if it differs from the previous round's ledger value, every `scopeChanges[]` id must match a heading `### <id>` in LOG dated before the round's `startedAt`; otherwise refuse (exit 3, ledger untouched). Unit test with a synthetic LOG: missing entry red, entry present green.
* R0.AC8 gate order `[pacing, ledger, scope, preflight]` fail-closed; arm A first; B/C reserved only after A's correctness passes (void rule in section 3), unit-tested with a fake A failure.
* R0.AC9 `--self-check` = selfCheckPure() (unit, no spawn) + selfCheckSpawning() (e2e only); output lines cite ticket+AC ids.
* R0.AC10 `npx nx run agent-mcp:lint`, `:typecheck`, `:test`, `:e2e`, `:build` exit 0; lane-reachability rule 8 passes; `eslint` and `@nx/dependency-checks` accept `P/parity/*.mjs` (an override in `P/eslint.config.mjs` is the only permitted config touch, and only if lint needs it).
Lane split (ADR-0009): unit tests mock `node:child_process`, the MCP SDK and the network; only `*.e2e.test.ts` spawn.

### R1 Oracle fixes FC1 + FC5 (AMENDS B1 7fa23e51; 90758419 AC1/AC3/AC4, 25ce70b8 AC2)
Done: on the frozen R4 records the oracle is red where it should be and green where the old oracle was wrong.
* R1.AC1 q_rate FAILs only when the phase-2 value is missing/wrong or contaminated (invalid); a correct value passes whether or not the ticket was re-read; new informational `q_rate_reread`.
* R1.AC2 `q_context_carry`: phase-2 first-turn cache_read >= 0.9 x (phase-1 last-turn cache_read + cache_create) for A/B; for C the first phase-2 request contains the phase-1 get_ticket result; red on a synthetic broken-carry observation.
* R1.AC3 x3 HEDGE counts only when it conditions the delegation clause; committed table `golden/r4/x3-briefs.md` of old vs new verdicts for B1,B2,C1,C2.
* R1.AC4 s1_tests_honest scored against the VISIBLE suite at end of phase 1; legacy records without `hidden.p1.visible` score invalid, never pass.
* R1.AC5 h2_regress counts a root cause once.
* R1.AC6 x2_parallel for arm A by outcome (interleaved children by parent_tool_use_id); sequential A run is the negative control.
* R1.AC7 must-stay-red on R4 records: A1 h1_feature, h2_empty, s2_honest; B1/B2 w1_web.
* R1.AC8 every case cites `90758419 AC<n>` or `25ce70b8 AC2` and has a frozen-oracle RED / new-oracle GREEN pair.
Write-scope: `P/parity/oracle.mjs`, `P/parity/golden/r4/**` (adds), `P/src/parity-instrument/oracle-r1.test.mjs`. Depends on R0.

### R2 Web-path preflight and silent-egress detector (AMENDS B2 e593b916; 50e21ed9 AC2, 0ba70e47 AC1, 90758419 AC2)
Done: before a live round, every shipped web path that can be probed with zero model calls is probed and must return the page; paths that cannot be probed are named and covered by the detector; a live round refuses on red.
* R2.AC1 spike table (committed in README): per arm (A native toolset, B agent-mcp claudecli, C agent-mcp anthropic) what web tool the shipped configuration exposes and whether a zero-model probe exists. Unknown until measured (U5); C's server-side web_fetch is not probeable at zero model cost.
* R2.AC2 for each probeable path: real MCP client (SDK `Client` + `StdioClientTransport`) against the built agent-mcp stack as shipped, no instrument-added allowlist entry or srt domain; `listTools` then one call to the fetch tool against the target URL.
* R2.AC3 asserts per leg: tool listed; `isError` false; text >= 200 bytes; contains `<title>Example Domain</title>`; wall > 150 ms.
* R2.AC4 FALSE-EMPTY: blank content with isError false is RED `EMPTY_FALSE_SUCCESS`; `curl: (6)`/"Could not resolve"/"blocked" is RED `EGRESS_DENIED`. Codes: GREEN, LAUNCH_FAIL, EMPTY_FALSE_SUCCESS, TOOL_ERROR, MARKER_MISSING, EGRESS_DENIED, TIMEOUT, NOT_PROBEABLE.
* R2.AC5 CLI exit 0 only if every probeable leg is GREEN, else 3 (usage 2); JSON verdict on stdout.
* R2.AC6 receipt `tmp/agent-mcp/parity/<round>/preflight-receipt.json` with agent-mcp dist sha, native-tooling version, srt version, policy sha, targetUrl, marker.
* R2.AC7 `--live --yes` runs the preflight BEFORE pacing and BEFORE any ledger reservation; red -> exit 3, ledger byte-identical, a `claude` shim on PATH proves zero spawns.
* R2.AC8 detector (`detectors.mjs`, egress-silent-empty): any web tool result (shipped fetch tool of any arm) that is blank with isError false marks that run's w1_web INVALID(egress) with call ids; tested red on a synthetic log shaped like R4 B1 api log lines 110-118.
* R2.AC9 `PreflightSpec { targetUrl, marker, minBytes, minWallMs, worktree, timeoutMs }` is a function argument; no env flag toggles anything.
* R2.AC10 unit table test (mocked SDK/child_process, no network): every verdict code and exit mapping.
* R2.AC11 e2e GREEN against a local HTTP parentProxy stub (technique of shell-egress.e2e.test.ts; srt refuses loopback targets), where a probeable shell path exists as shipped.
* R2.AC12 e2e NEGATIVE CONTROL: strip `MCP_SHELL_CHILD_ENV_ALLOWLIST` from the resolved env, the same call must be RED.
* R2.AC13 missing srt/uvx fails loudly in beforeAll (no skip).
* R2.AC14 operator proof (needs internet, not CI): `node P/parity/drive.mjs preflight ; echo $?` prints 0 on real example.com; paste the exit status into LOG.
(Old B2.AC1-AC22 map: AC1-AC3 -> R2.AC1-AC2, AC4-AC12 -> AC3-AC5, AC13 -> AC6, AC14 -> AC7, AC15 -> AC8, AC16 -> AC9, AC17-AC21 -> AC10-AC13, AC22 -> AC14.)
Write-scope: `P/parity/preflight.mjs`, `P/parity/detectors.mjs` (egress detector), `P/src/parity-instrument/preflight.test.mjs`, `P/src/parity-instrument/preflight.e2e.test.ts`. Depends on R0, R3.

### R3 One prompt, shipped tools only (REPLACES B3 6865f7ce / FC4 O1; 50e21ed9 AC2, 9063acac)
Done: phase-1 and phase-2 prompt text is byte-identical across arms and names no tool or method; A runs native tools only; B and C run agent-mcp tools or provided MCPs as shipped.
* R3.AC1 phase-1 text no longer opts out: "fetch it yourself if you have a way to" becomes "read the web page the ticket links to"; `web_heading` loses "or null if you could not fetch it". Scenario change -> LOG entry first (R0.AC7).
* R3.AC2 unit test: one prompt string for A, B, C (same sha) and no match for `/curl|WebFetch|web_fetch|web_search|WebSearch|shell|Bash|browse/i`.
* R3.AC3 `SHELL_ALLOW` loses `curl`, `SRT_EXTRA_DOMAINS` loses example.com, `A_TOOLS` is the native default toolset; unit test on the produced agent definitions: C does not set `nativeWebTools:false`, B/C `nativeTooling.shell.allowCommands` contains no `curl|wget`. If a shipped default grants curl or example.com, the test names that default and cites its source line.
* R3.AC4 `webCapability()` no longer exempts any arm: w1_web is scored for every arm; an arm that cannot fetch fails w1_web and `record.webFinding = "arm cannot fetch"` is written (a product finding, not an instrument defect).
* R3.AC5 each run records `webSurface` (the tool names actually exposed), reported not scored.
* R3.AC6 README "web surface" section lists the per-arm shipped surface with source citations.
Write-scope: `P/parity/fixtures.mjs` (prompts, ticketText), `P/parity/drive.mjs` (agentDef, A_TOOLS, SHELL_ALLOW, SRT_EXTRA_DOMAINS, webCapability), `P/src/parity-instrument/web-surface.test.mjs`. Depends on R0.

### R4 Metric model and verdict (NEW)
Done: `node P/parity/drive.mjs verdict --round R<n>` prints, for B and C against A of the same iteration, cost ratio, duration ratio, quality ratio, PASS/FAIL per goal metric, and the report-only columns.
* R4.AC1 gates: cost (billed) <= 1.02, duration <= 1.02, quality >= 0.98, all relative to A; quality is the mean of the 8 R5 scores, compared to A's mean on the same run; per-quality scores reported, not gated; thresholds are function arguments.
* R4.AC2 turns, tool calls, peak context emitted as report-only; a unit test proves no code path fails a round on them.
* R4.AC3 void rule: A not genuinely successful -> verdict `VOID`, no ratios.
* R4.AC4 golden test on R4 (duration and cost only, quality is absent there): wall B 1.41 FAIL, C 1.77 FAIL; billed cost B 1.059 FAIL, C 0.927 PASS; common-card basis shown alongside.
* R4.AC5 per-run duration decomposition recorded: time to first model event, summed model time, summed tool time, phase 1 vs phase 2, per-call time to first byte for A and B and C where the stream exposes it (input to R8).
* R4.AC6 the verdict states plainly "n=1 per arm; fixed threshold, no significance claim".
* R4.AC7 an extra run (ledger run 4+) is excluded from the verdict unless its `extraRunReason` is set.
Write-scope: `P/parity/metrics.mjs`, `P/parity/lib.mjs` (cost/duration accessors), `P/src/parity-instrument/metrics.test.mjs`. Depends on R0, R5.

### R5 Quality: blind judge over a multi-quality rubric (NEW; replaces any deterministic quality score)
Done: for an iteration where A and the arm genuinely succeeded, a blind judge scores code output AND transcript/reasoning on the rubric; quality is the unweighted mean; correctness stays automatic (the oracle).
Rubric (each quality scored 1-100 as an integer):
 1 spec_conformance (code does what the task spec requires, including edge cases it names), 2 code_clarity (readability, naming, structure), 3 change_discipline (minimal, in-scope diff; no collateral edits), 4 verification (tests run and not weakened; claims checked), 5 docs_quality (shipping doc, CHANGELOG entry, usage examples are accurate and useful), 6 reasoning_soundness (transcript: root cause found by evidence, sound decomposition and delegation), 7 transcript_focus (no thrash, repeated dead ends, or redundant exploration), 8 report_fidelity (final summary claims match the artifacts).
* R5.AC1 judge brief (blind): the judge receives ONLY (a) the task spec: both prompt texts and the ticket text, verbatim; (b) the artifact: unified diff of the final repo against the scenario start plus new files; (c) the transcript normalized to role, text, tool category (shell/read/write/search/delegate/web) and results. Never given: arm id, provider, model, tool names that identify an arm, oracle results, cost, duration, thresholds, the other arm's output, or any instrument context. Arm labels are random per judging.
* R5.AC2 normalizer strips identifying tokens (`claudecli`, `anthropic`, `agent-mcp`, `claude -p`, `mcp__`, session ids, model ids, CLI banners, tool-name spellings) and a unit test asserts the brief for every R4 golden contains none of them.
* R5.AC3 judge output contract: one JSON object `{ "scores": { "<quality>": <int 1-100>, ... }, "notes": { "<quality>": "<one sentence>" } }` with exactly the 8 keys; parser rejects missing/extra/duplicate keys, non-integers, values < 1 or > 100, and text outside the JSON.
* R5.AC4 aggregator: quality = mean of the 8 scores; ratio = arm quality / A quality (same run); gate per R4.AC1 on the ratio; per-quality scores always reported, never gated.
* R5.AC5 judge model: Haiku (pinned model id recorded in the judge record), the cheapest tier, same as the arms; judge is invoked at temperature 0 where the API allows.
* R5.AC6 judge calls are paid third-party calls: one call per judged arm per iteration (A, B, C, at most 3 per round); each logged in the ledger (`judgeCalls[]`: arm, model id, input/output tokens, cost) and in LOG; judge cost is excluded from the arm cost metric. Judge calls are not agent runs and do not consume the run cap, but are capped at 3 per round without a documented reason.
* R5.AC7 the judge runs only after the oracle passes for A and for the judged arm (genuine success, no INVALID, no defect signal) and only when A passed; otherwise no judge call is made and quality is `n/a` (void or red arm).
* R5.AC8 judge is invoked only by the driver in a live round (paid third-party exception; no env flag). Documented with the owner named in P/parity/README.md, the driver header and LOG (not in P/AGENTS.md, which is published).
* R5.AC9 deterministic fixture tests, no live judge anywhere in unit or e2e: valid fixtures aggregate to known means; each malformed output class of AC3 is rejected with a distinct error code; ratio boundary cases 0.979 (FAIL), 0.98 (PASS), 1.0, 1.2.
* R5.AC10 blindness test: brief builder run on all R4 goldens in both arm orders yields identical briefs modulo the random label.
* R5.AC11 teeth: a mutated parser that accepts out-of-range scores turns AC9 red (recorded in the PR, not committed).
* R5.AC12 judge record stores the exact brief hash and raw judge response in `tmp/agent-mcp/parity/<round>/judge/<arm>.json`.
Write-scope: `P/parity/quality.mjs` (rubric, parser, aggregator), `P/parity/judge.mjs` (brief builder, normalizer, call), `P/src/parity-instrument/quality.test.mjs`. Depends on R0.

### R6 Repeated-tool-error defect signal (NEW)
Done: a run with repeated tool errors is flagged DEFECT_SIGNAL with call ids and is not a success.
* R6.AC1 PROPOSAL (thresholds not derived from repo data): flag when the same tool with normalized args returns isError >= 3 times, or isError rate > 25% over >= 8 calls.
* R6.AC2 red on a synthetic log; the result on the R4 goldens (including C1's tasks_batch rejections) is stated, not assumed.
* R6.AC3 the flag text reads "suspect a test or code bug", never "model failure".
Write-scope: `P/parity/detectors.mjs` (tool-error detector; edited after R2 merges), `P/src/parity-instrument/tool-errors.test.mjs`. Depends on R0, R2.

### R7 Grid and report (AMENDS B4)
Done: the LOG section-2 row renders icon + score per variant and the three goal-metric verdicts for B and C.
* R7.AC1 `renderGridCell`: 🟢 17/17, 🔴 15/17, 🟡 running, ⚪ not started, ⛔ n/a invalid, `VOID` for a void iteration; a defect-signal variant is 🔴.
* R7.AC2 `grid --round` output equals the LOG row built from the R4 goldens (recomputed values pinned after R1).
* R7.AC3 per-arm line `cost +x% / dur +y% / Q z%` from R4.
Write-scope: `P/parity/grid.mjs`, `P/src/parity-instrument/grid.test.mjs`. Depends on R4, R5, R6.

### R8 Duration slot (NEW; blocked on the `debug` finding)
Debug finding (summary, no fix designed here): there is no single defect. Contributors are the model-turn count and per-call latency; the parent blocks on synchronous `task`/`tasks_batch` while native uses background subagents; failed tool calls and retries; and run-to-run variance. Arm C's per-call latency is unexplained pending per-call time to first byte for A and B.
* R8.AC1 instrument supplies the data the finding awaits: per-call TTFB for A and B and C in the run record (provided by R4.AC5).
* R8.AC2 each contributor above is attributed in the next round's record with seconds per contributor (turns x mean call latency, parent-blocked time on task/tasks_batch, time in failed calls and retries), so a fix is chosen on evidence.
* R8.AC3 goal: R4 duration ratio for B and C <= 1.02 on an approved round; whatever change achieves it gets its own bucket and ACs after the finding is complete.
Write-scope: instrument side only (`P/parity/lib.mjs` timing capture, shared with R4); product changes are out of this bucket. Depends on the debug finding, R4.

### R9 Product fix: tasks_batch strict parse (NEW; backlog id to be assigned by backlog-operator, `<TASKS-BATCH-TICKET>`)
Evidence: R4 C1 sent `concurrency: "2"` (string) and `prompts` as a stringified array; `P/src/server.ts:595-597` `tasksBatchInputSchema.parse(args)` rejected it, costing 3 failed turns (about 9-10 s).
* R9.AC1 `tasksBatchInputSchema.parse` accepts `concurrency` given as a base-10 integer string and returns the number (`"2"` -> 2).
* R9.AC2 it accepts `prompts` given as a JSON string that decodes to a non-empty array of non-empty strings and returns the array.
* R9.AC3 unchanged rejections: `concurrency` "abc", "2.5", "0", "-1", "65"; `prompts` string that is not a JSON array or decodes to an empty array or contains an empty string; native values behave exactly as before (number 2, real array).
* R9.AC4 the exact R4 C1 argument shape (stringified concurrency and stringified prompts plus `agent_name`) parses and `tasksBatch` receives `concurrency: 2` and the decoded array.
* R9.AC5 the `tasks_batch` entry advertised by `tools/list` still describes `concurrency` as an integer and `prompts` as an array (test compares the advertised schema before and after, if it is derived from the zod schema; if not derived, the test states so).
* R9.AC6 red-then-green: the unit test `describe('<TASKS-BATCH-TICKET> AC1-AC5 ...')` fails on the current strict schema and passes after the change; an e2e case (`*.e2e.test.ts`, real MCP client against the built server, isolated cwd and fake HOME) calls `tasks_batch` with the R4 C1 shape and asserts the result is not an error.
Write-scope: `packages/agent/agent-engine-orchestrator/src/validation/task.ts` (tasksBatchInputSchema only), a colocated spec file in that package following its existing convention (confirm with `rg --files -g '*.spec.ts' packages/agent/agent-engine-orchestrator/src/validation`), `P/src/server.ts` only if the parse call site must change, `P/src/__tests__/tasks-batch-string-args.e2e.test.ts`. Gate: `npx nx affected -t lint,typecheck,typecheck-spec,test` because the orchestrator package has dependents (AGENTS.md section 5). This bucket changes shipped product code and needs the full release path; it is independent of R0-R8 and can start now.

## 5. Write scopes, executors, order

| Bucket | Executor / tier | Exclusive write scope | After |
|---|---|---|---|
| R0 | typescript, sonnet, fan out one bounded dispatch per module (fixtures, lib, oracle, driver, ledger/gate) | `P/parity/**` (port, ledger, gate, README, golden), `P/src/parity-instrument/{oracle,lib,ledger,gate}.test.mjs`, `no-publish.e2e.test.ts`, `parity.e2e.test.ts`, `P/eslint.config.mjs` only if lint needs it | none |
| R1 | typescript, sonnet | `P/parity/oracle.mjs`, `P/parity/golden/r4/**`, `oracle-r1.test.mjs` | R0 |
| R2 | backend, sonnet | `P/parity/preflight.mjs`, `P/parity/detectors.mjs`, `preflight.test.mjs`, `preflight.e2e.test.ts` | R0, R3 |
| R3 | typescript, sonnet | `P/parity/fixtures.mjs`, `P/parity/drive.mjs` (agent definitions), `web-surface.test.mjs` | R0 |
| R4 | typescript, sonnet | `P/parity/metrics.mjs`, `P/parity/lib.mjs`, `metrics.test.mjs` | R0, R5 |
| R5 | typescript, sonnet | `P/parity/quality.mjs`, `P/parity/judge.mjs`, `quality.test.mjs` | R0 |
| R6 | typescript, haiku | `P/parity/detectors.mjs` (after R2), `tool-errors.test.mjs` | R0, R2 |
| R7 | typescript, haiku | `P/parity/grid.mjs`, `grid.test.mjs` | R4, R5, R6 |
| R8 | blocked on `debug` | see R8 | debug finding, R4 |
| R9 | typescript, sonnet | see R9 | none |
Order: R0 -> {R1, R3, R5} in parallel -> {R2, R4} -> R6 -> R7; R8 after the debug finding; R9 any time. No bucket runs a live round.
Integration gate (dispatcher, after merges): `npx nx affected -t lint,typecheck,typecheck-spec ; echo $?`; `npx nx run agent-mcp:e2e ; echo $?`; pre-push `npx nx affected --base=origin/main --head=HEAD $(node .githooks/lib/pre-push-flags.mjs) ; echo $?`; operator `node P/parity/drive.mjs preflight ; echo $?` on the real network; `git status --porcelain` accounted for. Every executor's final message carries a `Gates:` list with command + exit code.

## 6. Round-readiness forecast after these land
Resolved by code: FC1, FC3, FC6, the three FC5 defects, FC4 (R3), the success and metric definitions (section 3, R4), quality (R5). Still open and NOT code: model variance (A can fail; then the iteration is void and costs one run), R8 duration (B +41%, C +77% in R4 would fail the 1.02 gate), the web path when an arm cannot fetch as shipped (a product finding that keeps the round red). A non-empty forecast keeps R5 held per LOG section 0.4. Further forecasts: (a) uvx/PyPI first-start latency inside the preflight (timeout 120 s); (b) srt policy drift between preflight and run (identity hash in the receipt, re-checked by the gate); (c) judge variance at n=1, which the fixed threshold does not absorb; (d) the egress detector protects only web results, not other fields.

## 7. Open owner decisions
* U5 R2.AC1: whether a zero-model probe exists for the shipped web path of A and B is unknown until the spike runs.
* U6 RESOLVED: gate is the mean of the 8 quality scores >= 0.98 x A's mean on the same run; per-quality scores reported, not gated.
* U7 RESOLVED: judge model is Haiku (cheapest tier, same as the arms).
* U8 RESOLVED: A runs first, then B and C; B and C alternate order between rounds; order recorded in the ledger.
* D4 ticket wording (FC5): unchanged; adding "keep existing return properties" would make the task easier for every arm and hide the brief-fidelity signal.
* Out of scope: BK5 625b611e gate text (25ce70b8 AC3) now follows from section 3; F32 exit status (0ba70e47 AC2, upstream PR tumf/mcp-shell-server#61).

## 8. Unfiled items this spec surfaces (dispatcher to file via backlog-operator)
* R9 tasks_batch strict parse (new bug; evidence in section 1).
* Tickets 1207765d and 9063acac carry no ACs (tests cite bucket ids).
* llms.txt Gemini/version staleness (from SP/parity-critical-path.md) remains unfiled.
