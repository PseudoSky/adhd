# stream-orchestrator

**Phase:** engine · **Depends on:** stream-http-server · **Guard:**
```bash
grep -q 'eventBus\|emitTaskEvent' packages/ai/agent-mcp/src/engine/orchestrator.ts && \
grep -qE '"token"\|token.*chunk' packages/ai/agent-mcp/src/engine/orchestrator.ts && \
npx nx test agent-mcp 2>&1 | grep -qE 'passed'
```

---

## Goal

Wire `emitTaskEvent()` calls into the orchestrator to emit 4 event types in 0.4.0:
`tool_call` (per dispatch), `tool_result` (per result append), `status_change` (per status
update), `done` (on completion, failure, AND cancellation).

**`token` events are deferred to 0.5.0.** The `LLMProvider` interface (`providers/types.ts:38`)
returns `Promise<ProviderChatResponse>` — there is no streaming iterator. Switching to streaming
requires a breaking interface change. Do not add `token` emission in 0.4.0.

---

## Semantic Distillation

- **Primitive:** MODIFY `packages/ai/agent-mcp/src/engine/orchestrator.ts`.

- **Delta Spec — emit points (0.4.0: 4 events; token deferred to 0.5.0):**

  ```typescript
  import { emitTaskEvent } from "../streaming/event-bus.js";

  // token events are NOT emitted in 0.4.0 — LLMProvider does not support streaming.

  // 1. tool_call — emitted before dispatching each tool call
  emitTaskEvent({ type: "tool_call", taskId, toolName: toolCall.name,
                  toolCallId: toolCall.id, input: toolCall.input });

  // 2. tool_result — emitted after each tool result is received
  emitTaskEvent({ type: "tool_result", taskId, toolCallId: result.toolCallId,
                  content: result.content });

  // 3. status_change — emitted whenever task status changes in the orchestrator scope
  emitTaskEvent({ type: "status_change", taskId, status: newStatus });

  // 4. done — emitted on ALL terminal paths: completion, failure, AND cancellation.
  //    Place in a finally block to guarantee emission even when the task is aborted.
  emitTaskEvent({ type: "done", taskId, result: finalResult ?? null, error: errorMsg ?? null });
  ```

  **Cancellation path — `done` is mandatory.** The orchestrator's cancellation branch
  (`isCancelled` / `signal.aborted`) must also emit `done`. Without it, SSE clients
  subscribed to cancelled tasks hang indefinitely. Wire in a `finally` block or explicitly
  in the cancellation early-return.

  `taskId` is available throughout the orchestrator — it's passed as a parameter.

- **Invariants:**
  - `[inv:done-closes-connection]` — `done` is always emitted, including on cancellation.

- **Validation:** grep for `emitTaskEvent` in orchestrator.ts; tests pass.

---

## Acceptance criteria

- [ ] **[stream-orchestrator.1]** `emitTaskEvent` imported and used in orchestrator.ts.
      `grep -qE 'emitTaskEvent|eventBus' packages/ai/agent-mcp/src/engine/orchestrator.ts`
- [ ] **[stream-orchestrator.2]** `token` events deferred to 0.5.0 — NOT required in 0.4.0.
      (No check — verified by absence: `! grep -q 'type.*token' packages/ai/agent-mcp/src/engine/orchestrator.ts` or document as known omission.)
- [ ] **[stream-orchestrator.3]** `tool_call` event emitted before dispatch.
      `grep -q 'tool_call' packages/ai/agent-mcp/src/engine/orchestrator.ts`
- [ ] **[stream-orchestrator.4]** `tool_result` event emitted after result received.
      `grep -q 'tool_result' packages/ai/agent-mcp/src/engine/orchestrator.ts`
- [ ] **[stream-orchestrator.5]** `done` event emitted on completion and error paths.
      `grep -q '"done"' packages/ai/agent-mcp/src/engine/orchestrator.ts`
- [ ] **[stream-orchestrator.6]** Tests pass.
      `npx nx test agent-mcp 2>&1 | grep -qE 'passed'`

---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src/streaming/event-bus.ts",
             "packages/ai/agent-mcp/src/streaming/sse-server.ts",
             "packages/ai/agent-mcp/src/store/task-store.ts"]
mutates:    ["packages/ai/agent-mcp/src/engine/orchestrator.ts",
             "packages/ai/agent-mcp/src/__tests__/stream-orchestrator.test.ts"]
```

---

## Contract Promise

- **Modified:** `orchestrator.ts` — emits 5 event types via `emitTaskEvent`
- **Added:** `__tests__/stream-orchestrator.test.ts` — verifies events emitted in order

---

## Commit points

- [ ] **After orchestrator wiring + tests pass** (mandatory):
      `feat(agent-mcp): stream-orchestrator — emit token/tool_call/tool_result/status_change/done`

---

## Notes

- **Footgun: streaming vs non-streaming provider.** The current orchestrator may not use
  streaming mode for the AI provider. Before adding `token` event emission, check whether
  the provider call in orchestrator.ts already streams. If not, switching to streaming mode
  is a prerequisite for `token` events. `tool_call`, `tool_result`, `status_change`, and
  `done` events work regardless of streaming mode.
- **`done` must fire on the error path.** The orchestrator has a try/catch. Ensure `done` is
  emitted in both the happy path and the catch block.
- **Test approach:** Subscribe to `subscribeToTask(taskId, ...)` before triggering orchestrator.
  Capture events in an array. Assert order: `status_change("running")` → `token`* →
  `tool_call`? → `tool_result`? → `done`.
- **`status_change` from TaskStore:** If the orchestrator calls `taskStore.updateStatus()`,
  the `status_change` event should be emitted immediately after that call inside the orchestrator
  — do NOT add emission to TaskStore itself (it's a shared primitive without task context).
