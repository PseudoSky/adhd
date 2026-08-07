# audit-foundation

**Phase:** foundation · **Depends on:** task-types · **Guard:**
```bash
python3 docs/plan/task-schema-foundation/scripts/audit_schema_foundation.py --phase foundation
```

---

## Goal

Verify all `schema-columns` and `task-types` acceptance criteria pass before proceeding to
code-review. Run the audit script and inspect any FAIL lines before marking this state complete.

---

## What the audit checks

**`=== schema-columns ===`**
- `[schema-columns.1]` `depends_on` column present in `schema.ts`
- `[schema-columns.2]` `resume_token` column present in `schema.ts`
- `[schema-columns.3]` `"waiting"` in status enum
- `[schema-columns.4]` `"awaiting_input"` in status enum
- `[schema-columns.5]` Drizzle migration ≥4 `.sql` files

**`=== task-types ===`**
- `[task-types.1]` `"waiting"` in `taskStatusSchema`
- `[task-types.2]` `"awaiting_input"` in `taskStatusSchema`
- `[task-types.3]` `dependsOn` in `taskSchema`
- `[task-types.4]` `resumeToken` in `taskSchema`
- `[task-types.5]` `"waiting"` in `agent-mcp-types` `TaskStatus`
- `[task-types.6]` Build passes

---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src/db/schema.ts",
             "packages/ai/agent-mcp/src/validation/task.ts",
             "packages/ai/agent-mcp/src/store/task-store.ts",
             "packages/ai/agent-mcp-types/src/index.ts"]
mutates:    ["docs/plan/task-schema-foundation/scripts/audit_schema_foundation.py"]
```

---

## Contract Promise

Audit passes (exit 0) → proceed to code-review. Audit fails → fix the failing work state, re-run.

---

## Commit points

No commit required for an audit state — the guard IS the gate.
