# policy-engine-bridge — STATE_NAME

**Phase:** integration · **Kind:** work · **Depends on:** agent-store-retire · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/policy-tool-reconcile.test.ts`

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
read_only:  ["docs/plan/agent-mcp-refactor/decisions.md", "packages/ai/agent-mcp/src/engine/prompt-resolver.ts"]
mutates:    ["packages/ai/agent-mcp/src/engine/policy.ts", "packages/ai/agent-mcp/src/providers/claudecli.ts", "packages/ai/agent-mcp/src/validation/agent.ts", "packages/ai/agent-mcp/src/__tests__/policy-tool-reconcile.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
