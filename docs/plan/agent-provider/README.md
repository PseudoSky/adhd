# Agent Registry — Provider Registry (@adhd/agent-provider)

<one-paragraph statement of what this plan delivers>

## Consumer

<who walks through the change, and in what role>

## Value delta

<the observable before → after change the consumer experiences>

## Definition of Done

- `[dod.1]` **A canonical model id resolves to the correct provider-specific string per platform via model_platform_bindings, proven after DB reopen. (behavioral)** — A canonical model id resolves to the correct provider-specific string per platform via model_platform_bindings, proven after DB reopen..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `npx --yes nx test agent-provider --testFile=packages/ai/agent-provider/src/__tests__/binding-store.test.ts`
  - observable: `vitest exits 0 and the binding-store.test.ts case resolves claude_opus_4_8 to claude-opus-4-8 (claude_api) AND opus (claude_code) after closing and reopening the store from the same file path`
  - delivered-by: `model-platform-bindings, seed-and-roundtrip`
