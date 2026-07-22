# task-types

**Phase:** foundation · **Depends on:** schema-columns · **Guard:**
```bash
grep -q '"waiting"' packages/ai/agent-mcp/src/validation/task.ts && \
grep -q '"awaiting_input"' packages/ai/agent-mcp/src/validation/task.ts && \
grep -q 'resumeToken' packages/ai/agent-mcp/src/validation/task.ts && \
grep -q 'dependsOn' packages/ai/agent-mcp/src/validation/task.ts && \
npx --yes nx build agent-mcp 2>&1 | grep -q 'Successfully ran'
```

---

## Goal

Update `agent-mcp-types`, `validation/task.ts`, and `task-store.ts` so the TypeScript layer
fully reflects the new schema columns. After this state, downstream plans can use all new fields
without touching `task-store.ts` or `validation/task.ts`.

---

## Semantic Distillation

- **Primitive:** MODIFY three files in dependency order (types → validation → store).

- **Delta Spec:**

  **Step 1 — `packages/ai/agent-mcp-types/src/index.ts` (update FIRST):**
  ```typescript
  // Add to TaskStatus union (or wherever TaskStatus is defined/exported):
  export type TaskStatus =
    | "pending" | "running" | "completed" | "failed" | "cancelled"
    | "waiting"         // ← new
    | "awaiting_input"; // ← new
  ```
  After editing, rebuild: `npx --yes nx build agent-mcp-types`

  **Step 2 — `packages/ai/agent-mcp/src/validation/task.ts`:**
  ```typescript
  export const taskStatusSchema = z.enum([
      "pending", "running", "completed", "failed", "cancelled",
      "waiting",         // ← new: blocked on depends_on
      "awaiting_input",  // ← new: suspended in HITL Promise
  ]);

  export const taskSchema = z.object({
      // ... existing fields ...
      dependsOn:          z.array(z.string().uuid()).optional(),
      onUpstreamFailure:  z.enum(["fail", "skip"]).optional(),
      inputs:             z.record(z.string(), z.string()).optional(),
      resumeToken:        z.string().uuid().optional(),
  });

  // In taskToolInputSchema (both sessionModeSchema and ephemeralModeSchema):
  depends_on:          z.array(z.string().uuid()).optional(),
  on_upstream_failure: z.enum(["fail", "skip"]).optional(),
  // (resume_token is not a user-supplied input — it is generated server-side)
  ```

  **Step 3 — `packages/ai/agent-mcp/src/store/task-store.ts`:**

  `create()` additions:
  ```typescript
  // Accept new params
  dependsOn?:         string[];
  onUpstreamFailure?: "fail" | "skip";
  inputs?:            Record<string, string>;

  // Derive status
  const status = dependsOn && dependsOn.length > 0 ? "waiting" : "pending";

  // Persist to DB
  depends_on:          dependsOn ? JSON.stringify(dependsOn) : null,
  on_upstream_failure: onUpstreamFailure ?? null,
  inputs:              inputs ? JSON.stringify(inputs) : null,
  ```

  `updateStatus()` — accept optional resumeToken:
  ```typescript
  updateStatus(id: string, status: TaskStatus, opts?: {
      error?: string;
      result?: string;
      resumeToken?: string; // ← new: written when transitioning to 'awaiting_input'
  }): void {
      // Persist resumeToken when provided:
      // resume_token: opts?.resumeToken ?? null (or keep existing value)
  }
  ```

  `read()` and `list()` — include new fields in the returned record:
  ```typescript
  dependsOn:          row.depends_on ? JSON.parse(row.depends_on) : null,
  onUpstreamFailure:  row.on_upstream_failure ?? null,
  inputs:             row.inputs ? JSON.parse(row.inputs) : null,
  resumeToken:        row.resume_token ?? null,
  ```

- **Invariants:** See `[inv:types-before-validation]`, `[inv:task-store-accepts-all-fields]` in `_shared.md`.

- **Validation:** Four greps on `validation/task.ts` + build passes.

---

## Acceptance criteria

- [ ] **[task-types.1]** `"waiting"` in `taskStatusSchema` in `validation/task.ts`.
      `grep -q '"waiting"' packages/ai/agent-mcp/src/validation/task.ts`
- [ ] **[task-types.2]** `"awaiting_input"` in `taskStatusSchema` in `validation/task.ts`.
      `grep -q '"awaiting_input"' packages/ai/agent-mcp/src/validation/task.ts`
- [ ] **[task-types.3]** `dependsOn` field in `taskSchema`.
      `grep -q 'dependsOn' packages/ai/agent-mcp/src/validation/task.ts`
- [ ] **[task-types.4]** `resumeToken` field in `taskSchema`.
      `grep -q 'resumeToken' packages/ai/agent-mcp/src/validation/task.ts`
- [ ] **[task-types.5]** `"waiting"` exported in `TaskStatus` from `agent-mcp-types`.
      `grep -q 'waiting' packages/ai/agent-mcp-types/src/index.ts`
- [ ] **[task-types.6]** Build passes after all changes.
      `npx --yes nx build agent-mcp 2>&1 | grep -q 'Successfully ran'`

---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src/db/schema.ts",
             "packages/ai/agent-mcp/drizzle/"]
mutates:    ["packages/ai/agent-mcp-types/src/index.ts",
             "packages/ai/agent-mcp/src/validation/task.ts",
             "packages/ai/agent-mcp/src/store/task-store.ts"]
```

---

## Contract Promise

- **Modified:** `agent-mcp-types/src/index.ts` — `TaskStatus` gains `"waiting"`, `"awaiting_input"`
- **Modified:** `taskStatusSchema` — gains `"waiting"`, `"awaiting_input"`
- **Modified:** `taskSchema` — gains `dependsOn`, `onUpstreamFailure`, `inputs`, `resumeToken` optional fields
- **Modified:** `taskToolInputSchema` — gains `depends_on`, `on_upstream_failure` input fields
- **Modified:** `TaskStore.create()` — accepts dependency params; sets `"waiting"` status when `dependsOn.length > 0`
- **Modified:** `TaskStore.updateStatus()` — accepts optional `resumeToken`
- **Modified:** `TaskStore.read()` / `list()` — returns all new fields

---

## Commit points

- [ ] **After agent-mcp-types updated + built** (checkpoint):
      `feat(agent-mcp-types): add waiting and awaiting_input to TaskStatus`
- [ ] **After validation/task.ts + task-store.ts updated + build passes** (mandatory):
      `feat(agent-mcp): task-types — status enum, field schemas, TaskStore deps+HITL support`

---

## Notes

- **PREREQUISITE ORDER (CRITICAL):** Update `agent-mcp-types` and run `npx nx build agent-mcp-types` BEFORE editing `validation/task.ts`. The validator imports `TaskStatus` from the types package on line ~13. TypeScript will error on `"waiting"` assignments until the types package is current.
- **`resumeToken` is server-generated, not user-supplied.** Do NOT add it to `taskToolInputSchema` (the user-facing input schema). It is only in `taskSchema` (the internal representation) and `TaskStore.updateStatus()` opts.
- **`onUpstreamFailure` default.** The field is optional with no explicit default in the Zod schema. `TaskStore.create()` should treat `undefined` as `"fail"` (the operative default) when persisting to the DB. Downstream 0.2.0 plan's DagEngine reads `task.onUpstreamFailure ?? "fail"`.
- **`agent-mcp-types` path.** Verify the exact location of the `TaskStatus` type before editing — it may be in `src/domain.ts` or `src/index.ts` depending on the package structure. Check with `grep -r 'TaskStatus' packages/ai/agent-mcp-types/src/`.
