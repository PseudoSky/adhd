# Scenario: `sse-port-param`

**Tier:** simple (feature add — optional parameter). **Real change shipped in:** commit `9944cb7` (the injectable-port half of the SSE work).

---

## The coding task

`startSseServer(taskStore)` always binds the port from `SSE_PORT` (env, default
3001). **Add an optional `port` parameter** (and, while you're there, `host`) so
tests can bind an ephemeral port (`0`) — defaulting to the current env-derived
values so existing callers are unaffected. Pure additive feature; no debugging.

> Scope note: this scenario is *only* the parameterization. The separate
> EADDRINUSE crash is its own scenario (`sse-eaddrinuse`).

Context (before):
```ts
const SSE_PORT = parseInt(process.env["SSE_PORT"] ?? "3001", 10);

export function startSseServer(taskStore: TaskStore): http.Server {
    const server = http.createServer((req, res) => { /* …unchanged… */ });
    const SSE_HOST = process.env["SSE_HOST"] ?? "127.0.0.1";
    server.listen(SSE_PORT, SSE_HOST, () => {
        logger.info({ host: SSE_HOST, port: SSE_PORT }, "SSE server listening");
    });
    return server;
}
```

## Raw correct solution (shape, as shipped)

```ts
export function startSseServer(
    taskStore: TaskStore,
    port: number = SSE_PORT,
    host: string = process.env["SSE_HOST"] ?? "127.0.0.1"
): http.Server {
    const server = http.createServer((req, res) => { /* …unchanged… */ });
    server.listen(port, host, () => {
        const addr = server.address();
        const boundPort = addr && typeof addr === "object" ? addr.port : port;
        logger.info({ host, port: boundPort }, "SSE server listening");
    });
    return server;
}
```

## Rubric (0–5; "pass" = additive param with a default that preserves current behavior)

| # | Criterion | Weight |
|---|---|---|
| R1 | Adds an **optional** `port` parameter (default = the existing `SSE_PORT`) | ★★★ |
| R2 | Existing callers unaffected — omitting the arg behaves exactly as before | ★★ |
| R3 | The parameter is actually used in `listen()` (not shadowed by the old const) | ★★ |
| R4 | Compiles; param typed `number` | ★ |
| R5 | (bonus) reports the **actual bound** port for the ephemeral (`0`) case | ★ |

**Watch-fors:** adding the param but still calling `listen(SSE_PORT, …)` — R3 ✗;
making `port` required (breaks existing callers) — R1/R2 ✗.
