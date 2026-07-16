<!-- markdownlint-disable MD013 -->
# Step 7 — Final review checklist — agent-registry-schema

```text
[x] Definition of Done agreed in Step 1a — README has `## Definition of Done` with IDed [dod.1..5] (outcome, evidence, structural/behavioral split)
[x] Every [dod.N] is proven by a final-audit check (gap-check.js Check 8 passes)
[x] Every BEHAVIORAL [dod.N] (dod.1/2/3) declares entrypoint:/observable: and is proven by a check that DRIVES the vitest --testFile entrypoint; structural dod.4/5 stay grep
[x] Seam: composition order/pin/context are all asserted by ONE test (composition-store.test.ts) through resolveComposition, not three isolated greps
[x] Final audit emits a [dod.N] PASS line per clause; --confirm-dod stamped dod_provenance
[x] Final audit written first — audit_registry_schema.py authored before context bodies; every DoD has a named check
[x] All magic named — N/A: greenfield package, no special cases/parallel caches
[x] Shorthand/mechanism separated — N/A: greenfield, no ergonomic shorthand to preserve
[x] External caller analysis — N/A: greenfield package (plan_kind greenfield); no existing symbols deleted/renamed. tsconfig.base.json is additively edited.
[x] Every node changing a symbol declares it in dag.json changes — N/A: greenfield, no resigns/deletes
[x] Every deferral has a forcing function — open design questions are forced by design-and-architecture's guard + decisions.md criteria

Structure:
[x] Identity is a stable slug — no positional numbers
[x] dag.json holds structure; state.json holds runtime only
[x] Slug set in dag.json.nodes == slug set in state.json.states; every context path exists (gap-check Check 1 passes)
[x] Shared definitions centralized in contexts/_shared.md — defs/invs/refs referenced, not restated

Per-state completeness:
[x] Every work state has goal, semantic distillation/delta spec, reservations, criteria, commit points, notes
[x] Every guard is red→green and env-pinned (env-pin-check --strict: all 10 PINNED)
[x] Every criterion is a command/grep/exists, never prose
[x] Reservations (read_only/mutates) declared; shared mutable files (schema.ts, index.ts, tsconfig.base.json) noted as append-only across states
[x] Audit states carry no deferrable items

Reviewer: requesting engineer accepts via audit-final; architect-reviewer reviews decisions.md at design-and-architecture (Execution model).
```
