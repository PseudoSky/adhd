# model-and-policy-emit — STATE_NAME

**Phase:** resolve · **Kind:** work · **Depends on:** tool-header-emit · **Guard:** `true`

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
read_only:  ["packages/ai/agent-compiler/src/resolve/tools.ts"]
mutates:    ["packages/ai/agent-compiler/src/resolve/model.ts", "packages/ai/agent-compiler/src/resolve/policy.ts", "packages/ai/agent-compiler/src/index.ts", "packages/ai/agent-compiler/src/__tests__/model-policy.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
