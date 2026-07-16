# spec-foundations — STATE_NAME

**Phase:** spec · **Kind:** work · **Depends on:** triage · **Guard:** `npx --yes nx run-many -t test,build -p dispatch-base-spec`

---

## Goal

`@adhd/dispatch-spec` exports `ExecutionMode` and `ICalibrationStore`, promotes own-completion into the D-07 `eligible` definition, enforces the extended `provider` enum, and guards against `Infinity` — the ripple-root every downstream package inherits.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [spec-foundations.1] dispatch-base-spec builds and tests green

- [spec-foundations.2] ExecutionMode is exported from the spec
- [spec-foundations.3] ICalibrationStore is formalized in the spec
---

## Reservations

```text
read_only:  []
mutates:    ["packages/dispatch/dispatch-base-spec/src/lib/types.ts", "packages/dispatch/dispatch-base-spec/src/lib/validate.ts"]
```

---

## Notes for executor

Closes DEBT-005/BL-102 (ExecutionMode union), DEBT-013 (eligible own-completion — the spec definition, so every consumer inherits the guard), DEBT-018 (ICalibrationStore interface), DEBT-019 (provider enum + enforce in validate.ts), DEBT-014 (reject/clamp absent tiers). Land these BEFORE consumers (advisory P6). Reference impl in `dispatch-backlog-fill/SOLUTIONS.md` (stale `packages/shared/` paths → `packages/dispatch/`). [inv:teeth] [inv:layer-purity] (zero-dep shared).
