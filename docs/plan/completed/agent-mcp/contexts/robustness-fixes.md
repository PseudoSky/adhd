# State: robustness-fixes

## Goal

Fix two robustness bugs in `orchestrator.ts`: (1) add an empty tool-call guard to break the loop when `stopReason === "tool_calls"` but zero tool call blocks are present; (2) fix cancellation detection to use error code comparison instead of `error.message.includes("cancelled")` string-matching.

## Semantic distillation

Bug 1 — empty tool-call guard: The orchestrator loop currently processes `toolCalls` by iterating `assistantMessage.toolCalls ?? []`. If `stopReason === "tool_calls"` but the array is empty (possible if a provider returns a malformed response), the loop spins indefinitely — it neither breaks (no `"completed"` stop reason) nor processes any tools (empty array), so the condition never advances. Fix: after the tool-call loop, if `stopReason` signals tool use but no tools were found, break or throw.

Bug 2 — string-matching cancellation: The outer catch block detects cancellation via:
```typescript
error.message.includes("cancelled")
```
This is fragile — message text can change, and non-cancellation errors could accidentally match. Fix: detect cancellation by checking `signal.aborted` (already reliable) OR by checking `error instanceof ToolError && error.code === "PROVIDER_TIMEOUT"` when `signal.aborted` is true (the inner catch now throws `PROVIDER_TIMEOUT` for cancellation-triggered aborts).

## File ownership

**mutates:**
- `packages/ai/agent-mcp/src/engine/orchestrator.ts`

**read_only:**
- `packages/ai/agent-mcp/src/validation/errors.ts` (ToolError, error codes)

## Contract

**Modified: `packages/ai/agent-mcp/src/engine/orchestrator.ts`**

**Fix 1** — after the tool call `for` loop (line ~317 in current source), add:
```typescript
// Guard: if provider signalled tool_calls but sent no tool call blocks, break
// to prevent infinite spin on a malformed response.
if (
  providerResponse.stopReason === "tool_calls" &&
  (assistantMessage.toolCalls ?? []).length === 0
) {
  finalContent = assistantMessage.content ?? "";
  looping = false;
}
```

**Fix 2** — in the outer catch block, replace the `isCancelled` detection:

Before (line ~344):
```typescript
const isCancelled =
  signal.aborted ||
  (error instanceof ToolError && error.code === "PROVIDER_ERROR" && error.message.includes("cancelled"));
```

After:
```typescript
const isCancelled =
  signal.aborted ||
  (error instanceof ToolError && error.code === "PROVIDER_TIMEOUT" && signal.aborted);
```

Note: the second condition is now redundant (if `signal.aborted` is true, the first OR already matches). The simplified form is:
```typescript
const isCancelled = signal.aborted;
```

However if a PROVIDER_TIMEOUT can also occur without `signal.aborted` (pure provider timeout, not user cancellation), we should distinguish them. The safest form:
```typescript
const isCancelled =
  signal.aborted ||
  (error instanceof ToolError &&
    error.code === "PROVIDER_TIMEOUT" &&
    error.message.toLowerCase().includes("cancel")); // acceptable residual string check on our own messages
```

Use whichever form is clearest, but remove the check against `error.code === "PROVIDER_ERROR"` (which is the wrong code after `provider-error-codes` state changes the timeout throw to `PROVIDER_TIMEOUT`).

## Acceptance criteria

[robustness-fixes.1] Empty tool-call guard is present in `orchestrator.ts` (checks `toolCalls.length === 0` when `stopReason === "tool_calls"`)

[robustness-fixes.2] The cancellation detection in `orchestrator.ts` does NOT use `error.message.includes("cancelled")` with `PROVIDER_ERROR` code comparison (the old fragile pattern is removed)

## Commit points

**R2 (post-guard):**
```
fix(agent-mcp): empty tool-call guard; robust cancellation detection in orchestrator
```

## Notes

- The empty tool-call guard must fire AFTER the tool-call loop, not inside it. The pattern is: process whatever tools are present (zero in this case), then check if we should continue looping.
- For the cancellation detection fix: `signal.aborted` is the primary signal. The string-matching fallback was added because some throw paths inside the orchestrator used `new ToolError("PROVIDER_ERROR", "Task was cancelled ...")`. After `provider-error-codes`, those throws use `PROVIDER_TIMEOUT` and also only fire when `signal.aborted` is already true — so `signal.aborted` alone is sufficient for the outer catch.
- The guard `!grep -q 'error.message.includes.*cancelled'` in the state guard is a negative check — it passes when the old string-matching pattern is no longer present.
