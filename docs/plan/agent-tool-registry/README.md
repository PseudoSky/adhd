# Agent Registry — Tool & Platform Registry (@adhd/agent-tool-registry)

<one-paragraph statement of what this plan delivers>

## Consumer

<who walks through the change, and in what role>

## Value delta

<the observable before → after change the consumer experiences>

## Definition of Done

- `[dod.1]` **A canonical tool resolves to its platform-specific name via tool_platform_bindings after DB reopen (e.g. shell_exec to Bash on claude_code) (behavioral)** — A canonical tool resolves to its platform-specific name via tool_platform_bindings after DB reopen (e.g. shell_exec to Bash on claude_code).
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `npx --yes nx test agent-tool-registry --testFile=packages/ai/agent-tool-registry/src/__tests__/binding-store.test.ts`
  - observable: `vitest exits 0; BindingStore.resolve('shell_exec','claude_code') returns 'Bash' after the DB is closed and reopened from the same file path`
  - delivered-by: `platform-and-binding-schema, seed-and-roundtrip`

- `[dod.2]` **Seeding the tool catalog + platform bindings is idempotent and round-trips after reopen (behavioral)** — Seeding the tool catalog + platform bindings is idempotent and round-trips after reopen.
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `npx --yes nx test agent-tool-registry --testFile=packages/ai/agent-tool-registry/src/__tests__/roundtrip.test.ts`
  - observable: `vitest exits 0; after seed() runs twice the tool/binding row counts are identical, and a canonical tool resolves to its alias after reopen`
  - delivered-by: `seed-and-roundtrip`

- `[dod.3]` **An agent_tools junction grants a tool at a permission level, queryable back through the store (behavioral)** — An agent_tools junction grants a tool at a permission level, queryable back through the store.
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `npx --yes nx test agent-tool-registry --testFile=packages/ai/agent-tool-registry/src/__tests__/agent-tool-store.test.ts`
  - observable: `vitest exits 0; AgentToolStore.grant(agent,tool,'read_only') then listForAgent(agent) returns the tool at permission 'read_only' after reopen`
  - delivered-by: `agent-tool-junction`

- `[dod.4]` **@adhd/agent-tool-registry is a platform:node Nx library registered in tsconfig.base.json that builds clean and imports no browser code (structural)** — @adhd/agent-tool-registry is a platform:node Nx library registered in tsconfig.base.json that builds clean and imports no browser code.

- `[dod.5]` **The Drizzle schema contains tools, platforms, tool_platform_bindings, mcp_servers, and agent_tools tables with required fields; tool_types is a seeded text-PK lookup table, not a SQL enum (structural)** — The Drizzle schema contains tools, platforms, tool_platform_bindings, mcp_servers, and agent_tools tables with required fields; tool_types is a seeded text-PK lookup table, not a SQL enum.
