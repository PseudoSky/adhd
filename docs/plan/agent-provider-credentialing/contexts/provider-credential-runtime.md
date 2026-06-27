# provider-credential-runtime — STATE_NAME

**Phase:** runtime · **Kind:** work · **Depends on:** unified-credential-contract · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/credential-inference.test.ts`

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
mutates:    ["packages/ai/agent-mcp/src/providers/openai.ts", "packages/ai/agent-mcp/src/providers/anthropic.ts", "packages/ai/agent-mcp/src/providers/claudecli.ts", "packages/ai/agent-mcp/src/validation/agent.ts", "packages/ai/agent-mcp/src/__tests__/credential-inference.test.ts", "packages/ai/agent-mcp/src/__tests__/integration/openai-compat-roundtrip.e2e.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
