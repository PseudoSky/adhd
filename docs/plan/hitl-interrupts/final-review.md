# Final Review — hitl-interrupts

## DoD Checklist

- [x] **dod.1** `request_human_input` built-in tool available to agents; calling it suspends the task
- [x] **dod.2** Suspended tasks have status `"awaiting_input"` in DB
- [x] **dod.3** `resumeToken` persisted in DB (survives process restart at the token level)
- [x] **dod.4** `task_resume` MCP tool accepts `(taskId, resumeToken, userInput)` and resumes the orchestrator
- [x] **dod.5** Orchestrator intercepts `request_human_input` BEFORE MCP dispatch
- [x] **dod.6** Agent receives `userInput` as tool result and continues normally
- [x] **dod.7** `"awaiting_input"` in `taskStatusSchema` and `tasksTable` enum
- [x] **dod.8** `agent-mcp` published at version `0.3.0`

## Plan Completeness

- [x] README.md with DoD clauses
- [x] dag.json (8 nodes: hitl-schema, hitl-types, hitl-orchestrator, hitl-resume-tool, audit-foundation, code-review, audit-final, docs-and-publish)
- [x] state.json (current_state: hitl-schema, all pending)
- [x] references.json
- [x] state-machine.md
- [x] contexts/_shared.md
- [x] contexts/hitl-schema.md
- [x] contexts/hitl-types.md
- [x] contexts/hitl-orchestrator.md
- [x] contexts/hitl-resume-tool.md
- [x] contexts/audit-foundation.md
- [x] contexts/code-review.md
- [x] contexts/audit-final.md
- [x] contexts/docs-and-publish.md
- [x] scripts/audit_hitl.py
- [x] scripts/gap-check.js

## Architecture Decisions

- **Promise resolver pattern (not polling):** orchestrator `await`s an in-memory Promise. Zero
  CPU during suspension. Process restart loses the resolver — documented footgun with recovery
  path noted.
- **`resolveHitl()` exported from orchestrator:** avoids circular imports; `tools/task.ts`
  imports from engine, not the other way.
- **`resumeToken` cleared on resume:** prevents old tokens from being replayed after task
  completes and is re-queued.
- **`awaiting_input` is NOT terminal for DAG purposes:** `DagEngine.dispatchReady()` must
  explicitly skip it (documented in `[inv:awaiting-input-not-terminal]`).
