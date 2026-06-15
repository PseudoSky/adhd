# Scenario: `sse-eaddrinuse`

**Difficulty:** moderate. **Real fix shipped in:** commit `9944cb7` (BUG-001).

---

## The coding task

The process is primarily an MCP server speaking JSON-RPC over **stdio**. At startup
it *also* starts an HTTP SSE server for optional task streaming. **Symptom:** if the
SSE port (`SSE_PORT`, default 3001) is already in use, the **entire process dies**
with an uncaught error + stack trace — taking down the stdio MCP server, which never
needed that port. Desired: if SSE can't bind, the stdio server keeps running (SSE
just unavailable), logged usefully; also make the bind port injectable for tests.

"Before" code:
```ts
const SSE_PORT = parseInt(process.env["SSE_PORT"] ?? "3001", 10);
export function startSseServer(taskStore: TaskStore): http.Server {
    const server = http.createServer((req, res) => { /* …SSE routing… */ });
    const SSE_HOST = process.env["SSE_HOST"] ?? "127.0.0.1";
    server.listen(SSE_PORT, SSE_HOST, () => {
        logger.info({ host: SSE_HOST, port: SSE_PORT }, "SSE server listening");
    });
    return server;
}
```
`index.ts` uses it **synchronously** and closes it on shutdown:
```ts
const sseServer = startSseServer(taskStore);
await new Promise<void>((resolve) => sseServer.close(() => resolve()));
```

## The subtlety

`server.listen()` does **not** throw on `EADDRINUSE` — it emits an asynchronous
`'error'` **event** on the `http.Server`. An `'error'` event with no listener is
re-thrown by Node as an uncaught exception → process exit. Therefore a `try/catch`
around `listen()` does **not** help (the error fires after `listen()` returns). The
fix is to attach an `'error'` listener; and the return type must stay
`http.Server` (the caller uses it synchronously and calls `.close()`).

## Raw correct solution (as shipped)

```ts
export function startSseServer(
    taskStore: TaskStore,
    port: number = SSE_PORT,
    host: string = process.env["SSE_HOST"] ?? "127.0.0.1"
): http.Server {
    const server = http.createServer((req, res) => { /* …unchanged… */ });

    server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
            logger.warn({ host, port, err: err.message },
                "SSE server could not bind (port in use) — task SSE streaming DISABLED; the MCP server continues. Set SSE_PORT to a free port to enable streaming.");
        } else {
            logger.error({ host, port, code: err.code, err: err.message }, "SSE server error — streaming disabled");
        }
    });

    server.listen(port, host, () => {
        const addr = server.address();
        const boundPort = addr && typeof addr === "object" ? addr.port : port;
        logger.info({ host, port: boundPort }, "SSE server listening");
    });
    return server;
}
```
Harness binds an ephemeral port via the new `port` param (no double-`listen`).
Test: `sse.integration.test.ts` → "BUG-001 … bind failure does not crash" — attaches
**no** `'error'` listener of its own (teeth: without the in-server handler the
unhandled event crashes the worker and fails the file).

## Rubric (0–5; "pass" = a fix that actually survives EADDRINUSE)

| # | Criterion | Weight |
|---|---|---|
| R1 | **Root cause** = unhandled async `'error'` **event** (NOT a thrown exception / promise rejection) | ★★★ |
| R2 | **Fix attaches `server.on("error", …)`** (or otherwise handles the emitter event) — process survives | ★★★ |
| R3 | **Does NOT use `try/catch` around `listen()`** as the mechanism (it can't catch the async event) | ★★ |
| R4 | **Preserves the caller contract** — returns `http.Server` synchronously (no `Promise`, no `\| null` that breaks `.close()`) | ★★ |
| R5 | **Compiles** (no syntax errors, e.g. nested function declarations) | ★★ |
| R6 | **Port injectable** via a real parameter (not `process.argv[2]`, not a type-mismatched env string) | ★ |
| R7 | Actionable log + a test that proves survival | ★ |

**Common failure signatures observed:** "UnhandledPromiseRejection"/"listen throws"
(R1 ✗); `try/catch` around `listen()` (R2/R3 ✗); changing the return to
`http.Server \| null` or a `Promise` (R4 ✗); duplicated/nested `export function`
(R5 ✗); `process.argv[2]` for the port (R6 ✗).
