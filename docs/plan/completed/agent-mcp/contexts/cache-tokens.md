# State: cache-tokens

## Goal

Forward Anthropic cache token fields (`cache_read_input_tokens`, `cache_creation_input_tokens`) from the SDK response into `TokenUsage`. Add corresponding nullable integer columns to `task_usage`. Update `anthropic.ts` to use `AGENT_MCP_DEFAULT_MAX_TOKENS` as the fallback instead of the hard-coded `4096`.

## Semantic distillation

The Anthropic SDK returns `response.usage.cache_read_input_tokens` and `response.usage.cache_creation_input_tokens` (both `number | undefined`). Currently the provider ignores them. This state forwards both into `TokenUsage.cacheReadTokens` and `TokenUsage.cacheCreationTokens` (added to the interface in `stop-reason-types`). The schema migration adds two nullable integer columns and drizzle-kit generates the migration. The hard-coded `max_tokens: this.config.maxTokens ?? 4096` is replaced with `this.config.maxTokens ?? AGENT_MCP_DEFAULT_MAX_TOKENS`.

## File ownership

**mutates:**
- `packages/ai/agent-mcp/src/providers/anthropic.ts`
- `packages/ai/agent-mcp/src/db/schema.ts`
- `packages/ai/agent-mcp/drizzle/` (new migration or extended existing 0002 migration)

**read_only:**
- `packages/ai/agent-mcp-types/src/domain.ts` (TokenUsage already has cacheReadTokens? and cacheCreationTokens? from stop-reason-types)
- `packages/ai/agent-mcp/src/index.ts` (AGENT_MCP_DEFAULT_MAX_TOKENS exported from here after env-var-fixes)

## Contract

**Modified: `packages/ai/agent-mcp/src/providers/anthropic.ts`**

In the `run()` function, after `const sdkUsage = response.usage`:

```typescript
return {
  message,
  stopReason: toolCalls.length > 0 ? "tool_calls" : "completed",
  usage: {
    inputTokens: sdkUsage.input_tokens,
    outputTokens: sdkUsage.output_tokens,
    stopReason: normalisedStopReason,
    maxTokens: this.config.maxTokens ?? AGENT_MCP_DEFAULT_MAX_TOKENS,
    // Anthropic cache token fields — undefined on non-caching API tiers
    cacheReadTokens: sdkUsage.cache_read_input_tokens ?? undefined,
    cacheCreationTokens: sdkUsage.cache_creation_input_tokens ?? undefined,
  },
};
```

Also replace the `max_tokens` parameter in the `messages.create()` call:
```typescript
max_tokens: this.config.maxTokens ?? AGENT_MCP_DEFAULT_MAX_TOKENS,
```

Import the constant:
```typescript
import { AGENT_MCP_DEFAULT_MAX_TOKENS } from "../index.js";
```

**Modified: `packages/ai/agent-mcp/src/db/schema.ts`**

Add to `taskUsageTable` after the `maxTokens` column:
```typescript
// Anthropic prompt-caching tokens — null for other providers and non-caching tiers
cacheReadTokens: integer("cache_read_input_tokens"),
cacheCreationTokens: integer("cache_creation_input_tokens"),
```

**Generated: `packages/ai/agent-mcp/drizzle/` (updated or new migration)**

If `schema-migration` state already generated `0002_*.sql`, amend it (or generate `0003_*.sql`) to also include:
```sql
ALTER TABLE `task_usage` ADD `cache_read_input_tokens` integer;
ALTER TABLE `task_usage` ADD `cache_creation_input_tokens` integer;
```

Run: `cd packages/ai/agent-mcp && npx drizzle-kit generate`

## Acceptance criteria

[cache-tokens.1] `cacheReadTokens` appears in `TokenUsage` interface in `packages/ai/agent-mcp-types/src/domain.ts`

[cache-tokens.2] `cache_read_input_tokens` is forwarded in `packages/ai/agent-mcp/src/providers/anthropic.ts`

[cache-tokens.3] `cache_read_input_tokens` column is defined in `packages/ai/agent-mcp/src/db/schema.ts`

[cache-tokens.4] A drizzle migration adds the cache token columns (verified by migration file content)

[cache-tokens.5] `AGENT_MCP_DEFAULT_MAX_TOKENS` is used in `anthropic.ts` as the fallback for `max_tokens` (the old `4096` hard-code is removed)

## Commit points

**R2 (post-guard):**
```
feat(agent-mcp): forward Anthropic cache tokens; use AGENT_MCP_DEFAULT_MAX_TOKENS fallback
```

## Notes

- The Anthropic SDK types `cache_read_input_tokens` as `number` in some versions and `number | null | undefined` in others. Use `?? undefined` defensively to normalise nulls to undefined.
- `AGENT_MCP_DEFAULT_MAX_TOKENS` is exported from `index.ts` — importing it from there creates a potential circular dependency if `anthropic.ts` → `index.ts` → `providers/factory.ts` → `anthropic.ts`. To avoid this, consider moving the constant to a dedicated `packages/ai/agent-mcp/src/defaults.ts` file that `index.ts` also imports from. Document this in the commit message if you extract it.
- The `UsagePlugin` does not need changes for cache tokens — it writes `TokenUsage` fields to the DB but the new columns (`cacheReadTokens`, `cacheCreationTokens`) need to be included in the UPSERT values. Update the plugin accordingly as a sub-step.
