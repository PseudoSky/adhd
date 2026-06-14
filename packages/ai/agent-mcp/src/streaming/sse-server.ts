import http from "node:http";
import { subscribeToTask, emitTaskEvent, type TaskStreamEvent } from "./event-bus.js";
import type { TaskStore } from "../store/task-store.js";

const SSE_PORT = parseInt(process.env["SSE_PORT"] ?? "3001", 10);
const KEEPALIVE_INTERVAL_MS = 15_000;
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

export function startSseServer(taskStore: TaskStore): http.Server {
    const server = http.createServer((req, res) => {
        // Route: GET /tasks/:id/stream
        const match = req.url?.match(/^\/tasks\/([^/]+)\/stream$/);
        if (!match || req.method !== "GET") {
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
            emitTaskEvent({ type: "status_change", taskId, status: existingTask.status });
            emitTaskEvent({
                type: "done",
                taskId,
                result: existingTask.result ?? null,
                error: existingTask.error ?? null,
            });
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

    // Bind to localhost by default — exposes on all interfaces only if SSE_HOST is set.
    const SSE_HOST = process.env["SSE_HOST"] ?? "127.0.0.1";
    server.listen(SSE_PORT, SSE_HOST, () => {
        console.log(`SSE server listening on ${SSE_HOST}:${SSE_PORT}`);
    });

    return server;
}
