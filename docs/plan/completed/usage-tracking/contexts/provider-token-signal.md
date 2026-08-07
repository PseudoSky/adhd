# State: provider-token-signal

**Phase:** foundation  
**Kind:** work  
**Depends on:** —

## Goal

Add `usage?: TokenUsage` to `ProviderChatResponse` and populate it from the OpenAI and Anthropic SDK responses. claudecli returns `undefined` — correct and expected.

## Semantic distillation

Two SDK objects carry token data we currently discard:

- `openai.ts` line 92: `const response = await this.client.chat.completions.create(...)` — `response.usage` has `{ prompt_tokens, completion_tokens, total_tokens }`. Map to `{ inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens }`.
- `anthropic.ts` line 270: `const response = await this.client.messages.create(...)` — `response.usage` has `{ input_tokens, output_tokens }`. Map to `{ inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }`.

No change needed to claudecli or lmstudio (lmstudio is an alias for openai — it inherits the change automatically via `LmStudioProvider extends OpenAIProvider`).

The `TokenUsage` interface is new. **It must be defined in `packages/ai/agent-mcp-types/src/domain.ts`** — not in `providers/types.ts`. Reason: `hooks.ts` (in agent-mcp-types) imports from `./domain.js` and will need `TokenUsage` for `PostModelResponsePayload.tokenUsage?`. Defining it in `domain.ts` means both hooks.ts and providers/types.ts can import from the same canonical location without any cross-package circular dependency. `providers/types.ts` imports `TokenUsage` from `@adhd/agent-mcp-types`.

## Reservations

```text
read_only:  ["packages/ai/agent-mcp-types/src/index.ts",
             "packages/ai/agent-mcp-types/src/hooks.ts",
             "packages/ai/agent-mcp/src/providers/index.ts",
             "packages/ai/agent-mcp/src/engine/orchestrator.ts",
             "packages/ai/agent-mcp/src/providers/lmstudio.ts",
             "packages/ai/agent-mcp/src/providers/claudecli.ts"]
mutates:    ["packages/ai/agent-mcp-types/src/domain.ts",
             "packages/ai/agent-mcp/src/providers/types.ts",
             "packages/ai/agent-mcp/src/providers/openai.ts",
             "packages/ai/agent-mcp/src/providers/anthropic.ts"]
```

Notes: `index.ts` already re-exports everything from `domain.ts` — no change needed. `lmstudio.ts` inherits `chat()` from OpenAIProvider automatically. `claudecli.ts` returns undefined usage — by design.

## Contract promise

**Added:**
- `TokenUsage` interface in `packages/ai/agent-mcp-types/src/domain.ts`, auto-exported via existing `export * from "./domain.js"` in agent-mcp-types/src/index.ts
- `ProviderChatResponse.usage?: TokenUsage` in `providers/types.ts` (imports `TokenUsage` from `@adhd/agent-mcp-types`)

**Modified:**
- `openai.ts`: `chat()` return now includes `usage: response.usage ? { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens } : undefined`
- `anthropic.ts`: `chat()` return now includes `usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }`

**Deleted:** nothing

## Acceptance criteria

```bash
# [provider-token-signal.1] TokenUsage type visible in compiled types
# vite-dts emits a barrel index.d.ts that re-exports from domain.d.ts — grep the whole dist tree
cd /Users/nix/dev/node/adhd
npx nx build agent-mcp-types --skip-nx-cache 2>/dev/null
grep -rq 'TokenUsage' dist/packages/ai/agent-mcp-types/

# [provider-token-signal.2] ProviderChatResponse.usage field present in compiled types
npx nx build agent-mcp --skip-nx-cache 2>/dev/null
grep -n 'usage' dist/packages/ai/agent-mcp/src/providers/types.d.ts | grep -q 'TokenUsage'

# [provider-token-signal.3] openai.ts returns usage in return statement
grep -n 'usage' packages/ai/agent-mcp/src/providers/openai.ts | grep -q 'inputTokens'

# [provider-token-signal.4] anthropic.ts returns usage in return statement
grep -n 'usage' packages/ai/agent-mcp/src/providers/anthropic.ts | grep -q 'inputTokens'

# [provider-token-signal.5] Existing tests still pass
npx nx test agent-mcp 2>&1 | tail -5 | grep -q 'pass\|PASS'
```

## Commit points

**R1 (plan write):** Each plan file edit is committed before continuing.

**R2 (work product):** After guard exits 0, commit:
```
feat(agent-mcp): add TokenUsage to ProviderChatResponse; populate from OpenAI/Anthropic SDK
```
Single commit covering all four file changes.

## Notes

`lmstudio.ts` is a thin subclass that calls `super(config)` with a cast — it inherits `chat()` from OpenAIProvider, so the usage field is populated automatically. Verify with `grep -n 'class LmStudio' packages/ai/agent-mcp/src/providers/lmstudio.ts`.

The `agent-mcp-types` package index (`packages/ai/agent-mcp-types/src/index.ts`) may need a `export type { TokenUsage }` line added. Check before writing — it may already re-export everything from `hooks.ts`.

Do not add `TokenUsage` to `hooks.ts` content yet — it's defined in `providers/types.ts` and re-exported from agent-mcp-types. The hook payload change is the next state.
