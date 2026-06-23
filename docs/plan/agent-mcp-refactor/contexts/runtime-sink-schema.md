# runtime-sink-schema — STATE_NAME

**Phase:** schema · **Kind:** work · **Depends on:** refactor-design · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/composed-prompt-schema.test.ts`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [runtime-sink-schema.1] composed_prompts cache table in schema

- [runtime-sink-schema.2] experiment_assignments table in schema
- [runtime-sink-schema.3] sessions.composed_prompt_id FK column in schema
- [runtime-sink-schema.4] a drizzle migration file exists for the new tables/column
---

## Reservations

```text
read_only:  ["docs/plan/agent-mcp-refactor/decisions.md", "packages/ai/agent-mcp/src/store/session-store.ts"]
mutates:    ["packages/ai/agent-mcp/src/db/schema.ts", "packages/ai/agent-mcp/src/store/composed-prompt-store.ts", "packages/ai/agent-mcp/src/index.ts", "packages/ai/agent-mcp/drizzle", "packages/ai/agent-mcp/src/__tests__/composed-prompt-schema.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
