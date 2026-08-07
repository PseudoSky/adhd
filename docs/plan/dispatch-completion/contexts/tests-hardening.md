# tests-hardening — STATE_NAME

**Phase:** tests · **Kind:** work · **Depends on:** plugin-audit, storage-audit, tools-audit, cli-audit · **Guard:** `npx --yes nx run-many -t test,build -p dispatch-core-optimizer`

---

## Goal

Golden snapshot/optimize fixtures, the algorithm suite (gated), the stepwise-dispatch A/B experiment, and the dispatch-instance nx-inputs fix all land green.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [tests-hardening.1] optimizer golden/algorithm suite green

---

## Reservations

```text
read_only:  []
mutates:    ["packages/dispatch/dispatch-core-optimizer/src/test/golden.spec.ts"]
```

---

## Notes for executor

Closes DEBT-WORKSPACE-NX-INPUTS-001 (dispatch-package instances only — the workspace-wide sweep is out of scope). Golden fixtures + stepwise-ab record per-turn tokens with an artifact-equivalence assertion; a negative A/B result is persisted as a packing input, not a default. [inv:nx-cache] (prove hits by running twice).
