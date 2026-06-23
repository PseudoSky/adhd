<!-- markdownlint-disable MD013 -->
# Step 7 — Final review checklist — agent-tool-registry

```text
[x] Definition of Done agreed in Step 1a — README has `## Definition of Done` with IDed [dod.1..5] (outcome, evidence, structural/behavioral split)
[x] Every [dod.N] is proven by a final-audit check (gap-check.js Check 8 passes)
[x] Every BEHAVIORAL [dod.N] (dod.1/2/3) declares entrypoint:/observable: and is proven by a check that DRIVES the vitest --testFile entrypoint; structural dod.4/5 stay grep
[x] Seam: the package's reason for existing (canonical→platform alias resolution) is asserted through the REAL BindingStore.resolve against a reopened DB (dod.1), not a proxy grep
[x] Each behavioral [dod.N] names a negative-control whose text references the entrypoint's distinctive --testFile token
[x] Final audit emits a [dod.N] PASS line per clause; --confirm-dod stamped dod_provenance
[x] Final audit written first — audit_tool_registry.py authored before context bodies; every DoD has a named check
[x] All magic named — N/A: greenfield package, no special cases/parallel caches
[x] Shorthand/mechanism separated — N/A: greenfield, no ergonomic shorthand to preserve
[x] External caller analysis — N/A: greenfield package (plan_kind greenfield); no existing symbols deleted/renamed. tsconfig.base.json is additively edited.
[x] Every node changing a symbol declares it in dag.json changes — N/A: greenfield, no resigns/deletes
[x] Every deferral has a forcing function — N/A: no deferrals; cross-package agent_slug resolution is explicitly compile-time (agent-compiler), not deferred here

Structure:
[x] Identity is a stable slug — no positional numbers
[x] dag.json holds structure; state.json holds runtime only
[x] Slug set in dag.json.nodes == slug set in state.json.states; every context path exists (gap-check Check 1 passes)
[x] Shared definitions centralized in contexts/_shared.md — defs/invs/refs referenced, not restated

Per-state completeness:
[x] Every work state has goal, semantic distillation/delta spec, reservations, criteria, commit points, notes
[x] Every guard is red→green and env-pinned (env-pin-check --strict: all 8 PINNED)
[x] Every criterion is a command/grep/exists, never prose
[x] Reservations (read_only/mutates) declared; shared mutable files (schema.ts, index.ts, tsconfig.base.json) noted as append-only across states
[x] Audit states carry no deferrable items

Cross-plan:
[x] README + state-machine.md record the dependency on agent-registry-schema (plan 1) and the shared-DB / no-cross-package-FK topology decision
[x] agent_tools.agent_slug is a logical key resolved at compile time, never a SQLite FK ([inv:no-cross-pkg-fk])
[x] tool_types proven a text-PK lookup table (not a SQL enum) via grep_present + grep_absent in the audit

Reviewer: requesting compiler engineer accepts via audit-final; audit-schema is the mid-plan hold point.
```
