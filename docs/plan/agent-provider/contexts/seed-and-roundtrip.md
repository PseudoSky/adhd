# seed-and-roundtrip — STATE_NAME

**Phase:** seed · **Kind:** work · **Depends on:** runtime-tool-forwarding · **Guard:** `true`

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
read_only:  []
mutates:    ["packages/ai/agent-provider/src/seed/providers.ts", "packages/ai/agent-provider/src/seed/models.ts", "packages/ai/agent-provider/src/seed/bindings.ts", "packages/ai/agent-provider/src/seed/index.ts", "packages/ai/agent-provider/src/__tests__/roundtrip.test.ts", "packages/ai/agent-provider/src/index.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
