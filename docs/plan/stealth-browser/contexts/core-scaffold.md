# core-scaffold — STATE_NAME

**Phase:** scaffold · **Kind:** work · **Depends on:** split-plan-repair, surface-api, tests-unit-core, tests-unit-data, tests-unit-extract, mig-docs, chrome-lifecycle, capture-upgrade, cdp-test-harness, sp-reaper-load-proof · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py core-scaffold`

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
mutates:    ["packages/stealth/stealth-core-browser/", "entrypoint/stealth-browser/", ".adhd/workspace.json", "tsconfig.base.json", "pnpm-lock.yaml", "tools/nx-plugins/build/executors/typecheck-spec/stealth-core-browser.baseline.json", "docs/plan/stealth-browser/evidence/split/"]
```

---

## Notes for executor

typescript-pro sonnet/high; generator-built core library @adhd/stealth-core-browser, serialized rename owner
