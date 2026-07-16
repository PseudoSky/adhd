# Shared context — Agent Provider Unified Credentialing

> Single source of truth for definitions. Reference entries here from any
> context file instead of restating them.

## Glossary

- **[def:credentialEnv]** — A single optional `credentialEnv: string` field on a
  provider config that names the env var holding the credential. It **replaces**
  the two legacy fields `apiKeyEnv` (→ `x-api-key`) and `authTokenEnv` (→
  `Authorization: Bearer`). The provider **infers** the wire form from the value;
  the caller no longer chooses key-vs-token.
- **[def:credentialType]** — An optional escape-hatch override
  `credentialType?: "api_key" | "auth_token"` for an ambiguous value. Inference is
  the default; this only forces it.
- **[def:wire-form-inference]** — How each provider maps a credential value to a
  transport header. `openai`: always `apiKey` (Bearer; one mode).
  `anthropic`: `sk-ant-api…` → `apiKey` (`x-api-key`); `sk-ant-oat…` → `authToken`
  (`Authorization: Bearer` + the `oauth-2025-04-20` beta header); otherwise default
  `apiKey`. `claudecli`: n/a (local CLI auth). See [ref:credential-inference-idiom].
- **[def:dual-env-load]** — A deterministic replacement for bare `import "dotenv/config"`:
  `dotenv.config()` over `<project>/.adhd/agent-mcp/.env` **then** `~/.adhd/agent-mcp/.env`,
  where **project overrides home**. Both destinations are gitignored. Secrets live
  ONLY in these `.env` files; `.mcp.json` carries none.
- **[def:normalize-on-load]** — A zod `preprocess` step on the provider-config parse
  that rewrites legacy stored rows into the canonical unified shape **before**
  validation, so old `agents.db` rows keep working with no data migration:
  `type:"lmstudio"` → `type:"openai"` (`baseURL ??= LMSTUDIO_BASE_URL`,
  `credentialEnv ??= "LMSTUDIO_API_KEY"`); `apiKeyEnv`/`authTokenEnv` → `credentialEnv`
  (prefer `apiKeyEnv`, else `authTokenEnv`).
- **[def:fail-loud]** — When an `openai` provider has a **non-localhost** `baseURL`
  and resolves **no** credential, construction/first-call throws
  `no credential for openai provider at <baseURL>; set <credentialEnv>` — instead of
  the old silent `?? "lmstudio"` placeholder that 401s a real authed endpoint. A
  genuine no-auth local server sets any non-empty value explicitly in `.env`.

## Type shapes

- **[shape:unified-provider-config]** — the canonical post-change union (in
  `@adhd/agent-mcp-types/src/domain.ts`, mirrored by the agent-mcp zod schema):
  ```ts
  | { type: "anthropic"; model: string; credentialEnv?: string; credentialType?: "api_key"|"auth_token"; useClaudeOauth?: boolean; baseURL?: string; temperature?: number; maxTokens?: number; timeoutMs?: number; retryConfig?: RetryConfig }
  | { type: "openai";    model: string; credentialEnv?: string; credentialType?: "api_key"|"auth_token"; baseURL?: string; temperature?: number; maxTokens?: number; timeoutMs?: number; retryConfig?: RetryConfig }
  | { type: "claudecli"; model?: string; claudePath?: string; baseURL?: string; timeoutMs?: number; allowedBuiltinTools?: string[]; systemPromptIsAgentSpec?: boolean }
  ```
  `useClaudeOauth` is kept unchanged (a credential *source*, orthogonal to
  key-vs-token). There is **no** `lmstudio` member. `apiKeyEnv`/`authTokenEnv` are
  gone from the canonical shape but still accepted on input via [def:normalize-on-load].

## Cross-cutting invariants

- **[inv:multi-key]** — `credentialEnv` is per-agent provider config, so N agents
  reference N distinct env vars with no global limit. Anthropic can hold 2+ keys
  concurrently (agent A `ANTHROPIC_KEY_PROD`, agent B `ANTHROPIC_KEY_DEV`). Do not
  re-introduce a global single-key alias.
- **[inv:no-tracked-secrets]** — No credential value appears in any git-tracked
  file (incl. `docs/mcp-env/PROPOSAL.md`). Secrets live only in gitignored `.env`.
  Verified by `scripts/check-no-secrets.sh`.
- **[inv:lmstudio-gone]** — After the runtime phase the string `lmstudio` survives
  **only** as the retained env-var names `LMSTUDIO_API_KEY` / `LMSTUDIO_BASE_URL`
  (back-compat) and in prose/docs. It is gone as a provider *type* from the union,
  the zod schema, the factory, the registry seed, and the `?? "lmstudio"` placeholder.
- **[inv:build-green-on-removal]** — The `lmstudio` union member in `domain.ts` may
  only be removed **together with** every runtime reference (lmstudio.ts, factory
  case, validation schema). That is why the member-removal lands in
  `lmstudio-removal`, not the additive `unified-credential-contract` state — removing
  it earlier would break `nx build agent-mcp`.

## Reference patterns

- **[ref:credential-inference-idiom]** — see `references.json`. The existing
  `sk-ant-oat`-prefix detection in `anthropic.ts` (the `authToken.startsWith("sk-ant-oat")`
  branch + `defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" }`) is the idiom the
  unified inference must preserve and drive from `credentialEnv`.
- **[ref:provider-discriminated-union]** — see `references.json`. The
  `z.discriminatedUnion("type", […])` in `validation/agent.ts` and the `ProviderConfig`
  union in `domain.ts` must stay in lock-step (the seam in [def:normalize-on-load]).
