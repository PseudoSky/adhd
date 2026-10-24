# gates-first — STATE_NAME

**Phase:** review · **Kind:** work · **Depends on:** tests-unit-core, tests-unit-data, tests-unit-extract, tests-unit-surface, tests-use-cases, search-usecases, search-examples, tracing-log-validation, search-cutover, mig-docs, audit-fixes, sp-switch, sp-reaper-smoke, tripwire-pack · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py gates-first`

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
mutates:    ["docs/plan/stealth-browser/evidence/"]
```

---

## Notes for executor

executor=qa tier=sonnet/medium; also gates the tripwire package (gates-first.11) and the release hygiene of the manifests (gates-first.12)
