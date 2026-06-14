# hitl-orchestrator

**Phase:** engine · **Depends on:** hitl-types · **Guard:**
```bash
grep -q 'request_human_input' packages/ai/agent-mcp/src/engine/orchestrator.ts && \
grep -q 'awaiting_input' packages/ai/agent-mcp/src/engine/orchestrator.ts && \
npx nx test agent-mcp 2>&1 | grep -qE 'passed'
```

---

## Goal

Modify the orchestrator to intercept `request_human_input` tool calls before they reach any MCP
client. On intercept: suspend the task (status `"awaiting_input"`, write `resumeToken`), return
a placeholder result to the model, and `await` an in-memory Promise until `task_resume` resolves
it with `userInput`.

---

## Semantic Distillation

- **Primitive:** MODIFY `packages/ai/agent-mcp/src/engine/orchestrator.ts`.

- **Delta Spec:**

  Add a module-scoped resolver map:
  ```typescript
  const HITL_TOOL_NAME = "request_human_input";

  // Module-scoped map: taskId → resolver function
  const hitlResolvers = new Map<string, (userInput: string) => void>();

  export function resolveHitl(taskId: string, userInput: string): boolean {
      const resolve = hitlResolvers.get(taskId);
      if (!resolve) return false;
      hitlResolvers.delete(taskId);
      resolve(userInput);
      return true;
  }
  ```

  In the tool-dispatch loop, before dispatching each tool call:
  ```typescript
  if (toolCall.name === HITL_TOOL_NAME) {
      // 1. Generate resumeToken
      const resumeToken = crypto.randomUUID();

      // 2. Persist suspension — DB write BEFORE await (crash safety)
      await taskStore.updateStatus(taskId, "awaiting_input", { resumeToken });

      // 3. Register resolver and await userInput.
      //    Wire into the AbortSignal so task_cancel unblocks this promise —
      //    without this, cancelling an awaiting_input task leaves the promise
      //    pending forever and the orchestrator's async context leaks.
      const userInput = await new Promise<string>((resolve, reject) => {
          hitlResolvers.set(taskId, resolve);
          signal.addEventListener("abort", () => {
              hitlResolvers.delete(taskId);
              reject(new ToolError("PROVIDER_ERROR", "Task cancelled while awaiting human input"));
          }, { once: true });
      });

      // 4. Mark running again
      await taskStore.updateStatus(taskId, "running");

      // 5. Return userInput as the tool result (injected back into messages)
      return { toolCallId: toolCall.id, content: userInput };
  }
  ```

  **Ephemeral task prohibition:** If `taskId` identifies an ephemeral capture task (detectable
  by the absence of a DB row or by a flag in the execution context), throw `ToolError("VALIDATION_ERROR",
  "request_human_input is not supported for ephemeral tasks")` before registering any resolver.
  Ephemeral tasks have no durable DB row, so `resume_token` cannot be persisted and `task_resume`
  cannot validate it.

  The model receives `userInput` as the result of `request_human_input` and continues its
  reasoning loop normally.

- **Invariants:**
  - `[inv:request-human-input-intercept]` — never reaches MCP client.
  - `[inv:resume-token-db-persisted]` — written to DB before `await`.
  - `[inv:single-hitl-per-task]` — loop is suspended; second call impossible.

- **Validation:** grep for `request_human_input` + `awaiting_input` in orchestrator.ts; tests pass.

---

## Acceptance criteria

- [ ] **[hitl-orchestrator.1]** `HITL_TOOL_NAME` / `"request_human_input"` constant in orchestrator.ts.
      `grep -q 'request_human_input' packages/ai/agent-mcp/src/engine/orchestrator.ts`
- [ ] **[hitl-orchestrator.2]** Orchestrator sets status `"awaiting_input"` on HITL intercept.
      `grep -q 'awaiting_input' packages/ai/agent-mcp/src/engine/orchestrator.ts`
- [ ] **[hitl-orchestrator.3]** `resolveHitl` function exported from orchestrator.ts.
      `grep -q 'resolveHitl' packages/ai/agent-mcp/src/engine/orchestrator.ts`
- [ ] **[hitl-orchestrator.4]** `hitlResolvers` Map exists (in-memory suspension map).
      `grep -q 'hitlResolvers' packages/ai/agent-mcp/src/engine/orchestrator.ts`
- [ ] **[hitl-orchestrator.5]** Tests pass.
      `npx nx test agent-mcp 2>&1 | grep -qE 'passed'`

---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src/validation/task.ts",
             "packages/ai/agent-mcp/src/store/task-store.ts",
             "packages/ai/agent-mcp/src/tools/task.ts"]
mutates:    ["packages/ai/agent-mcp/src/engine/orchestrator.ts",
             "packages/ai/agent-mcp/src/__tests__/hitl-orchestrator.test.ts"]
```

---

## Contract Promise

- **Modified:** `orchestrator.ts` — intercepts `request_human_input`, exports `resolveHitl()`
- **Added:** `__tests__/hitl-orchestrator.test.ts` — tests for HITL suspension/resumption flow

---

## Commit points

- [ ] **After orchestrator changes + tests pass** (mandatory):
      `feat(agent-mcp): hitl-orchestrator — request_human_input intercept and suspension`

---

## Notes

- **Tool dispatch loop is sequential in the live code.** The current orchestrator (as of 0.2.0)
  uses a sequential `for` loop for tool dispatch. The intercept fires when the loop reaches
  `request_human_input`. Any earlier tool calls in the same turn have already completed; any
  later ones are blocked until resumption. If 0.1.0 parallel dispatch has been applied, the
  intercept fires in the Phase 1 serial pre-dispatch loop — before `Promise.all` — so the
  entire batch is suspended, not just the `request_human_input` call.
- **Footgun: process restart.** If the server restarts while a task is `awaiting_input`, the
  in-memory resolver is lost. `task_resume` will find the DB row but no in-memory resolver —
  it must return `"TASK_NOT_RESUMABLE"`. The task remains in `awaiting_input` indefinitely
  (manual intervention needed). A future improvement could re-queue the task.
- **`crypto.randomUUID()`** is available in Node 15+. No import needed.
- **Test approach:** mock `taskStore.updateStatus()`, call the orchestrator with a tool-call
  sequence that includes `request_human_input`, verify it suspends, then call `resolveHitl()`
  and verify the orchestrator continues with the injected input.
