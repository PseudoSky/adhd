# hitl-schema

**Phase:** foundation · **Depends on:** — · **Guard:**
```bash
grep -q 'awaiting_input' packages/ai/agent-mcp/src/db/schema.ts && \
grep -q 'resume_token' packages/ai/agent-mcp/src/db/schema.ts && \
python3 -c "import os; sqls=[f for f in os.listdir('packages/ai/agent-mcp/drizzle') if f.endswith('.sql')]; assert len(sqls)>=5, f'expected >=5, got {len(sqls)}'"
```

---

## Prerequisites

**This state assumes `"waiting"` already exists in the status enum** (added in 0.2.0
task-dependency-dag). The delta spec below includes `"waiting"` in the full enum because the
delta must match the live schema at execution time. If 0.2.0 has not yet been executed:
1. Verify the current enum in `packages/ai/agent-mcp/src/db/schema.ts` before editing.
2. Only add `"awaiting_input"` — do not add `"waiting"` if it is already present (duplicate
   enum values cause a Drizzle schema error).
3. The migration count guard (`>=5`) assumes 0.2.0's migration `0004_*` exists. If it does not,
   this guard will fail. Run 0.2.0 first.

## Goal

Add `"awaiting_input"` to the `tasksTable` status enum and add a `resume_token` nullable text
column. Generate the Drizzle migration.

---

## Semantic Distillation

- **Primitive:** MODIFY `packages/ai/agent-mcp/src/db/schema.ts`.

- **Delta Spec:** Add to `tasksTable` (after `inputs` from 0.2.0):
  ```typescript
  resumeToken: text("resume_token"),   // UUID or null; set on suspension, cleared on resume
  ```
  Add `"awaiting_input"` to the status enum:
  ```typescript
  status: text("status", {
      enum: ["pending", "running", "completed", "failed", "cancelled", "waiting", "awaiting_input"]
  }).notNull().default("pending"),
  ```
  Run from inside `packages/ai/agent-mcp/`:
  ```bash
  npx drizzle-kit generate
  ```
  The generated migration (0005_*.sql) will contain:
  ```sql
  ALTER TABLE tasks ADD COLUMN resume_token TEXT;
  ```

- **Invariants:** See `[ref:task-status-enum]` in `_shared.md`.

- **Validation:** grep confirms column + enum value; migration count ≥ 5.

---

## Acceptance criteria

- [ ] **[hitl-schema.1]** `"awaiting_input"` in `tasksTable` status enum.
      `grep -q 'awaiting_input' packages/ai/agent-mcp/src/db/schema.ts`
- [ ] **[hitl-schema.2]** `resume_token` column in `tasksTable`.
      `grep -q 'resume_token' packages/ai/agent-mcp/src/db/schema.ts`
- [ ] **[hitl-schema.3]** New Drizzle migration generated (≥5 .sql files).
      `python3 -c "import os; sqls=[f for f in os.listdir('packages/ai/agent-mcp/drizzle') if f.endswith('.sql')]; assert len(sqls)>=5"`

---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src/db/client.ts",
             "packages/ai/agent-mcp/src/db/migrate.ts"]
mutates:    ["packages/ai/agent-mcp/src/db/schema.ts",
             "packages/ai/agent-mcp/drizzle/"]
```

---

## Contract Promise

- **Modified:** `tasksTable` — new `resume_token` nullable column + `"awaiting_input"` in enum
- **Added:** migration `0005_<hash>.sql`

---

## Commit points

- [ ] **After schema + migration** (mandatory):
      `feat(agent-mcp): hitl-schema — awaiting_input status, resume_token column`

---

## Notes

- Do NOT run `drizzle-kit push` — server runs migrations on startup.
- The enum extension doesn't require ALTER TABLE in SQLite.
- By this point the schema already has `depends_on`, `on_upstream_failure`, `inputs` from 0.2.0.
  The migration numbering should be 0005 (after 0004 from task-dependency-dag).
