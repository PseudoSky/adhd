<!-- markdownlint-disable MD013 -->
# Step 7 — Final review checklist — agent-policy

```text
[x] Definition of Done agreed in Step 1a — README has `## Definition of Done` with IDed [dod.1..5] (outcome, evidence, structural/behavioral split)
[x] Every [dod.N] is proven by a final-audit check (gap-check.js Check 8 passes)
[x] Every BEHAVIORAL [dod.N] (dod.1/2/3) declares entrypoint:/observable: and is proven by a check that DRIVES the vitest --testFile entrypoint; structural dod.4/5 stay grep
[x] Seam: enforcement is proven through the REAL HookRegistry (@adhd/agent-mcp-types), not a mock — dod.2 drives hooks.enforce("pre:model_request") and asserts the propagating throw
[x] Seam: inheritance proven by adding a NEW agent to the category AFTER the category attach, then asserting inherited_from after reopen — proves "future agents inherit", not a snapshot
[x] Final audit emits a [dod.N] PASS line per clause; --confirm-dod stamped dod_provenance
[x] Final audit written first — audit_policy.py authored before context bodies; every DoD has a named check
[x] All magic named — EnforcementEvent pre:model_request-only constraint named in README non-goals + decisions.md forcing function (policy-design.3); enforcement-is-array invariant named
[x] Shorthand/mechanism separated — N/A: greenfield package, no ergonomic shorthand to preserve
[x] External caller analysis — N/A: greenfield package (plan_kind greenfield); no existing symbols deleted/renamed. tsconfig.base.json is additively edited; @adhd/agent-mcp-types is consumed read-only (its EnforcementEvent type is NOT modified by this plan)
[x] Every node changing a symbol declares it in dag.json changes — N/A: greenfield, no resigns/deletes
[x] Every deferral has a forcing function — EnforcementEvent extension deferral forced by policy-design.3 grep + the seeded-hook-policy trigger recorded in decisions.md/README; override-merge forced by policy-design

Structure:
[x] Identity is a stable slug — no positional numbers
[x] dag.json holds structure; state.json holds runtime only
[x] Slug set in dag.json.nodes == slug set in state.json.states; every context path exists (gap-check Check 1 passes)
[x] Shared definitions centralized in contexts/_shared.md — defs/invs/refs referenced, not restated

Per-state completeness:
[x] Every work state has goal, semantic distillation/delta spec, reservations, criteria, commit points, notes
[x] Every guard is red→green and env-pinned (env-pin-check --strict: all PINNED)
[x] Every criterion is a command/grep/exists/negative-control, never prose
[x] Reservations (read_only/mutates) declared; shared mutable files (schema.ts, index.ts, tsconfig.base.json) noted as append-only across states
[x] Audit states carry no deferrable items

Cross-plan:
[x] Depends on agent-registry-schema (agents + taxonomy_categories rows agent_policy attaches to); documented in README "Cross-plan dependencies"
[x] Reuses the agent-mcp plugin contract (createPlugin / IHookRegistry) — does NOT reinvent it (REFERENCES.md "Reuse, Not Replace")

Reviewer: requesting engineer accepts via audit-final; architect-reviewer reviews decisions.md at policy-design (Execution model).
```
