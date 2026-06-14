# hitl-types

**Phase:** foundation · **Depends on:** hitl-schema · **Guard:**
```bash
grep -q '"awaiting_input"' packages/ai/agent-mcp/src/validation/task.ts && \
grep -q 'resumeToken' packages/ai/agent-mcp/src/validation/task.ts && \
npx nx build agent-mcp 2>&1 | grep -q 'Successfully ran'
```

---

## Goal

Update `taskStatusSchema` to include `"awaiting_input"`. Update `taskSchema` and `TaskStore` to
include `resumeToken`. Update `TaskStore.updateStatus()` to accept and write `resumeToken`.

---

## Semantic Distillation

- **Primitive:** MODIFY `validation/task.ts` and `store/task-store.ts`.

- **Delta Spec:**

  **`validation/task.ts`:**
  ```typescript
  export const taskStatusSchema = z.enum([
      "pending", "running", "completed", "failed", "cancelled", "waiting", "awaiting_input",
  ]);

  export const taskSchema = z.object({
      // ... existing fields including dependsOn, onUpstreamFailure, inputs ...
      resumeToken: z.string().uuid().optional().nullable(),
  });
  ```

  **`store/task-store.ts`:**
  - `read()` and list mapping: include `resumeToken` from row.
  - `updateStatus()` (or equivalent): when called with `status: "awaiting_input"`, also write
    `resumeToken` to the task row. Signature addition:
    ```typescript
    updateStatus(id: string, status: TaskStatus, opts?: {
        error?: string;
        result?: string;
        resumeToken?: string;   // new
    }): void
    ```
  - When `status !== "awaiting_input"`, clear `resumeToken` (set to null) — a resumed task
    should not retain its old token.

- **Invariants:** See `[ref:task-status-enum]` — enum must match schema.ts.

- **Validation:** grep confirms `"awaiting_input"` and `resumeToken` in validation/task.ts; build passes.

---

## Acceptance criteria

- [ ] **[hitl-types.1]** `"awaiting_input"` in `taskStatusSchema`.
      `grep -q '"awaiting_input"' packages/ai/agent-mcp/src/validation/task.ts`
- [ ] **[hitl-types.2]** `resumeToken` field in `taskSchema`.
      `grep -q 'resumeToken' packages/ai/agent-mcp/src/validation/task.ts`
- [ ] **[hitl-types.3]** `TaskStore.updateStatus()` accepts `resumeToken`.
      `grep -q 'resumeToken' packages/ai/agent-mcp/src/store/task-store.ts`
- [ ] **[hitl-types.4]** Build passes after type changes.
      `npx nx build agent-mcp 2>&1 | grep -q 'Successfully ran'`

---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src/db/schema.ts",
             "packages/ai/agent-mcp/src/tools/task.ts",
             "packages/ai/agent-mcp/src/engine/orchestrator.ts"]
mutates:    ["packages/ai/agent-mcp/src/validation/task.ts",
             "packages/ai/agent-mcp/src/store/task-store.ts"]
```

---

## Contract Promise

- **Modified:** `taskStatusSchema` — gains `"awaiting_input"`
- **Modified:** `taskSchema` — gains `resumeToken` optional nullable field
- **Modified:** `TaskStore.updateStatus()` — accepts + writes `resumeToken`; clears on non-awaiting

---

## Commit points

- [ ] **After type + store updates + build passes** (mandatory):
      `feat(agent-mcp): hitl-types — awaiting_input status, resumeToken field and store support`

---

## Notes

- If `agent-mcp-types` exports `TaskStatus`, add `"awaiting_input"` there too. Check
  `packages/ai/agent-mcp-types/src/domain.ts`.
- Clearing `resumeToken` on non-`awaiting_input` status transitions prevents old tokens from
  being reused to resume a task that has already been completed or re-queued.
