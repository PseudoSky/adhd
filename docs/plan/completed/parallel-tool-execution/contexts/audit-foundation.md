# audit-foundation

**Phase:** foundation · **Depends on:** parallel-dispatch
**Guard:** `python3 docs/plan/parallel-tool-execution/scripts/audit_parallel.py --phase foundation`

---

## Goal

Verify all acceptance criteria from `parallel-dispatch` against the actual codebase. This is a
mandatory hold point. `code-review` may not begin until every item passes.

**No deferrable items.** If any criterion fails, fix the source file before advancing.

---

## Semantic Distillation

- **Primitive:** CREATE `scripts/audit_parallel.py --phase foundation` — runs all parallel-dispatch
  acceptance criteria checks.
- **Delta Spec:** The script checks [parallel-dispatch.1] through [parallel-dispatch.7] as listed
  in `contexts/parallel-dispatch.md`. Each check is a deterministic shell or Python command that
  exits 0 on pass.
- **Invariants:** The audit script is read-only. Fixes happen in source files. Every fix is listed
  in the transition log.
- **Validation:** `python3 docs/plan/parallel-tool-execution/scripts/audit_parallel.py --phase foundation`
  exits 0 and prints `FOUNDATION AUDIT PASSED`.

---

## Acceptance criteria

- [ ] `scripts/audit_parallel.py` is runnable.
- [ ] Script checks every criterion from `parallel-dispatch` (all 7 IDs present).
- [ ] Script exits 0 and prints `FOUNDATION AUDIT PASSED`.

---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src/"]
mutates:    ["docs/plan/parallel-tool-execution/scripts/audit_parallel.py"]
```

---

## Commit points

- [ ] **After each source fix** (if any): `fix(agent-mcp): parallel-dispatch.<n> — <what>`
- [ ] **After audit passes** (mandatory):
      `chore(parallel-tool-execution): audit-foundation green`
