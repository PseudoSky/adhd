# Multi-model differential — code-tasking study

Same harness (`runner/`), same `plan.json`, same system+user prompts — **including the
specialized SP variants** (`code-fixer` T1–8, the staff-level `ts-pro` persona T9–11, the
anti-fabrication `synth-coder` T12, the adversarial `architect` T13, the `lead` orchestrator
T14, `code-impl` T15–18). Only the model varies. Verdicts are **hand-graded with teeth**
against `scenarios/<slug>.md`; the auto-grader (`runner/grade.py`) is a conservative first
pass and is **overridden** here (it false-passes 'right fix / wrong cause' cases). 
`NEAR`/`PARTIAL` = correct or working fix with a wrong/muddled stated cause; `ERROR` =
orchestration plumbing failure, not a coding verdict. Columns in ascending capability.

| # | requires | SP | posing | gemma-4-e4b | qwen2.5-14b | qwen3.5-9b | qwen3-coder-30b | haiku-4.5 | sonnet-4.6 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | DIAGNOSE | `code-fixer` | SSE well-scoped | FAIL | PARTIAL | FAIL | NEAR | PASS | PASS |
| 2 | DIAGNOSE | `code-fixer` | FK underspecified | FAIL | FAIL | FAIL | FAIL | FAIL | PASS |
| 3 | DIAGNOSE | `code-fixer` | FK context-rich | FAIL | FAIL | FAIL | FAIL | PASS | PASS |
| 4 | APPLY | `code-fixer` | audit + pointer hint | PASS | PASS | PASS | PASS | PASS | PASS |
| 5 | APPLY | `code-fixer` | FK fix+API handed over | NEAR | NEAR | PASS | PASS | PASS | PASS |
| 6 | DIAGNOSE | `code-fixer` | FK full-context | FAIL | FAIL | FAIL | FAIL | NEAR | PASS |
| 7 | DIAGNOSE | `code-fixer` | SSE full-context | FAIL | FAIL | FAIL | NEAR | PASS | PASS |
| 8 | DIAGNOSE | `code-fixer` | audit neutral | FAIL | FAIL | FAIL | PASS | PASS | PASS |
| 9 | DIAGNOSE | `ts-pro` | FK role-primed (ts-pro) | FAIL | FAIL | FAIL | FAIL | NEAR | PASS |
| 10 | APPLY | `ts-pro` | FK facts-in-prompt (select) | FAIL | FAIL | PASS | PASS | PASS | PASS |
| 11 | APPLY | `ts-pro` | SSE fact-in-role | NEAR | FAIL | FAIL | PASS | PASS | PASS |
| 12 | DIAGNOSE | `synth-coder` | FK multi-turn synth→code | FAIL | FAIL | PASS | FAIL | NEAR | PASS |
| 13 | DIAGNOSE | `architect` | FK adversarial architect | FAIL | FAIL | FAIL | NEAR | FAIL | PASS |
| 14 | ORCH | `lead` | FK orchestrate lead→synth→coder | ERROR | FAIL | ERROR | FAIL | FAIL | ERROR |
| 15 | ADDITIVE | `code-impl` | floor: list filter | PASS | PASS | PASS | PASS | PASS | PASS |
| 16 | ADDITIVE | `code-impl` | floor: optional port param | PASS | PASS | PASS | PASS | PASS | PASS |
| 17 | ADDITIVE | `code-impl` | floor: extend enum | PASS | PASS | PASS | PASS | PASS | PASS |
| 18 | GOTCHA | `code-impl` | floor+TS4023 gotcha | FAIL | FAIL | FAIL | FAIL | PASS | PASS |

**Tally** (18 tests):
- gemma-4-e4b: **4 PASS** / 2 NEAR / 11 FAIL / 1 ERROR
- qwen2.5-14b: **4 PASS** / 2 NEAR / 12 FAIL
- qwen3.5-9b: **7 PASS** / 10 FAIL / 1 ERROR
- qwen3-coder-30b: **8 PASS** / 3 NEAR / 7 FAIL
- haiku-4.5: **12 PASS** / 3 NEAR / 3 FAIL
- sonnet-4.6: **17 PASS** / 1 ERROR

### Pass-rate by what the test *requires* (strict PASS only)
| requires | gemma-4-e4b | qwen2.5-14b | qwen3.5-9b | qwen3-coder-30b | haiku-4.5 | sonnet-4.6 |
|---|---|---|---|---|---|---|
| ADDITIVE | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| APPLY | 1/4 | 1/4 | 3/4 | 4/4 | 4/4 | 4/4 |
| GOTCHA | 0/1 | 0/1 | 0/1 | 0/1 | 1/1 | 1/1 |
| DIAGNOSE | 0/9 | 0/9 | 1/9 | 1/9 | 4/9 | 9/9 |
| ORCH | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 |

### What it shows

- **A capability ladder, and the rung that matters is `DIAGNOSE`.** Floor (`ADDITIVE`) is 3/3
  for every model. `APPLY` (fix handed over / selectable / scaffolded) climbs with capability.
  But cold cross-layer **diagnosis** separates them sharply: gemma-4-e4b 0/9 · qwen2.5-14b 0/9 · qwen3.5-9b 1/9 · qwen3-coder-30b 1/9 · haiku-4.5 4/9 · sonnet-4.6 9/9.
- **Size alone is not the axis.** gemma-4-e4b (4B) ties qwen2.5-14b — both hold the floor and
  fail every cold diagnosis. The 4B even matches the 14B on a couple of APPLY tests (it added
  the SSE handler its role supplied; the 14B ignored it). Diagnosis tracks capability tier, not
  parameter count.
- **The 9B "Claude-4.6 high-IQ distill" did not inherit diagnosis.** qwen3.5-9b matches the 14B
  wall — it only clears tests where the answer is supplied or scaffolded; every from-scratch
  diagnosis confabulates. Distillation bought application + calibration, not synthesis.
- **Haiku-4.5 is the dangerous middle: right fix, wrong reason.** It often lands a *working*
  connection-level FK fix (`db._.client` pragma toggle) while stating a *wrong* mechanism
  ('deferred FK checks until commit', 'migrator opens a separate connection') — T6/T9/T12. A
  test gate catches the bad ones; self-reported confidence does not. The `ts-pro` SP did not
  repair the reasoning (T9 still confabulated).
- **Only sonnet-4.6 gets cause *and* fix right every time** — 17/17 on the gradeable tasks,
  several cleaner than the human-shipped fix.

### Orchestration (T14) failed five different ways — none about coding ability
| model | T14 outcome |
|---|---|
| gemma-4-e4b | lead PROVIDER_ERROR — orchestration failed (4B lead could not drive the delegation) |
| qwen2.5-14b | coordinated (synth→coder) but fix wrong + fabricated imports |
| qwen3.5-9b | lead made one delegation then returned an EMPTY result (0 chars, status completed) — degenerate, no fix |
| qwen3-coder-30b | orchestrated correctly (synth→coder, composed) but the fix was wrong/vague |
| haiku-4.5 | orchestrated CORRECTLY (dispatched synth→coder, composed — no prefix trip) but the fix was wrong ('separate connection') |
| sonnet-4.6 | lead called bare `agent` (no server prefix) → orchestrator rejected → task failed; orphaned a sub-agent session (BUG-002 repro) |

So the bare-tool-name trip (BACKLOG **DEBT-004**) is **model-specific, not universal**: only
sonnet hit it; haiku + 14b orchestrated fine, qwen3.5 went empty, gemma errored in the loop.
The orphaned-session leak (BACKLOG **BUG-002**) was the sonnet run. Orchestration reliability
here is about following tool conventions + composing a result — orthogonal to diagnosis.

_Per-run responses: `results/runs.<label>.jsonl`. Usage/latency: `results/usage.json`._

---

## Results by delegation structure

Same FK-cascade bug, only the topology varies — isolating what structure buys.

| structure | topology | test | gemma-4-e4b | qwen2.5-14b | qwen3.5-9b | qwen3-coder-30b | haiku-4.5 | sonnet-4.6 |
|---|---|---|---|---|---|---|---|---|
| direct single-shot | 1 agent · 1 turn · depth 0 | T2 | FAIL | FAIL | FAIL | FAIL | FAIL | PASS |
| direct single-shot | 1 agent · 1 turn · depth 0 | T3 | FAIL | FAIL | FAIL | FAIL | PASS | PASS |
| direct single-shot | 1 agent · 1 turn · depth 0 | T6 | FAIL | FAIL | FAIL | FAIL | NEAR | PASS |
| direct + fix handed over | 1 agent · 1 turn · depth 0 | T5 | NEAR | NEAR | PASS | PASS | PASS | PASS |
| direct + heavy role (ts-pro) | 1 agent · 1 turn · depth 0 | T9 | FAIL | FAIL | FAIL | FAIL | NEAR | PASS |
| direct + facts in prompt | 1 agent · 1 turn · depth 0 | T10 | FAIL | FAIL | PASS | PASS | PASS | PASS |
| stateful multi-turn (diagnose→code) | 1 agent · 2 turns · depth 0 | T12 | FAIL | FAIL | PASS | FAIL | NEAR | PASS |
| pipeline review stage (architect) | 1 agent · 1 turn · depth 0 | T13 | FAIL | FAIL | FAIL | NEAR | FAIL | PASS |
| recursive orchestration (lead→synth→coder) | 3 agents · depth 1 | T14 | ERROR | FAIL | ERROR | FAIL | FAIL | ERROR |

- **Information/step-scaffolding moves small models; agent fan-out does not.** The structures
  that flipped a small model toward PASS *added information* (T5 handed, T10 facts) or *staged
  the reasoning* (T12). Adding agents/review stages without information (T13, T14) did not.
- **The richest topology (T14) was the least reliable across the board** — every model failed it,
  for four different reasons (table above), none about diagnosis ability. Keep delegation graphs
  shallow; reserve fan-out for genuinely parallel work, not to manufacture a missing diagnosis.
- **The frontier model needs the least structure**: sonnet solved the bug direct/single-shot/depth-0
  (T2/T3/T6); the most elaborate structure was the only thing that broke it (on plumbing).
