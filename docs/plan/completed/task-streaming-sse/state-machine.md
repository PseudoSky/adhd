# State Machine — task-streaming-sse

## States

| Slug | Kind | Phase | Depends on | Guard |
|---|---|---|---|---|
| `stream-event-bus` | work | foundation | — | event-bus.ts exists + TaskStreamEvent defined |
| `stream-http-server` | work | foundation | stream-event-bus | sse-server.ts has /tasks/ route + SSE_PORT |
| `stream-orchestrator` | work | engine | stream-http-server | orchestrator emits eventBus + token + tests pass |
| `stream-task-tool` | work | engine | stream-orchestrator | stream_url in task response + stream in validation + tests pass |
| `audit-foundation` | audit | engine | stream-task-tool | `audit_sse.py --phase foundation` exits 0 |
| `code-review` | review | convergence | audit-foundation | `.code-review-complete` sentinel exists |
| `audit-final` | audit | convergence | code-review | `audit_sse.py --phase final` exits 0 |
| `docs-and-publish` | work | convergence | audit-final | version = 0.4.0 AND npm shows 0.4.0 |
| `done` | terminal | — | docs-and-publish | — |

## Topology

```
stream-event-bus
    │
    ▼
stream-http-server
    │
    ▼
stream-orchestrator
    │
    ▼
stream-task-tool
    │
    ▼
audit-foundation
    │
    ▼
code-review  ← human hold point
    │
    ▼
audit-final
    │
    ▼
docs-and-publish
    │
    ▼
  done
```

## Key transitions

- `stream-event-bus` → `stream-http-server`: EventBus module exists with typed events.
- `stream-http-server` → `stream-orchestrator`: SSE endpoint exists, started in index.ts.
- `stream-orchestrator` → `stream-task-tool`: orchestrator emits all 5 event types.
- `stream-task-tool` → `audit-foundation`: task tool returns `stream_url` when `stream: true`.
- `code-review` → `audit-final`: human sentinel created.

## Rollback

EventBus and sse-server.ts are new files — delete to rollback. Orchestrator and tools/task.ts
changes are additive — revert specific hunks. No schema migration required.
