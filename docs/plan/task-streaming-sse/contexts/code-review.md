# code-review

**Phase:** convergence · **Depends on:** audit-foundation · **Guard:**
```bash
test -f docs/plan/task-streaming-sse/.code-review-complete
```

---

## Goal

Human code review of all SSE streaming changes. Human hold point.

---

## Review scope

1. **EventBus** (`streaming/event-bus.ts`): `TaskStreamEvent` union complete, `setMaxListeners`,
   subscribe/unsubscribe memory safety.
2. **SSE server** (`streaming/sse-server.ts`): correct SSE headers (`text/event-stream`,
   `Cache-Control`, `Connection`), keep-alive ping, cleanup on `req.close` and `done` event,
   route pattern handles UUIDs.
3. **Orchestrator** (`engine/orchestrator.ts`): all 5 event types emitted at correct points,
   `done` emitted on error path, no event emitted after `done`.
4. **Task tool** (`tools/task.ts`): `stream_url` only when `stream: true`, `SSE_BASE_URL`
   configurable, no DB column.
5. **Tests**: SSE event order, stream_url present/absent, memory leak prevention (unsubscribe
   called after done).

---

## Human action required

When review is approved:
```bash
touch docs/plan/task-streaming-sse/.code-review-complete
```

---

## Reservations

```text
read_only:  ["*"]
mutates:    ["docs/plan/task-streaming-sse/.code-review-complete"]
```
