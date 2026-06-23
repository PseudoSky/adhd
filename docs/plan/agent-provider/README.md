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

- `[dod.2]` **The tool-format emitter produces an Anthropic type-tagged server-side entry for a server-side-bound tool and throws an explicit, actionable error for an unsupported native tool (FEAT-007 cheap win + gated error). (behavioral)** — The tool-format emitter produces an Anthropic type-tagged server-side entry for a server-side-bound tool and throws an explicit, actionable error for an unsupported native tool (FEAT-007 cheap win + gated error)..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `npx --yes nx test agent-provider --testFile=packages/ai/agent-provider/src/__tests__/emit-tools.test.ts`
  - observable: `vitest exits 0 and emit-tools.test.ts asserts a server-side-bound tool emits a {type:'web_search_...'} entry (NOT a custom {name,description,input_schema}) and an unsupported native (OpenAI built-in / Anthropic client-exec) makes the emitter throw an explicit error naming the tool`
  - delivered-by: `provider-tool-formats, runtime-tool-forwarding`
