# Shared Definitions — agent-mcp 0.0.6

## [def:StopReason]

The normalised stop reason type. Four values only:

| Value | Meaning |
|-------|---------|
| `"stop"` | Normal completion (no tools, no truncation) |
| `"length"` | Output truncated at token limit — the most actionable signal |
| `"tool_calls"` | Model requested tool execution |
| `"unknown"` | Unrecognised or missing provider value |

TypeScript type: `"stop" | "length" | "tool_calls" | "unknown"` — stored in `TokenUsage.stopReason?`.

## [def:ProviderAuthError]

`PROVIDER_AUTH_ERROR` is thrown when credentials are unavailable, invalid, or explicitly rejected (HTTP 401). Sources:

| Source | Trigger |
|--------|---------|
| Anthropic provider (non-OAuth) | SDK throws `AuthenticationError` (HTTP 401) |
| Anthropic provider (useClaudeOauth) | Keychain read fails AND no env-var fallback available |
| OpenAI/LMStudio provider | SDK throws `AuthenticationError` (HTTP 401) |
| claudecli provider | Keychain ACL denial (security CLI non-zero exit) recorded; chat() result is `is_error: true` |

Recovery instruction that MUST appear verbatim in the thrown message:
```
Set ANTHROPIC_AUTH_TOKEN (run `claude setup-token` to obtain an OAuth access token) or use authTokenEnv in the provider config
```

## [ref:normalised-stop-reason]

Provider mapping to `StopReason`:

| Provider | Raw value | Normalised |
|----------|-----------|------------|
| OpenAI / LMStudio | `finish_reason === "stop"` | `"stop"` |
| OpenAI / LMStudio | `finish_reason === "length"` | `"length"` |
| OpenAI / LMStudio | `finish_reason === "tool_calls"` | `"tool_calls"` |
| OpenAI / LMStudio | anything else / null | `"unknown"` |
| Anthropic | `stop_reason === "end_turn"` | `"stop"` |
| Anthropic | `stop_reason === "max_tokens"` | `"length"` |
| Anthropic | `stop_reason === "tool_use"` | `"tool_calls"` |
| Anthropic | anything else | `"unknown"` |
| claudecli | N/A | `undefined` (no extraction) |

Must be implemented as a lookup object or switch — not inline ternaries.

## [inv:stop-reason-severity]

Severity ordering used by `UsagePlugin` (in-memory accumulator) and `summarise()` (query layer):

```
"length" (3) > "tool_calls" (2) > "stop" (1) > "unknown" (0)
```

**Rule:** When multiple model calls occur in one task, the most severe stop reason wins and is stored as the final `stop_reason`. A single `"length"` response overrides any number of `"stop"` or `"tool_calls"` responses.

Implementation:
```typescript
const SEVERITY: Record<string, number> = {
  length: 3, tool_calls: 2, stop: 1, unknown: 0
};
function mostSevere(a: string, b: string): string {
  return (SEVERITY[a] ?? 0) >= (SEVERITY[b] ?? 0) ? a : b;
}
```

## [inv:provider-error-dispatch]

Which error code to throw for which provider failure condition:

| Condition | Error code |
|-----------|------------|
| `composedSignal.aborted` or `error.name === "AbortError"/"TimeoutError"` | `PROVIDER_TIMEOUT` |
| HTTP 401 / `AuthenticationError` from SDK | `PROVIDER_AUTH_ERROR` |
| HTTP 429 after retries exhausted | `PROVIDER_RATE_LIMITED` |
| `context_length_exceeded` / `prompt is too long` | `CONTEXT_WINDOW_EXCEEDED` |
| Any other provider failure | `PROVIDER_ERROR` |

These checks must appear in the catch block IN THIS ORDER — timeout detection first, then auth, then rate-limit, then context, then generic fallback.

## [inv:claudecli-auth-recovery]

When `buildSubprocessEnv` keychain read fails in `ClaudeCliProvider`:
1. Log at `warn` level: include the raw error message from the security CLI.
2. Store the keychain error text in a local variable (e.g. `keychainError`).
3. Continue — let the subprocess inherit env as-is.
4. If `chat()` returns `is_error: true` on the result event OR `finalResult` is empty after the subprocess exits, throw:
   ```
   throw new ToolError("PROVIDER_AUTH_ERROR",
     `Claude CLI auth failed${keychainError ? ': keychain error: ' + keychainError : ''}. ` +
     `Set ANTHROPIC_AUTH_TOKEN (run \`claude setup-token\` to obtain an OAuth access token) or use authTokenEnv in the provider config`
   );
   ```

When `AnthropicProvider` with `useClaudeOauth:true` fails keychain read:
1. Log at `warn` level with the keychain error message.
2. Fall back in priority order: `ANTHROPIC_API_KEY` env → `ANTHROPIC_AUTH_TOKEN` env.
3. If neither env var is set, throw `PROVIDER_AUTH_ERROR` with the recovery instruction.

## [inv:window-messages]

Sliding-window truncation algorithm for `windowMessages(messages, tokenLimit)`:

1. If `tokenLimit <= 0`, return `messages` unchanged.
2. Estimate: `Math.ceil(messages.reduce((sum, m) => sum + (m.content?.length ?? 0) + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0) + (m.toolResults ? JSON.stringify(m.toolResults).length : 0), 0) / 4)`.
3. If estimate <= tokenLimit, return `messages` unchanged.
4. Separate `system` messages from non-system messages.
5. Estimate system budget: same formula applied to system messages only.
6. Remaining budget = tokenLimit - systemBudget (minimum 0).
7. Walk non-system messages from newest to oldest; include while running estimate stays <= remaining.
8. Reverse the selected non-system messages back to chronological order.
9. Return: `[...systemMessages, ...selectedNonSystem]`.

**Invariant:** System messages are always preserved. The function never mutates its input.

## [ref:drizzle-upsert-increment]

Established in 0.0.5 `UsagePlugin`. Accumulator columns use:
```typescript
sql`${taskUsageTable.inputTokens} + ${inputTokens}`
```
in the `onConflictDoUpdate` SET block. New columns that are NOT accumulators (`stopReason`, `maxTokens`) must use direct assignment, not the increment pattern.

## [ref:tool-error-throw]

All operational errors in the orchestrator loop must use:
```typescript
throw new ToolError("CODE", message);
```
`CODE` must be a member of `AgentMcpErrorCode`. Never throw a raw `Error` inside the orchestrator — the catch block checks `instanceof ToolError`.

## From prior plan (still applicable)

### [inv:plugin-no-throw]
`UsagePlugin` handlers must never throw. All errors are caught and logged via pino. An observational plugin that crashes the host is worse than no tracking.

### [inv:incremental-write]
`UsagePlugin` writes to `task_usage` on every `post:model_response` (INSERT on first call, accumulate on conflict). The terminal event (`task:completed/failed/cancelled`) does a final UPDATE for `latency_ms`, `root_task_id`, `is_complete=1`. The new `stop_reason` is updated on every response (most-severe) via the same UPSERT mechanism.

### [inv:claudecli-undefined]
claudecli returns `usage === undefined`. `UsagePlugin` records zeros for token counts. For Gap #6: `stop_reason` will be `null` and `max_tokens` will be `null` for claudecli tasks — both columns are nullable.
