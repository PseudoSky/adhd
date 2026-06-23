# compiler-integration — STATE_NAME

**Phase:** integration · **Kind:** work · **Depends on:** runtime-sink-schema · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/compiler-resolve.test.ts`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [compiler-integration.1] prompt-resolver imports compileAgent from @adhd/agent-compiler

---

## Reservations

```text
read_only:  ["docs/plan/agent-mcp-refactor/decisions.md", "packages/ai/agent-mcp/src/store/composed-prompt-store.ts", "packages/ai/agent-mcp/src/db/schema.ts", "packages/ai/agent-mcp-types/src/domain.ts"]
mutates:    ["packages/ai/agent-mcp/src/engine/prompt-resolver.ts", "packages/ai/agent-mcp/src/tools/session.ts", "packages/ai/agent-mcp/src/store/session-store.ts", "packages/ai/agent-mcp/src/index.ts", "packages/ai/agent-mcp/src/__tests__/compiler-resolve.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
