# State: stop-reason-types

## Goal

Add `stopReason?: string`, `maxTokens?: number`, `cacheReadTokens?: number`, and `cacheCreationTokens?: number` optional fields to `TokenUsage` in `agent-mcp-types`. Add all new error codes (`CONTEXT_WINDOW_EXCEEDED`, `PROVIDER_TIMEOUT`, `PROVIDER_AUTH_ERROR`, `PROVIDER_RATE_LIMITED`) to `AgentMcpErrorCode`. Rebuild the package so downstream states compile against the updated types.

## Semantic distillation

All Gap #6, Gap #7, and error-code additions require type-level changes in `agent-mcp-types`. Doing them in a single state avoids a partial rebuild. All new fields are optional so all existing callers compile unchanged. Cache token fields are added here so `cache-tokens` state can use them without a second types rebuild.

## File ownership

**mutates:**
- `packages/ai/agent-mcp-types/src/domain.ts`
- `packages/ai/agent-mcp-types/src/errors.ts`
- `packages/ai/agent-mcp-types/src/index.ts`

**read_only:**
- `packages/ai/agent-mcp-types/src/hooks.ts` (PostModelResponsePayload already has `tokenUsage?: TokenUsage` — no change needed)

## Contract

**Modified: `packages/ai/agent-mcp-types/src/domain.ts`**

```typescript
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  stopReason?: string;            // ← add: normalised stop reason (see [ref:normalised-stop-reason])
  maxTokens?: number;             // ← add: configured max_tokens from agent provider config
  cacheReadTokens?: number;       // ← add: Anthropic cache_read_input_tokens (undefined for other providers)
  cacheCreationTokens?: number;   // ← add: Anthropic cache_creation_input_tokens (undefined for other providers)
}
```

**Modified: `packages/ai/agent-mcp-types/src/errors.ts`**

Add all new error codes to the `AgentMcpErrorCode` union:

```typescript
export type AgentMcpErrorCode =
  | "AGENT_NOT_FOUND"
  // ... existing values ...
  | "PROVIDER_ERROR"
  | "MCP_CLIENT_ERROR"
  | "VALIDATION_ERROR"
  | "CONTEXT_WINDOW_EXCEEDED"   // ← add
  | "PROVIDER_TIMEOUT"          // ← add
  | "PROVIDER_AUTH_ERROR"       // ← add
  | "PROVIDER_RATE_LIMITED";    // ← add
```

**Modified: `packages/ai/agent-mcp-types/src/index.ts`**

Add a barrel-visible type alias so the new fields appear in the compiled `index.d.ts`:

```typescript
/** Confirms that stopReason, maxTokens, and cache fields are part of the public TokenUsage API. */
export type TokenUsageExtShape = {
  stopReason?: string;
  maxTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};
```

## Acceptance criteria

[stop-reason-types.1] `stopReason` appears in the compiled `dist/packages/ai/agent-mcp-types/src/domain.d.ts`

[stop-reason-types.2] `maxTokens` appears inside the `TokenUsage` interface in `domain.ts` (not only in `ProviderConfig`)

[stop-reason-types.3] `CONTEXT_WINDOW_EXCEEDED` appears in `packages/ai/agent-mcp-types/src/errors.ts`

[stop-reason-types.4] `npx nx build agent-mcp-types` exits 0 (package compiles cleanly)

[stop-reason-types.5] `PROVIDER_TIMEOUT` appears in `packages/ai/agent-mcp-types/src/errors.ts`

[stop-reason-types.6] `PROVIDER_AUTH_ERROR` appears in `packages/ai/agent-mcp-types/src/errors.ts`

[stop-reason-types.7] `PROVIDER_RATE_LIMITED` appears in `packages/ai/agent-mcp-types/src/errors.ts`

[stop-reason-types.8] `cacheReadTokens` appears in the `TokenUsage` interface in `domain.ts`

## Commit points

**R1:** commit each plan file as it is written (already done by the planner).

**R2 (post-guard):**
```
chore(agent-mcp-types): add stopReason/maxTokens/cacheTokens to TokenUsage; add new error codes
```

## Notes

- `maxTokens` in `TokenUsage` is NOT the same as `maxTokens` in `ProviderConfig`. One is a runtime observation (what was configured when the task ran), the other is agent configuration. When grepping, ensure you find it in the `TokenUsage` interface block specifically.
- The `stopReason` type is `string` not a union literal — this keeps the field flexible if new providers add new stop reasons. The four normalised values are a convention, not enforced by the type.
- `cacheReadTokens` and `cacheCreationTokens` are Anthropic-specific. Other providers will leave them `undefined`.
- After the guard passes, do NOT immediately move on. Verify that `npx nx build agent-mcp` (the consuming package) still compiles — it should since the changes are additive.
