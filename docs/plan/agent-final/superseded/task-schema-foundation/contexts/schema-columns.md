# schema-columns

**Phase:** foundation · **Depends on:** — · **Guard:**
```bash
grep -q 'depends_on' packages/ai/agent-mcp/src/db/schema.ts && \
grep -q 'resume_token' packages/ai/agent-mcp/src/db/schema.ts && \
grep -q '"waiting"' packages/ai/agent-mcp/src/db/schema.ts && \
grep -q '"awaiting_input"' packages/ai/agent-mcp/src/db/schema.ts && \
python3 -c "import os; sqls=[f for f in os.listdir('packages/ai/agent-mcp/drizzle') if f.endswith('.sql')]; assert len(sqls)>=4, f'expected >=4 migrations, got {len(sqls)}'"
```

---

## Goal

Extend `tasksTable` in `schema.ts` with four new columns and two new status enum values. Generate
**one** Drizzle migration (0004_*) covering all changes in a single atomic schema step.

---

## Semantic Distillation

- **Primitive:** MODIFY `packages/ai/agent-mcp/src/db/schema.ts`.

- **Delta Spec:**

  **Add to `tasksTable`:**
  ```typescript
  // Dependency DAG fields (consumed by task-dependency-dag plan)
  depends_on:          text("depends_on"),           // nullable JSON array of upstream task IDs
  on_upstream_failure: text("on_upstream_failure"),  // nullable: 'fail'|'skip'  (default: 'fail')
  inputs:              text("inputs"),               // nullable JSON blob: upstream taskId→result map

  // HITL suspension field (consumed by hitl-interrupts plan)
  resume_token:        text("resume_token"),         // nullable UUID written before await
  ```

  **Extend status enum** (or the `status` column's check constraint) to include:
  ```typescript
  "waiting",        // task is blocked on depends_on; not yet enqueued
  "awaiting_input", // task is suspended in HITL Promise; resumed by task_resume tool
  ```

  Current migration count: 3 files (0000–0003). The new migration will be `0004_*`.

  **Run after editing schema.ts:**
  ```bash
  cd packages/ai/agent-mcp && npx drizzle-kit generate
  ```
  Review the generated SQL — it must include all four column additions in one file.

- **Invariants:** See `[inv:single-migration]` in `_shared.md`.

- **Validation:** Four greps on `schema.ts` + migration count ≥ 4.

---

## Acceptance criteria

- [ ] **[schema-columns.1]** `depends_on` column present in `schema.ts`.
      `grep -q 'depends_on' packages/ai/agent-mcp/src/db/schema.ts`
- [ ] **[schema-columns.2]** `resume_token` column present in `schema.ts`.
      `grep -q 'resume_token' packages/ai/agent-mcp/src/db/schema.ts`
- [ ] **[schema-columns.3]** `"waiting"` in status enum in `schema.ts`.
      `grep -q '"waiting"' packages/ai/agent-mcp/src/db/schema.ts`
- [ ] **[schema-columns.4]** `"awaiting_input"` in status enum in `schema.ts`.
      `grep -q '"awaiting_input"' packages/ai/agent-mcp/src/db/schema.ts`
- [ ] **[schema-columns.5]** Drizzle migration generated (≥4 `.sql` files in `drizzle/`).
      `python3 -c "import os; sqls=[f for f in os.listdir('packages/ai/agent-mcp/drizzle') if f.endswith('.sql')]; assert len(sqls)>=4"`

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp/src/db/schema.ts",
             "packages/ai/agent-mcp/drizzle/"]
```

---

## Contract Promise

- **Modified:** `tasksTable` — gains `depends_on`, `on_upstream_failure`, `inputs`, `resume_token`
- **Modified:** status enum — gains `"waiting"`, `"awaiting_input"`
- **Added:** `drizzle/0004_*.sql` — single migration covering all column and enum additions

---

## Commit points

- [ ] **After schema edit + migration generated** (mandatory):
      `feat(agent-mcp): schema-columns — add DAG and HITL columns with migration 0004`

---

## Notes

- **Do not split into two migrations.** 0.2.0 and 0.3.0 both check migration counts (0.2.0 expects ≥4, 0.3.0 expects ≥5 from hitl-schema — but since hitl-schema is extracted here, 0.3.0's check also becomes ≥4 after this plan). One atomic migration is cleaner and avoids ordering ambiguity.
- **Check constraint vs enum.** If the current `status` column uses a Drizzle `text` with a runtime enum (not a DB-level CHECK), just extend the Drizzle schema array. Drizzle generates a new migration when the schema object changes even if the column type is plain `text`.
- **Review the generated SQL before committing.** Run `cat packages/ai/agent-mcp/drizzle/0004_*.sql` and verify all four columns appear in one `ALTER TABLE` statement.
