# Plan: task-streaming-sse (0.4.0)

**Feature:** #30 Task Streaming via SSE
**Target version:** `agent-mcp@0.4.0`
**Issues:** #30 SSE streaming

---

## Definition of Done

- `[dod.1]` A `GET /tasks/:id/stream` SSE endpoint exists on a separate HTTP server (not the MCP stdio transport).
- `[dod.2]` Clients can opt into streaming by passing `stream: true` in the task tool input; the response includes `stream_url` pointing to the SSE endpoint.
- `[dod.3]` `token` events are **deferred to 0.5.0** — the `LLMProvider` interface currently returns `Promise<ProviderChatResponse>` with no streaming iterator (`providers/types.ts:38`); adding token emission requires a breaking interface change to `LLMProvider`. In 0.4.0, `tool_call`, `tool_result`, `status_change`, and `done` events are emitted; `token` events are silently omitted.
- `[dod.4]` The SSE stream emits `tool_call` events when the orchestrator dispatches a tool.
- `[dod.5]` The SSE stream emits `tool_result` events when a tool result is appended.
- `[dod.6]` The SSE stream emits `status_change` events on every task status transition.
- `[dod.7]` The SSE stream emits a `done` event (with final result) when the task completes.
- `[dod.8]` The HTTP server is started alongside the MCP server on a configurable port (`SSE_PORT` env var, default `3001`).
- `[dod.9]` `agent-mcp` published at version `0.4.0`.

---

## Execution model

- **Implementer:** `sox-active:typescript-pro`
- **Reviewer:** `code-reviewer` subagent + human sentinel (`.code-review-complete`)
- **Automatic dispatch:** No

---

## Design invariants

- The SSE HTTP server is completely separate from the MCP stdio transport — they share no
  connection handling code. The SSE server is a plain Node `http.createServer()` or Express server.
- The event bus is an in-memory `EventEmitter` keyed by `taskId`. Orchestrator emits; SSE
  handler listens. No DB polling.
- Events after task completion: the `done` event closes the SSE connection. Any subsequent
  events (e.g., from a concurrent dispatcher race) are silently dropped.
- `stream_url` in the task response is `http://localhost:{SSE_PORT}/tasks/{taskId}/stream`.
  Production deployments must configure this via `SSE_BASE_URL` env var.
- SSE connections are per-request (not WebSocket). On reconnect, the client does not receive
  missed events (no replay). This is documented as a known limitation.
