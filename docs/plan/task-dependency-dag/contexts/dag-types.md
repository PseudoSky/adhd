# dag-types

**Phase:** foundation · **Depends on:** dag-schema · **Guard:**
```bash
grep -q '"waiting"' packages/ai/agent-mcp/src/validation/task.ts && \
grep -q 'dependsOn' packages/ai/agent-mcp/src/validation/task.ts && \
npx nx build agent-mcp 2>&1 | grep -q 'Successfully ran'
```

---

## Goal

Update validation types and `TaskStore` to reflect the new schema columns. `taskStatusSchema`
gains `"waiting"`. `taskSchema` gains `dependsOn`, `onUpstreamFailure`, `inputs`. Task creation
starts tasks in `"waiting"` when they have dependencies. `ExecutionContext` gains `inputs?`.

---

## Semantic Distillation

- **Primitive:** MODIFY `packages/ai/agent-mcp/src/validation/task.ts` and
  `packages/ai/agent-mcp/src/store/task-store.ts`.

- **Delta Spec:**

  **`validation/task.ts`:**
  ```typescript
  export const taskStatusSchema = z.enum([
      "pending", "running", "completed", "failed", "cancelled", "waiting",
  ]);

  export const taskSchema = z.object({
      // ... existing fields ...
      dependsOn: z.array(z.string().uuid()).optional(),
      onUpstreamFailure: z.enum(["fail", "skip"]).default("fail").optional(),
      inputs: z.record(z.string(), z.string()).optional(),
  });

  // taskToolInputSchema — add to both sessionModeSchema and ephemeralModeSchema:
  depends_on: z.array(z.string().uuid()).optional(),
  on_upstream_failure: z.enum(["fail", "skip"]).optional(),
  ```

  **`validation/execution.ts`** — add to `executionContextSchema`:
  ```typescript
  inputs: z.record(z.string(), z.string()).optional(),
  ```
  And export `ExecutionContext` update.

  **`store/task-store.ts`** — `create()` method:
  - Accepts `dependsOn?: string[]`, `onUpstreamFailure?: "fail" | "skip"`
  - Sets initial `status` to `"waiting"` if `dependsOn && dependsOn.length > 0`, else `"pending"`
  - Serialises `dependsOn` to JSON string for the `depends_on` DB column
  - `read()` and list mapping: parse `dependsOn` from JSON; include `onUpstreamFailure` and `inputs`

- **Invariants:** See `[ref:task-status-enum]` — zod enum must match schema.ts enum.

- **Validation:** grep confirms `"waiting"` and `dependsOn` in validation/task.ts; build passes.

---

## Acceptance criteria

- [ ] **[dag-types.1]** `"waiting"` in `taskStatusSchema`.
      `grep -q '"waiting"' packages/ai/agent-mcp/src/validation/task.ts`
- [ ] **[dag-types.2]** `dependsOn` field in `taskSchema`.
      `grep -q 'dependsOn' packages/ai/agent-mcp/src/validation/task.ts`
- [ ] **[dag-types.3]** `onUpstreamFailure` field in `taskSchema`.
      `grep -q 'onUpstreamFailure' packages/ai/agent-mcp/src/validation/task.ts`
- [ ] **[dag-types.4]** `depends_on` in `taskToolInputSchema` (both modes).
      `grep -q 'depends_on' packages/ai/agent-mcp/src/validation/task.ts`
- [ ] **[dag-types.5]** `TaskStore.create()` sets status `"waiting"` when `dependsOn.length > 0`.
      `grep -q 'waiting' packages/ai/agent-mcp/src/store/task-store.ts`
- [ ] **[dag-types.6]** Build passes after type changes.
      `npx nx build agent-mcp 2>&1 | grep -q 'Successfully ran'`

---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src/db/schema.ts",
             "packages/ai/agent-mcp/src/tools/task.ts"]
mutates:    ["packages/ai/agent-mcp/src/validation/task.ts",
             "packages/ai/agent-mcp/src/validation/execution.ts",
             "packages/ai/agent-mcp/src/store/task-store.ts"]
```

---

## Contract Promise

- **Modified:** `taskStatusSchema` — gains `"waiting"` value
- **Modified:** `taskSchema` — gains `dependsOn`, `onUpstreamFailure`, `inputs` optional fields
- **Modified:** `taskToolInputSchema` — gains `depends_on`, `on_upstream_failure` in input shape
- **Modified:** `TaskStore.create()` — accepts dependency params; sets `waiting` status
- **Modified:** `ExecutionContext` — gains `inputs?: Record<string, string>`

---

## Commit points

- [ ] **After type + store updates + build passes** (mandatory):
      `feat(agent-mcp): dag-types — waiting status, dependsOn schema, TaskStore deps support`

---

## Notes

- **PREREQUISITE: update `agent-mcp-types` FIRST.** `validation/task.ts` line 13 re-exports
  `TaskStatus` from `@adhd/agent-mcp-types`. Any assignment of `"waiting"` to a `TaskStatus`
  variable will produce a TypeScript error until the types package is updated. Update
  `packages/ai/agent-mcp-types/src/domain.ts` to add `"waiting"` to the `TaskStatus` union,
  rebuild agent-mcp-types (`npx nx build agent-mcp-types`), then update agent-mcp. This is not
  optional — the build will fail without it.
- `ExecutionContext` is defined in `validation/execution.ts` — verify this is the right file
  before editing. The `inputs` field is optional (tasks without dependencies have no inputs).
- The `inputs` field on `taskSchema` is `Record<string, string>` — keys are upstream task IDs,
  values are the upstream task's `result` string. It's nullable in the DB (JSON blob).
