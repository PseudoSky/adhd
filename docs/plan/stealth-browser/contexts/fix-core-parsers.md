# fix-core-parsers — STATE_NAME

**Phase:** migrate · **Kind:** work · **Depends on:** conform-core · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py fix-core-parsers`

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
mutates:    ["packages/stealth/stealth-core-browser/src/lib/parsers.ts", "packages/stealth/stealth-core-browser/test/unit/parsers/", "packages/stealth/stealth-core-browser/test/fixtures/parsers/", "packages/stealth/stealth-core-browser/test/helpers/parsers/", "docs/plan/stealth-browser/evidence/fix-core-parsers.md"]
```

---

## Notes for executor

executor=typescript-pro tier=sonnet/medium
