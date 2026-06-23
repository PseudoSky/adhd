# compile-fixtures-e2e — STATE_NAME

**Phase:** e2e · **Kind:** work · **Depends on:** audit-engine · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [compile-fixtures-e2e.1] seeds a real agent from shared components across four domains

---

## Reservations

```text
read_only:  ["packages/ai/agent-compiler/src/compile.ts", "packages/ai/agent-compiler/src/cli/compile.ts"]
mutates:    ["packages/ai/agent-compiler/src/seed/fixtures.ts", "packages/ai/agent-compiler/src/__tests__/compile-e2e.test.ts", "packages/ai/agent-compiler/src/index.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
