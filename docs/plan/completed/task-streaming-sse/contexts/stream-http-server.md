# stream-http-server

**Phase:** foundation · **Depends on:** stream-event-bus · **Guard:**
```bash
test -f packages/ai/agent-mcp/src/streaming/sse-server.ts && \
grep -q '/tasks/' packages/ai/agent-mcp/src/streaming/sse-server.ts && \
grep -q 'SSE_PORT' packages/ai/agent-mcp/src/streaming/sse-server.ts
```

---

## Goal

Create `packages/ai/agent-mcp/src/streaming/sse-server.ts` — a Node HTTP server that handles
`GET /tasks/:id/stream` SSE connections. Wire it into `src/index.ts` so it starts alongside
the MCP server.

---

## Semantic Distillation

- **Primitive:** CREATE `streaming/sse-server.ts`. MODIFY `src/index.ts`.

- **Delta Spec (`streaming/sse-server.ts`):**
  ```typescript
  import http from "node:http";
  import { subscribeToTask, TaskStreamEvent } from "./event-bus.js";

  const SSE_PORT = parseInt(process.env["SSE_PORT"] ?? "3001", 10);
  const KEEPALIVE_INTERVAL_MS = 15_000;

  export function startSseServer(): http.Server {
      const server = http.createServer((req, res) => {
          // Route: GET /tasks/:id/stream
          const match = req.url?.match(/^\/tasks\/([^/]+)\/stream$/);
          if (!match || req.method !== "GET") {
              res.writeHead(404);
              res.end("Not found");
              return;
          }
          const taskId = match[1];

          res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              "X-Accel-Buffering": "no",
          });
          res.flushHeaders?.();

          // Keep-alive ping
          const pingTimer = setInterval(() => {
              res.write(": ping\n\n");
          }, KEEPALIVE_INTERVAL_MS);

          // On connect: check if task is already terminal. If so, emit done immediately
          // and close — prevents reconnected clients from hanging forever waiting for
          // a done event that already fired before they connected.
          const existingTask = taskStore.read(taskId);
          const TERMINAL = ["completed", "failed", "cancelled"];
          if (existingTask && TERMINAL.includes(existingTask.status)) {
              emitTaskEvent({ type: "status_change", taskId, status: existingTask.status });
              emitTaskEvent({ type: "done", taskId,
                  result: existingTask.result ?? null,
                  error: existingTask.error ?? null });
              clearInterval(pingTimer);
              res.end();
              return;
          }

          // Subscribe to task events
          const unsubscribe = subscribeToTask(taskId, (event: TaskStreamEvent) => {
              if (cleaned) return; // guard against post-cleanup emissions
              const data = JSON.stringify(event);
              res.write(`event: ${event.type}\ndata: ${data}\n\n`);
              if (event.type === "done") {
                  cleanup();
              }
          });

          // `cleaned` flag prevents double-call: done handler calls cleanup() which calls
          // res.end(); req.on("close") fires because res.end() closes the connection and
          // would call cleanup() again — the second res.end() throws ERR_HTTP_HEADERS_SENT.
          let cleaned = false;
          function cleanup() {
              if (cleaned) return;
              cleaned = true;
              clearInterval(pingTimer);
              unsubscribe();
              res.end();
          }

          req.on("close", cleanup);
      });

      // Bind to localhost by default — exposes on all interfaces only if SSE_HOST is set.
      const SSE_HOST = process.env["SSE_HOST"] ?? "127.0.0.1";
      server.listen(SSE_PORT, SSE_HOST, () => {
          console.log(`SSE server listening on ${SSE_HOST}:${SSE_PORT}`);
      });

      return server;
  }
  ```

  **`src/index.ts`** — store the returned server and wire it into the shutdown handler:
  ```typescript
  import { startSseServer } from "./streaming/sse-server.js";

  // ... after existing MCP init ...
  const sseServer = startSseServer();

  // In the existing SIGTERM/SIGINT shutdown handler, add:
  sseServer.close(() => {
      // SSE connections drained
  });
  ```

  `startSseServer()` must be added to the same shutdown block that calls `close()` on the
  MCP server, so both servers drain cleanly on SIGTERM. Without this, the SSE port stays
  open after signal and the process may not exit.

- **Invariants:** See `[inv:separate-http-server]`, `[inv:done-closes-connection]`.

- **Validation:** file exists + `/tasks/` route + `SSE_PORT` reference.

---

## Acceptance criteria

- [ ] **[stream-http-server.1]** `streaming/sse-server.ts` exists.
      `test -f packages/ai/agent-mcp/src/streaming/sse-server.ts`
- [ ] **[stream-http-server.2]** `/tasks/` route pattern in sse-server.ts.
      `grep -q '/tasks/' packages/ai/agent-mcp/src/streaming/sse-server.ts`
- [ ] **[stream-http-server.3]** `SSE_PORT` env var referenced.
      `grep -q 'SSE_PORT' packages/ai/agent-mcp/src/streaming/sse-server.ts`
- [ ] **[stream-http-server.4]** `startSseServer` called in `src/index.ts`.
      `grep -q 'startSseServer' packages/ai/agent-mcp/src/index.ts`
- [ ] **[stream-http-server.5]** `Content-Type: text/event-stream` set in response.
      `grep -q 'text/event-stream' packages/ai/agent-mcp/src/streaming/sse-server.ts`

---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src/streaming/event-bus.ts"]
mutates:    ["packages/ai/agent-mcp/src/streaming/sse-server.ts",
             "packages/ai/agent-mcp/src/index.ts"]
```

---

## Contract Promise

- **Added:** `streaming/sse-server.ts` — SSE HTTP server, `GET /tasks/:id/stream`
- **Modified:** `src/index.ts` — calls `startSseServer()` on startup

---

## Commit points

- [ ] **After sse-server creation + index.ts wiring** (mandatory):
      `feat(agent-mcp): stream-http-server — SSE GET /tasks/:id/stream endpoint`

---

## Notes

- `res.flushHeaders?.()` — optional chaining for older Node versions. In Node 16+ this is
  always available, but the optional guard is safe.
- `X-Accel-Buffering: no` — prevents nginx from buffering SSE responses when behind a proxy.
- The server listens on all interfaces. For production, bind to localhost via
  `server.listen(SSE_PORT, "127.0.0.1", ...)` and proxy through nginx.
- **Test note:** SSE server tests should use Node's `http` module to make real HTTP requests
  rather than mocking the server. Fire an event via `emitTaskEvent` and verify the SSE
  connection receives it.
