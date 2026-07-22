# Step 7 — Final review checklist: task-schema-foundation

- [x] Definition of Done agreed in Step 1a — README has `## Definition of Done` with IDed [dod.N] clauses
- [x] Every [dod.N] is proven by a final-audit check (audit_schema_foundation.py --phase final covers dod.1–dod.6)
- [x] Final audit written first — every design principle has a named check
- [x] All magic named — `[inv:single-migration]` captures the one-migration rule; `[inv:types-before-validation]` captures the update-order constraint
- [x] Shorthand/mechanism separated — N/A (no ergonomic shorthands introduced)
- [x] External caller analysis done — no external callers; this plan only adds columns and enum values, no symbol renames or deletions
- [x] Every node changing a symbol declares it in dag.json `changes` (schema-columns: resigns tasksTable; task-types: resigns taskStatusSchema, taskSchema, taskToolInputSchema, TaskStore.create, TaskStore.updateStatus)
- [x] Every deferral has a forcing function — N/A (no deferrals)

Structure:
- [x] Identity is a stable slug — no positional state numbers
- [x] dag.json holds structure; state.json holds runtime only
- [x] Slug set in dag.json.nodes == slug set in state.json.states; every context path exists
- [x] Shared definitions centralized in contexts/_shared.md

Per-state completeness (schema-columns):
- [x] Acceptance criteria section present — 5 criteria covering all new columns + migration
- [x] Criterion IDs are slug-keyed ([schema-columns.1] through [schema-columns.5])
- [x] reservations.mutates populated: schema.ts + drizzle/
- [x] dag.json node artifacts matches reservations.mutates
- [x] Commit points present
- [x] No parallel states → no shared-file merge protocols needed

Per-state completeness (task-types):
- [x] Acceptance criteria section present — 6 criteria covering status enum, field shapes, store update, types export, build
- [x] Criterion IDs are slug-keyed ([task-types.1] through [task-types.6])
- [x] reservations.mutates populated: agent-mcp-types/src/index.ts + validation/task.ts + store/task-store.ts
- [x] dag.json node artifacts matches reservations.mutates
- [x] Commit points present

Guards and audits:
- [x] Guards are red→green — each guard currently fails (depends_on/resume_token columns do not exist; 'waiting'/'awaiting_input' not in schema.ts or validation/task.ts)
- [x] All criteria are deterministic commands
- [x] Final audit has negative check: none needed (pure additions, no deletions)
- [x] Final audit has live data check — build pass check (`npx nx build agent-mcp`) serves as live artifact check
- [x] notes field answers "what do I need to know" (migration ordering, types-first update order)
- [x] dag.json dependency graph matches state-machine.md topology diagram exactly

Hand off:
- [x] Dispatch-or-orchestrate decision made — sequential linear chain, no parallel dispatch needed within this plan
