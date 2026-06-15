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

## Cross-test synthesis

- **Correctness ladder:** only Test 4 (small bug + pointer) and Test 5 (fix pre-specified) produced usable output. Every test that required the model to *diagnose a subtle cause* or *compose a cross-layer fix* failed — regardless of role, scaffold, injected facts, or orchestration.
- **The wall is synthesis + grounding, not retrieval** (Test 10): it selects the right facts but can't compose them, and fabricates to cover the gap.
- **Levers help the wrong things:** role/discipline → better process + (sometimes) calibration; structured-out → caps *some* fabrication; orchestration → reliable dispatch. None supply the missing knowledge.
- **Confidence is not a safe signal:** broken fixes were rated High (Tests 11, 12, 14).
- **Actionable recipe:** see `README.md` → "Recipe that actually works" (cognition at the root, application at the leaves, verification on every edge).
