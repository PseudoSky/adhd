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

- `[dod.2]` **A second session for the same agent+context HITS the composed_prompt cache: the compiler is not re-invoked and sessions.composed_prompt_id points at the cached row, proven by reopening the DB. (behavioral)** — A second session for the same agent+context HITS the composed_prompt cache: the compiler is not re-invoked and sessions.composed_prompt_id points at the cached row, proven by reopening the DB..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/cache-reuse.test.ts`
  - observable: `vitest exits 0 and case 'second session reuses cached composed_prompt without recompile' passes: it counts compileAgent invocations (1 across two session starts), reopens the DB from the same file path, and asserts both sessions' composed_prompt_id reference the same composed_prompts row.`
  - negative-control: `make prompt-resolver skip the cache lookup and always call compileAgent → the invocation count becomes 2 / a second composed_prompts row appears → cache-reuse.test.ts goes red.`
  - delivered-by: `runtime-sink-schema, compiler-integration, session-e2e`

- `[dod.3]` **All existing agent-mcp unit tests still pass after the refactor (non-regression across the full suite). (behavioral)** — All existing agent-mcp unit tests still pass after the refactor (non-regression across the full suite)..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `npx --yes nx test agent-mcp`
  - observable: `vitest exits 0 for the entire agent-mcp suite (gate on exit code, never stdout grep — better-sqlite3 can segfault on teardown); no pre-existing test is deleted to make it green.`
  - negative-control: `revert the compiler-integration resolver wiring so task.ts reads a now-absent flat systemPrompt → the existing session/task tests throw and the suite exits non-zero.`
  - delivered-by: `compiler-integration, agent-store-retire, policy-engine-bridge, session-e2e`

- `[dod.4]` **The flat-systemPrompt authoring / source-of-truth path is removed: AgentDefinition no longer requires a user-authored systemPrompt string; if retained, systemPrompt is a documented computed compat shim populated from compiler output. Proven by [agent-store-retire.1] (grep_absent of the required z.string() systemPrompt authoring field) + [agent-store-retire.2]. (structural)** — The flat-systemPrompt authoring / source-of-truth path is removed: AgentDefinition no longer requires a user-authored systemPrompt string; if retained, systemPrompt is a documented computed compat shim populated from compiler output. Proven by [agent-store-retire.1] (grep_absent of the required z.string() systemPrompt authoring field) + [agent-store-retire.2]..

- `[dod.5]` **The runtime sink schema gains sessions.composed_prompt_id (+ composed_prompts and experiment_assignments tables) and agent-mcp depends on @adhd/agent-compiler. Proven by [runtime-sink-schema.1..3] and [compiler-integration.4..5]. (structural)** — The runtime sink schema gains sessions.composed_prompt_id (+ composed_prompts and experiment_assignments tables) and agent-mcp depends on @adhd/agent-compiler. Proven by [runtime-sink-schema.1..3] and [compiler-integration.4..5]..

- `[dod.6]` **The already-shipped claudecli allowedBuiltinTools + systemPromptIsAgentSpec features are reconciled with the registry AGENT_TOOL/compiled-tools model rather than left as a competing third tool-permission model. Proven by [policy-engine-bridge.1..2]. (structural)** — The already-shipped claudecli allowedBuiltinTools + systemPromptIsAgentSpec features are reconciled with the registry AGENT_TOOL/compiled-tools model rather than left as a competing third tool-permission model. Proven by [policy-engine-bridge.1..2]..
