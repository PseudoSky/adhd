# audit-v2-projection — STATE_NAME

**Phase:** v2-projection · **Kind:** audit · **Depends on:** projection-transports, logger-layer-plugin, mount-plugins, central-validation · **Guard:** `python3 docs/plan/apigen-client-generation/scripts/audit_apigen.py --phase v2-projection`

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

Real servers: each transport returns ground-truth values; envelope rides metadata; logger Layer wraps; openapi/health mounts answer. Negative control: drop a route from a generated server -> tools/list/route set no longer deep-equals derived ground truth -> red.
