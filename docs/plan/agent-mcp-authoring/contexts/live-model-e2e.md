# live-model-e2e — STATE_NAME

**Phase:** e2e · **Kind:** work · **Depends on:** composition-journey-e2e · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/authoring-live-e2e.test.ts`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [live-model-e2e.1] AGENT_MCP_LIVE=1 real model through component_search->agent_define->agent->task; skips when unset; empty registry forces COMPONENT_NOT_FOUND

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp/src/__tests__/authoring-live-e2e.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
