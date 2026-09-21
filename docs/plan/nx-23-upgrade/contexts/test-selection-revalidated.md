# test-selection-revalidated — STATE_NAME

**Phase:** tests · **Kind:** work · **Depends on:** audit-graph · **Guard:** `test -f docs/plan/nx-23-upgrade/TEST-SELECTION-PROBE.md && rg -q "D1" docs/plan/nx-23-upgrade/TEST-SELECTION-PROBE.md && rg -q "D2" docs/plan/nx-23-upgrade/TEST-SELECTION-PROBE.md && rg -q "D3" docs/plan/nx-23-upgrade/TEST-SELECTION-PROBE.md && ./node_modules/.bin/nx --version | rg -q "23\.2\.1"`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [test-selection-revalidated.1] The revalidation probe record exists

- [test-selection-revalidated.2] The probe record reports defect one
- [test-selection-revalidated.3] The probe record reports defect two
- [test-selection-revalidated.4] The probe record reports defect three
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "nx.json", "package.json", "tools/vite-plugins/source-resolution.mjs", ".githooks/pre-commit"]
mutates:    ["docs/plan/nx-23-upgrade/TEST-SELECTION-PROBE.md"]
```

---

## Notes for executor

The prior verdict on the changed flag was measured on Nx 18.3.4 with vitest 1.6.1. Re-run the same three probes on Nx 23.2.1 with vitest 4.1.9 and record confirm-or-refute per defect.
