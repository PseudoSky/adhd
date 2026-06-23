# Agent Policy — Types, Templates, Inheritance & Enforcement (@adhd/agent-policy)

<one-paragraph statement of what this plan delivers>

## Consumer

<who walks through the change, and in what role>

## Value delta

<the observable before → after change the consumer experiences>

## Definition of Done

- `[dod.1]` **A mandatory policy attached to a taxonomy category is inherited by a NEW agent added to that category (queryable, inherited_from set) and survives a DB reopen. (behavioral)** — A mandatory policy attached to a taxonomy category is inherited by a NEW agent added to that category (queryable, inherited_from set) and survives a DB reopen..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `npx --yes nx test agent-policy --testFile=packages/ai/agent-policy/src/__tests__/inheritance.test.ts`
  - observable: `vitest exits 0 and the case 'new category member inherits the mandatory policy after reopen' passes`
  - delivered-by: `policy-design, scaffold-package, policy-type-and-template-schema, agent-policy-junction, policy-inheritance, seed-and-roundtrip`

- `[dod.2]` **A rate policy registered as an agent-mcp plugin enforces its limit by THROWING through the real IHookRegistry.enforce('pre:model_request'). (behavioral)** — A rate policy registered as an agent-mcp plugin enforces its limit by THROWING through the real IHookRegistry.enforce('pre:model_request')..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `npx --yes nx test agent-policy --testFile=packages/ai/agent-policy/src/__tests__/enforcement-plugin.test.ts`
  - observable: `vitest exits 0 and the case 'rate policy throws through real IHookRegistry.enforce(pre:model_request) when the limit is crossed' passes`
  - delivered-by: `scaffold-package, policy-type-and-template-schema, enforcement-plugin`

- `[dod.3]` **Seeding the policy templates (with multi-value enforcement JSON arrays) is idempotent and round-trips after reopen. (behavioral)** — Seeding the policy templates (with multi-value enforcement JSON arrays) is idempotent and round-trips after reopen..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `npx --yes nx test agent-policy --testFile=packages/ai/agent-policy/src/__tests__/roundtrip.test.ts`
  - observable: `vitest exits 0 and the cases 'policy template round-trips after reopen' and 'seed is idempotent on re-run' pass`
  - delivered-by: `policy-type-and-template-schema, seed-and-roundtrip`

- `[dod.4]` **@adhd/agent-policy is a platform:node Nx library registered in tsconfig.base.json paths that builds clean and imports no browser code. (structural)** — @adhd/agent-policy is a platform:node Nx library registered in tsconfig.base.json paths that builds clean and imports no browser code..

- `[dod.5]` **The schema contains policy_types (a lookup table, not a SQL enum), policy_templates, and agent_policy tables; the enforcement plugin follows the agent-mcp-budget contract (exports configSchema + createPlugin). (structural)** — The schema contains policy_types (a lookup table, not a SQL enum), policy_templates, and agent_policy tables; the enforcement plugin follows the agent-mcp-budget contract (exports configSchema + createPlugin)..
