# hitl-resume-tool

**Phase:** engine · **Depends on:** hitl-orchestrator · **Guard:**
```bash
grep -q 'task_resume' packages/ai/agent-mcp/src/tools/task.ts && \
grep -q 'resumeToken' packages/ai/agent-mcp/src/tools/task.ts && \
npx nx test agent-mcp 2>&1 | grep -qE 'passed'
```

---

## Goal

Add a `task_resume` MCP tool to `tools/task.ts`. This tool is how external callers (humans, other
agents) provide the `userInput` that resumes a suspended task.

---

## Semantic Distillation

- **Primitive:** MODIFY `packages/ai/agent-mcp/src/tools/task.ts`.

- **Delta Spec:**

  Register a new MCP tool `task_resume` with:
  ```typescript
  // Input schema
  {
      taskId: z.string().uuid().describe("ID of the awaiting_input task to resume"),
      resumeToken: z.string().uuid().describe("Token returned when the task was suspended"),
      userInput: z.string().describe("The human's response to inject as tool result"),
  }

  // Handler
  async (input) => {
      const task = await taskStore.read(input.taskId);
      if (!task) throw new ToolError("NOT_FOUND", `Task ${input.taskId} not found`);
      if (task.status !== "awaiting_input") {
          throw new ToolError("VALIDATION_ERROR",
              `Task ${input.taskId} is not awaiting input (status: ${task.status})`);
      }
      if (task.resumeToken !== input.resumeToken) {
          throw new ToolError("VALIDATION_ERROR", "Invalid resumeToken");
      }
      const resolved = resolveHitl(input.taskId, input.userInput);
      if (!resolved) {
          // Process restarted — in-memory resolver is gone. Auto-fail the task so it
          // doesn't remain stranded in awaiting_input with no escape path.
          await taskStore.updateStatus(input.taskId, "failed", {
              error: "Task could not be resumed: server restarted while task was suspended. Create a new task.",
          });
          throw new ToolError("TASK_NOT_RESUMABLE",
              `Task ${input.taskId} has no active suspension (process restarted; task has been failed)`);
      }
      return { success: true, taskId: input.taskId };
  }
  ```

  Import `resolveHitl` from `engine/orchestrator.ts`.

  **Additionally, update `taskCancel` in `tools/task.ts`:**
  Add `"awaiting_input"` to `cancellableStatuses`:
  ```typescript
  const cancellableStatuses = ["pending", "running", "awaiting_input"];
  ```
  When cancelling an `awaiting_input` task, the AbortSignal fires which rejects the in-memory
  promise (see `hitl-orchestrator.md` — the promise is wired to `signal.addEventListener("abort",
  ...)`). The orchestrator then transitions the task to `failed` via its normal catch path.
  No additional `resolveHitl` call is needed from `taskCancel` — the signal handles it.

  **Wire `task_resume` in `server.ts`:**
  Register `task_resume` in the `ListToolsRequestSchema` handler (alongside `task`, `task_list`,
  `task_cancel`, `result`) and add a matching case to the `CallToolRequestSchema` switch.

- **Invariants:** See `[def:HitlResumption]` in `_shared.md`.

---

## Acceptance criteria

- [ ] **[hitl-resume-tool.1]** `task_resume` tool registered in `tools/task.ts`.
      `grep -q 'task_resume' packages/ai/agent-mcp/src/tools/task.ts`
- [ ] **[hitl-resume-tool.2]** `resumeToken` validated in tool handler.
      `grep -q 'resumeToken' packages/ai/agent-mcp/src/tools/task.ts`
- [ ] **[hitl-resume-tool.3]** `resolveHitl` imported from orchestrator.
      `grep -q 'resolveHitl' packages/ai/agent-mcp/src/tools/task.ts`
- [ ] **[hitl-resume-tool.4]** `TASK_NOT_RESUMABLE` error code for process-restart case.
      `grep -q 'TASK_NOT_RESUMABLE' packages/ai/agent-mcp/src/tools/task.ts`
- [ ] **[hitl-resume-tool.5]** Tests pass.
      `npx nx test agent-mcp 2>&1 | grep -qE 'passed'`

---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src/engine/orchestrator.ts",
             "packages/ai/agent-mcp/src/store/task-store.ts",
             "packages/ai/agent-mcp/src/validation/errors.ts"]
mutates:    ["packages/ai/agent-mcp/src/tools/task.ts",
             "packages/ai/agent-mcp/src/__tests__/hitl-resume.test.ts",
             "packages/ai/agent-mcp/src/server.ts"]
```

---

## Contract Promise

- **Modified:** `tools/task.ts` — adds `task_resume` MCP tool
- **Added:** `__tests__/hitl-resume.test.ts` — tests for resume validation

---

## Commit points

- [ ] **After task_resume tool + tests pass** (mandatory):
      `feat(agent-mcp): hitl-resume-tool — task_resume MCP tool with token validation`

---

## Notes

- The `TASK_NOT_RESUMABLE` error code must be added to `errorCodeSchema` in
  `validation/errors.ts` — check if it's already there.
- Test the process-restart case: mock `resolveHitl` to return `false` and verify
  `TASK_NOT_RESUMABLE` is thrown.
- Test the invalid token case: call with correct `taskId` but wrong `resumeToken`.
- Test the wrong status case: call `task_resume` on a `"running"` task.
