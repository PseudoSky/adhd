# parallel-dispatch

**Phase:** foundation · **Depends on:** — · **Guard:**
```bash
grep -q 'Promise.all' packages/ai/agent-mcp/src/engine/orchestrator.ts && \
! grep -q 'for (const toolCall of toolCalls)' packages/ai/agent-mcp/src/engine/orchestrator.ts && \
npx nx test agent-mcp 2>&1 | grep -qE 'passed'
```

---

## Goal

Replace the sequential `for (const toolCall of toolCalls)` loop (orchestrator.ts lines 232–361)
with a two-phase parallel pattern: a serial pre-dispatch pass that checks policy for each call,
followed by `Promise.all` that executes all calls concurrently. All existing behaviour is
preserved except execution order within a single tool-call batch.

---

## Semantic Distillation

- **Primitive:** MODIFY `packages/ai/agent-mcp/src/engine/orchestrator.ts` — replace the
  sequential tool loop with Promise.all-based parallel dispatch.

- **Reference Pattern:** Current sequential loop at lines 232–361 in orchestrator.ts. Each
  iteration: cancellation check → emit pre:tool_call hook → policy.check() → emit TOOL_CALL event
  → log → client.callTool() → catch error → emit TOOL_RESULT event → log → emit post:tool_call
  hook → append toolResultMessage → emit message:appended hook → increment toolCallCount.

- **Delta Spec:** Replace the entire for-loop block (lines 232–361) with:

  **Phase 1 — serial pre-dispatch loop (policy + count):**
  ```typescript
  // Policy + count pre-flight for each tool (serial, before any concurrent dispatch).
  // Uses variable name `tc` (not `toolCall`) so the guard can detect the old sequential
  // dispatch loop by its specific name `for (const toolCall of toolCalls)`.
  for (const tc of toolCalls) {
      if (signal.aborted) {
          throw new ToolError("PROVIDER_ERROR", "Task was cancelled before tool call");
      }
      // Increment BEFORE policy check — see [inv:toolCallCount-increment-before-check]
      executionContext.toolCallCount++;
      const qualifiedToolName = `${tc.server}__${tc.tool}`;
      await hooks.emit("pre:tool_call", {
          executionContext,
          toolName: qualifiedToolName,
          callId: tc.id,
          toolInput: tc.arguments,
      });
      policy.check({
          executionContext,
          targetTool: qualifiedToolName,
          targetAgentName:
              qualifiedToolName === "agent-mcp__agent"
                  ? (tc.arguments as { name?: string })?.name
                  : undefined,
      });
  }
  ```

  **Phase 2 — `Promise.all` concurrent execution:**
  ```typescript
  const toolResults = await Promise.all(
      toolCalls.map(async (toolCall) => {
          const qualifiedToolName = `${toolCall.server}__${toolCall.tool}`;

          taskStore.appendEvent({
              taskId,
              type: "TOOL_CALL",
              payload: { tool: qualifiedToolName, callId: toolCall.id },
          });

          logger.info(
              { taskId, agentName: executionContext.agentName, tool: qualifiedToolName, callId: toolCall.id },
              "TOOL_CALL"
          );

          let toolResult: unknown;
          let isError = false;
          try {
              const client = await registry.getClient(toolCall.server);
              toolResult = await client.callTool(toolCall.tool, toolCall.arguments);
          } catch (error) {
              // Re-throw fatal ToolError codes — these abort the entire task, not just this call.
              // See [inv:fatal-policy-codes] in _shared.md.
              const FATAL_CODES = ["MAX_DEPTH_EXCEEDED", "MAX_TOOL_LOOPS_EXCEEDED", "DELEGATION_NOT_ALLOWED"];
              if (error instanceof ToolError && FATAL_CODES.includes(error.code)) {
                  throw error;
              }
              isError = true;
              toolResult = error instanceof Error ? error.message : String(error);
              logger.warn({ taskId, tool: qualifiedToolName, error: toolResult }, "TOOL_RESULT error");
          }

          taskStore.appendEvent({
              taskId,
              type: "TOOL_RESULT",
              payload: { callId: toolCall.id, tool: qualifiedToolName, isError },
          });

          logger.debug({ taskId, tool: qualifiedToolName, isError }, "TOOL_RESULT");

          await hooks.emit("post:tool_call", {
              executionContext,
              toolName: qualifiedToolName,
              callId: toolCall.id,
              toolInput: toolCall.arguments,
              result: toolResult,
              isError,
          });

          return { toolCall, toolResult, isError };
      })
  );
  ```

  **Phase 3 — serial result append (preserves order per [inv:message-order]):**
  ```typescript
  for (const { toolCall, toolResult, isError } of toolResults) {
      const toolResultMessage: Message = {
          id: generateId(),
          sessionId: executionContext.sessionId,
          role: "tool",
          toolResults: [{
              toolCallId: toolCall.id,  // [inv:call-id-keying]
              result: toolResult,
              isError,
          }],
          createdAt: nowIso(),
      };
      await sessionStore.appendMessage(executionContext.sessionId, toolResultMessage);
      currentMessages.push(toolResultMessage);
      await hooks.emit("message:appended", { executionContext, message: toolResultMessage });
  }
  ```

  The empty-tool-call guard that follows the loop (lines 363–371) is unchanged — it still checks
  `(assistantMessage.toolCalls ?? []).length === 0` after the batch.

- **Invariants:** See `[inv:toolCallCount-increment-before-check]`, `[inv:fatal-policy-codes]`,
  `[inv:call-id-keying]`, `[inv:message-order]` in `_shared.md`.

- **Validation:** `grep -q 'Promise.all' orchestrator.ts && ! grep -q 'for (const toolCall of toolCalls)'`
  verifies structure. Full test suite (`npx nx test agent-mcp`) verifies behavior.

---

## Acceptance criteria

Checked by `audit-foundation` as slug-keyed IDs.

- [ ] **[parallel-dispatch.1]** `Promise.all` appears in orchestrator.ts.
      `grep -q 'Promise.all' packages/ai/agent-mcp/src/engine/orchestrator.ts`
- [ ] **[parallel-dispatch.2]** Sequential `for (const toolCall of toolCalls)` loop is absent.
      `! grep -q 'for (const toolCall of toolCalls)' packages/ai/agent-mcp/src/engine/orchestrator.ts`
- [ ] **[parallel-dispatch.3]** `toolCallId` in the result message uses `toolCall.id` (not a generated ID or index).
      `grep -q 'toolCallId: toolCall.id' packages/ai/agent-mcp/src/engine/orchestrator.ts`
- [ ] **[parallel-dispatch.4]** `executionContext.toolCallCount++` appears in orchestrator.ts BEFORE `policy.check(` in a pre-dispatch serial loop.
      `grep -n 'toolCallCount++\|policy.check(' packages/ai/agent-mcp/src/engine/orchestrator.ts` — count++ line must precede policy.check line
- [ ] **[parallel-dispatch.5]** Fatal policy codes re-throw (not caught as isError). Test: policy violation → task fails (not continues).
      `npx nx test agent-mcp -- --reporter=verbose 2>&1 | grep -q 'policy'`
- [ ] **[parallel-dispatch.6]** All existing tests pass.
      `npx nx test agent-mcp 2>&1 | grep -qE 'passed'`
- [ ] **[parallel-dispatch.7]** New test: `orchestrator.test.ts` has a test case with multiple concurrent tool calls that verifies parallel dispatch (e.g. both tools invoked, both results appended).
      `grep -q 'parallel\|concurrent\|Promise.all\|multiple.*tool' packages/ai/agent-mcp/src/__tests__/orchestrator.test.ts`

---

## Reservations

```text
read_only:  [
  "packages/ai/agent-mcp/src/engine/policy.ts",
  "packages/ai/agent-mcp/src/store/task-store.ts",
  "packages/ai/agent-mcp/src/store/session-store.ts",
  "packages/ai/agent-mcp/src/clients/registry.ts"
]
mutates:    [
  "packages/ai/agent-mcp/src/engine/orchestrator.ts",
  "packages/ai/agent-mcp/src/__tests__/orchestrator.test.ts"
]
```

---

## Contract Promise

- **Modified:** `Orchestrator.run()` — tool-call dispatch changes from sequential for-loop to
  Promise.all with serial pre-dispatch policy check.
- **Added (tests):** new test cases in `orchestrator.test.ts` covering parallel dispatch and
  one-fails-rest-continue.

---

## Commit points

- [ ] **After orchestrator.ts change + test updates pass** (mandatory):
      `feat(agent-mcp): parallel tool execution via Promise.all`

---

## Notes for executor

- **Footgun: toolCallCount increment moved.** The old code incremented `toolCallCount` AFTER
  appending the tool result. The new code increments BEFORE policy.check() in Phase 1. Both are
  correct for their model but the test for `MAX_TOOL_LOOPS_EXCEEDED` must be updated if it checks
  count state mid-execution.
- **Footgun: Phase 1 can throw a ToolError.** If `policy.check()` throws `MAX_TOOL_LOOPS_EXCEEDED`,
  the Phase 1 for-loop throws synchronously before `Promise.all` is reached. The catch block at
  the top of `Orchestrator.run()` handles this correctly — no special handling needed.
- **hooks.emit is async.** The `pre:tool_call` hook in Phase 1 is awaited. If a hook takes
  non-trivial time this still serializes, but the tools themselves (Phase 2) run in parallel.
- **sessionStore.appendMessage is sync-wrapped.** Better-sqlite3 is synchronous, so concurrent
  `appendMessage` calls in Phase 2 (inside Promise.all) will queue on the synchronous SQLite
  connection. This is safe — SQLite handles it. Phase 3 appends in order, which is correct.
- **Empty toolCalls guard.** The guard `if (stopReason === "tool_calls" && toolCalls.length === 0)`
  that follows the loop (old lines 363–371) is unchanged. It still runs after Phase 3.
