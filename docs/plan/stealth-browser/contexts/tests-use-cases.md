# tests-use-cases — STATE_NAME

**Phase:** verify · **Kind:** work · **Depends on:** prod-examples, capture-upgrade, chrome-lifecycle · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py tests-use-cases`

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
mutates:    ["packages/stealth/stealth-core-browser/src/test/use-cases/", "packages/stealth/stealth-core-browser/src/test/support/profile-fixtures.ts", "packages/stealth/stealth-core-browser/src/test/support/page-fixtures.ts"]
```

---

## Notes for executor

executor=test-automator tier=sonnet/high; use-case unit suites replace the e2e lane (user decision)
