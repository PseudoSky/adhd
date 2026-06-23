# session-e2e — STATE_NAME

**Phase:** e2e · **Kind:** work · **Depends on:** audit-integration · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/session-compiler-e2e.test.ts`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [session-e2e.1] e2e: real session start resolves systemPrompt == compileAgent(...) output (real DB, LLM boundary mocked)

- [session-e2e.2] cache: second session with same agent+context reuses composed_prompt (no recompile; proven by reopen)
- [session-e2e.3] negative-control: breaking the compiler call in prompt-resolver turns the e2e clause RED
- [session-e2e.4] non-regression: full agent-mcp unit suite still passes after the refactor
---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src/engine/prompt-resolver.ts", "packages/ai/agent-mcp/src/store/composed-prompt-store.ts", "packages/ai/agent-mcp/src/store/session-store.ts", "packages/ai/agent-mcp/src/tools/session.ts", "packages/ai/agent-mcp/src/db/schema.ts"]
mutates:    ["packages/ai/agent-mcp/src/__tests__/session-compiler-e2e.test.ts", "packages/ai/agent-mcp/src/__tests__/cache-reuse.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
