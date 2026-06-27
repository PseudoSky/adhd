# dotenv-dual-load — STATE_NAME

**Phase:** env · **Kind:** work · **Depends on:** unified-credential-contract · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/dotenv-load.test.ts`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [dotenv-dual-load.1] the env loader targets .adhd/agent-mcp/.env (project + home)

- [dotenv-dual-load.2] .env.example documents the unified credential shape
---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp/src/index.ts", "packages/ai/agent-mcp/src/utils/load-env.ts", "packages/ai/agent-mcp/.env.example", "packages/ai/agent-mcp/src/__tests__/dotenv-load.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
