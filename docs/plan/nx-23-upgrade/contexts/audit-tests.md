# audit-tests — STATE_NAME

**Phase:** tests · **Kind:** audit · **Depends on:** test-changed-optin · **Guard:** `python3 docs/plan/nx-23-upgrade/scripts/guard_audit_tests.py`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

_No criteria yet._

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/nx-23-upgrade/scripts/guard_audit_tests.py"]
```

---

## Notes for executor

Hold point. File-level selection must be proven to select cross-package tests AND to fail loudly on zero selection.
