# audit-final

**Phase:** convergence · **Depends on:** code-review · **Guard:**
```bash
python3 docs/plan/task-streaming-sse/scripts/audit_sse.py --phase final; test $? -eq 0
```

---

## Goal

Run the full DoD + reference-conformance audit. All checks must pass before publishing 0.4.0.

---

## Semantic Distillation

- **Primitive:** EXECUTE `scripts/audit_sse.py --phase final`. Verify all checks green.
- **No file mutations** — audit state.

---

## Acceptance criteria

- [ ] `scripts/audit_sse.py --phase final` exits 0 (includes foundation + DoD + ref checks).

---

## Reservations

```text
read_only:  ["*"]
mutates:    ["docs/plan/task-streaming-sse/scripts/audit_sse.py"]
```

---

## Notes

- dod.9 (version = 0.4.0) fails until docs-and-publish runs. Run after version bump.
