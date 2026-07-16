# optimizer-client — STATE_NAME

**Phase:** optimizer-client · **Kind:** work · **Depends on:** spec-audit · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [optimizer-client.1] optimizer and client build+test green

- [optimizer-client.2] optimize() sets execution_mode on units
---

## Reservations

```text
read_only:  []
mutates:    ["packages/dispatch/dispatch-core-optimizer/src/lib/optimize.ts", "packages/dispatch/dispatch-core-optimizer/src/lib/snapshot.ts", "packages/dispatch/dispatch-core-client/src/lib/client.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
