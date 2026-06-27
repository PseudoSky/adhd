# Agent Provider — Unified Credentialing, baseURL Everywhere, lmstudio Removal, .env Standard

<one-paragraph statement of what this plan delivers>

## Consumer

<who walks through the change, and in what role>

## Value delta

<the observable before → after change the consumer experiences>

## Definition of Done

- `[dod.1]` **The unified provider contract (@adhd/agent-mcp-types domain.ts AND the agent-mcp zod schema) declares a single credentialEnv plus optional credentialType on openai+anthropic and baseURL on every provider; the lmstudio type is absent from the type union, the zod discriminated union, the provider factory, the registry seed, and there is no "?? \"lmstudio\"" placeholder anywhere. (structural) (structural)** — The unified provider contract (@adhd/agent-mcp-types domain.ts AND the agent-mcp zod schema) declares a single credentialEnv plus optional credentialType on openai+anthropic and baseURL on every provider; the lmstudio type is absent from the type union, the zod discriminated union, the provider factory, the registry seed, and there is no "?? \"lmstudio\"" placeholder anywhere. (structural).
