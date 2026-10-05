/**
 * follow-renderer.ts — a reusable SSE *consumer* for agent-mcp task streams.
 *
 * The streaming substrate (`sse-server.ts` + `event-bus.ts`) already emits a
 * per-task Server-Sent Events stream at `GET /tasks/:id/stream`. Until now the
 * only consumers were the OpenAI-compat chat gateway (inside the same process)
 * and `agent-mcp-tail`, which reads the SQLite DB directly and POLLS it every
 * 500ms. Neither gives a caller outside the process live, incremental
 * visibility of a running task.
 *
 * This module is the missing consumer seam: it subscribes to the SSE endpoint
 * over real HTTP, parses the wire frames, and renders assistant text as it
 * arrives — resolving the moment the terminal `done` event lands, rather than
 * polling `result` until the task is terminal. It is the SSE half of
 * c667a213 (`dispatch-cli run --follow`); the dispatch-cli wiring itself lives
 * in the dispatch bucket and consumes this renderer.
 *
 * The frame parser is a pure function (`parseSseEvents`) so the wire format is
 * unit-tested independently of any socket; `followTaskStream` is the real
 * consumer exercised end-to-end against a live `startSseServer`.
 */
import http from "node:http";
import { URL } from "node:url";
import type { TaskStreamEvent } from "./event-bus.js";

/** One parse pass over an accumulated SSE byte buffer. */
export interface ParsedSseBatch {
    /** Complete events decoded from the buffer. */
    events: TaskStreamEvent[];
    /** Trailing bytes that do not yet form a complete event (`\n\n`-terminated). */
    rest: string;
}

/**
 * Parses every complete SSE event out of `buffer`.
 *
 * Wire format written by `sse-server.ts` is `event: <type>\ndata: <json>\n\n`
 * (and `: ping\n\n` keepalives). We deliberately key off the JSON `data:`
 * payload's own `type` field rather than the `event:` line, so a producer that
 * omits/mislabels the `event:` line cannot desync the consumer. Comment lines
 * (`:` prefix, e.g. the 15s keepalive) and any non-JSON data are skipped.
 *
 * Pure and incremental: feed the returned `rest` back in with the next chunk.
 */
export function parseSseEvents(buffer: string): ParsedSseBatch {
    const events: TaskStreamEvent[] = [];
    let rest = buffer;
    let idx: number;
    while ((idx = rest.indexOf("\n\n")) !== -1) {
        const block = rest.slice(0, idx);
        rest = rest.slice(idx + 2);
        const event = parseSseBlock(block);
        if (event) events.push(event);
    }
    return { events, rest };
}

/** Decodes a single `\n\n`-delimited SSE block into a `TaskStreamEvent`. */
function parseSseBlock(block: string): TaskStreamEvent | null {
    const dataLines: string[] = [];
    for (const rawLine of block.split("\n")) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line === "" || line.startsWith(":")) continue; // comment / keepalive
        if (line.startsWith("data:")) {
            dataLines.push(line.slice("data:".length).replace(/^ /, ""));
        }
        // `event:`/`id:`/`retry:` are intentionally ignored — the JSON payload
        // carries its own `type` (see the module header).
    }
    if (dataLines.length === 0) return null;
    try {
        return JSON.parse(dataLines.join("\n")) as TaskStreamEvent;
    } catch {
        return null;
    }
}

/** Rendering mode for a followed stream. */
export type FollowFormat = "text" | "events" | "json";

/**
 * Renders one stream event to display text, or `null` if it produces no output
 * in the requested mode.
 *
 * - `text`   — assistant text only (concatenated `token` chunks); the mode a
 *              `--follow` renderer uses to print a running answer.
 * - `events` — a human-readable line per event, tokens included.
 * - `json`   — one JSON object per event, newline-delimited.
 */
export function renderEvent(event: TaskStreamEvent, format: FollowFormat = "text"): string | null {
    if (format === "json") return `${JSON.stringify(event)}\n`;
    if (format === "events") {
        switch (event.type) {
            case "status_change": return `[status] ${event.status}\n`;
            case "tool_call":     return `[tool_call] ${event.toolName}\n`;
            case "tool_result":   return `[tool_result] ${event.toolCallId}\n`;
            case "done":          return `[done] ${event.error ? `error: ${event.error}` : "ok"}\n`;
            case "token":         return event.chunk;
        }
    }
    return event.type === "token" ? event.chunk : null;
}

/** Options for {@link followTaskStream}. */
export interface FollowStreamOptions {
    /** The task id to subscribe to (the UUID in `/tasks/:id/stream`). */
    taskId: string;
    /** Base URL of the agent-mcp HTTP surface, e.g. `http://127.0.0.1:3001`. */
    baseUrl?: string;
    /** Display mode (default `text`). */
    format?: FollowFormat;
    /** Output sink (default `process.stdout.write`). */
    write?: (text: string) => void;
    /** Fired once the SSE connection's response headers have been received. */
    onOpen?: () => void;
    /** Fired for every decoded event. */
    onEvent?: (event: TaskStreamEvent) => void;
    /** Fired for every `token` chunk (incremental assistant text). */
    onToken?: (chunk: string) => void;
    /** Fired on every `status_change`. */
    onStatus?: (status: string) => void;
    /** Abort the follow (closes the connection). */
    signal?: AbortSignal;
}

/** Terminal outcome of a followed stream. */
export interface FollowResult {
    taskId: string;
    /** Last observed task status (`completed`/`failed`/`cancelled`/…) or null. */
    status: string | null;
    /** Final result text from the terminal `done` event, if any. */
    result: string | null;
    /** Error string from the terminal `done` event, if any. */
    error: string | null;
    /** Number of `token` events observed — the incremental-output measure. */
    tokens: number;
    /** Total events observed. */
    events: number;
}

/**
 * Subscribes to a task's SSE stream and resolves on its terminal `done` event.
 *
 * Uses a real `http.get` (not `fetch`) so the consumer has an explicit open
 * signal: the response callback fires after `sse-server.ts` has already
 * synchronously written headers AND subscribed to the task, so a caller may
 * safely emit events as soon as `onOpen` fires. The connection is torn down as
 * soon as `done` is seen; the returned promise resolves exactly once.
 */
export function followTaskStream(options: FollowStreamOptions): Promise<FollowResult> {
    const { taskId } = options;
    const format = options.format ?? "text";
    const write = options.write ?? ((text: string) => process.stdout.write(text));
    const baseUrl = options.baseUrl
        ?? `http://localhost:${process.env["ADHD_AGENT_SSE_PORT"] ?? 3001}`;
    const url = new URL(`/tasks/${taskId}/stream`, baseUrl);

    return new Promise<FollowResult>((resolve, reject) => {
        const result: FollowResult = {
            taskId,
            status: null,
            result: null,
            error: null,
            tokens: 0,
            events: 0,
        };
        let buffer = "";
        let settled = false;

        const finish = (err?: Error): void => {
            if (settled) return;
            settled = true;
            if (err) reject(err);
            else resolve(result);
        };

        const req = http.get(url, (res) => {
            if (res.statusCode !== undefined && res.statusCode !== 200) {
                res.resume();
                finish(new Error(`agent-mcp-follow: unexpected HTTP ${res.statusCode} for ${url.pathname}`));
                return;
            }
            options.onOpen?.();
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
                buffer += chunk;
                const parsed = parseSseEvents(buffer);
                buffer = parsed.rest;
                for (const event of parsed.events) {
                    result.events += 1;
                    if (event.type === "token") {
                        result.tokens += 1;
                        options.onToken?.(event.chunk);
                    } else if (event.type === "status_change") {
                        result.status = event.status;
                        options.onStatus?.(event.status);
                    } else if (event.type === "done") {
                        result.status = event.error ? "failed" : (result.status ?? "completed");
                        result.result = event.result;
                        result.error = event.error;
                    }
                    options.onEvent?.(event);
                    const rendered = renderEvent(event, format);
                    if (rendered) write(rendered);
                    if (event.type === "done") {
                        res.destroy();
                        finish();
                        return;
                    }
                }
            });
            res.on("end", () => finish());
            res.on("error", (err: Error) => finish(err));
        });

        req.on("error", (err: Error) => finish(err));

        if (options.signal) {
            if (options.signal.aborted) req.destroy(new Error("agent-mcp-follow: aborted"));
            else {
                options.signal.addEventListener(
                    "abort",
                    () => req.destroy(new Error("agent-mcp-follow: aborted")),
                    { once: true }
                );
            }
        }
    });
}
