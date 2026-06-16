# Three-model differential — code-tasking study

Same harness, same `plan.json`, same system+user prompts. Only the model varies.
Verdicts are **hand-graded with teeth** against `scenarios/<slug>.md` (the auto-grader in
`runner/grade.py` is a conservative first pass; these override it). `PARTIAL`/`NEAR` = correct
shape with a real bug; `ERROR` = orchestration plumbing failure, not a coding verdict.

| # | requires | posing | qwen2.5-14b | qwen3.5-9b (claude-distill) | sonnet-4.6 |
|---|---|---|---|---|---|
| 1 | DIAGNOSE | SSE well-scoped | PARTIAL | FAIL | PASS |
| 2 | DIAGNOSE | FK underspecified | FAIL | FAIL | PASS |
| 3 | DIAGNOSE | FK context-rich | FAIL | FAIL | PASS |
| 4 | APPLY | audit + pointer hint | PASS | PASS | PASS |
| 5 | APPLY | FK fix+API handed over | NEAR | PASS | PASS |
| 6 | DIAGNOSE | FK full-context | FAIL | FAIL | PASS |
| 7 | DIAGNOSE | SSE full-context | FAIL | FAIL | PASS |
| 8 | DIAGNOSE | audit neutral | FAIL | FAIL | PASS |
| 9 | DIAGNOSE | FK role-primed | FAIL | FAIL | PASS |
| 10 | APPLY | FK facts-in-prompt (select) | FAIL | PASS | PASS |
| 11 | APPLY | SSE fact-in-role | FAIL | FAIL | PASS |
| 12 | DIAGNOSE | FK multi-turn synth→code | FAIL | PASS | PASS |
| 13 | DIAGNOSE | FK adversarial architect | FAIL | FAIL | PASS |
| 14 | ORCH | FK orchestrate lead→synth→coder | FAIL | ERROR | ERROR |
| 15 | ADDITIVE | floor: list filter | PASS | PASS | PASS |
| 16 | ADDITIVE | floor: optional port param | PASS | PASS | PASS |
| 17 | ADDITIVE | floor: extend enum | PASS | PASS | PASS |
| 18 | GOTCHA | floor+TS4023 gotcha | FAIL | FAIL | PASS |

**Tally** (18 tests): qwen2.5-14b **4 PASS** / 1 NEAR / 13 FAIL · qwen3.5-9b **7 PASS** / 10 FAIL / 1 ERROR · sonnet-4.6 **17 PASS** / 1 ERROR.

### Pass-rate by what the test *requires*
| requires | qwen2.5-14b | qwen3.5-9b | sonnet-4.6 |
|---|---|---|---|
| ADDITIVE | 3/3 | 3/3 | 3/3 |
| APPLY | 1/4 | 3/4 | 4/4 |
| GOTCHA | 0/1 | 0/1 | 1/1 |
| DIAGNOSE | 0/9 | 1/9 | 9/9 |
| ORCH | 0/1 | 0/1 | 0/1 |

### What it shows

- **The wall is unchanged by the 9B "claude-4.6 high-IQ" distill.** qwen3.5-9b clears exactly the
  categories the 14B already cleared — `ADDITIVE` floor work, and `APPLY` cases where the fix is
  handed over (T5), selectable from a fact list (T10), or scaffolded by a multi-turn NEEDS step
  (T12). Every `DIAGNOSE` test — cold cross-layer synthesis from the code — **failed**, the same
  confabulation shape as the 14B (T1 'something calls process.exit()', T3 misreads the rename, T8
  'both on line 410', T13 'something else deletes them').
- **The distill bought application + calibration, not synthesis.** Net of the 14B, qwen3.5-9b
  *gained* T5 (clean apply vs the 14B's restore-form bug), T10 (synthesized the selected facts vs
  the 14B's hallucinated API), and T12 (correct `session.client` NEEDS vs the 14B's relocated
  fabrication) — and *regressed* on T1 (the 14B at least kept the `.on('error')` handler). It is a
  *smaller* model (9B vs 14B) that follows instructions and applies given facts better, but does
  not diagnose any better.
- **Only the frontier model clears `DIAGNOSE`.** sonnet-4.6 passed all 9 diagnosis tests (and 17/17
  gradeable), several more cleanly than the human-shipped fix. The capability that matters here —
  subtle multi-file diagnosis — did not distill into 9B; it is a property of the frontier model.
- **T14 (orchestration) errored identically for both sonnet-4.6 and qwen3.5-9b** (the lead called a
  bare `agent` tool, tripping the orchestrator's `missing server prefix` rule) while the original
  14B lead followed the convention. Orchestration reliability here is about following the harness's
  tool-naming convention, *not* capability — excluded from the capability tally.

_Usage/latency per run: `results/usage.json` (all tasks) + `results/runs.<label>.jsonl`._
