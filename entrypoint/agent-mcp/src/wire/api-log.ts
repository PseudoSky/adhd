/**
 * Inbound raw capture for agent-mcp (backlog c536ce29, segment W3; TRC-AC23, TRC-AC24).
 *
 * Everything the server RECEIVES is logged raw to the api channel, the mirror image of the outbound
 * wrappers in this directory:
 *
 *  - {@link withApiLog} wraps the MCP `tools/call` handler. Per call it writes `mcp.request`
 *    (tool name, arguments as `body`, `mcp-session-id`, request id) and exactly one `mcp.response`
 *    (`is_error`, result payload as `body`, and the original error when the handler's own catch swallowed one -
 *    see {@link noteToolError}) or, if the handler itself throws, `mcp.error`.
 *  - {@link withHttpApiLog} wraps an `http.createServer` request listener (the streamable-HTTP MCP
 *    route and the SSE/gateway routes). It writes `http.inbound.request` (method, redacted URL,
 *    headers, request body) and `http.inbound.response` (status, headers, response body). Bodies are
 *    observed passively - `req.emit` is tapped, never a competing `data` listener, so the stream's
 *    flow mode and the wrapped handler's behavior are untouched.
 *
 * Every record carries `call_id` and the ambient `withLogContext` ids. Redaction is the channel's
 * (one shared redactor); URL query VALUES are additionally dropped via `redactUrl`. With an inert
 * channel both wrappers return the wrapped function's own result untouched. Nothing here throws into
 * the caller: logging failures are swallowed, handler errors propagate exactly as before.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
    BodyCapture,
    captureBody,
    currentLogContext,
    withLogContext,
    type LogChannel,
} from "@adhd/agent-plugin-tracing";

import {
    DEFAULT_BODY_MAX_BYTES,
    describeError,
    emitRaw,
    isInertChannel,
    newCallId,
    redactUrl,
    resolveChannel,
    safely,
    type ChannelSource,
    type IWireOptions,
} from "./traced-fetch.js";

/** Holder the tool handler's swallowing catch reports into (see {@link noteToolError}). */
interface IToolCallState {
    error?: unknown;
}

const toolCallState = new AsyncLocalStorage<IToolCallState>();

/** The slice of an MCP `tools/call` request {@link withApiLog} reads. */
interface IToolCallRequest {
    params: { name: string; arguments?: Record<string, unknown> | undefined };
}

/** The slice of the SDK's per-request `extra` {@link withApiLog} reads. */
interface IToolCallExtra {
    sessionId?: string | undefined;
    requestId?: string | number | undefined;
}

/**
 * Reports the error a tool handler is about to convert into an `isError` result. Call it from the
 * handler's catch block: the enclosing {@link withApiLog} record then carries the original error
 * (class, message, stack) instead of only the flattened text. A no-op outside a logged call.
 *
 * @param error the value caught
 */
export function noteToolError(error: unknown): void {
    const state = toolCallState.getStore();
    if (state) state.error = error;
}

function jsonBytes(value: unknown): Uint8Array {
    let text: string;
    try {
        text = JSON.stringify(value) ?? "null";
    } catch {
        text = JSON.stringify({ unserializable: typeof value });
    }
    return Buffer.from(text, "utf8");
}

/**
 * Wraps the MCP `tools/call` handler so every inbound call is logged raw.
 *
 * @param handler the original handler
 * @param channel the api channel (or lazy resolver); default: the process-wide api channel
 * @param opts capture options
 * @returns a handler with the same signature and results
 */
export function withApiLog<Req extends IToolCallRequest, Extra extends IToolCallExtra, R>(
    handler: (request: Req, extra: Extra) => R | Promise<R>,
    channel?: ChannelSource,
    opts: IWireOptions = {}
): (request: Req, extra: Extra) => Promise<R> {
    const maxBytes = opts.bodyMaxBytes ?? DEFAULT_BODY_MAX_BYTES;
    return async function loggedToolCall(request: Req, extra: Extra): Promise<R> {
        let ch: LogChannel;
        try {
            ch = resolveChannel(channel);
        } catch {
            return handler(request, extra);
        }
        if (isInertChannel(ch)) return handler(request, extra);

        const callId = newCallId();
        const startedAt = Date.now();
        const base = {
            call_id: callId,
            tool: request?.params?.name,
            mcp_session_id: extra?.sessionId,
            request_id: extra?.requestId,
        };
        const ctx = { ...currentLogContext(), call_id: callId };
        safely(() =>
            emitRaw(ch, ctx, "mcp.request", {
                ...base,
                body: captureBody(jsonBytes(request?.params?.arguments ?? null), { maxBytes }),
            })
        );

        const state: IToolCallState = {};
        try {
            const result = await withLogContext({ ...ctx }, () => toolCallState.run(state, () => handler(request, extra)));
            safely(() => {
                const isError = (result as { isError?: unknown } | undefined)?.isError === true;
                emitRaw(ch, ctx, "mcp.response", {
                    ...base,
                    is_error: isError,
                    duration_ms: Date.now() - startedAt,
                    body: captureBody(jsonBytes(result), { maxBytes }),
                    ...(state.error !== undefined
                        ? { ...describeError(state.error), ...(state.error instanceof Error && state.error.stack ? { error_stack: state.error.stack } : {}) }
                        : {}),
                });
            });
            return result;
        } catch (err) {
            safely(() =>
                emitRaw(ch, ctx, "mcp.error", {
                    ...base,
                    duration_ms: Date.now() - startedAt,
                    ...describeError(err),
                    ...(err instanceof Error && err.stack ? { error_stack: err.stack } : {}),
                })
            );
            throw err;
        }
    };
}

function headersRecord(h: IncomingMessage["headers"] | ReturnType<ServerResponse["getHeaders"]>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) {
        if (v === undefined) continue;
        out[k] = Array.isArray(v) ? v.join(", ") : String(v);
    }
    return out;
}

function chunkBytes(chunk: unknown, encoding: unknown): Uint8Array | undefined {
    if (typeof chunk === "string") return Buffer.from(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
    if (chunk instanceof Uint8Array) return chunk;
    return undefined;
}

/**
 * Wraps an `http.createServer` request listener so every inbound request is logged raw.
 *
 * @param route a stable label for the route group (`mcp-http`, `sse-gateway`, ...)
 * @param listener the original listener
 * @param channel the api channel (or lazy resolver); default: the process-wide api channel
 * @param opts capture options
 * @returns a listener with the same behavior
 */
export function withHttpApiLog(
    route: string,
    listener: (req: IncomingMessage, res: ServerResponse) => void,
    channel?: ChannelSource,
    opts: IWireOptions = {}
): (req: IncomingMessage, res: ServerResponse) => void {
    const maxBytes = opts.bodyMaxBytes ?? DEFAULT_BODY_MAX_BYTES;
    return function loggedHttpRequest(req: IncomingMessage, res: ServerResponse): void {
        let ch: LogChannel;
        try {
            ch = resolveChannel(channel);
        } catch {
            return listener(req, res);
        }
        if (isInertChannel(ch)) return listener(req, res);

        const callId = newCallId();
        const startedAt = Date.now();
        const ctx = { ...currentLogContext(), call_id: callId };
        const sidHeader = req.headers["mcp-session-id"];
        const base = {
            call_id: callId,
            route,
            method: req.method ?? "GET",
            url: redactUrl(`http://${req.headers.host ?? "local"}${req.url ?? "/"}`),
            mcp_session_id: Array.isArray(sidHeader) ? sidHeader[0] : sidHeader,
        };

        const reqCapture = new BodyCapture({ maxBytes });
        let requestLogged = false;
        const logRequest = (): void => {
            if (requestLogged) return;
            requestLogged = true;
            safely(() =>
                emitRaw(ch, ctx, "http.inbound.request", {
                    ...base,
                    headers: headersRecord(req.headers),
                    remote_address: req.socket?.remoteAddress,
                    remote_port: req.socket?.remotePort,
                    body: reqCapture.finish(),
                })
            );
        };

        // Passive tap: observe 'data' as it is emitted, never subscribe (subscribing would switch
        // the stream to flowing mode before the handler attached its own listener).
        const originalEmit = req.emit.bind(req) as (event: string | symbol, ...args: unknown[]) => boolean;
        (req as { emit: unknown }).emit = (event: string | symbol, ...args: unknown[]): boolean => {
            safely(() => {
                if (event === "data") {
                    const bytes = chunkBytes(args[0], undefined);
                    if (bytes) reqCapture.append(bytes);
                } else if (event === "end") {
                    logRequest();
                }
            });
            return originalEmit(event, ...args);
        };
        const hasBody = req.headers["transfer-encoding"] !== undefined || Number(req.headers["content-length"] ?? 0) > 0;
        if (!hasBody) logRequest();

        const resCapture = new BodyCapture({ maxBytes });
        let resBytes = 0;
        const originalWrite = res.write.bind(res) as (...a: unknown[]) => boolean;
        const originalEnd = res.end.bind(res) as (...a: unknown[]) => ServerResponse;
        (res as { write: unknown }).write = (...a: unknown[]): boolean => {
            safely(() => {
                const bytes = chunkBytes(a[0], a[1]);
                if (bytes) {
                    resBytes += bytes.byteLength;
                    resCapture.append(bytes);
                }
            });
            return originalWrite(...a);
        };
        (res as { end: unknown }).end = (...a: unknown[]): ServerResponse => {
            safely(() => {
                const bytes = chunkBytes(a[0], a[1]);
                if (bytes) {
                    resBytes += bytes.byteLength;
                    resCapture.append(bytes);
                }
            });
            return originalEnd(...a);
        };
        res.once("close", () => {
            logRequest();
            safely(() =>
                emitRaw(ch, ctx, "http.inbound.response", {
                    ...base,
                    status: res.statusCode,
                    headers: headersRecord(res.getHeaders()),
                    body: resCapture.finish(),
                    body_bytes: resBytes,
                    duration_ms: Date.now() - startedAt,
                    completed: res.writableFinished,
                })
            );
        });

        try {
            withLogContext({ ...ctx }, () => listener(req, res));
        } catch (err) {
            safely(() =>
                emitRaw(ch, ctx, "http.inbound.error", { ...base, duration_ms: Date.now() - startedAt, ...describeError(err) })
            );
            throw err;
        }
    };
}
