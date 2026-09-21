# test-selection-revalidated — Changed-flag verdict revalidated on the upgraded toolchain

**Phase:** tests · **Kind:** work · **Depends on:** audit-graph · **Guard:** `test -f docs/plan/nx-23-upgrade/TEST-SELECTION-PROBE.md && rg -q "D1" docs/plan/nx-23-upgrade/TEST-SELECTION-PROBE.md && rg -q "D2" docs/plan/nx-23-upgrade/TEST-SELECTION-PROBE.md && rg -q "D3" docs/plan/nx-23-upgrade/TEST-SELECTION-PROBE.md && ./node_modules/.bin/nx --version | rg -q "23\.2\.1"`

---

## Goal

The three defects that made the previous selection attempt fail-open are confirmed or refuted on the toolchain this branch actually carries.

---

## Semantic distillation

- The prior verdict was measured on a much older Nx and vitest. It is evidence, not a fact about this branch — re-run the probes.
- Probe D1: adding options under a target-name key crashed project-graph construction for run-commands targets.
- Probe D2: a boolean option stringified into vitest's CLI became the string `true`, producing a fatal git invocation that HUNG rather than exited.
- Probe D3: the one-character repair worked and was FAIL-OPEN — a clean tree reported success having run zero tests. If D3 still reproduces, the design decision to keep the default fail-safe is confirmed by measurement, not preference.

---

## Contract promise

```text
added:    ["docs/plan/nx-23-upgrade/TEST-SELECTION-PROBE.md"]
modified: []
deleted:  []
```

---

## Commit points

- Commit TEST-SELECTION-PROBE.md post-guard, with raw command output per probe.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [test-selection-revalidated.1] The revalidation probe record exists

- [test-selection-revalidated.2] The probe record reports defect one
- [test-selection-revalidated.3] The probe record reports defect two
- [test-selection-revalidated.4] The probe record reports defect three
- [test-selection-revalidated.5] The probes ran against the upgraded toolchain
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "nx.json", "package.json", "tools/vite-plugins/source-resolution.mjs", ".githooks/pre-commit"]
mutates:    ["docs/plan/nx-23-upgrade/TEST-SELECTION-PROBE.md"]
```

---

## References & interfaces

- [iface:vitest-related-cli] — vitest related <files...>

---

## Notes for executor

The prior verdict on the changed flag was measured on Nx 18.3.4 with vitest 1.6.1. Re-run the same three probes on Nx 23.2.1 with vitest 4.1.9 and record confirm-or-refute per defect.
