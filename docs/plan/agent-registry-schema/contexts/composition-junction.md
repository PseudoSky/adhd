# composition-junction — STATE_NAME

**Phase:** composition · **Kind:** work · **Depends on:** agent-and-taxonomy-schema · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [composition-junction.1] agent_components junction with position, version_pin, context_condition, is_required

- [composition-junction.2] resolveComposition reads ordered components
---

## Reservations

```text
read_only:  ["packages/ai/agent-registry/src/store/agent-store.ts", "packages/ai/agent-registry/src/store/component-store.ts"]
mutates:    ["packages/ai/agent-registry/src/db/schema.ts", "packages/ai/agent-registry/src/store/composition-store.ts", "packages/ai/agent-registry/src/index.ts", "packages/ai/agent-registry/src/__tests__/composition-store.test.ts", "packages/ai/agent-registry/drizzle"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
