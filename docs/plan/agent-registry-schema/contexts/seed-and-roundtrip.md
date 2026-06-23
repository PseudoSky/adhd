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

- [seed-and-roundtrip.1] seed + reopen + idempotency round-trip suite passes

- [seed-and-roundtrip.2] prompt-types seed lists every DATA_MODEL seed type
---

## Reservations

```text
read_only:  ["packages/ai/agent-registry/src/store/component-store.ts", "packages/ai/agent-registry/src/db/schema.ts"]
mutates:    ["packages/ai/agent-registry/src/seed/prompt-types.ts", "packages/ai/agent-registry/src/seed/components.ts", "packages/ai/agent-registry/src/seed/index.ts", "packages/ai/agent-registry/src/__tests__/roundtrip.test.ts", "packages/ai/agent-registry/src/index.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
