# tool-header-emit — STATE_NAME

**Phase:** resolve · **Kind:** work · **Depends on:** composition-resolve · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [tool-header-emit.1] joins tool_platform_bindings to build platform tools header

- [tool-header-emit.2] resolved tools header test passes
---

## Reservations

```text
read_only:  ["packages/ai/agent-compiler/src/resolve/composition.ts"]
mutates:    ["packages/ai/agent-compiler/src/resolve/tools.ts", "packages/ai/agent-compiler/src/index.ts", "packages/ai/agent-compiler/src/__tests__/tool-header.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
