# audit-final

**Phase:** convergence · **Depends on:** code-review · **Guard:**
```bash
python3 docs/plan/hitl-interrupts/scripts/audit_hitl.py --phase final; test $? -eq 0
```

---

## Goal

Run the full DoD + reference-conformance audit. All checks must pass before publishing 0.3.0.

---

## Semantic Distillation

- **Primitive:** EXECUTE `scripts/audit_hitl.py --phase final`. Verify all checks green.
- **No file mutations** — audit state.

---

## Acceptance criteria

- [ ] `scripts/audit_hitl.py --phase final` exits 0 (includes foundation + DoD + ref checks).

---

## Reservations

```text
read_only:  ["*"]
mutates:    ["docs/plan/hitl-interrupts/scripts/audit_hitl.py"]
```

---

## Notes

- dod.8 (version = 0.3.0) is verified here; it will fail until docs-and-publish runs.
  Run this audit AFTER version bump.
