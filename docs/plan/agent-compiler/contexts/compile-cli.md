# compile-cli — STATE_NAME

**Phase:** cli · **Kind:** work · **Depends on:** platform-markdown-emit · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [compile-cli.1] CLI parses --platform/--context/--out-dir/--all

---

## Reservations

```text
read_only:  ["packages/ai/agent-compiler/src/compile.ts"]
mutates:    ["packages/ai/agent-compiler/src/cli/compile.ts", "packages/ai/agent-compiler/src/index.ts", "packages/ai/agent-compiler/src/__tests__/compile-cli.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
