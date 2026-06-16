# Code-Tasking Study — Test Log

Chronological. Each test = one way a [scenario](scenarios/) was posed to the local
`qwen2.5-14b-instruct` worker, graded by that scenario's rubric. Requests are in
`tests/test-<n>/mcp.jsonl`.

**Grades:** `PASS` (root cause right + fix would work) · `NEAR` (correct shape, reviewable bug) · `PARTIAL` (key insight present, impl flawed) · `FAIL`.

**Agent reuse:** `code-fixer` created in Test 1 (reused 2–5, deleted in 5); re-created in Test 6 (reused 7–8, deleted in 8). `ts-pro` created Test 9 (reused 10–11, deleted 11). `synth-coder`/`architect`/`coder`/`lead` span Tests 12–14, cleaned up at the end.

---

## Experiment 1 — baseline offload with *hinted* prompts (role = generic senior engineer)
> Overarching hypothesis: a 14B can produce these fixes if the prompt scopes the problem and supplies the diagnosis/approach.

### Test 1 — SSE, well-scoped · scenario: `sse-eaddrinuse`
- **Hypothesis:** full code + desired outcome (survive, log, injectable port) → moderate bug is in range.
- **Result: PARTIAL.** Found the load-bearing fix (`.on('error')`) ✓ R2; but root cause wrong ("UnhandledPromiseRejection") ✗R1, wrapped in a `Promise` that changes the return type and breaks the sync caller ✗R4, used `process.argv[2]` for the port ✗R6.
- **Gap:** the key idea was present; mechanism mis-stated and implementation over-engineered/contract-breaking.
- Requests: `tests/test-1/mcp.jsonl`

### Test 2 — FK, underspecified · scenario: `fk-cascade-migration`
- **Hypothesis:** minimal context (no PRAGMA/transaction facts) — can it diagnose from the symptom?
- **Result: FAIL.** Reached "FK cascade" insight, but fix was MySQL/Postgres dialect (`ALTER TABLE … DROP FOREIGN KEY`, `ON DELETE RESTRICT`) — invalid in SQLite ✗R4 and weakens the cascade ✗R5.
- **Gap:** plausible diagnosis → confidently invalid, behavior-changing fix.
- Requests: `tests/test-2/mcp.jsonl`

### Test 3 — FK, context-rich · scenario: `fk-cascade-migration`
- **Hypothesis:** add the migrator-transaction + PRAGMA-present facts → can it land the fix?
- **Result: FAIL.** Diagnosis closer ("FK stays ON in the txn"), but fix adds `BEGIN/COMMIT` *inside the SQL* ✗R2 — still a no-op (migrator owns the txn). Never reached the connection-level remedy.
- **Gap:** right cause direction, wrong fix *layer*.
- Requests: `tests/test-3/mcp.jsonl`

### Test 4 — audit, hinted · scenario: `audit-ref-policy-comment`
- **Hypothesis:** small self-contained bug + an explicit pointer ("there is ALSO a comment on line 306").
- **Result: PASS.** Correct cause + working comment-skipping fix; near-parity with the shipped fix (only missed `*`/`/*` block-comment lines).
- **Gap:** none material — but note the pointer did the diagnostic work (see Test 8).
- Requests: `tests/test-4/mcp.jsonl`

### Test 5 — FK, layer-scoped + API handed over · scenario: `fk-cascade-migration`
- **Hypothesis:** spell out the fix layer ("in `runMigrations()`, toggle on the connection") + give the `pragma()` API — does it apply correctly?
- **Result: NEAR.** Correct approach (`pragma OFF → migrate → restore` on the connection) ✓R1/R2 (by instruction); but the "restore" used the **read** form `pragma("foreign_keys",{simple:true})` (a no-op write) → FK never re-enabled ✗R6.
- **Gap:** the *only* path to a correct-shaped fix was pre-solving the hard part; even then a subtle slip.
- Requests: `tests/test-5/mcp.jsonl`

---

## Experiment 2 — full real context, **no diagnosis, no how**
> Hypothesis: give everything a competent engineer would have (real code + symptom + constraints) but withhold the diagnosis/fix — does it reason it out?

### Test 6 — FK · scenario: `fk-cascade-migration`
- **Result: FAIL.** Root cause **inverted** ("the `PRAGMA OFF` causes the deletion"); never sees it's *ignored* in the txn; fix is irrelevant (adds an unrelated `sessions` FK). Worse than the hinted Tests 3/5.
- **Gap:** without the diagnosis it confabulates and inverts the PRAGMA's role.
- Requests: `tests/test-6/mcp.jsonl`

### Test 7 — SSE · scenario: `sse-eaddrinuse`
- **Result: FAIL.** "`server.listen` throws" ✗R1 → wraps `listen()` in a `try/catch` that **cannot catch the async event** ✗R2/R3 (still crashes); still returns `null` ✗R4; no real port param ✗R6. Regressed vs Test 1.
- **Gap:** same async-vs-sync misconception; non-functional fix.
- Requests: `tests/test-7/mcp.jsonl`

### Test 8 — audit · scenario: `audit-ref-policy-comment`
- **Hypothesis:** the *same* small bug as Test 4 but neutral (comment present in the code, not pointed at).
- **Result: FAIL — flipped from Test 4.** Missed the comment entirely, invented a "multi-line statements" theory, switched to a `re.finditer` that **still matches the comment** ✗R1/R2/R3.
- **Gap:** the single pointer sentence in Test 4 was carrying the win, not the model's reasoning.
- Requests: `tests/test-8/mcp.jsonl`

---

## Experiment 3 — `typescript-pro` role + reasoning/knowledge levers
> Hypothesis: a strong role + debugging discipline (+ knowledge) unlocks correct diagnosis without handing over the fix.

### Test 9 — FK, role only · scenario: `fk-cascade-migration`
- **Result: FAIL.** Improved *process*: enumerated candidates, raised "transaction scope", self-rated **Medium**. But fix still = `BEGIN/COMMIT` in the SQL ✗R2.
- **Gap:** better reasoning + calibration, same wrong destination — discipline can't supply a missing fact.
- Requests: `tests/test-9/mcp.jsonl`

### Test 10 — FK, role + neutral knowledge injection · scenario: `fk-cascade-migration`
- **Hypothesis (decisive):** the exact facts supplied *among distractors* — knowledge-bottleneck or reasoning-bottleneck?
- **Result: FAIL — but diagnostic.** It **correctly selected** the relevant facts (migrator-uses-transaction ✓, PRAGMA-overridden-in-txn ✓), then **failed to synthesize** them and **hallucinated an API** (`new Migrator(db)`, `migrate.up({transaction:false})`) ✗R3. Never reached the connection-level fix.
- **Gap:** the wall is *synthesis*, not retrieval. It can pick the facts; it can't compose them into the cross-layer move, and papers the gap with fabrication.
- Requests: `tests/test-10/mcp.jsonl`

### Test 11 — SSE, role contains the fact · scenario: `sse-eaddrinuse`
- **Hypothesis:** the role prompt literally states "an unhandled `'error'` event ≠ a thrown exception" — does the embedded fact change behavior?
- **Result: FAIL.** **Ignored the fact**, used `try/catch` anyway ✗R2/R3; emitted **uncompilable** code (function nested in itself) ✗R5; passed a `string` where a `number` was expected; rated it **High** confidence (miscalibrated).
- **Gap:** a fact in the system prompt doesn't override the model's default pattern (`handle error → try/catch`); confidence is an unreliable routing signal.
- Requests: `tests/test-11/mcp.jsonl`

---

## Experiment 4 — structured "out" + multi-step structures
> Hypothesis: an anti-fabrication "declare the missing dependency" rule + sequencing/critique/orchestration get past the synthesis wall.

### Test 12 — multi-turn (synthesize → code) · scenario: `fk-cascade-migration`
- **Setup:** `synth-coder` (ts-pro role + **anti-fabrication NEEDS rule**), session; turn 1 diagnose-only, turn 2 code.
- **Result: FAIL (with a partial anti-fab win).** Turn 1 inverted the cause again + vague NEEDS. Turn 2: the rule **capped the connection hallucination** (it wrote "we cannot access the raw `sqlite`") but **relocated** the fabrication to invalid SQL (`ALTER TABLE … ADD FOREIGN KEY … DEFERRABLE`) ✗R4; **High** confidence.
- **Gap:** the "out" only surfaces a need the model can *conceive*; it can't name the dependency that presupposes the (unreached) fix, so fabrication leaks elsewhere.
- Requests: `tests/test-12/mcp.jsonl`

### Test 13 — synthesis → architect revision → code · scenario: `fk-cascade-migration`
- **Setup:** `architect` (adversarial reviewer) given the bug + Test-12's wrong diagnosis.
- **Result: FAIL (closest diagnosis yet).** The architect **correctly rejected** the wrong cause and got nearest the mechanism ("how SQLite handles transactions and pragmas inside a transaction scope") — then **inverted the fix** ("ensure `foreign_keys=ON`") and garbled the spec (`import {drizzle} from "better-sqlite3"`). Coder phase moot (inverted spec).
- **Gap:** 14B-reviewing-14B refines *direction* but can't *source* the missing fact, and can invert it.
- Requests: `tests/test-13/mcp.jsonl`

### Test 14 — SP-driven orchestrator dispatch · scenario: `fk-cascade-migration`
- **Setup:** `lead` (orchestrator SP, `mcpServers:{agent-mcp}`, `allowedAgents:[synth-coder,coder]`) → dispatches `synth-coder` (diagnose) then `coder` (implement).
- **Result: FAIL on the fix; SUCCESS on coordination.** Subtree = 3 tasks / 6 model calls: the 14B `lead` **correctly dispatched** synth→coder, passed context, and composed the result. But the fix was wrong (knowledge gap), with fabricated imports, rated **High**.
- **Gap:** the offload *topology works*; no topology rescues a missing fact. Swap the synthesizer for a capable model and the local pipeline would deliver application.
- Requests: `tests/test-14/mcp.jsonl`

---

## Experiment 5 — the "floor": simple, additive scenarios
> Hypothesis: the model reliably handles single-locus additive changes (establishes a competence floor + a control for the hard set). Worker: `code-impl` (a neutral "make this small change" role), created in Test 15, deleted after Test 18.

### Test 15 — add an optional list filter · scenario: `tasklist-ephemeral-filter`
- **Result: PASS.** Optional param added; used `!== undefined` (correctly keeps the `false`/`0` case) + a consistent `eq`. Chose `z.number().int()` (caller passes 0/1) instead of the shipped `z.boolean()` + `? 1 : 0` — a different public API but internally consistent and correct.
- Requests: `tests/test-15/mcp.jsonl`

### Test 16 — add an optional parameter · scenario: `sse-port-param`
- **Result: PASS.** Optional `port`/`host` defaulted via `?? SSE_PORT`, used in `listen()`, existing callers unaffected — equivalent to the shipped fix. Only missed the bonus (reporting the *actual* bound port for the ephemeral `0` case).
- Requests: `tests/test-16/mcp.jsonl`

### Test 17 — extend an enum in two places · scenario: `task-status-enum-extend`
- **Result: PASS (perfect).** Both the Drizzle and Zod enums updated consistently; existing values preserved; even flagged "check no other part references an outdated list."
- Requests: `tests/test-17/mcp.jsonl`

### Test 18 — export + a TS4023 gotcha · scenario: `export-sqlite-type-annotation`
- **Result: FAIL.** Renamed the export to `sqliteInstance` believing TS4023 was a "naming conflict" — but that is **still TS4023** (the build still fails); it never added the type annotation. The one embedded knowledge-detail tripped it: it pattern-matched "name" in the error and "fixed" the wrong thing — the discriminators' failure shape, in miniature.
- Requests: `tests/test-18/mcp.jsonl`

---

## Experiment 6 — capable-model differential (Anthropic, *same exact prompts*)
> The control for the study's central claim. Re-run the failing prompts on a capable model (`claude-sonnet-4-6`) with the **identical system prompt + identical user prompt** — only the provider swapped. If the capable model passes, the failure is **model-bound** (capability), not **prompt-bound** (task design). Workers: `fixer-anthropic` (SP = the `code-fixer` role) and `impl-anthropic` (SP = the `code-impl` role); both deleted after. The `<test>A` runs reuse the user prompt from the cited original test. (FK framings deduped — the near-identical variants would all pass on a capable model; ran the minimal and the full-context framings.)

| re-run | original (14B) | Anthropic, same prompt | requests |
|---|---|---|---|
| **2A** — FK underspecified | FAIL (invalid MySQL syntax) | **PASS** — FK-cascade-on-rebuild cause; *unprompted*, surfaced the migrator-transaction PRAGMA subtlety as a contingency. (Weak spot: caveat #4 suggests `RESTRICT` "going forward" — would weaken the cascade — but the minimal prompt never stated the keep-cascade constraint.) | `tests/test-2/mcp.anthropic.jsonl` |
| **6A** — FK full-context | FAIL (inverted cause) | **PASS** — exact "`PRAGMA` no-op inside the migrator transaction" cause; connection-level `fkWasOn` + `try/finally` toggle (restore via the **write** form); offered both `db.session.client` and export-`sqlite`; cited SQLite §2.2. **Cleaner than the human-shipped fix.** | `tests/test-6/mcp.anthropic.jsonl` (incl. the shared `fixer-anthropic` create) |
| **7A** — SSE full-context | FAIL (`try/catch` on async event) | **PASS** — async `'error'` event cause; `server.on("error")`; optional port; updated the caller guard. (Minor: declared `\| null` though it never returns null.) | `tests/test-7/mcp.anthropic.jsonl` |
| **8A** — audit neutral | FAIL (missed the comment) | **PASS** — comment-on-306 cause; `is_code_line` skip on both matches; flagged the same `/* */` block-comment limitation the shipped fix has. | `tests/test-8/mcp.anthropic.jsonl` |
| **18A** — TS4023 | FAIL (renamed the var) | **PASS** — explicit type annotation (`type Database as DatabaseType`); NOTE explains the exact `.d.ts`-nameability rule. | `tests/test-18/mcp.anthropic.jsonl` (incl. `impl-anthropic` create + both cleanups) |

**Differential: 5/5 PASS on the exact prompts the 14B failed** — including the underspecified FK and the TS4023 gotcha, in two cases more cleanly than the human-shipped fix. **The failures are model-bound, not prompt-bound:** the same context that left the 14B confabulating was sufficient for a capable model to diagnose and fix correctly. This is the direct evidence for the recipe — put the cognition on a capable model; the local model's job is application + orchestration behind a verification gate.

---

## Experiment 7 — Anthropic across the *full remaining set* (automated)
> Experiment 6 ran 5 hand-built prompts; Experiment 7 closes the column by running **every other test** (1, 3–5, 9–17) on `claude-sonnet-4-6` through the new automated harness (`runner/run-study.mjs` + `runner/plan.json`), identical system + user prompts, provider swapped. Responses in `results/runs.anthropic-sonnet46.jsonl`; usage in `results/usage.json`.

**Result: 12/12 PASS on the coding tasks** (T1, T3, T4, T5, T9, T10, T11, T12, T13, T15, T16, T17). Highlights: T13 the adversarial `architect` correctly *rejected* the planted wrong diagnosis and produced the grounded spec (the 14B inverted the fix); T10 selected the right facts among distractors **and** synthesized the connection-level fix (the 14B selected then hallucinated `new Migrator`); T11 used `server.once("error", …)` and rejected two distractor mechanisms. **T14 (orchestration) errored** — the `lead` called a bare `agent` tool and tripped the orchestrator's `missing server prefix` rule (a tool-naming artifact, not a coding failure; see Experiment 8 — qwen3.5 errored identically). Combined with Experiment 6, **Anthropic is 17/17 on the gradeable coding tasks.**

## Experiment 8 — second local model: a 9B "claude-4.6 high-IQ" distill (full battery)
> Does a small model *distilled toward Claude-4.6* close the gap the 14B couldn't? Ran all 18 tests on `qwen3.5-9b-claude-4.6-highiq-instruct-heretic-uncensored-mlx-mxfp8` (LM Studio) through the same harness. Responses in `results/runs.qwen35-9b-hiq.jsonl`.

**Result: 7 PASS / 10 FAIL / 1 ERROR.** It passes exactly the categories the 14B already passed — `ADDITIVE` floor (T15–17), and `APPLY` cases where the answer is handed over (T5), selectable from a fact list (T10), or scaffolded by a multi-turn NEEDS step (T12). **Every `DIAGNOSE` test failed** with the same confabulation shape as the 14B (T1 "something calls `process.exit()`", T3 misreads the table-rebuild rename, T8 "both on line 410", T13 "something else deletes them"); the TS4023 gotcha (T18) failed too. Net of the 14B it *gained* T5/T10/T12 (better application + calibration — e.g. T12 correctly surfaced `(db as any).session.client` via NEEDS instead of fabricating) and *regressed* on T1 — a smaller model that follows instructions better but **does not diagnose any better**. T14 errored on the same tool-prefix trip as sonnet.

**The full three-model table + by-requirement pass-rates: [`results/comparison.md`](results/comparison.md)** (machine-readable verdicts in `results/grades.manual.json`).

---

## Cross-test synthesis

- **The failures are the *model*, not the task** (Experiments 6–7). Re-running every failing/remaining prompt on `claude-sonnet-4-6` — identical system + user prompts — gave **17/17 correct** fixes on the gradeable coding tasks (including the underspecified FK and the TS4023 gotcha; several cleaner than the shipped fix). So "design the task better" has a ceiling set by the model: the reliable lever is **routing the diagnosis to a capable model**, not more scaffolding on the small one.
- **Distilling "high-IQ Claude" into a 9B does not transfer the diagnosis capability** (Experiment 8). `qwen3.5-9b-claude-4.6-highiq` passed **0/9 `DIAGNOSE` tests cold** (1/9 if you count the multi-turn-scaffolded T12) — the same wall as the 14B. The distill bought better *application* of given facts and better calibration (it gained T5/T10/T12 over the 14B), but every cold cross-layer synthesis still confabulated. Cross-layer diagnosis is a property of the frontier model, not a style you can distill into 9B. `results/comparison.md`.
- **The floor is real — pure additive/mechanical work is reliable** (Tests 15–17: 3/3 clean). But it's bounded by knowledge, not size: Test 18, a *one-line* change carrying a specialized detail (TS4023 needs a type annotation), failed the **same way** as the hard scenarios — misread the error, pattern-matched a keyword, shipped a plausible non-fix. So the safe leaf is "additive change with **no embedded knowledge gotcha**"; any gotcha must be supplied.
- **Correctness ladder:** the reliable wins were Tests 15–17 (additive), Test 4 (small bug + pointer), Test 5 (fix pre-specified). Every test that required the model to *diagnose a subtle cause*, *compose a cross-layer fix*, or *apply a specialized fact it didn't have* failed — regardless of role, scaffold, injected facts, or orchestration.
- **The wall is synthesis + grounding, not retrieval** (Test 10): it selects the right facts but can't compose them, and fabricates to cover the gap.
- **Levers help the wrong things:** role/discipline → better process + (sometimes) calibration; structured-out → caps *some* fabrication; orchestration → reliable dispatch. None supply the missing knowledge.
- **Confidence is not a safe signal:** broken fixes were rated High (Tests 11, 12, 14).
- **Actionable recipe:** see `README.md` → "Recipe that actually works" (cognition at the root, application at the leaves, verification on every edge).
