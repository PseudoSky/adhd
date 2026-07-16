# code-review

**Phase:** convergence · **Depends on:** audit-foundation · **Guard:**
```bash
test -f docs/plan/task-dependency-dag/.code-review-complete
```

---

## Goal

Human code review of all changes introduced in this plan. This is a human hold point — the plan
pauses until the reviewer creates the sentinel file.

---

## Semantic Distillation

- **Primitive:** Human reviews the diff. On approval, creates the sentinel.
- **No automated mutations.**

---

## Review scope

The reviewer should verify:

1. **Schema migration** (`db/schema.ts` + drizzle migration): nullable columns, enum extension,
   correct Drizzle column types.
2. **Validation types** (`validation/task.ts`): `"waiting"` in enum, new optional fields,
   `taskToolInputSchema` accepts `depends_on` and `on_upstream_failure`.
3. **TaskStore** (`store/task-store.ts`): `create()` sets `"waiting"` when deps present, JSON
   serialisation/deserialisation of `dependsOn`, `inputs` populated correctly.
4. **DagEngine** (`engine/dag-engine.ts`):
   - `validateNoCycle()`: BFS is correct, correctly detects all cycle shapes, throws `ToolError`.
   - `dispatchReady()`: correctly evaluates terminal state, fail/skip policy, inputs injection,
     no double-dispatch.
5. **tools/task.ts wiring**: `validateNoCycle` before `create`, `dispatchReady` on every terminal
   event (completed, failed, cancelled).
6. **Tests** (`__tests__/dag-engine.test.ts`): covers single dep, fan-in, fail propagation, skip
   propagation. All pass.

---

## Human action required

When review is approved:
```bash
touch docs/plan/task-dependency-dag/.code-review-complete
```

---

## Reservations

```text
read_only:  ["*"]
mutates:    ["docs/plan/task-dependency-dag/.code-review-complete"]
```
