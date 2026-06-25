# compat-shim — STATE_NAME

**Phase:** compat · **Kind:** work · **Depends on:** agent-define · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/systemprompt-compat.test.ts`

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
mutates:    ["packages/ai/agent-mcp/src/tools/agent-crud.ts", "packages/ai/agent-mcp/src/validation/agent.ts", "packages/ai/agent-mcp/src/tools/guide.ts", "packages/ai/agent-mcp/src/__tests__/systemprompt-compat.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
