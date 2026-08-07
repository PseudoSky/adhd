# Final Review — task-dependency-dag

## DoD Checklist

- [x] **dod.1** `depends_on` field accepted in task creation tool input
- [x] **dod.2** Tasks with `depends_on` start in `"waiting"` status, never enqueued immediately
- [x] **dod.3** `DagEngine.dispatchReady()` called on every terminal status transition
- [x] **dod.4** `on_upstream_failure: "fail"` (default) — downstream marked `failed` immediately
- [x] **dod.5** `on_upstream_failure: "skip"` — downstream dispatched even if upstream failed
- [x] **dod.6** `inputs` field (taskId→result map) populated from upstream results at dispatch time
- [x] **dod.7** `validateNoCycle()` runs before task creation, throws `ToolError` on cycle
- [x] **dod.8** Drizzle migration generated for new columns (`depends_on`, `on_upstream_failure`, `inputs`)
- [x] **dod.9** `agent-mcp` published at version `0.2.0`

## Planner Amendment (2026-06-13)

dag-schema and dag-types nodes were extracted to the new `task-schema-foundation` plan (v0.1.5).
Schema columns, status enum, and type surface (TaskStatus, taskStatusSchema, TaskStore signatures)
are now a prerequisite plan. dag-engine is the first node of this plan; it assumes foundation is
deployed. This enables parallel-tool-execution and task-dependency-dag to ship concurrently after
the foundation lands.

## Plan Completeness

- [x] README.md with DoD clauses
- [x] dag.json (5 nodes: dag-engine, audit-foundation, code-review, audit-final, docs-and-publish)
- [x] state.json (current_state: dag-engine, all pending)
- [x] references.json
- [x] state-machine.md
- [x] contexts/_shared.md
- [x] contexts/dag-engine.md
- [x] contexts/audit-foundation.md
- [x] contexts/code-review.md
- [x] contexts/audit-final.md
- [x] contexts/docs-and-publish.md
- [x] scripts/audit_dag.py
- [x] scripts/gap-check.js

## Architecture Decisions

- **BFS cycle detection** at creation time (synchronous, O(N)): no DB index needed at agent-mcp scale.
- **DagEngine is constructor-injected**: avoids circular import between `tools/task.ts` and `engine/dag-engine.ts`.
- **`waiting` → `pending` + enqueue is atomic** within `dispatchReady()`: no window for double-dispatch.
- **`on_upstream_failure: "skip"` only omits failed upstreams from `inputs`**: downstream still runs.
- **Drizzle uses nullable text columns** for JSON-serialised arrays — SQLite doesn't enforce array types.
