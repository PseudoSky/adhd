# agent-define — STATE_NAME

**Phase:** authoring · **Kind:** work · **Depends on:** component-define · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/agent-define.test.ts`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [agent-define.1] agent_define declarative upsert: full-replace, version-bump-on-change, idempotent, compiled_preview+composed_prompt_id, typed *_NOT_FOUND errors

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp/src/tools/authoring.ts", "packages/ai/agent-mcp/src/registry/composition-writer.ts", "packages/ai/agent-mcp/src/server.ts", "packages/ai/agent-mcp/src/__tests__/agent-define.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
