<!-- markdownlint-disable MD013 -->
# Step 7 — Final review checklist — agent-mcp-refactor

```text
[x] Definition of Done agreed in Step 1a — README has `## Definition of Done` with IDed [dod.1..6]; behavioral/structural split explicit; dod_provenance stamped (--confirm-dod, 2026-06-23)
[x] Every [dod.N] is proven by a final-audit check (gap-check.js Check 8 passes)
[x] Every BEHAVIORAL [dod.N] (dod.1/2/3) declares entrypoint:/observable:/negative-control: and is proven by a check that DRIVES the vitest --testFile entrypoint; structural dod.4/5/6 stay grep
[x] Seam: dod.1+dod.2 are proven through the REAL session-start path (real SessionStore + prompt-resolver + ComposedPromptStore + agent tool, real on-disk DB), LLM provider mocked only — not three isolated greps
[x] Final audit emits a [dod.N] PASS line per clause; --confirm-dod stamped dod_provenance
[x] Final audit written first — audit_mcp_refactor.py authored before context bodies; every DoD has a named check
[x] All magic named — composed_prompt cache (agent_slug+context_hash key), compat-shim, thin-cache, claudecli reconciliation are all named in _shared.md / decisions.md
[x] Shorthand/mechanism separated — the systemPrompt compat shim is a computed mechanism populated from compiler output, distinct from the (gone) authoring path; documented in decisions.md Decision 3
[x] External caller analysis (BROWNFIELD) — full AgentStore/systemPrompt caller map in _shared.md; every caller assigned to a state's mutates/read_only; gap-check --discover exits 0
[x] Every node changing a symbol declares it in dag.json `changes` — compiler-integration/agent-store-retire/policy-engine-bridge each carry resigns/adds; gap-check --discover finds no undeclared change
[x] Every deferral has a forcing function — the four open design questions are forced by refactor-design's guard + decisions.md grep criteria [refactor-design.2..5]; the compiler baseline is forced by [compiler-integration.4..5]

Structure:
[x] Identity is a stable slug — no positional numbers
[x] dag.json holds structure; state.json holds runtime only
[x] Slug set in dag.json.nodes == slug set in state.json.states; every context path exists (gap-check Check 1 passes)
[x] Shared definitions centralized in contexts/_shared.md — defs/invs/refs/caller-map referenced, not restated

Per-state completeness:
[x] Every work state has goal, semantic distillation/delta spec, reservations, criteria, commit points, notes
[x] Every guard is red→green and env-pinned (env-pin-check --strict: all 8 PINNED)
[x] Every criterion is a command/grep/exists/negative-control, never prose
[x] Reservations (read_only/mutates) declared; shared mutable files (schema.ts, index.ts, validation/agent.ts) noted as append-only across states in _shared.md
[x] Audit states carry no deferrable items
[x] Teeth: session-e2e ships a negative-control (perturb compileAgent in prompt-resolver → e2e red); deterministic (count invocations + reopen DB, no sleep); exit-code gated ([inv:exit-code-gate])

Cross-plan:
[x] Depends on plan 5 (agent-compiler / compileAgent) — recorded in dag.json depends_on_plans + decisions.md + [inv:compiler-is-baseline]; treated as assumed_baseline

Reviewer: requesting engineer accepts via audit-final; architect-reviewer reviews decisions.md at refactor-design (Execution model).

Residual gap-check warnings (advisory, legacy-plan class — non-blocking):
- dod.1 observable-assertion: the audit check drives the vitest entrypoint whose own expect() asserts the deep-equal; gap-check's literal-token heuristic is satisfied via the testfile token. (Substantively the assertion lives in the test, per the verification standard.)
  NOTE: re-run after authoring shows this resolved; the remaining warnings are the GitNexus-stale/LSP-fallback NOTE and gap-review reminder, which are environmental, not plan defects.
```
