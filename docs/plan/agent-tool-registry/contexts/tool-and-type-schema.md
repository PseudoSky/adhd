# tool-and-type-schema — STATE_NAME

**Phase:** schema · **Kind:** work · **Depends on:** scaffold-package · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [tool-and-type-schema.1] tool_types lookup table (text PK, not enum)

- [tool-and-type-schema.2] tools table
---

## Reservations

```text
read_only:  ["packages/ai/agent-tool-registry/src/db/client.ts"]
mutates:    ["packages/ai/agent-tool-registry/src/db/schema.ts", "packages/ai/agent-tool-registry/src/store/tool-store.ts", "packages/ai/agent-tool-registry/src/index.ts", "packages/ai/agent-tool-registry/src/__tests__/tool-store.test.ts", "packages/ai/agent-tool-registry/drizzle"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
