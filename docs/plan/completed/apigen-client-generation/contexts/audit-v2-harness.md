# audit-v2-harness — STATE_NAME

**Phase:** v2-harness · **Kind:** audit · **Depends on:** layer-harness, central-validation, error-taxonomy · **Guard:** `python3 docs/plan/apigen-client-generation/scripts/audit_apigen.py --phase v2-harness`

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

Drive invoke() through REAL Layers: order preserved, ctx threaded, validation rejects bad data with invalid_argument, error codes map per transport. Negative control: remove validation Layer -> bad-data test goes red.
