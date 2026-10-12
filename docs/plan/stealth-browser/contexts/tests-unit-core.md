# tests-unit-core — STATE_NAME

**Phase:** verify · **Kind:** work · **Depends on:** mig-chrome-manager · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py tests-unit-core`

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
mutates:    ["entrypoint/stealth-browser/src/test/unit/foundation/", "entrypoint/stealth-browser/src/test/unit/cdp/", "entrypoint/stealth-browser/src/test/unit/chrome-manager/"]
```

---

## Notes for executor

executor=test-automator tier=sonnet/medium
