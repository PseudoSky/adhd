# search-port-guards — STATE_NAME

**Phase:** migrate · **Kind:** work · **Depends on:** search-errors · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py search-port-guards`

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
mutates:    ["entrypoint/stealth-search/src/lib/guard.ts", "entrypoint/stealth-search/src/lib/tripwire.ts", "entrypoint/stealth-search/src/lib/config.ts", "entrypoint/stealth-search/src/test/unit/guards/"]
```

---

## Notes for executor

typescript-pro sonnet/high; tripwire adoption, cooldown, concurrency
