# central-validation — STATE_NAME

**Phase:** v2-harness · **Kind:** work · **Depends on:** layer-harness · **Guard:** `npx --yes nx test apigen-runtime`

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
mutates:    ["packages/apigen/runtime/src/lib/validate-layer.ts"]
```

---

## Notes for executor

SPEC §6: built-in validation Layer — validate data vs input and envelope once before dispatch (AJV); fail -> ApiError{invalid_argument}. Replaces per-plugin/route-bound validation.
