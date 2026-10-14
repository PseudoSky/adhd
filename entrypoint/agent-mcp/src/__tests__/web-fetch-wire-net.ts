/**
 * 49cec55e - in-process stand-in for `node:http(s).request`, the network leaf under the engine-native
 * `web_fetch`. No socket is opened: a handler answers each pinned request in-process, and every call is
 * recorded so a test can assert WHICH address a connection was made to. Used as the `base` of
 * `tracedRequest` / `createWireSeams({ request })`, so the production tracing code runs for real around it.
 */
import { EventEmitter } from "node:events";
import type { ClientRequest } from "node:http";
import { PassThrough } from "node:stream";

import type { WireRequestFn } from "../wire/traced-request.js";

export interface IFakeReply {
    status: number;
    headers?: Record<string, string>;
    /** The bytes that cross the (fake) wire: for a compressed reply these are the COMPRESSED bytes. */
    body?: Buffer;
}

export interface IFakeNet {
    request: WireRequestFn;
    /** Options of every call, in order. */
    calls: Array<Parameters<WireRequestFn>[0]>;
}

/**
 * @param handler    answers a request given the validated address it was connected to and the `Host` header
 * @param connectErrors address -> errno code: a connection to that address fails before any response
 */
export function fakeNet(
    handler: (ip: string, host: string, path: string) => IFakeReply,
    connectErrors: Record<string, string> = {}
): IFakeNet {
    const calls: IFakeNet["calls"] = [];
    const request: WireRequestFn = (options) => {
        calls.push(options);
        const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (e?: Error) => void };
        req.destroy = (e?: Error) => {
            if (e) queueMicrotask(() => req.emit("error", e));
        };
        req.end = () => {
            setImmediate(() => {
                const ip = String(options.host);
                const code = connectErrors[ip];
                if (code) {
                    req.emit("error", Object.assign(new Error(`connect ${code} ${ip}`), { code }));
                    return;
                }
                const reply = handler(ip, String((options.headers as Record<string, string>)["host"]), options.path ?? "/");
                const msg = new PassThrough() as PassThrough & {
                    statusCode: number;
                    statusMessage: string;
                    headers: Record<string, string>;
                    complete: boolean;
                };
                msg.statusCode = reply.status;
                msg.statusMessage = "";
                msg.headers = reply.headers ?? {};
                msg.complete = true;
                req.emit("response", msg);
                msg.end(reply.body ?? Buffer.alloc(0));
            });
        };
        return req as unknown as ClientRequest;
    };
    return { request, calls };
}
