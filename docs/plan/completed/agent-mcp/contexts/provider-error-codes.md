# State: provider-error-codes

## Goal

Add `PROVIDER_TIMEOUT`, `PROVIDER_AUTH_ERROR`, and `PROVIDER_RATE_LIMITED` to both `AgentMcpErrorCode` (agent-mcp-types) and `errorCodeSchema` (agent-mcp). Fix the orchestrator catch block to throw `PROVIDER_TIMEOUT` on timeout. Add 401-detection in providers. Add 429/rate-limit detection after retry exhaustion.

## Semantic distillation

The orchestrator currently throws `PROVIDER_ERROR` for both timeouts and all other provider failures. This conflates distinct failure modes. Callers cannot distinguish "timed out — increase timeout" from "auth failed — check credentials" from "rate limited — back off". The fix dispatches to the correct code per [inv:provider-error-dispatch]. Both error type files must be updated simultaneously since `errorCodeSchema` must mirror `AgentMcpErrorCode` — they can diverge if only one is updated.

## File ownership

**mutates:**
- `packages/ai/agent-mcp-types/src/errors.ts`
- `packages/ai/agent-mcp/src/validation/errors.ts`
- `packages/ai/agent-mcp/src/engine/orchestrator.ts`
- `packages/ai/agent-mcp/src/providers/anthropic.ts`
- `packages/ai/agent-mcp/src/providers/openai.ts`

**read_only:**
- `packages/ai/agent-mcp/src/providers/types.ts` (LLMProvider interface — no change needed)

## Contract

**Modified: `packages/ai/agent-mcp-types/src/errors.ts`**

`PROVIDER_TIMEOUT`, `PROVIDER_AUTH_ERROR`, and `PROVIDER_RATE_LIMITED` are added in `stop-reason-types`. This state verifies they are present — no new edits to `agent-mcp-types/src/errors.ts` should be needed if stop-reason-types ran correctly.

**Modified: `packages/ai/agent-mcp/src/validation/errors.ts`**

Add three new values to `errorCodeSchema` z.enum:
```typescript
export const errorCodeSchema = z.enum([
  // ... existing values ...
  "PROVIDER_ERROR",
  "MCP_CLIENT_ERROR",
  "VALIDATION_ERROR",
  "CONTEXT_WINDOW_EXCEEDED",   // added in context-error-code, pre-declare here
  "PROVIDER_TIMEOUT",          // ← add
  "PROVIDER_AUTH_ERROR",       // ← add
  "PROVIDER_RATE_LIMITED",     // ← add
]);
```

**Modified: `packages/ai/agent-mcp/src/engine/orchestrator.ts`**

Replace the current catch block timeout throw (which uses `PROVIDER_ERROR`):
```typescript
} catch (error) {
  if (signal.aborted) {
    throw new ToolError("PROVIDER_TIMEOUT", "Task was cancelled during provider call");
  }
  if (
    composedSignal.aborted ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  ) {
    const ms = executionContext.agentDefinition.provider.timeoutMs ?? 60_000;
    throw new ToolError(
      "PROVIDER_TIMEOUT",
      `Provider call timed out after ${ms}ms. Increase timeoutMs on the agent's provider config.`
    );
  }
  // Auth failure detection (HTTP 401 / AuthenticationError)
  if (
    error instanceof Error && (
      error.constructor.name === "AuthenticationError" ||
      ('status' in error && (error as { status?: number }).status === 401)
    )
  ) {
    throw new ToolError(
      "PROVIDER_AUTH_ERROR",
      `Provider authentication failed: ${error.message}. ` +
      `Set ANTHROPIC_AUTH_TOKEN (run \`claude setup-token\` to obtain an OAuth access token) or use authTokenEnv in the provider config`
    );
  }
  // Rate-limit detection (HTTP 429 — after retries exhausted)
  if (
    error instanceof Error && (
      ('status' in error && (error as { status?: number }).status === 429) ||
      error.message?.includes('rate limit') ||
      error.message?.includes('429')
    )
  ) {
    throw new ToolError(
      "PROVIDER_RATE_LIMITED",
      `Provider rate limit exceeded: ${error.message}`
    );
  }
  // Generic provider failure (fallback)
  throw new ToolError(
    "PROVIDER_ERROR",
    `Provider call failed: ${error instanceof Error ? error.message : String(error)}`
  );
}
```

Note: `CONTEXT_WINDOW_EXCEEDED` detection is added in the `context-error-code` state (comes after this state in the chain). Pre-declare it in `errorCodeSchema` here so the schema is complete.

**Modified: `packages/ai/agent-mcp/src/providers/anthropic.ts`**

In the `pRetry` `onFailedAttempt` callback, detect 401 to throw early without retrying:
```typescript
onFailedAttempt: error => {
  if (request.signal?.aborted) {
    throw error; // don't retry on cancellation
  }
  // Don't retry auth failures
  if ('status' in error && (error as { status?: number }).status === 401) {
    throw new ToolError(
      "PROVIDER_AUTH_ERROR",
      `Anthropic authentication failed. ` +
      `Set ANTHROPIC_AUTH_TOKEN (run \`claude setup-token\` to obtain an OAuth access token) or use authTokenEnv in the provider config`
    );
  }
},
```

**Modified: `packages/ai/agent-mcp/src/providers/openai.ts`**

Same pattern in `onFailedAttempt` if retry is used; otherwise let the orchestrator catch block handle it.

## Acceptance criteria

[provider-error-codes.1] `PROVIDER_TIMEOUT` in `errorCodeSchema` in `packages/ai/agent-mcp/src/validation/errors.ts`

[provider-error-codes.2] `PROVIDER_AUTH_ERROR` in `errorCodeSchema` in `packages/ai/agent-mcp/src/validation/errors.ts`

[provider-error-codes.3] `PROVIDER_RATE_LIMITED` in `errorCodeSchema` in `packages/ai/agent-mcp/src/validation/errors.ts`

[provider-error-codes.4] `PROVIDER_TIMEOUT` thrown in orchestrator catch block (replaces `PROVIDER_ERROR` for timeout path)

[provider-error-codes.5] `PROVIDER_AUTH_ERROR` thrown or referenced in `packages/ai/agent-mcp/src/providers/anthropic.ts`

## Commit points

**R2 (post-guard):**
```
feat(agent-mcp): add PROVIDER_TIMEOUT, PROVIDER_AUTH_ERROR, PROVIDER_RATE_LIMITED error codes
```

## Notes

- Per [inv:provider-error-dispatch]: timeout detection must come FIRST in the catch block order, before auth and rate-limit detection. This prevents a race where a timed-out request that also returns 401 gets misclassified.
- The `signal.aborted` check at the top of the catch block should throw `PROVIDER_TIMEOUT` (not `PROVIDER_ERROR`) when the outer task signal fires — cancellation and timeout are both timeout-family errors from the caller's perspective. However this is a judgment call; throwing a dedicated `TASK_CANCELLED` code may be cleaner but requires a new code. For now use `PROVIDER_TIMEOUT` for all abort-signal cases.
- `composedSignal.aborted` fires for EITHER the task cancellation signal OR the `AbortSignal.timeout()` component. Both are timeout conditions.
- After this state, the outer catch block in `orchestrator.ts` (the `isCancelled` detection) uses string-matching. That will be fixed in `robustness-fixes`.
