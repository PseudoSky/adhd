# prod-errors — STATE_NAME

**Phase:** surface · **Kind:** work · **Depends on:** core-seam, tests-unit-core, tests-unit-data, tests-unit-extract, capture-upgrade, chrome-lifecycle, surface-api · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py prod-errors`

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
mutates:    ["packages/stealth/stealth-core-browser/src/errors.ts", "packages/stealth/stealth-core-browser/src/lib/", "packages/stealth/stealth-core-browser/src/index.ts", "packages/stealth/stealth-core-browser/docs/ERRORS.md", "packages/stealth/stealth-core-browser/src/test/unit/errors/"]
```

---

## Notes for executor

executor=typescript-pro tier=sonnet/high; 100% typed errors (user decision): every lib throw site raises a StealthBrowserError code
