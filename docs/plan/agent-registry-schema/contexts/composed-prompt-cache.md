# composed-prompt-cache — STATE_NAME

**Phase:** composition · **Kind:** work · **Depends on:** usecase-and-context-rules · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [composed-prompt-cache.1] composed_prompts table: agent slug, context hash, content, component versions JSON

- [composed-prompt-cache.2] composed-prompt-store cache lookup test passes
---

## Reservations

```text
read_only:  ["packages/ai/agent-registry/src/store/composition-store.ts"]
mutates:    ["packages/ai/agent-registry/src/db/schema.ts", "packages/ai/agent-registry/src/store/composed-prompt-store.ts", "packages/ai/agent-registry/src/index.ts", "packages/ai/agent-registry/src/__tests__/composed-prompt-store.test.ts", "packages/ai/agent-registry/drizzle"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
