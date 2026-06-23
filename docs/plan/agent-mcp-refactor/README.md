# agent-mcp Refactor — Consume @adhd/agent-compiler + @adhd/agent-registry

<one-paragraph statement of what this plan delivers>

## Consumer

<who walks through the change, and in what role>

## Value delta

<the observable before → after change the consumer experiences>

## Definition of Done

- `[dod.1]` **Starting a session against an agent resolves its systemPrompt from @adhd/agent-compiler output (real agent-mcp session-start path, real on-disk DB), asserted equal to compileAgent(...).content — not read from a stored user-authored flat blob. (behavioral)** — Starting a session against an agent resolves its systemPrompt from @adhd/agent-compiler output (real agent-mcp session-start path, real on-disk DB), asserted equal to compileAgent(...).content — not read from a stored user-authored flat blob..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/session-compiler-e2e.test.ts`
  - observable: `vitest exits 0 and case 'session systemPrompt equals compileAgent output' passes: it wires the REAL SessionStore + prompt-resolver + composed-prompt-store against an on-disk SQLite file, starts a session via the agent tool with the LLM provider mocked, and deep-equals the session's resolved systemPrompt to compileAgent({agentSlug,platform,context}).content.`
  - negative-control: `in prompt-resolver.ts replace the compileAgent call token with a stub returning a fixed string → the resolved systemPrompt no longer equals compileAgent output → the session-compiler-e2e.test.ts clause goes red.`
  - delivered-by: `runtime-sink-schema, compiler-integration, session-e2e`
