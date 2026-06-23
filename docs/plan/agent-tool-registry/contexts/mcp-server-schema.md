# mcp-server-schema — STATE_NAME

**Phase:** schema · **Kind:** work · **Depends on:** platform-and-binding-schema · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [mcp-server-schema.1] mcp_servers table with transport

---

## Reservations

```text
read_only:  ["packages/ai/agent-tool-registry/src/store/tool-store.ts"]
mutates:    ["packages/ai/agent-tool-registry/src/db/schema.ts", "packages/ai/agent-tool-registry/src/store/mcp-server-store.ts", "packages/ai/agent-tool-registry/src/index.ts", "packages/ai/agent-tool-registry/src/__tests__/mcp-server-store.test.ts", "packages/ai/agent-tool-registry/drizzle"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
