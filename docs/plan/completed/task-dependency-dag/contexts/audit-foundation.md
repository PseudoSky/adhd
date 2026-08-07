# audit-foundation

**Phase:** engine · **Depends on:** dag-engine · **Guard:**
```bash
python3 docs/plan/task-dependency-dag/scripts/audit_dag.py --phase foundation 2>&1 | grep -q '0 checks' || python3 docs/plan/task-dependency-dag/scripts/audit_dag.py --phase foundation; test $? -eq 0
```

---

## Goal

Run the automated acceptance-criteria audit across all foundation states (dag-schema, dag-types,
dag-engine). All checks must pass before human code review begins.

---

## Semantic Distillation

- **Primitive:** EXECUTE `scripts/audit_dag.py --phase foundation`. Verify all checks green.
- **No file mutations** — this is an audit state.

---

## Acceptance criteria

- [ ] `scripts/audit_dag.py --phase foundation` exits 0.

---

## Reservations

```text
read_only:  ["*"]
mutates:    ["docs/plan/task-dependency-dag/scripts/audit_dag.py"]
```

---

## Notes

- Fix any failing checks in the appropriate state context (dag-schema, dag-types, or dag-engine)
  before re-running this audit.
- Do NOT advance to code-review until this exits 0.
