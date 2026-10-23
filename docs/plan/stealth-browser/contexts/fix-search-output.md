# fix-search-output — STATE_NAME

**Phase:** migrate · **Kind:** work · **Depends on:** conform-search · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py fix-search-output`

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
mutates:    ["entrypoint/stealth-search/src/lib/search.ts", "entrypoint/stealth-search/src/api.ts", "entrypoint/stealth-search/src/lib/output.ts", "entrypoint/stealth-search/test/unit/verbs/", "entrypoint/stealth-search/test/helpers/verbs/", "docs/plan/stealth-browser/evidence/fix-search-output.md"]
```

---

## Notes for executor

executor=typescript-pro tier=sonnet/medium
