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
