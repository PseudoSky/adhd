import http from "node:http";
import { subscribeToTask, type TaskStreamEvent } from "./event-bus.js";
import { handleGetModels, handleChatCompletions, type GatewayDepsRef } from "./chat-gateway.js";
import type { TaskStore } from "@adhd/agent-store-runtime";
import { logger } from "../logger.js";
import { config } from "../config.js";

const KEEPALIVE_INTERVAL_MS = 15_000;
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

export function startSseServer(
    taskStore: TaskStore,
    port: number = config.sse.port,
    host: string = config.sse.host,
    gatewayDepsRef?: GatewayDepsRef
): http.Server {
    const server = http.createServer((req, res) => {
        const url = req.url ?? "";
        const method = req.method ?? "GET";

        if (url === "/v1/models" && method === "GET") {
            if (!gatewayDepsRef?.value) {
                res.writeHead(503, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: { message: "Gateway not yet initialized", type: "server_error" } }));
                return;
            }
            handleGetModels(res, gatewayDepsRef.value);
            return;
        }

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

        const pingTimer = setInterval(() => {
            res.write(": ping\n\n");
        }, KEEPALIVE_INTERVAL_MS);

        let existingTask: ReturnType<TaskStore["read"]> | null = null;
        try {
            existingTask = taskStore.read(taskId);
        } catch {
            // TASK_NOT_FOUND — let the client wait
        }

        if (existingTask && TERMINAL_STATUSES.includes(existingTask.status as typeof TERMINAL_STATUSES[number])) {
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

        let cleaned = false;
        function cleanup() {
            if (cleaned) return;
            cleaned = true;
            clearInterval(pingTimer);
            unsubscribe();
            res.end();
        }

        const unsubscribe = subscribeToTask(taskId, (event: TaskStreamEvent) => {
            if (cleaned) return;
            const data = JSON.stringify(event);
            res.write(`event: ${event.type}\ndata: ${data}\n\n`);
            if (event.type === "done") {
                cleanup();
            }
        });

        req.on("close", cleanup);
    });

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
        const addr = server.address();
        const boundPort = addr && typeof addr === "object" ? addr.port : port;
        logger.info({ host, port: boundPort }, "SSE server listening");
    });

    return server;
}
