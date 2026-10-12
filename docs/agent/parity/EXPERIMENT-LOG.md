# CLI-parity experiment log

Question under test: are agent-mcp results truly equivalent or better than native `claude` CLI, on `claude-haiku-4-5`.
Arms: **A** native `claude -p` · **B** Claude CLI via agent-mcp `claudecli` provider · **C** Anthropic OAuth via agent-mcp `anthropic` provider.
Keeper: dispatcher run `dispatch-2026-10-06-48dc`, written with Bash by the dispatcher itself (owner direction 2026-10-11). Created 2026-10-11T19:19Z at main `ebd24f9c`. Append-only: a correction is a new dated entry, never an edit of an old one.

## 0. Process contract (owner, 2026-10-11, verbatim intent)

1. Before each round dispatch, this log holds: every change included in that round (ticket ids, the specific fix, why) = everything implemented after the previous round was triaged.
2. Before each round, the dispatcher declares why it believes the included fixes reach 100% success.
3. After the round: results are added, then labeled triage naming the core reason(s) blocking success.
4. No round is dispatched until every known blocker is corrected. The dispatcher forecasts what else could block the round and resolves those first. A non-empty forecast means the round does not run.
5. A bug found against the experiment, fixed, then re-run and gone, is resolved (owner point). A fix that was never re-run is UNVERIFIED.
6. Every turn the dispatcher reports the last 3 rounds as one grid (section 2). The standard dispatcher status table is retired.
7. Results are documented here concretely and committed; the scratchpad is not a record.

Honest provenance note: contract items 1-3 were set on 2026-10-11 after R4. For R1-R4 no pre-round declaration or forecast was recorded at the time; those entries are marked `NOT RECORDED AT THE TIME` and the changelogs are reconstructed afterwards from git, the backlog and the scratchpad (source: reconstructed history, 11 live iterations). Nothing below is backfilled as if it had been declared.

## 1. Definitions

* Variant = one run of one arm, e.g. A1, A2, B1, B2, C1, C2 (two runs per arm per round so far).
* Variant result icon: 🟢 success · 🔴 fail · 🟡 running · ⚪ not started. The score is shown next to it as content items passed out of 17 (R2: out of 14 or 16, denominators differed).
* Success (ASSUMED, owner has not confirmed): all content items of the scenario pass for that variant. Cost, latency and context are reported but are not part of per-variant success.
* Fix icon: ⚪ unstarted · 🟡 in progress · 🟢 ready (shipped; ready is not the same as verified, see the fix register status column).
* Round row icon: 🟢 while the round is running.
* Cost: common rate card claude_haiku_4_5 in 1.00 / cache-read 0.10 / cache-write 1.25 / out 5.00 per M; billed = driver or CLI authoritative cost. The cost verdict flips with the basis (R4: B +0.5% vs +5.9% over A; C +3.1% vs -7.3%).

## 2. State grid (render exactly this shape every turn; last 3 rounds)

Snapshot at 2026-10-11T19:19Z.

```
| Round     | Fixes in round           | A1       | A2       | B1       | B2       | C1       | C2       | Core blockers (triage)         | Forecast: unresolved, with why               |
|-----------|--------------------------|----------|----------|----------|----------|----------|----------|--------------------------------|----------------------------------------------|
| R3 done   | 🟢 F16-F26 CRLF,         | 🟢 17/17 | 🟢 17/17 | 🔴 16/17 | 🔴 16/17 | 🟢 17/17 | 🔴 15/17 | B1 model omitted numbers       | —                                            |
| 4277d7b5  |    parallel, scorer      |          |          |          |          |          |          | B2 scorer defect on w2         |                                              |
|           |                          |          |          |          |          |          |          | C2 h2_empty oracle too strict  |                                              |
|-----------|--------------------------|----------|----------|----------|----------|----------|----------|--------------------------------|----------------------------------------------|
| R4 done   | 🟢 oracle defects fixed  | 🔴 12/17 | 🟢 17/17 | 🔴 15/17 | 🔴 15/17 | 🟢 17/17 | 🟢 17/17 | B w1_web: proxy env dropped    | ⚪ FC1 q_rate oracle 90758419: any phase-2   |
| 6abde7cb  | 🟢 thinking off, all arms|          |          |          |          |          |          |   (fixed 0.0.4, not re-run)    |    get_ticket call = fail, even if correct   |
|           | 🟢 curl allowlist        |          |          |          |          |          |          | B q_rate: oracle fails a       | ⚪ FC2 0.0.4 unproven live 0ba70e47: only    |
|           |                          |          |          |          |          |          |          |   correct re-read              |    component e2e; w1_web may fail again     |
|           |                          |          |          |          |          |          |          | A1: native fail, cause unknown | ⚪ FC3 silent fetch fail 50e21ed9: empty     |
|           |                          |          |          |          |          |          |          |                                |    result gives no signal; B invented text  |
|           |                          |          |          |          |          |          |          |                                | ⚪ FC4 web asymmetry 50e21ed9: C has         |
|           |                          |          |          |          |          |          |          |                                |    server web tools, A/B use curl            |
|           |                          |          |          |          |          |          |          |                                | ⚪ FC5 A1 cause unknown, no ticket: native   |
|           |                          |          |          |          |          |          |          |                                |    fails at random, 100% may be unreachable  |
|           |                          |          |          |          |          |          |          |                                | ⚪ FC6 instrument not in repo 25ce70b8:      |
|           |                          |          |          |          |          |          |          |                                |    changes between runs unprovable           |
|           |                          |          |          |          |          |          |          |                                | ⚪ FC7 bands undefined, no ticket: R5        |
|           |                          |          |          |          |          |          |          |                                |    unjudgeable; cost flips by basis          |
|           |                          |          |          |          |          |          |          |                                | ⚪ FC8 model miss, no ticket: one random     |
|           |                          |          |          |          |          |          |          |                                |    omission fails a 100% round               |
|-----------|--------------------------|----------|----------|----------|----------|----------|----------|--------------------------------|----------------------------------------------|
| R5 held   | ⚪ resolve FC1-FC7/accept| ⚪       | ⚪       | ⚪       | ⚪       | ⚪       | ⚪       | —                              | — (declared only when R4 forecast is empty)  |
|           | ⚪ FC8 per success defn  |          |          |          |          |          |          |                                |                                              |
|           | 🟢 0ba70e47 egress ships |          |          |          |          |          |          |                                |                                              |
```

Naming: fixes are `F01`-`F38` (section 4, owner-facing history ids); forecasts are `FC1`-`FC8` (section 5).

## 3. Round log

Each entry: build · changelog since the previous round's triage · pre-round declaration · forecast · results · labeled triage. Raw results are in a session scratchpad (non-durable); this log keeps the distilled numbers (section 6).

### R1 · 2026-10-10 19:28-19:33Z · agent-mcp dist from worktree `cp-battery`, HEAD `92589dca` · 6 runs

* Changelog: first round of the R-series. Product delta from the last P-series build `3976d3ce`: 429/529/usage-window fault classification and retry (`3fac822e`, `4b6f0c11`), bridged tool calls governed by the permission gate (`ca4851b5`), cache guard at 0.75 of model minimum (`273a6490`), spawn-failure reporting (`a6d2b282`).
* Pre-round declaration: NOT RECORDED AT THE TIME. Forecast: NOT RECORDED AT THE TIME.
* Scenario: old two-task set. T1 find the function violating "<=3 params", reply `NAME:LINE`. T2 read two files, write the sum (single level). Thinking on for A and B, off for C.
* Results (pass/fail): A 2/2, B 2/2, C 1/2. Peak ctx A 57,096 · B 7,694 · C 9,085. Driver-card cost A 0.1082 · B 0.0119 · C 0.0113. Wall A 25.5 · B 14.8 · C 9.2 s.
* Triage:
  * CORE (instrument): the numeric gates (ctx <= 1/6 of A, cost <= 1/2 of A) only passed because A ran with its stock config (about 54k turn-1 context). Gate meaningless against a matched A.
  * CORE (instrument): driver cost model wrong for A and B (A output tokens undercounted 31 vs 2,473; 1h cache writes priced at the 5m rate), so the headline cost ratios were wrong.
  * C T1: answered `makeBox:6` (comment line) instead of `makeBox:7`, multi-line prose. Single sample, unexplained.
  * Coverage: shell, MCP, subagent, 84 KB results, deny rules, JSON fields were never exercised.

### R2 · 2026-10-10 22:33-22:52Z · agent-mcp `270d26f3`, claude 2.1.296 · 6 runs

Changelog since R1 triage:
* Instrument (F16, F18): new driver and per-field oracle; composite two-phase scenario (bugfix + feature, docs/owner/changelog, CRLF edit, web fetch, ticket via MCP, parallel + nested dispatch, phase-2 empty cart) with hidden tests; matched native arm A; tier-aware cost. Why: R1 gave no evidence on shell/MCP/subagent and its gates were meaningless.
* Product (F26, F35, F36): claudecli continuation replay carries earlier tool calls/results (`270d26f3`, `54499db1`); first-turn context, failed-run usage and `usage_query` fields (`0ea88328`, `debd934d`, `afa37093`, `8333f755`); retried-attempt spend summing (`93ccdbb7`); migration retry jitter (`d5beac75`); ADR-0008 amendment (`c00dc560`). Why: B phase 2 re-wrote a cold ~20k prefix; failed runs looked free.

* Pre-round declaration / forecast: NOT RECORDED AT THE TIME.
* Thinking: on for A and B, off for C (not equalised).
* Results (content items passed): A1 12/14 · A2 14/14 · B1 14/14 · B2 14/14 · C1 13/16 · C2 13/16 (denominators differ). Peak ctx A 37,933 · B 25,922 · C 37,084 (recomputed). Wall A 139 · B 196 · C 121 s.
* Blind review (independent): NOT PROVEN, leans not-yet-equivalent.
* Triage:
  * CORE (product): CRLF edit failed 4/4 on agent-mcp (B1 B2 C1 C2). Root cause: the adopted `@modelcontextprotocol/server-filesystem` normalises CRLF to LF (`lib.js`). → F22.
  * CORE (product): parallel dispatch failed 4/4 on agent-mcp. B: claudecli executes same-message MCP calls serially unless `readOnlyHint`. C: models do not batch dispatch. → F23, F25.
  * Oracle: `q_rate` invalid on A1 A2 B1 B2 (rate echoed in phase 1) → F19; `h2_empty`/`s2_honest` failed on A1 C1 C2; C1 `f1_docs`; C2 `w1_web` (`# Source:` prefix); four oracle asymmetries; different denominators.
  * Instrument: arm A cost understated 29-32% by two driver bugs (output tokens scaled to the last result segment; cumulative vs per-phase cost) → F16 partial.

### R3 · 2026-10-11 00:19-00:35Z · agent-mcp `4277d7b5` · 6 runs · exit 0

Changelog since R2 triage:
* F17 R3-HARNESS AC4: A cost from `modelUsage`; warnings <5%. Why: A understated.
* F19 R3-HARNESS AC3: `q_rate` uncontaminated. Why: invalid on 4/6 in R2.
* F20 R3-HARNESS AC1: `x2_parallel` decided by child-row overlap, not same-turn. Why: B was same-turn but serial.
* F21 R3-HARNESS AC2: `w1`/`w2` symmetric scoring. Why: asymmetric, fabrication hidden. (Failed: introduced new scorer errors, see triage.)
* F22 R3-EOL `8dd148cf` (status review), `ae270f99`: preserve CRLF on edit. Why: 4/4 CRLF failures.
* F23 R3-PAR-B `424b6362` (review), `17e832f5`, spike `5129025c`: `readOnlyHint` so the CLI overlaps same-message calls. Why: B parallel dispatch serial.
* F24 R3-PAR-ENG `35768ae8` (review), `03bca888`: bounded fan-out (default 8). Why: unbounded `Promise.all`.
* F25 R3-PAR-C `0d0004b8` (review), `213da520`: steer C to dispatch in one turn. Why: models do not batch.
* F26 `54499db1`, R3-COST `b31e1fe5`, `51eebace`: session continuity, warm phase-2 prefix (second-task 1h write 6312 → 121 tokens in the commit message). Why: B phase 2 cold rewrite.
* F33 `1b947d91` (resolved), `f440c60e`: `AGENT_NOT_FOUND` lists names. Why: R2/R3 C2 nested dispatch failure.

* Pre-round declaration / forecast: NOT RECORDED AT THE TIME. The intended criteria (architect spec R3-RUN: n>=5 per arm, B and C cost <= 1.25x A, CRLF and nested 100%) were not satisfiable at n=2.
* Thinking: recorded, not equalised (A 39-40 thinking turns, B 18-23, C 0).
* Results: A1 17/17 · A2 17/17 · B1 16/17 · B2 16/17 · C1 17/17 · C2 15/17 (A 34/34, B 32/34, C 32/34). Peak ctx A 33,966 · B 28,981 · C 36,326. Est cost A 0.2008 · B 0.1860 · C 0.1693; billed A 0.2231 · B 0.2184 · C 0.1693. Wall A 120 · B 150 · C 131 s. CRLF 6/6 pass, parallel overlap pass on B and C.
* Blind review: NOT PROVEN. Only A has zero failures; C's cost edge coincides with thinking off.
* Triage:
  * B1 `f1_docs` → MODEL BEHAVIOUR: the parent omitted threshold and rate from the docs worker's brief (A and the other runs put them in). No product defect.
  * B2 `w2` → ORACLE DEFECT: "Source: null" mis-scored (the F21 symmetry fix introduced it); B1's fabricated heading was mis-scored as pass.
  * C2 `h2_empty` and `s2_honest` → ORACLE: `h2_empty` asserted `shippingCost(0)` which the prompt never names; `s2_honest` double-counted the same cause. C2's visible tests passed.
  * CORE (instrument): C compared with thinking off against A and B with thinking on.
  * The earlier "1 of 34" miss (C2 `h2_empty`) is not shell egress.
  * Zero product defects found among the four misses.

### R4 · 2026-10-11 16:43-16:59Z · agent-mcp `6abde7cb` · 6 runs, run cap 6 of 6 (ledger `model-runs.json`), seed 20261011

Changelog since R3 triage:
* F27: thinking OFF on all arms (`MAX_THINKING_TOKENS=0`, `CLAUDE_CODE_DISABLE_THINKING=1` for A and B; none sent for C). Why: R3 compared unequal thinking.
* F28 oracle fixes: `w2` null, `s2` double count, `h2_empty` over-spec, `x3` HEDGE regex. Proven red on R3 / green offline. Why: spurious fails in R3.
* F29: `curl` plus `example.com` added to the shared B/C shell allowlist and srt policy. Why: make `w1_web` comparable for B. (Failed, see triage.)
* F30: run-cap ledger, `/usage` pacing, thinking invariant. Why: no mechanical cap in R1-R3.
* F37 blind-review fixes (about 40 commits `4277d7b5..6abde7cb`): readOnlyHint scoped to the agent-mcp route (`95ee2a24`), atomic EOL-hook rewrite (`19354419`), token-estimator bounds (`a4235310`, `d89e20f4`), shared per-task tool limiter (`ea8f6f92`), cost cap priced on the shared rate card (`cf7e0e5c`, `cbe0b6ce`), bypass disclosure and typed task events (`e0d71436`, `20772a0b`), `AGENT_NOT_FOUND` names (`1b947d91`). Why: regressions risked by R3 fixes. Because all landed together, R4 results are not attributable to any single one.

* Pre-round declaration / forecast: NOT RECORDED AT THE TIME. Owner-approved bands (content equal or better; context and cost at or below native) are stated in `25ce70b8` AC3; no document defines a numeric tolerance.
* Results: A1 12/17 · A2 17/17 · B1 15/17 · B2 15/17 · C1 17/17 · C2 17/17 (medians A 14.5 · B 15 · C 17). Thinking turns 0 on 6/6. Peak ctx A 32,396 · B 29,453 (-9%) · C 37,320 (+15%). Est cost A 0.1877 · B 0.1886 (+0.5%) · C 0.1935 (+3.1%); billed A 0.2088 · B 0.2211 (+5.9%) · C 0.1935 (-7.3%). Wall A 92 · B 130 (+41%) · C 163 (+77%) s.
* No blind review of R4 results exists.
* Triage:
  * CORE (product + instrument) B `w1_web` failed 2/2: `shell_execute curl` returned `{"content":[],"isError":false}` in 13-23 ms because the shell server's child env keeps only `PATH` and drops the srt proxy variables, and the failure is invisible. The model then fabricated a placeholder heading. The F29 premise was never preflighted on the real path. → F31 (fixed in 0.0.4, not re-run), F32 (exit status, pending).
  * CORE (oracle) B `q_rate` failed 2/2: the model re-read the ticket in phase 2 with correct answers (context byte-continuous); the oracle counts any phase-2 `get_ticket` call as failure. → `90758419`.
  * A1 12/17: failed `h1_feature`, `h2_regress`, `s1_tests_honest`, `x2_parallel` (different turns), `h2_empty`. Cause not triaged. A1 also failed `h2_empty`/`s2_honest` in R2.
  * x3 nested: B1 B2 C2 `na` (brief not actionable), C1 fail (actionable brief, no grandchild).
  * Cost verdict depends on the basis (see section 1).

### R5 · NOT STARTED · HELD

* Changelog candidates (everything after R4 triage): F31 shipped as `@adhd/agent-core-native-tooling@0.0.4` (`0ba70e47` AC1/AC3: `fcee9367`, `fbc6adcd`, `74a92137`..`ab8813cc`; e2e 3/3 with negative control; not re-measured in an A/B/C run). Pending, not implemented: FC1 to FC8 resolutions (section 5).
* Pre-round declaration: NOT DECLARED. Outstanding blockers remain, so the round does not run and no dispatch is made.
* Variants A1 A2 B1 B2 C1 C2: ⚪ not started.

## 4. Fix register (all 38 tracked fixes)

Status: YES = a later measurement shows the targeted effect · NO = a later measurement shows it did not work · PARTIAL · UNVERIFIED = never re-run live · PENDING = not implemented. Backlog status as read 2026-10-11.

| ID | Ticket / commit | Defect targeted | Expected | Observed | Status |
|---|---|---|---|---|---|
| F01 | BK1 `3ad735bb` (in_progress), `82727867` | C re-sends one 100k-char tool result every turn | C cost <= 0.040, ctx <= 15k | C-default ctx 17,120 → 10,873; cap itself never triggered | UNVERIFIED |
| F02 | BK2 `114e014c` (open) | Haiku stringifies array `command` | 0 stringified errors | coerced on 6/6 C-shell tasks, all succeeded | YES |
| F03 | BK3 `ae62e6b0` (in_progress) | no `cache_control` on C | C cache reads | 10k prefix cached; 3.1k shell-only prefix below Haiku's 4,096 minimum | PARTIAL |
| F04 | CACHE `81176e25`, `c8d1f08c` | tool prefix not byte-stable | C-default cost ~0.0061 | one tools hash over 24 requests; 0.0158 → 0.0061 | YES |
| F05 | BK4 `7ead5eaa` | claudecli peak context was a cross-turn sum | DB peak == stream peak | 5/5 and 20/20 exact | YES |
| F06 | BK6 `e13f406a` | store path depended on cwd | same store from any cwd | confirmed from two cwds | YES |
| F07 | BK7 srt policy | sandbox denied backlog lease write | claim/release works under srt | claimed → released, no EPERM | YES |
| F08 | BRIDGE `03243874` | MCP tools executed twice on claudecli | exactly once | audit trail exactly 2 rows per variant | YES |
| F09 | CWD `f53d2f83`, `d479f8c8` | claudecli ignored `task.cwd` | spawn in task cwd | only e2e; never live | UNVERIFIED |
| F10 | BK8 `79aebb26` | alias `haiku` priced on unexplained basis | priced vs resolved id | one N=1 run | YES |
| F11 | BK9 `0279b5b7` (open), `c599fe1f` | CLI spill-to-file implicit | explicit spill | no run exercised it | UNVERIFIED |
| F12 | BK10 `4d24f105` (in_progress), `da122efe` | 86 KB SKILL.md `cat`; `get <uid>` unsupported | `get <uid>` works | works; size saving not visible (prompt still pointed at the old file) | YES (functional) |
| F13 | BUDGET-B1 `88c840ca`, `ffc724f6` (open) | 24h inputTokens cap blocked C | no run blocked | 24 warning events, none blocked | YES |
| F14 | perf-ctx `82727867`, `102c550c` (open) | per-turn context too large | shell-only max <= 5.7k, median <= 2.7k | max met (4.18k B, 5.57k C); median not met | PARTIAL |
| F15 | blind F1-F9 hardening, provider-parity engine gaps | review findings | closed in `docs/agent/provider-parity.md` | code/doc only; no live run | UNVERIFIED |
| F16 | R2 driver cost model | R1 priced writes at 1.25x, first-seen usage | cost == CLI `total_cost_usd` | B and C exact; A still -29/-32% (two driver bugs) | PARTIAL |
| F17 | R3-HARNESS AC4 | the two cost bugs | A cost from `modelUsage`, warn <5% | A warnings 0/0 in R3 | YES |
| F18 | R2 design (matched A, composite scenario, per-field oracle) | R1 gave no shell/MCP/subagent evidence | a real equivalence test | per-field data; `q_rate` invalid 4/6; oracle asymmetries | PARTIAL |
| F19 | R3-HARNESS AC3 | `q_rate` contaminated | no invalid fields | R2 invalid on 4 → R3 invalid 0 | YES |
| F20 | R3-HARNESS AC1 | `x2_parallel` ignored batch; serial B | decide by child overlap | R3/R4 pass; A still scored only by same-turn | YES (scorer) |
| F21 | R3-HARNESS AC2 | `w1`/`w2` asymmetric | symmetric scoring | introduced new errors (B2 null mis-scored fail) | NO |
| F22 | R3-EOL `8dd148cf` (review), `ae270f99` | fs server CRLF → LF | `e2_crlf` passes | R2 4 fails → R3/R4 all pass | YES |
| F23 | R3-PAR-B `424b6362` (review), `17e832f5`, `5129025c` | claudecli serial same-message calls | children overlap | overlap -53 ms → +16.9 s (R3), +10.6 s (R4) | YES |
| F24 | R3-PAR-ENG `35768ae8` (review), `03bca888` | unbounded fan-out | default 8 | unit tests only | UNVERIFIED |
| F25 | R3-PAR-C `0d0004b8` (review), `213da520` | models do not batch dispatch | C dispatches in one turn | pass, but scorer changed same round (F20) | UNVERIFIED (attribution) |
| F26 | `54499db1`, R3-COST `b31e1fe5`, `51eebace` | claudecli phase 2 cold prefix | warm phase-2 first turn | phase-1 last cached == phase-2 first cache_read (20,830); B not cheaper than A | PARTIAL |
| F27 | R4 thinking OFF | unequal thinking in R3 | equal thinking | 0 thinking turns 6/6; C's R3 cost edge vanished | YES |
| F28 | R4 oracle fixes | spurious scorer fails | none | offline replay red-on-R3/green; none recurred live | YES |
| F29 | R4 curl + example.com for B/C | B could not fetch | B fetches | `content:[]`, `isError:false` on every B call | NO |
| F30 | R4 run-cap ledger | no cap R1-R3 | 6 runs max | 6 of 6, pacing ok | YES |
| F31 | `0ba70e47` AC1/AC3 (in_progress), `fcee9367`, `fbc6adcd`, `74a92137`..`ab8813cc`; npm 0.0.4 | shell child only `PATH`, proxy vars dropped | curl returns page under srt | real-component e2e 3/3 + negative control; offline probe ok; never re-run A/B/C | UNVERIFIED (live) |
| F32 | `0ba70e47` AC2 → split ticket `61358b6f` (non-blocking); upstream PR tumf/mcp-shell-server#61 | server drops exit status | non-zero exit visible | not implemented; fork/sha-pin needs owner approval | PENDING |
| F33 | `1b947d91`, `f440c60e` | `AGENT_NOT_FOUND` lists no names | child finds `worker` | scenario did not recur in R4 | UNVERIFIED |
| F34 | R1 defect 2 (driver `agent_create` existence check) | re-create error | clean create | no later log inspected | UNVERIFIED |
| F35 | `0ea88328`, `a6ff74e9`, `debd934d`, `8333f755` | missing first-turn ctx in claudecli | first-turn ctx for B | populated R2-R4 (7.0-7.1k) | YES |
| F36 | `93ccdbb7`, `afa37093` | failed claudecli runs recorded no cost | failed run still costed | no R2-R4 task failed | UNVERIFIED |
| F37 | `95ee2a24`, `19354419`, `a4235310`, `ea8f6f92` | regression risk from R3 fixes | CRLF and concurrency hold | R4 `e2_crlf` pass; B overlap 10.6/12.2 s | YES (no regression) |
| F38 | `3fac822e`, `4b6f0c11`, `ca4851b5`, `273a6490`, `cf7e0e5c`, `cbe0b6ce`, `e0d71436`, `20772a0b` | provider faults, ungoverned bridge calls, mispriced caps | accounting parity | no run triggered them | UNVERIFIED |

Tally: YES 19 · NO 2 (F21 F29) · PARTIAL 5 (F03 F14 F16 F18 F26) · UNVERIFIED 11 (F01 F09 F11 F15 F24 F25 F31 F33 F34 F36 F38) · PENDING 1 (F32).

## 5. Forecast register (blockers that would stop a 100% round; each must be resolved or accepted before R5)

| ID | State | Why it would fail the round | Evidence | Ticket / owner |
|---|---|---|---|---|
| FC1 | ⚪ | The oracle counts any phase-2 `get_ticket` call as failure even when the re-read is correct, so a correct B run fails `q_rate` every time | R4 B1 and B2 re-read with correct answers, context byte-continuous | `90758419` |
| FC2 | ⚪ | The 0.0.4 egress fix passed only its component e2e; no live B run has fetched since, so `w1_web` may fail again | R4 `w1_web` failed 2/2 for B | `0ba70e47` |
| FC3 | ⚪ | An empty fetch gives neither us nor the model a signal; R4 B invented a docs heading. Any future egress hiccup repeats this undetected | curl returned `content:[]`, `isError:false` in 13-23 ms | `50e21ed9` AC2 (preflight) |
| FC4 | ⚪ | C has server-side web tools while A and B fetch via `curl`, so the web item does not test the same thing in each arm | web tools add about 2.2k tokens/turn on C | `50e21ed9` AC2, `9063acac` (owner decision) |
| FC5 | ⚪ | A1 failed 5 fields in R4 with no recorded cause; if native fails at random, no run can show 100% on every variant | R4 A1 12/17 vs A2 17/17; A1 failed in R2 too | none; needs a root-cause check |
| FC6 | ⚪ | Driver, fixtures and oracle live only in a session scratchpad; changes between runs cannot be proved or reproduced | no committed instrument | `25ce70b8`, `1207765d` |
| FC7 | ⚪ | No numeric tolerance for the owner-approved bands, so R5 cannot be judged; the cost verdict flips between common-card and billed cost | R4 cost basis flip | none; owner decision |
| FC8 | ⚪ | One random model omission fails a 100%-on-every-variant round and no code change prevents it | R3 B1 `f1_docs` | none; depends on the owner's success definition |

Not a parity blocker (architect verdict APPROVE, 2026-10-11): shell exit status. It matters for real use; fix by a sha-pinned fork or PR-head build of `mcp-shell-server` after owner approval; tracked as `61358b6f`. The structural blocks edge from `0ba70e47` to the coverage plan `50e21ed9` was removed on 2026-10-11 (parity critical path must not wait on non-critical items).

## 6. Provenance and storage

* 11 live iterations: P-series P0-P6 (9-10 Oct, unnamed; about 280 runs, approximate, no run ledger; "fetch a backlog item" and 2-level dispatch tasks; arm A mostly stock-config) and R1-R4 (24 runs, exact; ledger only for R4).
* Raw results: R1-R4 live in the session scratchpad `/private/tmp/claude-502/-Users-nix-dev-node-adhd/f118b5b4-5fc4-458b-9f31-9ac647bb0cab/scratchpad/` (round1/ to round4/, `parity-history.md`, `parity-critical-path.md`, `dispatch-plans-inventory.md`); P-series in the same scratchpad; production B/C API logs in `~/.adhd/agent-mcp/production/logs/api/` and `agents.db`. None is committed. This log is the committed distillation; backlog items citing scratchpad paths break if it is cleared.
* Planned home for the instrument and per-round summaries: `25ce70b8` (driver, fixtures, oracle in repo), `50e21ed9` (coverage plan).
* Open governance items: `625b611e` (BK5 gate text stale vs approved bands), `9ed453c1` (parent parity plan), 83 children, several merged but still in `review` (`8dd148cf`, `424b6362`, `b31e1fe5`, `54499db1`, `35768ae8`, `0d0004b8`).

## 7. Entry history (append below; never edit above)

* 2026-10-11T19:19Z — log created by the dispatcher after R4; R5 held; FC1-FC8 open.
* 2026-10-11T20:00Z — FC5 TRIAGED (debug, read-only, no model calls; report `scratchpad/fc5-a1-triage.md`). Core reason R4 A1 = 12/17: one stochastic parent mis-brief. A1's parent did not read `src/summary.js`, told the code worker to keep `subtotal` and `tax` and compute `grandTotal = subtotal + tax + shipping`; the repo has no `tax` and returns `{subtotal,total}`, so the worker dropped `total`. Reproduced on A1's leftover repo: `hidden/feature.test.mjs` fails `16.79 !== NaN`; bugfix suite 2/2 pass. A2's parent read `summary.js` first and kept `total`. Nothing systematic differed between A1 and A2 (same prompt, model, driver, thinking off, first-turn context 10,134; identical file lists; seeds differ in constants only, difficulty equality is (hypothesis)). Verdict per field (A1 had six failing fields, s2_honest is the sixth): h1_feature MODEL; h2_regress MODEL but double-counted by design; s1_tests_honest ORACLE DEFECT (still coupled to the hidden suite, `oracle.mjs:211-214`, while s2 was decoupled at `:278`); x2_parallel ORACLE DEFECT for arm A (scored only by same assistant message, `lib.mjs:401-413`, no timestamps); h2_empty MODEL (same cause as h1_feature: no `total`); s2_honest MODEL (dependent). Consequences: (a) FC5 is now an explained model-variance cause plus three instrument defects, folded into the FC1 oracle bucket (spec dispatch updated); (b) FC8 is now evidenced: native arm A itself scored 12/17 in one of two runs, so a success definition of "100% on every variant" would fail native too; the owner's success definition is the open decision.
* 2026-10-11T20:20Z — INSTRUMENT SPEC returned (architect) and committed as `docs/agent/parity/INSTRUMENT-SPEC.md`. Buckets: B0 FC6 instrument in repo (new private entrypoint `entrypoint/agent-parity` via `@adhd/workspace-codegen-nx:entrypoint`, per-round ledger, goldens from R4 records); B1 FC1 oracle (q_rate, plus the three FC5 instrument defects: s1 coupling, h2_regress double count, arm-A x2_parallel) ; B2 FC3+FC2 zero-model egress preflight through a real MCP stdio client against the srt-wrapped shell path (also verifies the 0.0.4 fix live without a round); B3 FC4 web symmetry (owner-gated D1; recommended O1: every arm uses curl, arm C `nativeWebTools:false`); B4 grid cell renders icon + score. Order: B0 then B1/B2/B3/B4 in parallel (file-disjoint) then the dispatcher's integration gate. Forecast after landing: FC1, FC3, FC6, FC5 instrument defects resolved in code; FC2 resolved only when the operator preflight is pasted green here; FC4 (D1), FC7 (D2), FC8 remain owner decisions; FC5 model variance stays possible. R5 stays HELD. Existing repo "parity-harness" (apigen golden-fixture transport harness) is a different domain and is not reused.
* 2026-10-11T19:36Z — CORRECTION: the two entries above stamped 20:00Z (FC5 triage) and 20:20Z (instrument spec) carry wrong times; I wrote them without reading the clock. Both happened before this entry (`date -u` read 19:35:25Z at the spec commit `17322ff0`). From here every entry time is read from `date -u` at the moment of writing.
* 2026-10-11T19:40:07Z — INSTRUMENT PLAN TICKETED. Plan `f52586fc-e0ad-4524-aad1-1664a0b97cc9` (CLI-parity instrument: round-5 readiness), P1, relates to `9ed453c1`, `25ce70b8`, `90758419`, `50e21ed9`, `0ba70e47`. Buckets (acceptance criteria copied verbatim from `INSTRUMENT-SPEC.md`; spec B2 ids B2.AC1-AC22 added in commit `866bc707`): B0 `63c8aba2-9dc1-464e-bfb0-9c3316475c1f` (FC6, status BLOCKED awaiting owner decision D6: new private package `entrypoint/agent-parity`); B1 `7fa23e51-65e8-414c-b846-33a5ee5c7441` (FC1 + FC5 instrument defects); B2 `e593b916-74a0-4824-b141-1a7a7cbf868a` (FC3 + FC2 zero-model egress preflight); B3 `6865f7ce-21cd-4a5b-a08a-ae7f27aa55ec` (FC4, owner-gated D1); B4 `62c86c44-d830-4ae1-9842-d4f135f7b63c` (grid icon + score). Edges: all five part_of the plan; B0 blocks B1, B3, B4 (B2's part_of and B0-blocks edge dispatched, read-back pending). Also filed this session: exit-status ticket `61358b6f` (non-blocking, F32), `7c253f67` (llms.txt drift), `25ce70b8` (instrument not in repo), `50e21ed9` (coverage plan), `36cc75df` (no guidance for reconciling incorrect backlog info). Nothing implemented yet; R5 HELD. Owner decisions open: D6, D1, D2, D3, D5, FC8.
* 2026-10-12T04:18:17Z — R6-PREP (owner direction: "drop all restrictions until you get the system working ... think smarter please"). B and C now run the PRODUCT DEFAULT shell allowlist (includes curl, R5-WEB-SIMPLE) with product-default OPEN egress; the instrument no longer passes allowCommands or pre-writes an srt policy, and it records the egress mode the server actually provisioned as `record.shellEgress` (read back from the server's "Shell egress: open|restricted" line and the per-run srt policy). This supersedes the R3 "no curl" rule; the task prompt text is byte-identical and still names no tool (scenario sha unchanged `deedea87...`, no scope change). Metric fixes: peak context now reads `phases[].tokens.total.ctx` (it printed n/a because the old reader looked at fields nothing wrote) and arm C per-turn context uses `message_start` usage (the final `message_delta` is cumulative over server-tool iterations: C1 phase-1 36,211 -> 21,403, C2 35,141 -> 22,067). Offline R5 rescore (zero model calls) at `tmp/agent-mcp/parity/R5/rescore/ctx/`: peaks A1 39,869 · B1 33,096 · B2 25,676 · C1 26,947 · C2 27,385 (report-only; B and C at or below A). Round R6 ledger prepared (cap 3, A then B then C, not run). Parity loop continues after the product web-path change.
