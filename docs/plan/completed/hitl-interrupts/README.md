# Plan: hitl-interrupts (0.3.0)

**Feature:** #20 Human-in-the-Loop (HITL) Interrupts
**Target version:** `agent-mcp@0.3.0`
**Issues:** #20 HITL interrupts

---

## Definition of Done

- `[dod.1]` A `request_human_input` built-in tool is available to agents; calling it suspends the task and returns a `resumeToken`.
- `[dod.2]` Suspended tasks have status `"awaiting_input"` in the DB.
- `[dod.3]` The `resumeToken` is persisted in the DB and survives process restart.
- `[dod.4]` A `task_resume` MCP tool accepts `(taskId, resumeToken, userInput)` and resumes the suspended orchestrator.
- `[dod.5]` The orchestrator intercepts `request_human_input` tool calls before executing them — it does NOT delegate to the MCP client.
- `[dod.6]` Once resumed, the agent receives `userInput` as the `request_human_input` tool result and continues normally.
- `[dod.7]` `awaiting_input` is added to the `taskStatusSchema` and `tasksTable` enum.
- `[dod.8]` `agent-mcp` published at version `0.3.0`.

---

## Execution model

- **Implementer:** `sox-active:typescript-pro`
- **Reviewer:** `code-reviewer` subagent + human sentinel (`.code-review-complete`)
- **Automatic dispatch:** No

---

## Design invariants

- `request_human_input` is a built-in tool name constant — the orchestrator checks for it by name
  before dispatching tool calls to the MCP client.
- The `resumeToken` is a UUID generated at suspension time, stored in the task row.
- Resumption uses a `Promise` resolver pattern: the orchestrator stores a resolver in memory,
  keyed by `taskId`. The `task_resume` MCP tool resolves that promise. If the process restarts,
  the in-memory resolver is gone — the task must be re-driven by re-queuing it (see Notes in
  hitl-orchestrator.md).
- `awaiting_input` tasks are NOT re-dispatched by `DagEngine.dispatchReady()`.
