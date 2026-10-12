# tests-unit-data — STATE_NAME

**Phase:** verify · **Kind:** work · **Depends on:** mig-queries · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py tests-unit-data`

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
mutates:    ["entrypoint/stealth-browser/src/test/unit/domains-storage/", "entrypoint/stealth-browser/src/test/unit/queries/"]
```

---

## Notes for executor

executor=test-automator tier=sonnet/medium
