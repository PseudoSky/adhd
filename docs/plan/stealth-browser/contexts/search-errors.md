# search-errors — STATE_NAME

**Phase:** migrate · **Kind:** work · **Depends on:** search-inventory, prod-errors · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py search-errors`

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
mutates:    ["entrypoint/stealth-search/src/errors.ts", "entrypoint/stealth-search/src/test/unit/errors/", "entrypoint/stealth-search/docs/ERRORS.md"]
```

---

## Notes for executor

typescript-pro sonnet/high; StealthSearchError registry
