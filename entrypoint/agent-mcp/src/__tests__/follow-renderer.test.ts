/**
 * Tests for the SSE follow renderer (c667a213, agent-mcp side).
 *
 * Two layers, per the repo's verification standard:
 *
 *  1. PURE WIRE-FORMAT PARSER — `parseSseEvents` decodes the exact frames
 *     `sse-server.ts` writes (`event: <type>\ndata: <json>\n\n`, plus `: ping`
 *     keepalives), incrementally across chunk boundaries, keyed off the JSON
 *     payload's own `type` (not the `event:` line).
 *
 *  2. REAL SEAM — `followTaskStream` drives a REAL `http.Server` started by the
 *     real `startSseServer` over a real loopback socket, and receives REAL
 *     events emitted through the real `event-bus`. It asserts the consumer-
 *     visible outcome the feature exists for: assistant text arrives as
 *     INCREMENTAL `token` events that precede the terminal `done`, and the
 *     returned promise resolves on `done` with the final result — no polling,
 *     no DB reads.
 *
 * Determinism: `startSseServer`'s request handler writes headers and calls
 * `subscribeToTask` in the SAME synchronous block, before the client's
 * `http.get` callback can fire. So `onOpen` firing is itself proof the
 * subscription is established — the test emits events only after `onOpen`, and
 * never sleeps or wall-clock-waits.
 */
import http from "node:http";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { TaskStore } from "@adhd/agent-store-runtime";

import { startSseServer } from "../streaming/sse-server.js";
import { emitTaskEvent } from "../streaming/event-bus.js";
import {
    followTaskStream,
    parseSseEvents,
    renderEvent,
    type FollowResult,
} from "../streaming/follow-renderer.js";

// ──────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────

const CREATE_TASKS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT,
    parent_task_id TEXT,
    is_ephemeral INTEGER DEFAULT 0 NOT NULL,
    recursion_depth INTEGER DEFAULT 0 NOT NULL,
    status TEXT DEFAULT 'pending' NOT NULL,
    prompt TEXT NOT NULL,
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    cancelled_at TEXT,
    depends_on TEXT,
    on_upstream_failure TEXT,
    inputs TEXT,
    resume_token TEXT
);
CREATE TABLE IF NOT EXISTS task_events (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload TEXT,
    created_at TEXT NOT NULL
);
`;

function buildTaskStore(): { taskStore: TaskStore; close: () => void } {
    const sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TASKS_TABLE_SQL);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = drizzle(sqlite) as any;
    return { taskStore: new TaskStore(db), close: () => sqlite.close() };
}

const openServers: http.Server[] = [];
const closeFns: Array<() => void> = [];

afterEach(async () => {
    await Promise.all(
        openServers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
    );
    closeFns.splice(0).forEach((fn) => fn());
});

// ──────────────────────────────────────────────────────────────────────────
// 1. Pure frame parser
// ──────────────────────────────────────────────────────────────────────────

describe("parseSseEvents (SSE wire format)", () => {
    it("decodes complete `event:/data:` frames and keeps a partial frame as rest", () => {
        const buffer =
            'event: token\ndata: {"type":"token","taskId":"t","chunk":"Hel"}\n\n' +
            'event: token\ndata: {"type":"token","taskId":"t","chunk":"lo"}\n\n' +
            'event: done\ndata: {"type":"done","taskId":"t","result":"Hello","error":null}\n\n' +
            'event: token\ndata: {"type":"token","taskId":"t"';

        const { events, rest } = parseSseEvents(buffer);
        expect(events.map((e) => e.type)).toEqual(["token", "token", "done"]);
        expect(events[0]).toEqual({ type: "token", taskId: "t", chunk: "Hel" });
        expect(rest).toBe('event: token\ndata: {"type":"token","taskId":"t"');
    });

    it("reassembles a frame split across two chunks (incremental feed)", () => {
        const first = 'event: token\ndata: {"type":"token","taskId":"t","chu';
        const second = 'nk":"hi"}\n\n';
        const a = parseSseEvents(first);
        expect(a.events).toHaveLength(0);
        const b = parseSseEvents(a.rest + second);
        expect(b.events).toEqual([{ type: "token", taskId: "t", chunk: "hi" }]);
        expect(b.rest).toBe("");
    });

    it("ignores keepalive comments and keys off the JSON type, not the event: line", () => {
        const buffer = ': ping\n\n' + 'event: whatever\ndata: {"type":"status_change","taskId":"t","status":"running"}\n\n';
        const { events } = parseSseEvents(buffer);
        expect(events).toEqual([{ type: "status_change", taskId: "t", status: "running" }]);
    });

    it("skips non-JSON data rather than throwing", () => {
        const { events } = parseSseEvents("data: not-json\n\n");
        expect(events).toHaveLength(0);
    });
});

describe("renderEvent", () => {
    it("text mode emits assistant text only (token chunks)", () => {
        expect(renderEvent({ type: "token", taskId: "t", chunk: "hi" })).toBe("hi");
        expect(renderEvent({ type: "status_change", taskId: "t", status: "running" })).toBeNull();
        expect(renderEvent({ type: "done", taskId: "t", result: "x", error: null })).toBeNull();
    });

    it("events mode labels every event", () => {
        expect(renderEvent({ type: "status_change", taskId: "t", status: "running" }, "events"))
            .toBe("[status] running\n");
        expect(renderEvent({ type: "tool_call", taskId: "t", toolName: "fs.read", toolCallId: "c", input: {} }, "events"))
            .toBe("[tool_call] fs.read\n");
        expect(renderEvent({ type: "done", taskId: "t", result: null, error: "boom" }, "events"))
            .toBe("[done] error: boom\n");
    });
});

// ──────────────────────────────────────────────────────────────────────────
// 2. Real seam: renderer against a live startSseServer
// ──────────────────────────────────────────────────────────────────────────

describe("followTaskStream (real SSE server)", () => {
    it("renders assistant text incrementally and resolves on done, with token events preceding the terminal event", async () => {
        const { taskStore, close } = buildTaskStore();
        closeFns.push(close);
        const { server, port } = await startSseServer(taskStore, 0, "127.0.0.1");
        openServers.push(server);
        expect(port).toBeDefined();

        const taskId = "11111111-2222-4333-8444-555555555555";
        const eventOrder: string[] = [];
        const chunks: string[] = [];
        const written: string[] = [];
        let markOpen!: () => void;
        const opened = new Promise<void>((resolve) => { markOpen = resolve; });

        const followPromise = followTaskStream({
            taskId,
            baseUrl: `http://127.0.0.1:${port}`,
            write: (text) => written.push(text),
            onOpen: () => markOpen(),
            onEvent: (event) => eventOrder.push(event.type),
            onToken: (chunk) => chunks.push(chunk),
        });

        // `onOpen` fires only after the server has flushed headers AND
        // synchronously subscribed — so emitting here cannot race the listener.
        await opened;
        emitTaskEvent({ type: "token", taskId, chunk: "Hello" });
        emitTaskEvent({ type: "token", taskId, chunk: " world" });
        emitTaskEvent({ type: "done", taskId, result: "Hello world", error: null });

        const result: FollowResult = await followPromise;

        // Consumer-visible outcome: incremental tokens, then the terminal done.
        expect(eventOrder).toEqual(["token", "token", "done"]);
        expect(chunks.join("")).toBe("Hello world");
        expect(written).toEqual(["Hello", " world"]); // text-mode rendering
        expect(result.tokens).toBe(2);
        expect(result.events).toBe(3);
        expect(result.status).toBe("completed");
        expect(result.result).toBe("Hello world");
        expect(result.error).toBeNull();
    });

    it("surfaces a failed task's error and status from the terminal done event", async () => {
        const { taskStore, close } = buildTaskStore();
        closeFns.push(close);
        const { server, port } = await startSseServer(taskStore, 0, "127.0.0.1");
        openServers.push(server);

        const taskId = "99999999-8888-4777-8666-555555555555";
        let markOpen!: () => void;
        const opened = new Promise<void>((resolve) => { markOpen = resolve; });

        const followPromise = followTaskStream({
            taskId,
            baseUrl: `http://127.0.0.1:${port}`,
            onOpen: () => markOpen(),
        });
        await opened;
        emitTaskEvent({ type: "status_change", taskId, status: "failed" });
        emitTaskEvent({ type: "done", taskId, result: null, error: "provider exploded" });

        const result = await followPromise;
        expect(result.status).toBe("failed");
        expect(result.error).toBe("provider exploded");
        expect(result.result).toBeNull();
    });

    it("rejects when the endpoint is not a live task stream (non-200)", async () => {
        // A bare server with no /tasks route → sse-server answers 404.
        const { taskStore, close } = buildTaskStore();
        closeFns.push(close);
        const { server, port } = await startSseServer(taskStore, 0, "127.0.0.1");
        openServers.push(server);

        // An id that does NOT match the UUID route regex → 404 "Not found".
        await expect(
            followTaskStream({ taskId: "not-a-uuid", baseUrl: `http://127.0.0.1:${port}` })
        ).rejects.toThrow(/unexpected HTTP 404/);
    });
});
