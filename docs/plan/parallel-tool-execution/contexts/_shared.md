# Shared Definitions — parallel-tool-execution

## [ref:tool-error-throw]

All operational errors inside the orchestrator tool loop use:
```typescript
throw new ToolError("CODE", message);
```
`CODE` must be a member of `AgentMcpErrorCode`. Raw `Error` objects are never thrown past the
orchestrator boundary. Non-fatal tool call errors are caught and returned as `isError: true`
result objects — they do not throw.

## [ref:policy-before-dispatch]

`policy.check()` fires for each tool before `client.callTool()`. In the new parallel
implementation, this means the pre-dispatch serial loop MUST:
1. Call `policy.check({executionContext, targetTool, targetAgentName})`.
2. Increment `executionContext.toolCallCount` AFTER the check passes — see
   `[inv:toolCallCount-increment-after-check]`.
3. On policy violation (throws a `ToolError` with a fatal code), abort the entire batch — the
   `Promise.all` is never reached.

## [inv:fatal-policy-codes]

Three `ToolError` codes are fatal and re-throw from the tool-result catch block:
- `MAX_DEPTH_EXCEEDED`
- `MAX_TOOL_LOOPS_EXCEEDED`
- `DELEGATION_NOT_ALLOWED`

Any other error is caught and surfaced as `isError: true` in the tool result, and the tool loop
continues.

## [inv:toolCallCount-increment-after-check]

`executionContext.toolCallCount` is incremented AFTER `policy.check()` passes, but still inside
the serial pre-dispatch loop (per tool) — NOT after the result is appended in Phase 3.

Rationale: `policy.check()` enforces `toolCallCount < effectiveMaxToolLoops` (it throws at
`>=`), treating the count as "calls already accounted for". So the check must see the count of
prior calls, not a count that already includes the current one — otherwise the effective cap is
reduced by one (e.g. max 50 would block on the 50th call, allowing only 49). Incrementing per
tool here (rather than in Phase 3) still enforces the limit WITHIN a single concurrent batch:
each tool's `policy.check()` sees the running count incremented by the prior tools in the same
loop.

(Earlier revisions of this plan incremented BEFORE the check; that was an off-by-one bug —
the comparison in `policy.check` was calibrated for the increment-after-check ordering.)

## [inv:call-id-keying]

`toolResults[i].toolCallId` MUST equal `toolCalls[i].id` — the ID returned by the model, not
an array index or a generated ID. This is required for the model to match tool results back to
its tool calls.

## [inv:message-order]

After `Promise.all` resolves, tool result messages are appended to `currentMessages` in the
original toolCalls order (i.e., `toolCalls[0]` result first, `toolCalls[N-1]` last). The model
requires results in the same order as the original calls.
