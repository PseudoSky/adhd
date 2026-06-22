# audit-v2-core — STATE_NAME

**Phase:** v2-core · **Kind:** audit · **Depends on:** ts-extractor-by-symbol, naming-helpers · **Guard:** `python3 docs/plan/apigen-client-generation/scripts/audit_apigen.py --phase v2-core`

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

Export-shape matrix: named/renamed(as)/default-fn/default-object/anonymous/CJS source each yield correct descriptor ids + projections. Negative control: revert symbol-naming -> matrix goes red.
