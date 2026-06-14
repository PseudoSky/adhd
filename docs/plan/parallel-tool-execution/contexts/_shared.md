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
1. Increment `executionContext.toolCallCount` first.
2. Call `policy.check({executionContext, targetTool, targetAgentName})`.
3. On policy violation (throws a `ToolError` with a fatal code), abort the entire batch — the
   `Promise.all` is never reached.

## [inv:fatal-policy-codes]

Three `ToolError` codes are fatal and re-throw from the tool-result catch block:
- `MAX_DEPTH_EXCEEDED`
- `MAX_TOOL_LOOPS_EXCEEDED`
- `DELEGATION_NOT_ALLOWED`

Any other error is caught and surfaced as `isError: true` in the tool result, and the tool loop
continues.

## [inv:toolCallCount-increment-before-check]

`executionContext.toolCallCount` is incremented BEFORE `policy.check()` is called for each
dispatch — not after the result is appended. This ensures the policy limit check sees the count
that WILL be true after dispatch, not the count at the time of check. This differs from the
original sequential code (which incremented after append) and is the correct semantics for the
parallel case.

## [inv:call-id-keying]

`toolResults[i].toolCallId` MUST equal `toolCalls[i].id` — the ID returned by the model, not
an array index or a generated ID. This is required for the model to match tool results back to
its tool calls.

## [inv:message-order]

After `Promise.all` resolves, tool result messages are appended to `currentMessages` in the
original toolCalls order (i.e., `toolCalls[0]` result first, `toolCalls[N-1]` last). The model
requires results in the same order as the original calls.
