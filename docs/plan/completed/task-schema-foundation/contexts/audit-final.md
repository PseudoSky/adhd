# audit-final

**Phase:** convergence · **Depends on:** code-review · **Guard:**
```bash
python3 docs/plan/task-schema-foundation/scripts/audit_schema_foundation.py --phase final
```

---

## Goal

Full DoD coverage. Runs all foundation checks (schema-columns.1-5, task-types.1-6) plus
DoD clauses (dod.1-dod.6). All must pass before publishing.

---

## What the audit checks

**Foundation checks** (same as audit-foundation)

**DoD clauses:**
- `[dod.1]` Migration file exists with all four columns
- `[dod.2]` Both `"waiting"` and `"awaiting_input"` in enum (schema.ts + validation/task.ts)
- `[dod.3]` TaskStore methods updated (create accepts deps, updateStatus accepts resumeToken)
- `[dod.4]` agent-mcp-types TaskStatus export includes new values
- `[dod.5]` Build passes
- `[dod.6]` Version bumped to 0.1.5 (checked at docs-and-publish guard, not here)

---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src/db/schema.ts",
             "packages/ai/agent-mcp/drizzle/",
             "packages/ai/agent-mcp/src/validation/task.ts",
             "packages/ai/agent-mcp/src/store/task-store.ts",
             "packages/ai/agent-mcp-types/src/index.ts"]
mutates:    ["docs/plan/task-schema-foundation/scripts/audit_schema_foundation.py"]
```

---

## Contract Promise

Audit passes (exit 0) → proceed to docs-and-publish.
