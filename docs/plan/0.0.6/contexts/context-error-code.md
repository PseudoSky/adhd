# State: context-error-code

## Goal

Add `CONTEXT_WINDOW_EXCEEDED` to `errorCodeSchema` in `validation/errors.ts`. Detect context-length errors from providers in the orchestrator catch block and re-throw them as `CONTEXT_WINDOW_EXCEEDED` instead of `PROVIDER_ERROR`.

## Semantic distillation

`AgentMcpErrorCode` was already updated in `agent-mcp-types` during `stop-reason-types`. This state makes the local Zod schema (`errorCodeSchema`) consistent with the type union, and adds the detection logic to the orchestrator. The detection must be inserted BEFORE the generic `PROVIDER_ERROR` re-throw — otherwise context errors are swallowed into the wrong code.

## File ownership

**mutates:**
- `packages/ai/agent-mcp/src/validation/errors.ts`
- `packages/ai/agent-mcp/src/engine/orchestrator.ts`

**read_only:**
- `packages/ai/agent-mcp-types/src/errors.ts` (AgentMcpErrorCode already has CONTEXT_WINDOW_EXCEEDED)

## Contract

**Modified: `packages/ai/agent-mcp/src/validation/errors.ts`**

Add `"CONTEXT_WINDOW_EXCEEDED"` to the `z.enum([...])` array in `errorCodeSchema`:

```typescript
export const errorCodeSchema = z.enum([
  // ... existing values ...
  "PROVIDER_ERROR",
  "MCP_CLIENT_ERROR",
  "VALIDATION_ERROR",
  "CONTEXT_WINDOW_EXCEEDED",   // ← add
]);
```

**Modified: `packages/ai/agent-mcp/src/engine/orchestrator.ts`**

In the `catch (error)` block inside the provider call `try/catch` (lines ~123-141), add context-length detection AFTER the AbortError/TimeoutError check and BEFORE the generic re-throw:

```typescript
} catch (error) {
  if (signal.aborted) {
    throw new ToolError("PROVIDER_ERROR", "Task was cancelled during provider call");
  }
  if (
    composedSignal.aborted ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  ) {
    const ms = executionContext.agentDefinition.provider.timeoutMs ?? 60_000;
    throw new ToolError(
      "PROVIDER_ERROR",
      `Provider call timed out after ${ms}ms. Increase timeoutMs on the agent's provider config.`
    );
  }
  // ── Context window overflow detection ────────────────────────────────────
  // OpenAI/LMStudio: APIError with code === "context_length_exceeded"
  // Anthropic: BadRequestError with message containing "prompt is too long"
  if (
    error instanceof Error && (
      ('code' in error && (error as { code?: string }).code === 'context_length_exceeded') ||
      error.message?.includes('context_length_exceeded') ||
      error.message?.includes('prompt is too long')
    )
  ) {
    throw new ToolError(
      "CONTEXT_WINDOW_EXCEEDED",
      `Context window exceeded. Set AGENT_MCP_CONTEXT_LIMIT to enable automatic truncation.`
    );
  }
  // ── Generic provider failure ──────────────────────────────────────────────
  throw new ToolError(
    "PROVIDER_ERROR",
    `Provider call failed: ${error instanceof Error ? error.message : String(error)}`
  );
}
```

## Acceptance criteria

[context-error-code.1] `CONTEXT_WINDOW_EXCEEDED` appears in `errorCodeSchema` in `validation/errors.ts`

[context-error-code.2] `CONTEXT_WINDOW_EXCEEDED` appears in `orchestrator.ts`

[context-error-code.3] When context-length patterns are present in `orchestrator.ts`, they are inside a `CONTEXT_WINDOW_EXCEEDED` throw, not a `PROVIDER_ERROR` throw

## Commit points

**R2 (post-guard):**
```
feat(agent-mcp): add CONTEXT_WINDOW_EXCEEDED error code and orchestrator detection
```

## Notes

- The OpenAI SDK throws an `APIError` subclass. The `code` field is on the error object but TypeScript types it as `string | null | undefined`. Use `'code' in error` guard before accessing.
- The Anthropic SDK throws `BadRequestError` (a subclass of `APIError`) for prompt-too-long. The message text `"prompt is too long"` is the most reliable signal — it is stable across SDK versions.
- `error.message?.includes('context_length_exceeded')` catches the case where LM Studio (OpenAI-compatible) returns the code in the message body rather than as a structured field.
- After this state, the orchestrator will throw `CONTEXT_WINDOW_EXCEEDED` AFTER the context window fills. The next state (`sliding-window`) prevents the context from filling in the first place. Both layers are needed: the detection handles unexpected overflows, the window prevents them proactively.
- See [ref:tool-error-throw]: use `new ToolError(CODE, message)` — do not throw a raw `Error`.
