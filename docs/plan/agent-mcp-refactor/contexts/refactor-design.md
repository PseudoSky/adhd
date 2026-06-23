# refactor-design — STATE_NAME

**Phase:** architecture · **Kind:** work · **Depends on:** none · **Guard:** `python3 docs/plan/agent-mcp-refactor/scripts/audit_mcp_refactor.py --phase architecture`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [refactor-design.1] decisions.md exists

- [refactor-design.2] AgentStore removal-vs-thin-cache decision recorded
- [refactor-design.3] session-start composed_prompt cache flow recorded
- [refactor-design.4] systemPrompt compat-shim policy recorded
---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src/store/agent-store.ts", "packages/ai/agent-mcp/src/store/session-store.ts", "packages/ai/agent-mcp/src/db/schema.ts", "packages/ai/agent-mcp/src/tools/task.ts", "packages/ai/agent-mcp/src/providers/claudecli.ts", "packages/ai/agent-mcp-types/src/domain.ts"]
mutates:    ["docs/plan/agent-mcp-refactor/decisions.md", "docs/plan/agent-mcp-refactor/contexts/refactor-design.md"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
