# fix-search-fetch — STATE_NAME

**Phase:** migrate · **Kind:** work · **Depends on:** conform-search · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py fix-search-fetch`

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
mutates:    ["entrypoint/stealth-search/src/lib/fetch/", "entrypoint/stealth-search/test/unit/fetch/", "entrypoint/stealth-search/test/fixtures/fetch/", "entrypoint/stealth-search/test/helpers/fetch/", "docs/plan/stealth-browser/evidence/fix-search-fetch.md"]
```

---

## Notes for executor

executor=typescript-pro tier=sonnet/medium
