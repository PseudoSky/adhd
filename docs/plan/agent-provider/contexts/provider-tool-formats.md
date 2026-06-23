# provider-tool-formats — STATE_NAME

**Phase:** schema · **Kind:** work · **Depends on:** model-platform-bindings · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [provider-tool-formats.1] provider_tool_formats table

- [provider-tool-formats.2] tool-format store test passes
---

## Reservations

```text
read_only:  ["packages/ai/agent-provider/src/store/provider-store.ts", "packages/ai/agent-provider/src/store/model-store.ts"]
mutates:    ["packages/ai/agent-provider/src/db/schema.ts", "packages/ai/agent-provider/src/store/tool-format-store.ts", "packages/ai/agent-provider/src/index.ts", "packages/ai/agent-provider/src/__tests__/tool-format-store.test.ts", "packages/ai/agent-provider/drizzle"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
