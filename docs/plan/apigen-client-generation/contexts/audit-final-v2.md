# audit-final-v2 — STATE_NAME

**Phase:** v2-verify · **Kind:** audit · **Depends on:** integration-tests-v2 · **Guard:** `python3 docs/plan/apigen-client-generation/scripts/audit_apigen.py --phase final`

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
mutates:    ["docs/plan/apigen-client-generation/scripts/audit_apigen.py"]
```

---

## Notes for executor

Final DoD audit against the v2 canonical contract. Every behavioral DoD clause proven by an audit check that drives the real entrypoint; negative controls confirmed positive. Supersedes v1 final audit.
