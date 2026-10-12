# CLI-parity instrument (private, unpublished)

Line 1 of every `parity/*.mjs` is `// PARITY-INSTRUMENT-ONLY`. This directory is not in `tsconfig.lib.json` `include`, not in the build `cp` list, not in `package.json` `files`, and this README sits here (not at the package root) so the build's `cp *.md` skips it. Verification is `no-publish.e2e.test.ts` (walks `dist`, `npm pack --dry-run`, with a negative control).

## Scenario and arms
One scenario ("shopkit", two phases in one session; `fixtures.mjs`). One run per arm per round, ledger cap 3: **A** native `claude -p` (native default toolset only), **B** agent-mcp `claudecli` provider, **C** agent-mcp `anthropic` provider. B and C use only agent-mcp tools or MCP servers as shipped. The task prompt is byte-identical for every arm and names no tool or method (R3). Arm A runs first; B and C alternate order between rounds (`ledger.armOrderFor`). If A is not a genuine success (every content item green, not INVALID, no defect signal) the iteration is VOID: B and C are not run.

## Commands (`node entrypoint/agent-mcp/parity/drive.mjs ...`)
`--self-check` (no model call, no `claude`), `--print-plan`, `--check-oracle`, `--check-lib`, `preflight` (zero model calls, exit 0/3), `verdict --round R<n>`, `grid --round R<n>`, `--dry-run`, `--live --yes` (refuses, exit 3, unless every gate is green).

## Gate order (deviation from R0.AC8)
R0.AC8 lists `[pacing, ledger, scope, preflight]` but R2.AC7 requires the preflight to run before pacing (pacing spawns `claude /usage`) with zero spawns on red. Implemented order: `ledger` (read-only: `approvedBy` non-empty, cap) -> `scope` (scenarioSha vs previous round, LOG headings) -> `judgeCredential` (presence only, no model call: `ANTHROPIC_API_KEY` or `ADHD_AGENT_ANTHROPIC_SECRET` in env or the `.env` cascade) -> `preflight` -> `pacing` (per-run `gatePacing` before each reservation) -> reservation. Any red or throwing gate exits 3 and leaves the ledger untouched.

## Ledger (`ledger/<round>.json`, tracked)
`runs[]`, `approvedBy` (the owner message, quoted; required for `--live`), `extraRunReason` (required for run 4+), `judgeCalls[]`, `scenarioSha`, `scopeChanges[]`, `armOrder`, `armA`. Scope-change rule: when `scenarioSha` differs from the previous round's, every `scopeChanges[]` id needs a LOG heading `### <timestamp> ... <id> ...` dated before the round's `startedAt`.

## Web surface (R2.AC1, R3.AC6) - spike table
| arm | shipped web tools | zero-model probe |
|---|---|---|
| A native | WebFetch, WebSearch (native default toolset) | none: WebFetch makes a hidden small-model call |
| B claudecli | none exposed by agent-mcp; shell has no fetch command by default | none; the arm cannot fetch as shipped (w1_web fails, `webFinding: "arm cannot fetch"`, a product finding) |
| C anthropic | server-side web_fetch / web_search | none: server-executed |
U5 stays open until measured; the preflight is generic (`WEB_SURFACE[arm].probe`) and every unprobeable leg is `NOT_PROBEABLE`, covered by the silent-egress detector.

## Metrics (R4) and quality (R5)
Cost (billed, authoritative; common-card shown beside it) <= 1.02 x A, duration <= 1.02 x A, quality >= 0.98 x A (mean of 8 judged qualities). Turns, tool calls, peak context are report-only. n=1 per arm: fixed threshold, no significance claim. Billed vs common-card: billed uses the CLI `total_cost_usd` for A and tier-aware cache pricing for B/C; common-card prices all cache writes at the 5m rate.
The judge (Haiku, `judge.mjs`) is a PAID third-party call; it authenticates with the arm-C credential path (`ANTHROPIC_API_KEY`, else `ADHD_AGENT_ANTHROPIC_SECRET` from env or the `.env` cascade; auth shape chosen by token prefix as `providers/anthropic.ts` does; the secret is never logged). It runs only from the driver in a live round, after the oracle passed for A and the judged arm, with no env flag. Owner: the repository owner (skywinstonsk@gmail.com), recorded here, in the driver header and in the experiment LOG; it is deliberately not mentioned in the published `AGENTS.md`.

## Oracle scope change SCOPE-R5-oracle-model-and-leak (applies to every arm)
- `r1_model` scores TURN models only (`init.model` plus every assistant turn, parent and child). Models that appear only as `result.modelUsage` keys with no assistant turn are hidden helper calls (arm A's native WebFetch summariser); they are recorded as informational `observation.sideModels` and never scored, for A, B and C. Arm C's server-side web_fetch is not visible at all, so its `sideModels` is always empty (a measurement asymmetry, not a pass).
- `q_rate` is INVALID only when phase 2 read the leaked file (a parent or worker call naming docs/shipping.md or CHANGELOG.md, or a `docs/` wildcard read; `observation.phase2.workerCalls` carries the workers' calls) or the value is in phase-1 assistant text. A copy of the carrier rate in phase-1 docs/changelog that phase 2 never read leaves the answer judged, with the detail "leaked to <file> in phase 1, not read in phase 2".
- New scored content item `leak_internal_note` (F4): FAILS when docs/shipping.md or CHANGELOG.md contain the ticket's internal carrier rate or handling fee ("Internal finance note, not for customer-facing docs"). `na` for legacy expectations without a carrierRate. The R4 goldens score unchanged on every existing item and pass it.
- Driver exit status: `drive.mjs --live` exits 4 when the iteration is VOID because arm A is not a genuine success (B and C are not run), so a void never looks like success; 1 is a harness failure, abort or invalid run; 3 a red gate; 0 a clean plan. Per the owner rule, a void iteration is not a started iteration: release its run with `ledger.releaseRun` and move its run directory aside before rerunning.
- Tests: `entrypoint/agent-mcp/src/__tests__/parity-instrument/oracle-scope-r5.test.ts` (AC-MODEL-1, AC-QRATE-1, AC-LEAK-1, AC-EXIT-1) and the matching oracle self-test checks and mutants (`drive.mjs --check-oracle`).

## Reply selection (R5-reply, applies to every arm)

The scored reply of a phase is NOT the stream's last `result` frame: on a native run with background subagents the CLI emits a late notification follow-up turn after the real answer, and that turn becomes the final result. `oracle.applyReplySelection` (called at the end of `analyzeA` and `analyzeBC`, identically for A, B and C) picks the LAST assistant text of the phase whose last JSON object carries every required key (phase 1: `root_cause, ticket, owner, web_heading, flat_shipping_total, tests_pass, files_changed`; phase 2: `empty_cart_handled, tests_pass, carrier_rate, first_file_fixed, examples_updated`), falling back to the last non-empty assistant text. `<system-reminder>` blocks are stripped first, so notification-only text (and JSON echoed inside a reminder) is never eligible. The record carries `phaseN.replySource = {index, via: 'json'|'fallback'}` and `phaseN.replyTextRaw` (the stream value). No prompt, threshold or item criterion changed. Tests cite "R5-reply AC1..AC4" (`oracle.mjs` selfTest, `drive.mjs --self-check`).

## Judge reply parsing and `--reparse-judge` (R5-judge)
The judge reply must be exactly one JSON object; it may be wrapped in exactly one markdown code fence (` ```json ` or bare ` ``` `). Prose before/after, a second object or second fence, or an unclosed fence is `TEXT_OUTSIDE_JSON`; schema validation (8 qualities, integers 1-100, string notes) is unchanged.
`node drive.mjs --reparse-judge --round R5` re-parses saved `tmp/agent-mcp/parity/<round>/judge/<arm>.json` records that carry `error` + `rawResponse` with the current parser. ZERO model calls; the ledger (`judgeCalls[]`) is never touched, since the paid call was already logged. A repaired record gains `scores`, `notes`, `reparsedFromRaw: true`, `originalError` (the rejection code) and drops `error`; the arm's `record.json` quality block is updated the same way. It prints per-arm judge means and the C/A ratio against the owner gate (>= 0.98 x A) and never a round verdict.

## Output
Raw output goes to repo-root `tmp/agent-mcp/parity/<round>/` (gitignored). The arm working directory lives under the OS temp dir (`adhd-agent-mcp-parity/<round>/work`) so no repo or agent-instruction file sits above it; only an operator-supplied `--out` moves it under that directory (and `ancestorLeaks` then rejects an in-repo one). Every attempt of a runId gets a fresh, never-used work dir `work/<runId>-a<n>` (n starts at the ledger's runs+releases count for that runId and is bumped past any dir on disk; old dirs are never deleted). `prepare()` then fails closed if the repo holds any file outside the fixture set (a pre-spawn harness fault: nothing reserved, record `aborted`, retryable), and `record.json` carries `workDir` and `preManifest` (path -> sha256 of the repo before phase 1). Proven by the `R5-workdir AC1-AC3` self-checks.

## Ledger releases (R5-harness)
A run is reserved only after fixture preparation succeeds, immediately before the first model-capable spawn. A fault before that point records the arm as `aborted` (retryable) and consumes no run and never records arm A as a void. `ledger.releaseRun(round, runId, reason)` is the audited repair for a run that was reserved but provably never reached a model: it appends to `releases[]` and resets `armA` when A is released.

## Goldens
`golden/legacy` (frozen round-3 oracle + fixtures, byte-identical), `golden/r4` (R4 observation/expected/score per run with the source sha256; `oracle.r4.frozen.mjs` is the R4 oracle before R1, one import path adjusted), `golden/selfcheck/round3`.

## Pacing gate (SCOPE-R5-pacing-gate)

Before every live run `drive.mjs` reads `claude -p /usage` (0 model calls, asserted). The run aborts with a recorded reason when the 5-hour window is at or above 90% (AC1), when any seen rate-limit status is not `allowed`/`allowed_warning`, or when the reading is unreadable (fail closed). The 7-day window is not checked (AC2); `week_pct` is still recorded in `pacing.before/after` for information only.

## Owner-directed retry (R5-retry, R5-resume)
- `ledger.retryPlan` (e.g. `[{"arm":"B","rep":2},{"arm":"C","rep":2}]`) replaces the seeded plan; the CLI still cannot slice it. It is honoured only with a non-empty `extraRunReason` (the owner direction, quoted), never contains arm A (A1 is the native reference and is not rerun), and rejects rep 1, unknown arms and duplicates (`ledger.retryPlanOf`, fail closed). Run ids are `<arm><rep>` (B2, C2); fixtures are seeded by rep, so a rep-2 run is a different (same-shape) instance. `c1_cache` treats C rep 2 as a warm repetition inside the 5 minute TTL: a retry hours later cannot satisfy it (instrument artifact; a process item, not part of genuineness).
- The loop stops at the first aborted or harness-failed retry arm (no loop).
- `ledger.judgeCapExtra` + `ledger.judgeCapReason` raise the judge cap above 3 (`ledger.effectiveJudgeCap`); the extension is bounded, the reason is recorded on each extra call, and the cap is checked before the paid call.
- Retry judge records go to `tmp/.../<round>/judge-rep<N>/<arm>.json`, never into `judge/`.
- `verdict|grid --round R5 --rep 2` reports A1 vs the rep-2 B/C (read-only).
- R5-resume AC1: on an idempotent resume (A skipped) or a plan without A, `state.aGenuine` is seeded from the finished A record AND the ledger `armA.genuine` (`seedAGenuine`); before this the judge was suppressed for later arms.

## Scorer fixes and offline rescore (R5-scorefix)
- `x2_parallel` (B/C): the overlap is that of the INTENDED pair, the first group of two or more depth-1 child rows created within 2000 ms of each other (one `tasks_batch` creates its rows ~1 ms apart; `lib.intendedPairOverlap`). Extra model-chosen workers before or after the pair no longer enter an N-way intersection. With no such group the overlap is over all rows (negative for a sequential run). The observation records `pairBasis` and `pairRows`.
- `c1_cache` (C): the warm-repetition requirement applies only when rep 2 starts within the 300 s cache TTL of rep 1 (`oracle.CACHE_TTL_SECONDS`). A later start is `na` with detail "cold repetition by schedule". The gap is seeded from the rep-1 `record.json` on disk, so a separate retry pass has it (it used to be null there). An unknown gap is not excused.
- Judge brief format 2 (`judge.BRIEF_FORMAT`): server-tool results (web_fetch/web_search) are captured from the response stream and rendered in the transcript; an uncaptured result reads `(result not captured)` and a captured blank `(empty result)`. Every judge record carries `briefFormat`; records without it (all of R5 so far) are format 1, whose server-tool results were blank.
- `node entrypoint/agent-mcp/parity/rescore.mjs [--round R5] [--out DIR]`: zero model calls. Re-scores a round's finished records under the corrected scorers into `tmp/agent-mcp/parity/<round>/rescore/` (items, counts, diff, fidelity, verdict and grid per repetition). It first re-scores the stored observation unpatched and exits 3 if that does not reproduce the stored score. Raw records are never written.
