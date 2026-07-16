# Shared Definitions — task-streaming-sse

## [def:TaskStreamEvent]

The union type for all SSE events emitted per task:

```typescript
export type TaskStreamEvent =
  | { type: "token";         taskId: string; chunk: string }
  | { type: "tool_call";     taskId: string; toolName: string; toolCallId: string; input: unknown }
  | { type: "tool_result";   taskId: string; toolCallId: string; content: unknown }
  | { type: "status_change"; taskId: string; status: string }
  | { type: "done";          taskId: string; result: string | null; error: string | null };
```

These are the only events. No other event types. Wire format: named SSE event with JSON data.

## [def:EventBus]

An in-memory `EventEmitter`-based singleton. API:
```typescript
export function emitTaskEvent(event: TaskStreamEvent): void
export function subscribeToTask(taskId: string, handler: (e: TaskStreamEvent) => void): () => void
```
`subscribeToTask` returns an unsubscribe function. The SSE handler calls it when the connection
closes (or on the `done` event) to prevent memory leaks.

## [def:SseWireFormat]

Named SSE events:
```
event: <type>\ndata: <JSON.stringify(event)>\n\n
```
Keep-alive ping every 15 seconds:
```
: ping\n\n
```
The connection is closed by the server after sending the `done` event.

## [def:StreamUrl]

`stream_url` format: `${SSE_BASE_URL}/tasks/${taskId}/stream`

Where `SSE_BASE_URL` defaults to `http://localhost:${SSE_PORT}` and `SSE_PORT` defaults to `3001`.
Configure both via environment variables for production.

## [shape:TaskInputStreamField]

```typescript
// Added to both sessionModeSchema and ephemeralModeSchema in taskToolInputSchema:
stream: z.boolean().optional(),
```

## [shape:TaskResponseWithStream]

```typescript
// task tool response when stream: true:
{
    taskId: string,
    status: "pending" | "waiting",
    stream_url: string,     // added when input.stream === true
}
```

## [inv:event-bus-no-db]

The event bus is entirely in-memory. It does NOT poll the DB, store events, or write to disk.
Events are fire-and-forget. Missed events (e.g., client connects after task starts) are not
replayed. This is a documented limitation.

## [inv:done-closes-connection]

After emitting the `done` event, the SSE server closes the response and unsubscribes from the
event bus. No further events are emitted on a closed connection.

## [inv:no-schema-migration]

SSE streaming requires no DB schema changes. The `stream` flag is request-time only;
`stream_url` is computed at task creation time. No new columns needed.

## [inv:separate-http-server]

The SSE HTTP server is NOT the MCP server. They run on different ports. The MCP server uses
stdio (or HTTP in claude.ai mode). The SSE server is a plain Node http server. They share no
connection handling code — only the event bus.

## [inv:token-events-from-streaming-provider]

`token` events require streaming from the AI provider. The orchestrator must call the provider
with `stream: true` (or equivalent) to receive chunks. If the provider does not support
streaming, `token` events are not emitted. The `done` event is always emitted.
