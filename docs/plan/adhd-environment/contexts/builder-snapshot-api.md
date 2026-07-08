# builder-snapshot-api — STATE_NAME

**Phase:** builder · **Kind:** work · **Depends on:** builder-engine · **Guard:** `true`

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
mutates:    ["packages/environment/environment-builder/src/environment-snapshot.ts", "packages/environment/environment-builder/src/index.ts", "packages/environment/environment-builder/src/__tests__/environment-snapshot.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
