# Agent Provider — Unified Credentialing, baseURL Everywhere, lmstudio Removal, .env Standard

<one-paragraph statement of what this plan delivers>

## Consumer

<who walks through the change, and in what role>

## Value delta

<the observable before → after change the consumer experiences>

## Definition of Done

- `[dod.1]` **The unified provider contract (@adhd/agent-mcp-types domain.ts AND the agent-mcp zod schema) declares a single credentialEnv plus optional credentialType on openai+anthropic and baseURL on every provider; the lmstudio type is absent from the type union, the zod discriminated union, the provider factory, the registry seed, and there is no "?? \"lmstudio\"" placeholder anywhere. (structural) (structural)** — The unified provider contract (@adhd/agent-mcp-types domain.ts AND the agent-mcp zod schema) declares a single credentialEnv plus optional credentialType on openai+anthropic and baseURL on every provider; the lmstudio type is absent from the type union, the zod discriminated union, the provider factory, the registry seed, and there is no "?? \"lmstudio\"" placeholder anywhere. (structural).

- `[dod.2]` **The anthropic adapter infers the credential wire form from the value: sk-ant-api… resolves to an x-api-key client and sk-ant-oat… resolves to an Authorization: Bearer client with the oauth-2025-04-20 beta header. (structural)** — The anthropic adapter infers the credential wire form from the value: sk-ant-api… resolves to an x-api-key client and sk-ant-oat… resolves to an Authorization: Bearer client with the oauth-2025-04-20 beta header..

- `[dod.3]` **A missing credential fails loud for a non-localhost openai baseURL instead of silently sending a placeholder. (structural)** — A missing credential fails loud for a non-localhost openai baseURL instead of silently sending a placeholder..
