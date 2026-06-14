# stream-event-bus

**Phase:** foundation · **Depends on:** — · **Guard:**
```bash
test -f packages/ai/agent-mcp/src/streaming/event-bus.ts && \
grep -q 'TaskStreamEvent' packages/ai/agent-mcp/src/streaming/event-bus.ts
```

---

## Goal

Create `packages/ai/agent-mcp/src/streaming/event-bus.ts` — the in-memory event bus that
decouples the orchestrator (emitter) from the SSE handler (subscriber).

---

## Semantic Distillation

- **Primitive:** CREATE `packages/ai/agent-mcp/src/streaming/event-bus.ts`.

- **Delta Spec:**
  ```typescript
  import { EventEmitter } from "node:events";

  export type TaskStreamEvent =
    | { type: "token";         taskId: string; chunk: string }
    | { type: "tool_call";     taskId: string; toolName: string; toolCallId: string; input: unknown }
    | { type: "tool_result";   taskId: string; toolCallId: string; content: unknown }
    | { type: "status_change"; taskId: string; status: string }
    | { type: "done";          taskId: string; result: string | null; error: string | null };

  const emitter = new EventEmitter();
  emitter.setMaxListeners(500); // many concurrent SSE connections

  export function emitTaskEvent(event: TaskStreamEvent): void {
      emitter.emit(`task:${event.taskId}`, event);
  }

  export function subscribeToTask(
      taskId: string,
      handler: (event: TaskStreamEvent) => void,
  ): () => void {
      const key = `task:${taskId}`;
      emitter.on(key, handler);
      return () => emitter.off(key, handler);
  }
  ```

- **Invariants:** See `[inv:event-bus-no-db]` — no DB polling, no persistence.

- **Validation:** file exists + `TaskStreamEvent` defined.

---

## Acceptance criteria

- [ ] **[stream-event-bus.1]** `streaming/event-bus.ts` exists.
      `test -f packages/ai/agent-mcp/src/streaming/event-bus.ts`
- [ ] **[stream-event-bus.2]** `TaskStreamEvent` type exported.
      `grep -q 'TaskStreamEvent' packages/ai/agent-mcp/src/streaming/event-bus.ts`
- [ ] **[stream-event-bus.3]** `emitTaskEvent` exported.
      `grep -q 'emitTaskEvent' packages/ai/agent-mcp/src/streaming/event-bus.ts`
- [ ] **[stream-event-bus.4]** `subscribeToTask` exported.
      `grep -q 'subscribeToTask' packages/ai/agent-mcp/src/streaming/event-bus.ts`

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp/src/streaming/event-bus.ts"]
```

---

## Contract Promise

- **Added:** `streaming/event-bus.ts` — `TaskStreamEvent` union, `emitTaskEvent`, `subscribeToTask`

---

## Commit points

- [ ] **After event-bus creation** (mandatory):
      `feat(agent-mcp): stream-event-bus — in-memory EventBus for SSE task events`

---

## Notes

- `setMaxListeners(500)` prevents Node's default 10-listener warning when many SSE clients
  connect to the same task. Adjust if needed.
- The event key format `task:${taskId}` allows multiple tasks to share one EventEmitter
  without listener bleed-through.
- No cleanup for tasks that complete: after the `done` event, the SSE handler unsubscribes
  via the returned unsubscribe function. The emitter retains no state for completed tasks.
