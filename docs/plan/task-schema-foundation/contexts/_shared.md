# Shared Definitions — task-schema-foundation

## Invariants

- `[inv:single-migration]` — All four new columns (`depends_on`, `on_upstream_failure`, `inputs`, `resume_token`) and both new status values (`"waiting"`, `"awaiting_input"`) land in a **single migration file** (0004_*). Never split into two migrations — the downstream plans assume both statuses and all columns exist together.
- `[inv:types-before-validation]` — `packages/ai/agent-mcp-types` is updated and rebuilt BEFORE `validation/task.ts` is touched. The validator re-exports `TaskStatus` from the types package; assigning `"waiting"` or `"awaiting_input"` to `TaskStatus` produces a TypeScript error until the types package is current.
- `[inv:task-store-accepts-all-fields]` — After this plan completes, `TaskStore.create()` can accept any combination of the new fields. Downstream plans (0.2.0, 0.3.0) add feature logic without needing to modify `task-store.ts`.

## Definitions

- `[def:NewColumns]` — The four new `tasksTable` columns added by this plan:
  ```typescript
  depends_on:          text("depends_on"),           // nullable JSON array of task IDs
  on_upstream_failure: text("on_upstream_failure"),  // nullable: 'fail'|'skip'
  inputs:              text("inputs"),               // nullable JSON blob (upstream results map)
  resume_token:        text("resume_token"),         // nullable UUID — HITL resume key
  ```

- `[def:NewStatuses]` — The two new status values added to the `status` enum:
  ```typescript
  "waiting"        // blocked on depends_on; DagEngine dispatches when all deps complete
  "awaiting_input" // suspended in HITL Promise; task_resume resolves it
  ```

- `[def:UpdatedTaskStore]` — After this plan, `TaskStore` interface gains:
  - `create(opts)`: accepts `dependsOn?: string[]`, `onUpstreamFailure?: 'fail'|'skip'`, `inputs?: Record<string,string>`; sets `status = 'waiting'` when `dependsOn.length > 0`
  - `updateStatus(id, status, opts?)`: accepts `resumeToken?: string` in opts
  - `read(id)` and `list()`: return all new fields (dependsOn parsed from JSON, resumeToken, inputs parsed from JSON)
