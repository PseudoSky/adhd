# Agent Registry — Composition & Compile Engine (@adhd/agent-compiler)

<one-paragraph statement of what this plan delivers>

## Consumer

<who walks through the change, and in what role>

## Value delta

<the observable before → after change the consumer experiences>

## Definition of Done

- `[dod.1]` **Compiling a seeded agent for claude_code emits markdown whose YAML frontmatter tools: is the platform-resolved set (from tool_platform_bindings) and whose body contains the components in junction order. (behavioral)** — Compiling a seeded agent for claude_code emits markdown whose YAML frontmatter tools: is the platform-resolved set (from tool_platform_bindings) and whose body contains the components in junction order..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `npx --yes nx test agent-compiler --testFile=packages/ai/agent-compiler/src/__tests__/compile-e2e.test.ts`
  - observable: `vitest exits 0; emitted claude_code markdown frontmatter tools: equals Read, Write, Bash resolved from tool_platform_bindings and the body sections follow junction position order`
  - delivered-by: `composition-resolve, tool-header-emit, platform-markdown-emit, compile-fixtures-e2e`

- `[dod.2]` **The SAME agent compiled with --context {ticket_type:security} includes the security success_criteria component and excludes the general one (context-conditional). (behavioral)** — The SAME agent compiled with --context {ticket_type:security} includes the security success_criteria component and excludes the general one (context-conditional)..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `npx --yes nx test agent-compiler --testFile=packages/ai/agent-compiler/src/__tests__/compile-e2e.test.ts`
  - observable: `vitest exits 0; with context security the compiled body contains the security-criteria component text and NOT the general review-criteria text; with the default context the inclusion flips`
  - delivered-by: `composition-resolve, platform-markdown-emit, compile-fixtures-e2e`

- `[dod.3]` **An attached policy's constraint appears in the compiled header/body of the emitted output. (behavioral)** — An attached policy's constraint appears in the compiled header/body of the emitted output..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `npx --yes nx test agent-compiler --testFile=packages/ai/agent-compiler/src/__tests__/compile-e2e.test.ts`
  - observable: `vitest exits 0; the compiled output contains the constraint text derived from the agent_policy row attached to the seeded agent (e.g. no-credentials)`
  - delivered-by: `model-and-policy-emit, platform-markdown-emit, compile-fixtures-e2e`
