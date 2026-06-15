# Scenario: `task-status-enum-extend`

**Tier:** simple (mechanical — consistent additive edit in two places). **Real change shipped in:** task-schema-foundation.

---

## The coding task

Add two new task statuses, **`waiting`** and **`awaiting_input`**, to the status
enum. The status is declared in **two** places that must stay in sync; add the
values to both, keep the existing ones. No diagnosis.

Context (before):
```ts
// db/schema.ts — Drizzle column
status: text("status", {
    enum: ["pending", "running", "completed", "failed", "cancelled"],
}).notNull().default("pending"),
```
```ts
// validation/task.ts — Zod
export const taskStatusSchema = z.enum([
    "pending", "running", "completed", "failed", "cancelled",
]);
```

## Raw correct solution (shape, as shipped)

Add `"waiting"` and `"awaiting_input"` to **both** enum lists:
```ts
enum: ["pending", "running", "completed", "failed", "cancelled", "waiting", "awaiting_input"]
```
```ts
z.enum(["pending", "running", "completed", "failed", "cancelled", "waiting", "awaiting_input"])
```

## Rubric (0–5; "pass" = both enums extended consistently, compiles)

| # | Criterion | Weight |
|---|---|---|
| R1 | Both new values added to the **Drizzle** column enum | ★★ |
| R2 | Both new values added to the **Zod** `taskStatusSchema` | ★★ |
| R3 | Existing values preserved (none dropped/renamed) | ★ |
| R4 | The two enums are **consistent** with each other | ★★ |
| R5 | Compiles | ★ |

**Watch-fors:** editing only one of the two places (drift) — R1/R2/R4 ✗; renaming
or reordering existing values — R3 ✗. Primary thing this probes: does the model
find and update *all* the places a value is declared, not just the first one it sees.
