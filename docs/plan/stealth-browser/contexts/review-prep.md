# review-prep — STATE_NAME

**Phase:** review · **Kind:** work · **Depends on:** gates-first · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py review-prep`

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
mutates:    ["docs/plan/stealth-browser/review/migration.diff", "docs/plan/stealth-browser/review/INPUT.sha256", "docs/plan/stealth-browser/review/BRIEF.txt"]
```

---

## Notes for executor

executor=qa tier=sonnet/low
