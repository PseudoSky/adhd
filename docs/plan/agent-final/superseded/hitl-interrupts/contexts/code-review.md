# code-review

**Phase:** convergence · **Depends on:** audit-foundation · **Guard:**
```bash
test -f docs/plan/hitl-interrupts/.code-review-complete
```

---

## Goal

Human code review of all HITL changes. Human hold point — pauses until sentinel is created.

---

## Semantic Distillation

- **Primitive:** Human reviews the diff. On approval, creates the sentinel.

---

## Review scope

1. **Schema migration** (`db/schema.ts` + drizzle migration): `resume_token` column, `awaiting_input` enum.
2. **Validation types** (`validation/task.ts`): `"awaiting_input"` in enum, `resumeToken` in task schema.
3. **TaskStore** (`store/task-store.ts`): `updateStatus()` writes/clears `resumeToken` correctly.
4. **Orchestrator** (`engine/orchestrator.ts`):
   - `request_human_input` intercepted BEFORE MCP dispatch.
   - `resumeToken` written to DB BEFORE `await`.
   - `resolveHitl()` exported and keyed correctly.
5. **`task_resume` tool** (`tools/task.ts`):
   - Token validated.
   - Status checked (`awaiting_input` guard).
   - `TASK_NOT_RESUMABLE` returned when no in-memory resolver.
6. **Tests**: HITL suspension/resumption, invalid token, wrong status, process-restart case.

---

## Human action required

When review is approved:
```bash
touch docs/plan/hitl-interrupts/.code-review-complete
```

---

## Reservations

```text
read_only:  ["*"]
mutates:    ["docs/plan/hitl-interrupts/.code-review-complete"]
```
