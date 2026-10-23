# main-merge — STATE_NAME

**Phase:** scaffold · **Kind:** work · **Depends on:** search-examples, search-usecases, sp-reaper-smoke, sp-switch, tests-unit-surface, tests-use-cases, tripwire-reverse-migrate · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py main-merge`

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
mutates:    [".adhd/workspace.json", "tsconfig.base.json", "pnpm-lock.yaml", "package.json", "docs/plan/stealth-browser/evidence/main-merge.md"]
```

---

## Notes for executor

executor=haiku tier=haiku; merge conflict union edits and a lockfile regeneration; depends on every completed leaf state so all completed owners are ancestors of the conform and fix states
