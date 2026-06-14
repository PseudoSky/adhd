# audit-foundation

**Phase:** engine · **Depends on:** hitl-resume-tool · **Guard:**
```bash
python3 docs/plan/hitl-interrupts/scripts/audit_hitl.py --phase foundation; test $? -eq 0
```

---

## Goal

Run the automated acceptance-criteria audit across all foundation states (hitl-schema,
hitl-types, hitl-orchestrator, hitl-resume-tool). All checks must pass before human review.

---

## Semantic Distillation

- **Primitive:** EXECUTE `scripts/audit_hitl.py --phase foundation`. Verify all checks green.
- **No file mutations** — audit state.

---

## Acceptance criteria

- [ ] `scripts/audit_hitl.py --phase foundation` exits 0.

---

## Reservations

```text
read_only:  ["*"]
mutates:    ["docs/plan/hitl-interrupts/scripts/audit_hitl.py"]
```

---

## Notes

Fix failing checks in the appropriate context state before re-running. Do NOT advance to
code-review until this exits 0.
