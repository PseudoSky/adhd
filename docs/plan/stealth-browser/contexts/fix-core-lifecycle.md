# fix-core-lifecycle — STATE_NAME

**Phase:** migrate · **Kind:** work · **Depends on:** conform-core · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py fix-core-lifecycle`

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
mutates:    ["packages/stealth/stealth-core-browser/src/lib/lifecycle/", "packages/stealth/stealth-core-browser/test/unit/lifecycle/", "packages/stealth/stealth-core-browser/test/helpers/lifecycle/", "docs/plan/stealth-browser/evidence/fix-core-lifecycle.md"]
```

---

## Notes for executor

executor=typescript-pro tier=sonnet/medium; backlog 86a2318f
