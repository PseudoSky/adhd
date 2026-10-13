# search-verbs — STATE_NAME

**Phase:** surface · **Kind:** work · **Depends on:** search-port-providers, search-port-fetch, search-port-engine, search-port-guards · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py search-verbs`

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
mutates:    ["entrypoint/stealth-search/src/api.ts", "entrypoint/stealth-search/src/lib/search.ts", "entrypoint/stealth-search/src/host-projection.ts", "entrypoint/stealth-search/src/index.ts", "entrypoint/stealth-search/src/test/unit/verbs/", "docs/plan/stealth-browser/evidence/split/search-verbs-probes.json"]
```

---

## Notes for executor

typescript-pro sonnet/high; U-REEXPORT and U-BOOL probes first
