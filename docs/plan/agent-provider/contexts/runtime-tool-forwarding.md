# runtime-tool-forwarding — STATE_NAME

**Phase:** runtime · **Kind:** work · **Depends on:** provider-adapter-contract · **Guard:** `true`

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
read_only:  ["packages/ai/agent-provider/src/store/tool-format-store.ts", "packages/ai/agent-mcp-types/src/domain.ts"]
mutates:    ["packages/ai/agent-provider/src/runtime/emit-tools.ts", "packages/ai/agent-provider/src/index.ts", "packages/ai/agent-provider/src/__tests__/emit-tools.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
