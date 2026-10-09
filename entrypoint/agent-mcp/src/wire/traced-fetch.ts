/**
 * `tracedFetch` — raw HTTP wire logging for every outbound `fetch` (backlog c536ce29, segment W1).
 *
 * Wraps a base `fetch` and writes, to the `agent-mcp.api` channel:
 *
 *  - `http.request`  BEFORE the request is sent (so a hung call is visible): `call_id`, `method`,
 *    `url` (userinfo stripped, query VALUES redacted), `headers`, the request body bytes
 *    (`body`, `body_bytes`, `body_sha256`, `truncated`) and the ambient `withLogContext` ids.
 *  - `http.response` once the response body has been fully read: `status`, `status_text`,
 *    `headers`, the whole body (SSE/chunked streams included), `ttfb_ms`, `latency_ms`,
 *    `chunk_count`, `chunk_timing`, `aborted`, and `error` when the stream broke mid-body.
 *  - `http.error` when `fetch` itself rejects (refused, DNS, abort): error class/message/code and
 *    `duration_ms`. The original error is rethrown unchanged.
 *
 * The caller always receives the ORIGINAL `Response`. The body is observed on a `clone()` that is
 * drained eagerly in the background, so what the caller reads is byte-for-byte what the server
 * sent. Bodies beyond `bodyMaxBytes` are cut in the record (`truncated: true`) while `body_bytes`
 * and `body_sha256` still describe ALL bytes. Redaction of secrets in headers/body is the
 * channel's job (its redactor runs at the sink); this module only redacts URL query values,
 * which the sink cannot see structurally. Nothing here ever throws into the caller.
 */
import { createHash, randomUUID } from "node:crypto";

import {
    BodyCapture,
    captureBody,
    currentLogContext,
    withLogContext,
    type CapturedBody,
    type LogChannel,
} from "@adhd/agent-plugin-tracing";

import { getLogChannels, isNoopLogChannel } from "./channels.js";

/** The first argument of `fetch`. */
type FetchInput = Parameters<typeof fetch>[0];

/** Default per-body capture cap, matching `logging.apiBodyMaxBytes`' default (4 MiB). */
export const DEFAULT_BODY_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Default ceiling on how many response bytes the logging clone may drain. `res.clone()` tees the
 * stream, and a tee buffers every chunk for whichever branch is slower; the clone is drained
 * eagerly, so a caller that reads slowly or never (an unconsumed long-lived SSE response) would
 * otherwise make that buffer grow without bound. Past the ceiling the clone is cancelled — the
 * caller's branch is then pulled on demand with normal back-pressure — and the record says so
 * (`drain_cancelled: true`; `body_bytes`/`body_sha256` then describe only the bytes observed).
 * Well above `bodyMaxBytes`, so the exact-digest contract holds for every realistic body.
 */
export const DEFAULT_BODY_DRAIN_MAX_BYTES = 64 * 1024 * 1024;

/** Cap on the `chunk_timing` array of a streamed response (the count is always exact). */
const MAX_CHUNK_TIMING_ENTRIES = 256;

/** Options shared by the wire wrappers. */
export interface IWireOptions {
    /** Per-body capture cap in bytes. Default {@link DEFAULT_BODY_MAX_BYTES}. */
    bodyMaxBytes?: number;
    /** Ceiling on bytes the logging clone drains before it is cancelled. Default {@link DEFAULT_BODY_DRAIN_MAX_BYTES}. */
    bodyDrainMaxBytes?: number;
}

/** A channel, or a lazy resolver; `undefined` means "the process-wide api channel". */
export type ChannelSource = LogChannel | (() => LogChannel) | undefined;

/** Generates the id that correlates a request with its response/exit records. */
export function newCallId(): string {
    return randomUUID();
}

/**
 * True when `channel` is an inert channel (one produced by {@link noopLogChannel}): raw capture is
 * skipped. Detection is by object identity (a WeakSet marker), never by function source text.
 */
export function isInertChannel(channel: LogChannel): boolean {
    return isNoopLogChannel(channel);
}

/** Resolves a {@link ChannelSource} to a concrete channel (default: the process-wide api channel). */
export function resolveChannel(source: ChannelSource): LogChannel {
    if (source === undefined) return getLogChannels().api;
    return typeof source === "function" ? source() : source;
}

/** Runs `fn`, swallowing anything it throws: logging must never reach the caller. */
export function safely(fn: () => void): void {
    try {
        fn();
    } catch {
        /* never throws into the caller */
    }
}

/** `{ name, message, code }` of a thrown value, for error records. */
export function describeError(err: unknown): { error_class: string; error_message: string; error_code?: string } {
    if (err instanceof Error) {
        const code = (err as { code?: unknown }).code;
        return {
            error_class: err.name,
            error_message: err.message,
            ...(typeof code === "string" ? { error_code: code } : {}),
        };
    }
    return { error_class: typeof err, error_message: String(err) };
}

/** Emits `event` on `channel` inside the captured log context so async completions keep their ids. */
export function emitRaw(
    channel: LogChannel,
    ctx: ReturnType<typeof currentLogContext>,
    event: string,
    payload: Parameters<LogChannel["logRaw"]>[1]
): void {
    safely(() => withLogContext({ ...ctx }, () => channel.logRaw(event, payload)));
}

/** Header bag -> plain record (multi-valued headers joined per the Fetch spec). */
function headersToRecord(h: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    h.forEach((value, key) => {
        out[key] = value;
    });
    return out;
}

/**
 * The URL as it may be logged: userinfo and fragment dropped, query NAMES kept, query VALUES
 * replaced with `[REDACTED:len=<n>]` (API keys are routinely passed as `?key=...`).
 */
export function redactUrl(raw: string): string {
    try {
        const u = new URL(raw);
        const params: string[] = [];
        u.searchParams.forEach((value, name) => {
            params.push(`${encodeURIComponent(name)}=[REDACTED:len=${value.length}]`);
        });
        return `${u.protocol}//${u.host}${u.pathname}${params.length > 0 ? `?${params.join("&")}` : ""}`;
    } catch {
        return raw.replace(/\?.*$/, "?[REDACTED]").replace(/\/\/[^/@]*@/, "//");
    }
}

interface IRequestFacts {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: CapturedBody | undefined;
    bodyKind: "none" | "bytes" | "stream" | "form";
}

/** Extracts what is loggable from `fetch(input, init)` WITHOUT consuming the caller's body. */
async function describeRequest(input: FetchInput, init: RequestInit | undefined, maxBytes: number): Promise<IRequestFacts> {
    const isRequest = typeof Request !== "undefined" && input instanceof Request;
    let rawUrl: string;
    if (isRequest) rawUrl = input.url;
    else if (input instanceof URL) rawUrl = input.href;
    else rawUrl = String(input);
    const method = (init?.method ?? (isRequest ? input.method : "GET")).toUpperCase();
    const headers = headersToRecord(new Headers(init?.headers ?? (isRequest ? input.headers : undefined)));

    const body = init?.body;
    let bytes: Uint8Array | undefined;
    let bodyKind: IRequestFacts["bodyKind"] = "none";
    if (body !== undefined && body !== null) {
        if (typeof body === "string") bytes = Buffer.from(body, "utf8");
        else if (body instanceof URLSearchParams) bytes = Buffer.from(body.toString(), "utf8");
        else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
        else if (ArrayBuffer.isView(body)) bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
        else if (typeof Blob !== "undefined" && body instanceof Blob) bytes = new Uint8Array(await body.arrayBuffer());
        else if (typeof FormData !== "undefined" && body instanceof FormData) bodyKind = "form";
        else bodyKind = "stream";
    } else if (isRequest && input.body !== null && init?.body === undefined) {
        bytes = new Uint8Array(await input.clone().arrayBuffer());
    }
    if (bytes) bodyKind = "bytes";
    return {
        method,
        url: redactUrl(rawUrl),
        headers,
        body: bytes ? captureBody(bytes, { maxBytes }) : undefined,
        bodyKind,
    };
}

/**
 * Drains `clone` to completion, never applying back-pressure to the caller's branch, and returns
 * the capture plus timing. A read error (abort, reset) ends the drain with `error` set.
 */
async function drainClone(
    clone: Response,
    maxBytes: number,
    startedAt: number,
    drainMaxBytes: number
): Promise<{ captured: CapturedBody; chunks: number; timing: Array<[number, number]>; error?: unknown; aborted: boolean; drainCancelled: boolean }> {
    const capture = new BodyCapture({ maxBytes });
    const timing: Array<[number, number]> = [];
    let chunks = 0;
    let error: unknown;
    let drainCancelled = false;
    let seen = 0;
    if (clone.body) {
        const reader = clone.body.getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks++;
                capture.append(value);
                if (timing.length < MAX_CHUNK_TIMING_ENTRIES) timing.push([Date.now() - startedAt, value.byteLength]);
                seen += value.byteLength;
                if (seen >= drainMaxBytes) {
                    // Stop tee-buffering for the caller's branch (see DEFAULT_BODY_DRAIN_MAX_BYTES).
                    drainCancelled = true;
                    // Not awaited: a tee branch's cancel() settles only once BOTH branches are
                    // cancelled, i.e. after the caller finishes with its own branch.
                    void reader.cancel().catch(() => undefined);
                    break;
                }
            }
        } catch (err) {
            error = err;
        }
    }
    const aborted = error !== undefined && (error as { name?: string }).name === "AbortError";
    return { captured: drainCancelled ? { ...capture.finish(), truncated: true } : capture.finish(), chunks, timing, error, aborted, drainCancelled };
}

/**
 * Wraps `base` so every call is logged raw to the api channel. Returns a function with the exact
 * `fetch` signature; the response and any thrown error are the originals.
 *
 * @param channel the api channel (or a lazy resolver). Default: the process-wide api channel,
 *   resolved per call. Pass `noopLogChannel()` (what `logging.api=off` yields) to disable logging.
 * @param base the fetch to wrap. Default: `globalThis.fetch` (resolved per call).
 * @param opts capture options
 */
export function tracedFetch(channel?: ChannelSource, base?: typeof fetch, opts: IWireOptions = {}): typeof fetch {
    const maxBytes = opts.bodyMaxBytes ?? DEFAULT_BODY_MAX_BYTES;
    const drainMaxBytes = opts.bodyDrainMaxBytes ?? DEFAULT_BODY_DRAIN_MAX_BYTES;
    return async function tracedFetchImpl(input: FetchInput, init?: RequestInit): Promise<Response> {
        const inner = base ?? globalThis.fetch;
        let ch: LogChannel;
        try {
            ch = resolveChannel(channel);
        } catch {
            return inner(input, init);
        }
        if (isInertChannel(ch)) return inner(input, init);

        const callId = newCallId();
        const ctx = { ...currentLogContext() };
        const startedAt = Date.now();
        let facts: IRequestFacts | undefined;
        try {
            facts = await describeRequest(input, init, maxBytes);
            emitRaw(ch, ctx, "http.request", {
                call_id: callId,
                method: facts.method,
                url: facts.url,
                headers: facts.headers,
                body_kind: facts.bodyKind,
                ...(facts.body ? { body: facts.body } : {}),
            });
        } catch {
            /* logging the request failed; still send it */
        }

        let res: Response;
        try {
            res = await inner(input, init);
        } catch (err) {
            const signal = init?.signal ?? (typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined);
            emitRaw(ch, ctx, "http.error", {
                call_id: callId,
                method: facts?.method,
                url: facts?.url,
                duration_ms: Date.now() - startedAt,
                aborted: signal?.aborted === true || (err as { name?: string })?.name === "AbortError",
                ...describeError(err),
            });
            throw err;
        }

        const ttfb = Date.now() - startedAt;
        try {
            const clone = res.clone();
            void drainClone(clone, maxBytes, startedAt, drainMaxBytes)
                .then((d) => {
                    emitRaw(ch, ctx, "http.response", {
                        call_id: callId,
                        status: res.status,
                        status_text: res.statusText,
                        headers: headersToRecord(res.headers),
                        body: d.captured,
                        ttfb_ms: ttfb,
                        latency_ms: Date.now() - startedAt,
                        chunk_count: d.chunks,
                        chunk_timing: d.timing,
                        aborted: d.aborted,
                        ...(d.drainCancelled ? { drain_cancelled: true } : {}),
                        ...(d.error !== undefined ? { error: describeError(d.error) } : {}),
                    });
                })
                .catch(() => undefined);
        } catch {
            emitRaw(ch, ctx, "http.response", {
                call_id: callId,
                status: res.status,
                status_text: res.statusText,
                headers: headersToRecord(res.headers),
                ttfb_ms: ttfb,
                latency_ms: Date.now() - startedAt,
                body_unavailable: true,
            });
        }
        return res;
    };
}

/** sha256 hex of bytes — exported for tests and the other wrappers' digests. */
export function sha256Hex(bytes: Uint8Array | string): string {
    return createHash("sha256").update(bytes).digest("hex");
}
