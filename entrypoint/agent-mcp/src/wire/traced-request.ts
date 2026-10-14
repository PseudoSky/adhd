/**
 * `tracedRequest` — wire logging for the engine-native `web_fetch` (backlog 49cec55e).
 *
 * `web_fetch` connects through `node:http(s).request` to an IP it validated itself (the SSRF pin,
 * bc799330), so it cannot use the traced `fetch`: a fetch implementation resolves the name again,
 * which is exactly the second resolution the pin exists to rule out. This wraps the request function
 * instead, and writes to the SAME `agent-mcp.api` channel with the SAME event names and envelope as
 * {@link tracedFetch} (`call_id`, the ambient `withLogContext` ids, `emitRaw`):
 *
 *  - `http.request`  when the request is created: `call_id`, `method`, `scheme`, `host` (the NAME,
 *    from the `Host` header, port removed), `port`, `ip` (the validated address the socket goes to).
 *  - `http.response` when the response body is finished or torn down: `call_id`, `method`, `scheme`,
 *    `host`, `port`, `ip`, `status`, `wire_bytes`, `complete`.
 *  - `http.error`    when the request fails before a response (refused, reset, abort, timeout):
 *    `call_id`, `method`, `scheme`, `host`, `port`, `ip` and the error class/message/code.
 *
 * The seam is called once per redirect hop and once per failover attempt, so each is its own record
 * set. Unlike the LLM-API records, a web_fetch record NEVER carries the request path or query, any
 * header, the response body or a credential: the page the model asked for is not API traffic and the
 * URL (path and query included) can hold tokens. `wire_bytes` counts the bytes received from the
 * socket BEFORE `Content-Encoding` is undone (what crossed the network, not the decoded text length).
 *
 * The caller always receives the ORIGINAL `ClientRequest` and the response stream unchanged. Nothing
 * here ever throws into the caller. Counting attaches a `data` listener to the response in the same
 * tick the consumer attaches its own, so it never starves or reorders the consumer.
 */
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import type { WireSeams } from "@adhd/agent-engine-orchestrator";
import { currentLogContext } from "@adhd/agent-plugin-tracing";

import {
    describeError,
    emitRaw,
    isInertChannel,
    newCallId,
    resolveChannel,
    safely,
    type ChannelSource,
} from "./traced-fetch.js";

/** The socket-level request function `web_fetch` connects through (`WireSeams.request`). */
export type WireRequestFn = NonNullable<WireSeams["request"]>;

/** The real `node:http` / `node:https` request functions behind one signature (used when no base is injected). */
export const plainRequest: WireRequestFn = (o) => (o.protocol === "https:" ? httpsRequest(o) : httpRequest(o));

/** What a record may say about a request: derived from the pinned options, never from path/query/headers' values beyond `Host`. */
interface IRequestFacts {
    method: string;
    scheme: string;
    host: string;
    port: number | undefined;
    ip: string;
}

/** `host`/`port` of the `Host` header (the name the model asked for), `ip` from `options.host` (the validated address). */
function describe(options: Parameters<WireRequestFn>[0]): IRequestFacts {
    const raw = options.headers && !Array.isArray(options.headers) ? (options.headers as Record<string, unknown>)["host"] : undefined;
    const hostHeader = typeof raw === "string" ? raw : String(options.host ?? "");
    let host = hostHeader;
    try {
        host = new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, "");
    } catch {
        /* keep the raw header */
    }
    const port = options.port === undefined || options.port === null ? undefined : Number(options.port);
    return {
        method: (options.method ?? "GET").toUpperCase(),
        scheme: options.protocol.replace(/:$/, ""),
        host,
        port: port !== undefined && Number.isFinite(port) ? port : undefined,
        ip: String(options.host ?? ""),
    };
}

/**
 * Wraps `base` so every request is logged to the api channel. Returns a function with the exact
 * {@link WireRequestFn} signature; the request, its response and any error are the originals.
 *
 * @param channel the api channel (or a lazy resolver). Default: the process-wide api channel,
 *   resolved per call. An inert channel (`logging.api=off`) makes this a pure pass-through.
 * @param base the request function to wrap. Default: the real `node:http(s).request`.
 */
export function tracedRequest(channel?: ChannelSource, base: WireRequestFn = plainRequest): WireRequestFn {
    return function tracedRequestImpl(options): ClientRequest {
        let ch;
        try {
            ch = resolveChannel(channel);
        } catch {
            return base(options);
        }
        if (isInertChannel(ch)) return base(options);

        const callId = newCallId();
        const ctx = { ...currentLogContext() };
        let facts: IRequestFacts | undefined;
        safely(() => {
            facts = describe(options);
            emitRaw(ch, ctx, "http.request", { call_id: callId, ...facts });
        });

        let req: ClientRequest;
        try {
            req = base(options);
        } catch (err) {
            if (facts) emitRaw(ch, ctx, "http.error", { call_id: callId, ...facts, ...describeError(err) });
            throw err;
        }

        safely(() => {
            const f = facts;
            if (!f) return;
            let settled = false;
            req.once("error", (err: unknown) => {
                if (settled) return;
                settled = true;
                emitRaw(ch, ctx, "http.error", { call_id: callId, ...f, ...describeError(err) });
            });
            req.once("response", (res: IncomingMessage) => {
                if (settled) return;
                settled = true;
                let bytes = 0;
                res.on("data", (chunk: Buffer | string) => {
                    bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
                });
                res.once("close", () => {
                    emitRaw(ch, ctx, "http.response", {
                        call_id: callId,
                        ...f,
                        status: res.statusCode,
                        wire_bytes: bytes,
                        complete: res.complete === true,
                    });
                });
            });
        });
        return req;
    };
}
