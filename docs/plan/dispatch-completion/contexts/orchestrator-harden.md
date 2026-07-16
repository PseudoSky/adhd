# orchestrator-harden — STATE_NAME

**Phase:** orchestrator · **Kind:** work · **Depends on:** opt-audit · **Guard:** `npx --yes nx run-many -t test,build -p dispatch-orchestrator`

---

## Goal

`orchestrateCycle` records a `failed` entry instead of throwing on a mid-cycle runner/persist error, routes op-level guards, cuts output on a char boundary, and consumes the real `ICalibrationStore` with a seeded cold-start B.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [orchestrator-harden.1] orchestrator builds+tests green

- [orchestrator-harden.2] ICalibrationPlaceholder is replaced by the real store
---

## Reservations

```text
read_only:  []
mutates:    ["packages/dispatch/dispatch-orchestrator/src/lib/orchestrator.ts"]
```

---

## Notes for executor

Closes DEBT-015 (per-unit try/catch — teeth: remove it → uncaught rejection), DEBT-016 (route op-level type:automated/action:guard through GuardExecFn), DEBT-017 (capOutput UTF-8 boundary), DEBT-018 impl (replace ICalibrationPlaceholder), DEBT-005/BL-106 (seed b_per_tier). Do NOT touch the tool-call execution path (EXEC-001 owns it). [inv:teeth].
