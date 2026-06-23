# audit-v2-host — STATE_NAME

**Phase:** v2-host-contract · **Kind:** audit · **Depends on:** python-host · **Guard:** `python3 docs/plan/apigen-client-generation/scripts/audit_apigen.py --phase v2-host`

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

Drives the REAL mixed-host gateway: adhd-apigen run --source <ts> <py> -> op host:ts answered by TS runtime, host:python by Python runtime; kill the Python sidecar -> only its ops 503 (partial availability §13.1) while TS keeps serving; conformance vectors pass on the Python host. Negative control: route all ops to one runtime -> cross-host op red.
