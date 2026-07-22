# Shared Definitions — hitl-interrupts

## [def:AwaitingInputStatus]

`"awaiting_input"` is a new task status meaning "orchestrator is suspended, waiting for
`task_resume` to be called". An `awaiting_input` task is neither queued nor completed. It
holds an in-memory `Promise` resolver keyed by `taskId`.

Terminal statuses for DAG purposes: `completed`, `failed`, `cancelled`.
`awaiting_input` is NOT terminal — `DagEngine.dispatchReady()` must skip it.

## [def:ResumeToken]

A UUID generated when a task is suspended. Stored in the DB `resume_token` column and returned
to the caller of `request_human_input`. The `task_resume` MCP tool must present a matching token
to resume the task — this prevents accidental or malicious resumption.

## [def:HitlSuspension]

When the orchestrator intercepts a `request_human_input` tool call:
1. Generate `resumeToken` (UUID).
2. Write task status to `"awaiting_input"` + `resume_token` in DB.
3. Return the tool result to the model as: `{ resumeToken, message: "Waiting for human input" }`.
4. Store a `Promise` resolver in a `Map<taskId, Resolver>` (in-memory, module-scoped).
5. Pause the orchestrator loop by `await`ing the promise.
6. When `task_resume` resolves the promise with `userInput`, the orchestrator loop continues
   with `userInput` injected as the tool result.

## [def:HitlResumption]

`task_resume` MCP tool input: `{ taskId: string, resumeToken: string, userInput: string }`.
Steps:
1. Validate `taskId` exists and `status === "awaiting_input"`.
2. Validate `resumeToken` matches DB `resume_token`.
3. Look up the in-memory resolver for `taskId`. If not found: process restarted — return error
   `"TASK_NOT_RESUMABLE"`.
4. Update task status to `"running"`.
5. Resolve the promise with `userInput`.

## [shape:ResumeTokenDb]

```typescript
// In tasksTable (new column):
resumeToken: text("resume_token"),   // UUID or null; set on suspension, cleared on resume
```

## [ref:task-status-enum]

`tasksTable.status` enum in `db/schema.ts` and `taskStatusSchema` z.enum in `validation/task.ts`
must always list the same values. Add `"awaiting_input"` to both in `hitl-schema` and
`hitl-types` respectively.

## [ref:tool-error-throw]

Use `throw new ToolError("VALIDATION_ERROR", message)` for invalid `resumeToken` or mismatched
task state in `task_resume`.

## [ref:orchestrator-tool-loop]

The tool intercept point is within the orchestrator's tool-dispatch loop. In 0.2.0 this is the
parallel dispatch (from plan parallel-tool-execution). Check tool name BEFORE dispatching.
`request_human_input` must never reach the MCP client.

## [inv:request-human-input-intercept]

`request_human_input` is intercepted in the orchestrator BEFORE any MCP client dispatch. It is
a built-in tool, not a server-registered tool. The name `"request_human_input"` is a string
constant — define it as `HITL_TOOL_NAME = "request_human_input"` in orchestrator.ts.

## [inv:resume-token-db-persisted]

`resume_token` is written to the DB synchronously before the orchestrator `await`s the Promise.
This ensures the token survives process restart (even if the in-memory resolver does not).

## [inv:awaiting-input-not-terminal]

`DagEngine.dispatchReady()` must skip `awaiting_input` tasks — they are not terminal and must
not trigger downstream dispatch. Add `awaiting_input` to the "not terminal" set in dag-engine.ts.

## [inv:single-hitl-per-task]

A task cannot call `request_human_input` twice concurrently (the orchestrator is suspended and
awaiting the Promise — it cannot reach a second HITL call until resumed). No special handling
needed for concurrent HITL calls.
