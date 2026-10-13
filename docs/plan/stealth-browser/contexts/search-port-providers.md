# search-port-providers — STATE_NAME

**Phase:** migrate · **Kind:** work · **Depends on:** search-errors · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py search-port-providers`

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
mutates:    ["entrypoint/stealth-search/src/lib/types.ts", "entrypoint/stealth-search/src/lib/providers.ts", "entrypoint/stealth-search/src/lib/utils.ts", "entrypoint/stealth-search/src/lib/queries/last-search.ts", "entrypoint/stealth-search/src/test/unit/providers/"]
```

---

## Notes for executor

typescript-pro sonnet/high
