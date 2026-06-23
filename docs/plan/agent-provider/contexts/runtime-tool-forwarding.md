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

- [runtime-tool-forwarding.1] emitter branches on server-side type-tagged shape

- [runtime-tool-forwarding.2] emitter throws explicit actionable error for unsupported native
- [runtime-tool-forwarding.3] emit-tools test: server-side -> type-tagged entry; unsupported native -> explicit throw
- [runtime-tool-forwarding.4] FEAT-007 emitter has teeth: reverting to custom-only emission re-buries the server-side tool
---

## Reservations

```text
read_only:  ["packages/ai/agent-provider/src/store/tool-format-store.ts", "packages/ai/agent-mcp-types/src/domain.ts"]
mutates:    ["packages/ai/agent-provider/src/runtime/emit-tools.ts", "packages/ai/agent-provider/src/index.ts", "packages/ai/agent-provider/src/__tests__/emit-tools.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
