import http from "node:http";
import { subscribeToTask, type TaskStreamEvent } from "./event-bus.js";
import { handleGetModels, handleChatCompletions, type GatewayDepsRef } from "./chat-gateway.js";
import type { TaskStore } from "../store/task-store.js";
import { logger } from "../logger.js";
import { config } from "../config.js";

const KEEPALIVE_INTERVAL_MS = 15_000;
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

/**
 * Start the task-streaming SSE server.
 *
 * Serves two surfaces on a single node:http server:
 *  - `/tasks/:id/stream`            — existing task-event SSE stream
 *  - `/v1/models`                   — OpenAI-compatible agent listing (P0 gateway)
 *  - `/v1/chat/completions`         — OpenAI-compatible chat turns (P0 gateway)
 *
 * The gateway routes (`/v1/*`) are always active when `gatewayDepsRef` is
 * supplied and its `value` is non-null.  They return 503 while the server is
 * still initializing (value === undefined).  No opt-in flag is required; the
 * SSE server already starts by default from index.ts.
 *
 * @param taskStore       TaskStore for terminal-on-connect checks on the SSE path.
 * @param port            port to bind (default config.sse.port, else 3001).
 *                        Pass `0` for an ephemeral port (used by tests).
 * @param host            host to bind (default config.sse.host, else 127.0.0.1).
 * @param gatewayDepsRef  Late-bound gateway deps ref-box.  Populated by index.ts
 *                        after startServer resolves (mirrors the taskDepsRef pattern).
 *                        When absent (e.g. existing SSE-only tests) the `/v1/*`
 *                        routes return 404 to preserve existing test behaviour.
 *
 * A bind failure (e.g. `EADDRINUSE` when the port is already taken) is handled
 * gracefully: it is logged and SSE streaming is left unavailable, but the
 * process does NOT crash — the stdio MCP transport, which never needed the
 * port, keeps serving. (BUG-001)
 */
export function startSseServer(
    taskStore: TaskStore,
    port: number = config.sse.port,
    host: string = config.sse.host,
    gatewayDepsRef?: GatewayDepsRef
): http.Server {
    const server = http.createServer((req, res) => {
        const url = req.url ?? "";
        const method = req.method ?? "GET";

        // ── Route: GET /v1/models ─────────────────────────────────────────
        if (url === "/v1/models" && method === "GET") {
            if (!gatewayDepsRef?.value) {
                res.writeHead(503, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: { message: "Gateway not yet initialized", type: "server_error" } }));
                return;
            }
            handleGetModels(res, gatewayDepsRef.value);
            return;
        }

        // ── Route: POST /v1/chat/completions ──────────────────────────────
        if (url === "/v1/chat/completions" && method === "POST") {
            if (!gatewayDepsRef?.value) {
                res.writeHead(503, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: { message: "Gateway not yet initialized", type: "server_error" } }));
                return;
            }
            handleChatCompletions(req, res, gatewayDepsRef.value).catch((err: unknown) => {
                logger.error({ err }, "chat-gateway: unhandled error in handleChatCompletions");
                if (!res.headersSent) {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: { message: "Internal server error", type: "server_error" } }));
                }
            });
            return;
        }

        // ── Route: GET /tasks/:id/stream — :id must be a UUID ────────────
        const match = url.match(
            /^\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/stream$/i
        );
        if (!match || method !== "GET") {
            res.writeHead(404);
            res.end("Not found");
            return;
        }
        const taskId = match[1]!;

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

        // Terminal-on-connect short-circuit: if the task is already in a terminal
        // state when the client connects, emit status_change + done and close
        // immediately — prevents clients from hanging forever waiting for events
        // that already fired before they connected.
        let existingTask: ReturnType<TaskStore["read"]> | null = null;
        try {
            existingTask = taskStore.read(taskId);
        } catch {
            // TASK_NOT_FOUND — let the client wait (task may not exist yet)
        }

        if (existingTask && TERMINAL_STATUSES.includes(existingTask.status as typeof TERMINAL_STATUSES[number])) {
            // Write directly to THIS response. The connection has not subscribed
            // yet, so emitting on the shared bus would miss this client entirely
            // and would also spuriously close any OTHER client still subscribed to
            // the same task (their handler would see a second done and clean up).
            const statusEvent: TaskStreamEvent = {
                type: "status_change",
                taskId,
                status: existingTask.status,
            };
            const doneEvent: TaskStreamEvent = {
                type: "done",
                taskId,
                result: existingTask.result ?? null,
                error: existingTask.error ?? null,
            };
            res.write(`event: ${statusEvent.type}\ndata: ${JSON.stringify(statusEvent)}\n\n`);
            res.write(`event: ${doneEvent.type}\ndata: ${JSON.stringify(doneEvent)}\n\n`);
            clearInterval(pingTimer);
            res.end();
            return;
        }

        // `cleaned` flag prevents double-call: done handler calls cleanup() which
        // calls res.end(); req.on("close") fires because res.end() closes the
        // connection and would call cleanup() again — the second res.end() throws
        // ERR_HTTP_HEADERS_SENT.
        let cleaned = false;
        function cleanup() {
            if (cleaned) return;
            cleaned = true;
            clearInterval(pingTimer);
            unsubscribe();
            res.end();
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

        req.on("close", cleanup);
    });

    // Handle bind/runtime errors so an unhandled 'error' event can't crash the
    // whole MCP process (BUG-001). EADDRINUSE (port already taken) is the common
    // case — degrade to "SSE unavailable" rather than taking down the server.
    server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
            logger.warn(
                { host, port, err: err.message },
                "SSE server could not bind (port already in use) — task SSE streaming is DISABLED; the MCP server continues normally. Set SSE_PORT to a free port to enable streaming."
            );
        } else {
            logger.error(
                { host, port, code: err.code, err: err.message },
                "SSE server error — task streaming disabled"
            );
        }
    });

    server.listen(port, host, () => {
        // Use the pino logger (stderr) — never console.log, which writes to
        // stdout and corrupts the MCP JSON-RPC transport on the shared process.
        const addr = server.address();
        const boundPort = addr && typeof addr === "object" ? addr.port : port;
        logger.info({ host, port: boundPort }, "SSE server listening");
    });

    return server;
}
