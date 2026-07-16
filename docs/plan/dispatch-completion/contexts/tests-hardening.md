# tests-hardening — STATE_NAME

**Phase:** tests · **Kind:** work · **Depends on:** plugin-audit, storage-audit, tools-audit, cli-audit · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

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

<footguns, ordering constraints, non-obvious decisions>
