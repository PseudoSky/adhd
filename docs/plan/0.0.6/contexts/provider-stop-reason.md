# State: provider-stop-reason

## Goal

Extract `finish_reason` / `stop_reason` from the provider SDK response and map it to the normalised four-value enum (see [ref:normalised-stop-reason] in `_shared.md`). Populate `usage.stopReason` and `usage.maxTokens` in both OpenAI and Anthropic providers.

## Semantic distillation

The OpenAI provider already binds `const sdkUsage = response.usage` (see [ref:drizzle-upsert-increment]) and returns `usage: { inputTokens, outputTokens }`. This state adds `stopReason` and `maxTokens` to that return. Anthropic follows the same pattern. LMStudio inherits OpenAI changes. claudecli is untouched (returns `undefined` for usage).

## File ownership

**mutates:**
- `packages/ai/agent-mcp/src/providers/openai.ts`
- `packages/ai/agent-mcp/src/providers/anthropic.ts`

**read_only:**
- `packages/ai/agent-mcp/src/providers/types.ts` (ProviderChatResponse.usage?: TokenUsage — no change needed, TokenUsage now has the new fields)
- `packages/ai/agent-mcp-types/src/domain.ts` (TokenUsage definition — updated in stop-reason-types)
- `packages/ai/agent-mcp/src/providers/lmstudio.ts` (extends OpenAIProvider — inherits automatically)

## Contract

**Modified: `packages/ai/agent-mcp/src/providers/openai.ts`**

In the `run()` function, after binding `const sdkUsage = response.usage`:

```typescript
// Map finish_reason to normalised StopReason (see [ref:normalised-stop-reason])
const STOP_REASON: Record<string, string> = {
  stop: "stop", length: "length", tool_calls: "tool_calls",
};
const rawFinishReason = choice?.finish_reason ?? null;
const normalisedStopReason: string = STOP_REASON[rawFinishReason ?? ""] ?? "unknown";

return {
  message,
  stopReason: toolCalls.length > 0 ? "tool_calls" : "completed",
  usage: sdkUsage
    ? {
        inputTokens: sdkUsage.prompt_tokens,
        outputTokens: sdkUsage.completion_tokens,
        stopReason: normalisedStopReason,
        maxTokens: this.config.maxTokens,
      }
    : undefined,
};
```

**Modified: `packages/ai/agent-mcp/src/providers/anthropic.ts`**

In the `run()` function, after the existing `const sdkUsage = response.usage` binding:

```typescript
const STOP_REASON: Record<string, string> = {
  end_turn: "stop", max_tokens: "length", tool_use: "tool_calls",
};
const normalisedStopReason: string = STOP_REASON[response.stop_reason ?? ""] ?? "unknown";

return {
  message,
  stopReason: toolCalls.length > 0 ? "tool_calls" : "completed",
  usage: {
    inputTokens: sdkUsage.input_tokens,
    outputTokens: sdkUsage.output_tokens,
    stopReason: normalisedStopReason,
    maxTokens: this.config.maxTokens,
  },
};
```

## Acceptance criteria

[provider-stop-reason.1] `finish_reason` is accessed from `choice` in `openai.ts` (the SDK field name)

[provider-stop-reason.2] `stopReason` is set on the `usage` return value in `openai.ts`

[provider-stop-reason.3] `stop_reason` is accessed from `response` in `anthropic.ts`

[provider-stop-reason.4] `stopReason` is set on the `usage` return value in `anthropic.ts`

## Commit points

**R2 (post-guard):**
```
feat(agent-mcp): extract normalised stop_reason from OpenAI and Anthropic providers
```

## Notes

- `this.config.maxTokens` is `number | undefined` in both configs — pass as-is. TypeScript accepts `undefined` for an optional field.
- The `STOP_REASON` lookup object should be defined as a `const` inside the `run()` closure or at module level — do not use a long switch statement.
- `ProviderChatResponse.stopReason` (the existing field, `"completed" | "tool_calls"`) is DIFFERENT from `TokenUsage.stopReason` (the new field). The former controls the orchestrator loop; the latter is an observational field for usage tracking. Do not confuse them.
- For OpenAI: `choice?.finish_reason` is `string | null` — handle `null` as `"unknown"`.
- For Anthropic: `response.stop_reason` is typed by the SDK — bind it before the return to avoid repeated property access.
