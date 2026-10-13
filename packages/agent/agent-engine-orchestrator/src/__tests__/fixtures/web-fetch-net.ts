/**
 * Test doubles for the two network seams of `executeWebFetch` (`resolve` = DNS, `request` =
 * `node:http(s).request`). No socket is opened and nothing is resolved: a handler answers in-process,
 * and every request/resolution is recorded so a test can assert WHICH address a connection was made to.
 */
import { EventEmitter } from 'node:events';
import type { ClientRequest, RequestOptions } from 'node:http';
import { PassThrough } from 'node:stream';

import type { IResolvedAddress, WebFetchRequestFn, WebFetchResolver } from '../../tools/web-fetch.js';

/** A public address (example.com's), the default answer of {@link stubNet}'s resolver. */
export const PUBLIC_IP = '93.184.216.34';

export type NetHandler = (url: URL, options: RequestOptions) => Response | Promise<Response>;

export interface IStubNet {
  resolve: WebFetchResolver;
  request: WebFetchRequestFn;
  /** Hostnames passed to the resolver, in call order. */
  resolved: string[];
  /** Options of every connection attempt, in call order. */
  requests: Array<RequestOptions & { protocol: string; servername?: string }>;
}

/**
 * @param handler answers a request with a `Response` (the stand-in for the remote server)
 * @param dns     hostname -> addresses; a missing host resolves to {@link PUBLIC_IP}. A function is called per
 *                resolution (to model a rebinding answer that changes between calls).
 */
export function stubNet(
  handler: NetHandler,
  dns: Record<string, string[]> | ((host: string, call: number) => string[]) = {}
): IStubNet {
  const resolved: string[] = [];
  const requests: IStubNet['requests'] = [];
  const resolve: WebFetchResolver = async (host) => {
    resolved.push(host);
    const list = typeof dns === 'function' ? dns(host, resolved.length) : (dns[host] ?? [PUBLIC_IP]);
    return list.map((address): IResolvedAddress => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  const request: WebFetchRequestFn = (options) => {
    requests.push(options);
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (e?: Error) => void };
    req.destroy = (e?: Error) => {
      if (e) queueMicrotask(() => req.emit('error', e));
    };
    req.end = () => {
      void (async () => {
        try {
          const hostHeader = String((options.headers as Record<string, string>)['host']);
          const res = await handler(new URL(`${options.protocol}//${hostHeader}${options.path ?? '/'}`), options);
          const body = Buffer.from(await res.arrayBuffer());
          const msg = new PassThrough() as PassThrough & { statusCode: number; statusMessage: string; headers: Record<string, string> };
          msg.statusCode = res.status;
          msg.statusMessage = res.statusText;
          msg.headers = Object.fromEntries(res.headers.entries());
          req.emit('response', msg);
          msg.end(body);
        } catch (e) {
          req.emit('error', e);
        }
      })();
    };
    return req as unknown as ClientRequest;
  };
  return { resolve, request, resolved, requests };
}
