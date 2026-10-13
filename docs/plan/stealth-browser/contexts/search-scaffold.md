# search-scaffold — STATE_NAME

**Phase:** scaffold · **Kind:** work · **Depends on:** core-scaffold, tripwire-pack · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py search-scaffold`

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
mutates:    ["entrypoint/stealth-search/", "tsconfig.base.json", "pnpm-lock.yaml", "tools/nx-plugins/build/executors/typecheck-spec/stealth-search.baseline.json", "docs/plan/stealth-browser/evidence/split/"]
```

---

## Notes for executor

typescript-pro sonnet/high; generator-built entrypoint @adhd/stealth-search with every dependency declared
