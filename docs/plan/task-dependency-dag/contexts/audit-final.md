# audit-final

**Phase:** convergence · **Depends on:** code-review · **Guard:**
```bash
python3 docs/plan/task-dependency-dag/scripts/audit_dag.py --phase final; test $? -eq 0
```

---

## Goal

Run the full DoD + reference-conformance audit. All checks must pass before publishing 0.2.0.

---

## Semantic Distillation

- **Primitive:** EXECUTE `scripts/audit_dag.py --phase final`. Verify all checks green.
- **No file mutations** — audit state.

---

## Acceptance criteria

- [ ] `scripts/audit_dag.py --phase final` exits 0 (includes foundation + DoD + ref checks).

---

## Reservations

```text
read_only:  ["*"]
mutates:    ["docs/plan/task-dependency-dag/scripts/audit_dag.py"]
```

---

## Notes

- All 9 DoD clauses must pass, including dod.9 (version = 0.2.0).
- If dod.9 fails, the docs-and-publish state must run first — but version bump happens in
  docs-and-publish. Re-run this audit AFTER version bump.
- Reference conformance checks verify that schema.ts and validation/task.ts both carry `"waiting"`,
  and that DagEngine uses `ToolError` for cycle detection.
