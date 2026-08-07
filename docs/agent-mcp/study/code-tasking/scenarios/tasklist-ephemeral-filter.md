# Scenario: `tasklist-ephemeral-filter`

**Tier:** simple (feature add — single locus, additive). **Real change shipped in:** the ephemeral-observability work (commit `62893bf`).

---

## The coding task

The task-list tool lists tasks, optionally filtered by `session_id` and `status`.
**Add an optional `is_ephemeral` filter** so a caller can list only ephemeral
(or only non-ephemeral) tasks. No diagnosis required — just extend the input
schema and the query.

Context:
- The DB column is `is_ephemeral INTEGER NOT NULL DEFAULT 0` (SQLite boolean: 0/1).
- The Zod input schema:
  ```ts
  export const taskListInputSchema = z.object({
      session_id: z.string().uuid().optional(),
      status: taskStatusSchema.optional(),
  });
  ```
- `TaskStore.list(filter)` builds a Drizzle query over `tasksTable` and applies
  the provided filters with `eq(...)` conditions.

## Raw correct solution (shape, as shipped)

```ts
// validation/task.ts
export const taskListInputSchema = z.object({
    session_id: z.string().uuid().optional(),
    status: taskStatusSchema.optional(),
    is_ephemeral: z.boolean().optional(),   // ← added
});
```
```ts
// store/task-store.ts — list()
const conditions = [];
if (filter.session_id) conditions.push(eq(tasksTable.sessionId, filter.session_id));
if (filter.status)     conditions.push(eq(tasksTable.status, filter.status));
if (filter.is_ephemeral !== undefined)                       // ← added; note !== undefined
    conditions.push(eq(tasksTable.isEphemeral, filter.is_ephemeral ? 1 : 0)); // boolean → 0/1
// …apply conditions via and(...) as before…
```

## Rubric (0–5; "pass" = correct additive change that compiles and doesn't break the no-filter path)

| # | Criterion | Weight |
|---|---|---|
| R1 | Adds an **optional** `is_ephemeral` boolean to the input schema | ★★ |
| R2 | Applies the filter **only when provided** (`!== undefined`, not a truthy check — so `false` still filters) | ★★ |
| R3 | Maps the boolean to the integer column (`? 1 : 0`), not comparing a boolean to an INTEGER column | ★★ |
| R4 | Composes with the existing `session_id`/`status` filters (doesn't replace them) | ★ |
| R5 | Compiles / valid Drizzle | ★ |

**Watch-fors:** using `if (filter.is_ephemeral)` (drops the `false` case) — R2 ✗;
comparing boolean directly to the `is_ephemeral` INTEGER column — R3 ✗.
