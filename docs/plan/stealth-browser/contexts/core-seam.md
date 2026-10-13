# core-seam — STATE_NAME

**Phase:** migrate · **Kind:** work · **Depends on:** core-scaffold, chrome-lifecycle, sp-link · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py core-seam`

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
mutates:    ["packages/stealth/stealth-core-browser/src/lib/managers.ts", "packages/stealth/stealth-core-browser/src/lib/chrome-manager.ts", "packages/stealth/stealth-core-browser/src/lib/lifecycle/index.ts", "packages/stealth/stealth-core-browser/src/index.ts", "packages/stealth/stealth-core-browser/src/api.ts", "packages/stealth/stealth-core-browser/src/test/unit/seam/"]
```

---

## Notes for executor

typescript-pro sonnet/high; manager seam (configureManagers/managerFor/chromeExitTarget) moved out of the retired surface-hosts
