import http from "node:http";
import { subscribeToTask, type TaskStreamEvent } from "./event-bus.js";
import { handleGetModels, handleChatCompletions, type GatewayDepsRef } from "./chat-gateway.js";
import type { TaskStore } from "@adhd/agent-store-runtime";
import { logger } from "../logger.js";
import { env } from "../config.js";

const KEEPALIVE_INTERVAL_MS = 15_000;
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

export interface SseServerStartResult {
    server: http.Server;
    /** The port actually bound (may differ from the requested `port` — see
     *  the EADDRINUSE→ephemeral fallback below), or `undefined` if the
     *  server never managed to bind at all (SSE streaming and the
     *  OpenAI-compat gateway are unavailable on this instance in that
     *  case; still non-fatal — the MCP server itself continues). */
    port: number | undefined;
}

/**
 * Starts the SSE/OpenAI-compat-gateway HTTP server, resolving once it is
 * either actually listening or has definitively failed to bind.
 *
 * Port-contention handling (BUG-AGENTMCP-SSE-PORT-CONTENTION-001): multiple
 * `agent-mcp` instances run concurrently (one per stdio host connection),
 * and `port` may be a shared default (3001) or a per-instance-derived
 * candidate (see `resolveInitialSsePort()` in `config.ts`) that still
 * happens to collide. Either way, on `EADDRINUSE` this retries EXACTLY
 * ONCE with `listen(0, host)` — an OS-assigned ephemeral port — so an
 * instance never loses SSE/gateway service just because another instance
 * got there first.
 */
export function startSseServer(
    taskStore: TaskStore,
    port: number = env.config.sse.port,
    host: string = env.config.sse.host,
    gatewayDepsRef?: GatewayDepsRef
): Promise<SseServerStartResult> {
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
        const taskId = match[1];
        if (!taskId) {
            res.writeHead(404);
            res.end("Not found");
            return;
        }

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

    return new Promise<SseServerStartResult>((resolve) => {
        let settled = false;
        let triedEphemeralFallback = false;

        const settle = (boundPort: number | undefined) => {
            if (settled) return;
            settled = true;
            resolve({ server, port: boundPort });
        };

        server.on("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE" && !triedEphemeralFallback) {
                triedEphemeralFallback = true;
                logger.warn(
                    { host, port, err: err.message },
                    "SSE port already in use (another agent-mcp instance likely holds it) — falling back to an OS-assigned ephemeral port"
                );
                server.listen(0, host);
                return;
            }
            logger.error(
                { host, port, code: err.code, err: err.message },
                "SSE server failed to bind — task SSE streaming and the OpenAI-compat gateway are DISABLED for this instance; the MCP server continues normally"
            );
            settle(undefined);
        });

        server.on("listening", () => {
            const addr = server.address();
            const boundPort = addr && typeof addr === "object" ? addr.port : port;
            logger.info({ host, port: boundPort }, "SSE server listening");
            settle(boundPort);
        });

        server.listen(port, host);
    });
}
