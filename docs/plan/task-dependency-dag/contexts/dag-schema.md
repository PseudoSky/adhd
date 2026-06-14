# dag-schema

**Phase:** foundation · **Depends on:** — · **Guard:**
```bash
grep -q 'depends_on' packages/ai/agent-mcp/src/db/schema.ts && \
grep -q '"waiting"' packages/ai/agent-mcp/src/db/schema.ts && \
python3 -c "import os; sqls=[f for f in os.listdir('packages/ai/agent-mcp/drizzle') if f.endswith('.sql')]; assert len(sqls)>=4, f'expected >=4, got {len(sqls)}'"
```

---

## Goal

Add three new nullable columns to `tasksTable` and add `"waiting"` to the status enum. Generate
the Drizzle migration. This is the foundation for all DAG features — no feature works without the
schema in place.

---

## Semantic Distillation

- **Primitive:** MODIFY `packages/ai/agent-mcp/src/db/schema.ts` — add columns + enum value.

- **Reference Pattern:** Existing `tasksTable` definition in `src/db/schema.ts` (lines 65–84).
  Current enum: `"pending" | "running" | "completed" | "failed" | "cancelled"`.

- **Delta Spec:** Add to `tasksTable` (after `cancelledAt`):
  ```typescript
  dependsOn: text("depends_on"),        // JSON array of task UUID strings, nullable
  onUpstreamFailure: text("on_upstream_failure"),  // "fail"|"skip", nullable
  inputs: text("inputs"),               // JSON object: taskId→result, nullable
  ```
  Add `"waiting"` to the `status` enum:
  ```typescript
  status: text("status", {
      enum: ["pending", "running", "completed", "failed", "cancelled", "waiting"]
  }).notNull().default("pending"),
  ```
  Run:
  ```bash
  cd packages/ai/agent-mcp && npx drizzle-kit generate
  ```
  The generated migration (0004_*.sql) will contain:
  ```sql
  ALTER TABLE tasks ADD COLUMN depends_on TEXT;
  ALTER TABLE tasks ADD COLUMN on_upstream_failure TEXT;
  ALTER TABLE tasks ADD COLUMN inputs TEXT;
  ```
  Note: SQLite ALTER TABLE ADD COLUMN does not allow enum constraints — the enum is enforced
  by the application layer. The status enum extension doesn't require a migration.

- **Invariants:** See `[ref:task-status-enum]` — the schema enum must match the zod enum in
  dag-types.

- **Validation:** grep confirms columns present; migration count ≥ 4.

---

## Acceptance criteria

- [ ] **[dag-schema.1]** `depends_on` column in `tasksTable`.
      `grep -q 'depends_on' packages/ai/agent-mcp/src/db/schema.ts`
- [ ] **[dag-schema.2]** `on_upstream_failure` column in `tasksTable`.
      `grep -q 'on_upstream_failure' packages/ai/agent-mcp/src/db/schema.ts`
- [ ] **[dag-schema.3]** `inputs` column in `tasksTable`.
      `grep -q '"inputs"' packages/ai/agent-mcp/src/db/schema.ts`
- [ ] **[dag-schema.4]** `"waiting"` in the status enum.
      `grep -q '"waiting"' packages/ai/agent-mcp/src/db/schema.ts`
- [ ] **[dag-schema.5]** New Drizzle migration generated (≥4 .sql files in drizzle/).
      `python3 -c "import os; sqls=[f for f in os.listdir('packages/ai/agent-mcp/drizzle') if f.endswith('.sql')]; assert len(sqls)>=4"`

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

- **Modified:** `tasksTable` — three new nullable text columns + "waiting" in status enum
- **Added:** migration `0004_<hash>.sql`

---

## Commit points

- [ ] **After schema + migration** (mandatory):
      `feat(agent-mcp): dag-schema — depends_on, on_upstream_failure, inputs columns`

---

## Notes

- Run `npx drizzle-kit generate` from inside `packages/ai/agent-mcp/`, not the repo root.
- Do NOT run `drizzle-kit push` or `drizzle-kit migrate` — the server runs migrations on startup.
- The `status` enum extension in Drizzle doesn't require ALTER TABLE in SQLite (SQLite doesn't
  enforce enum constraints at the DB level; the enum is a Drizzle/app-layer construct).
