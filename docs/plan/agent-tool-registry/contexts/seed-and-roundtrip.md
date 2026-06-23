# seed-and-roundtrip — STATE_NAME

**Phase:** seed · **Kind:** work · **Depends on:** audit-schema · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [seed-and-roundtrip.1] seed + reopen + idempotency + binding-resolution round-trip suite passes

---

## Reservations

```text
read_only:  ["packages/ai/agent-tool-registry/src/store/tool-store.ts", "packages/ai/agent-tool-registry/src/store/binding-store.ts", "packages/ai/agent-tool-registry/src/db/schema.ts"]
mutates:    ["packages/ai/agent-tool-registry/src/seed/tool-types.ts", "packages/ai/agent-tool-registry/src/seed/platforms.ts", "packages/ai/agent-tool-registry/src/seed/tools.ts", "packages/ai/agent-tool-registry/src/seed/bindings.ts", "packages/ai/agent-tool-registry/src/seed/index.ts", "packages/ai/agent-tool-registry/src/__tests__/roundtrip.test.ts", "packages/ai/agent-tool-registry/src/index.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
