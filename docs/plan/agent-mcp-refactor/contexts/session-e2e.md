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

_No criteria yet._

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp/src/__tests__/session-compiler-e2e.test.ts", "packages/ai/agent-mcp/src/__tests__/cache-reuse.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
