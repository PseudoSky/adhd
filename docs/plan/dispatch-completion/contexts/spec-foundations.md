# spec-foundations — STATE_NAME

**Phase:** spec · **Kind:** work · **Depends on:** triage · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

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

<footguns, ordering constraints, non-obvious decisions>
