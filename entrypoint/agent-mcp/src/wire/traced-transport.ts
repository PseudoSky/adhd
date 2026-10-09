/**
 * `TracedTransport` — raw MCP JSON-RPC logging around any MCP client `Transport` (stdio, SSE,
 * streamable HTTP, in-memory) (backlog c536ce29, segment W1).
 *
 * Records, on the api channel:
 *  - `mcp.send`   each message written to the server (`direction: 'out'`)
 *  - `mcp.recv`   each message read from the server (`direction: 'in'`)
 *  - `mcp.close`  transport closed;  `mcp.error`  transport error
 *
 * Every message record carries `server`, `transport`, `kind` (request / notification / response /
 * error), the JSON-RPC `id` and `method` when present, the whole message as a captured `body`
 * (so params / result are included), and a `call_id` of `<transport-id>:<rpc-id>` that links a
 * request to its response. The wrapper is a pure pass-through otherwise: handlers, `start`,
 * `send`, `close`, `sessionId` and `setProtocolVersion` behave exactly as on the inner transport,
 * and a failing log write never reaches the protocol.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { captureBody, currentLogContext, type LogChannel } from "@adhd/agent-plugin-tracing";

import {
    DEFAULT_BODY_MAX_BYTES,
    describeError,
    emitRaw,
    isInertChannel,
    newCallId,
    resolveChannel,
    safely,
    type ChannelSource,
    type IWireOptions,
} from "./traced-fetch.js";

/** Labels attached to every record of one wrapped transport. */
export interface ITransportMeta {
    /** MCP server name. */
    server: string;
    /** Transport kind, e.g. `stdio`, `sse`, `streamable-http`, `memory`. */
    transport: string;
}

type OnMessage = NonNullable<Transport["onmessage"]>;
type SendOptions = Parameters<Transport["send"]>[1];

function classify(message: JSONRPCMessage): { kind: string; id?: string | number; method?: string } {
    const m = message as { id?: string | number; method?: string; error?: unknown };
    if (m.method !== undefined) return { kind: m.id !== undefined ? "request" : "notification", id: m.id, method: m.method };
    return { kind: m.error !== undefined ? "error" : "response", id: m.id };
}

/** Wraps an MCP `Transport`; use in place of the inner transport (`new Client().connect(traced)`). */
export class TracedTransport implements Transport {
    private readonly transportId = newCallId();
    private readonly maxBytes: number;
    private userOnMessage: Transport["onmessage"];
    private userOnClose: Transport["onclose"];
    private userOnError: Transport["onerror"];

    /**
     * @param inner the real transport
     * @param meta server/transport labels for the records
     * @param channel the api channel (or lazy resolver); default the process-wide api channel
     * @param opts capture options
     */
    constructor(
        private readonly inner: Transport,
        private readonly meta: ITransportMeta,
        private readonly channel?: ChannelSource,
        opts: IWireOptions = {}
    ) {
        this.maxBytes = opts.bodyMaxBytes ?? DEFAULT_BODY_MAX_BYTES;
    }

    private log(event: string, payload: Parameters<LogChannel["logRaw"]>[1]): void {
        safely(() => {
            const ch = resolveChannel(this.channel);
            if (isInertChannel(ch)) return;
            emitRaw(ch, { ...currentLogContext() }, event, { server: this.meta.server, transport: this.meta.transport, ...payload });
        });
    }

    private logMessage(direction: "out" | "in", message: JSONRPCMessage): void {
        safely(() => {
            const ch = resolveChannel(this.channel);
            if (isInertChannel(ch)) return;
            const { kind, id, method } = classify(message);
            this.log(direction === "out" ? "mcp.send" : "mcp.recv", {
                call_id: id !== undefined ? `${this.transportId}:${String(id)}` : this.transportId,
                direction,
                kind,
                ...(id !== undefined ? { id } : {}),
                ...(method !== undefined ? { method } : {}),
                body: captureBody(JSON.stringify(message), { maxBytes: this.maxBytes }),
            });
        });
    }

    /** Installs the inner handlers lazily so user handlers set before/after `start` are both seen. */
    private bindInner(): void {
        this.inner.onmessage = ((message, extra) => {
            this.logMessage("in", message);
            this.userOnMessage?.(message, extra);
        }) as OnMessage;
        this.inner.onclose = () => {
            this.log("mcp.close", { call_id: this.transportId });
            this.userOnClose?.();
        };
        this.inner.onerror = (error) => {
            this.log("mcp.error", { call_id: this.transportId, ...describeError(error) });
            this.userOnError?.(error);
        };
    }

    get onmessage(): Transport["onmessage"] {
        return this.userOnMessage;
    }
    set onmessage(handler: Transport["onmessage"]) {
        this.userOnMessage = handler;
        this.bindInner();
    }
    get onclose(): Transport["onclose"] {
        return this.userOnClose;
    }
    set onclose(handler: Transport["onclose"]) {
        this.userOnClose = handler;
        this.bindInner();
    }
    get onerror(): Transport["onerror"] {
        return this.userOnError;
    }
    set onerror(handler: Transport["onerror"]) {
        this.userOnError = handler;
        this.bindInner();
    }

    get sessionId(): string | undefined {
        return this.inner.sessionId;
    }
    set sessionId(value: string | undefined) {
        this.inner.sessionId = value;
    }

    /** Forwards to the inner transport when it supports protocol-version negotiation. */
    setProtocolVersion(version: string): void {
        this.inner.setProtocolVersion?.(version);
    }

    async start(): Promise<void> {
        this.bindInner();
        return this.inner.start();
    }

    async send(message: JSONRPCMessage, options?: SendOptions): Promise<void> {
        this.logMessage("out", message);
        try {
            return await this.inner.send(message, options);
        } catch (err) {
            this.log("mcp.error", { call_id: this.transportId, direction: "out", ...describeError(err) });
            throw err;
        }
    }

    async close(): Promise<void> {
        return this.inner.close();
    }
}
