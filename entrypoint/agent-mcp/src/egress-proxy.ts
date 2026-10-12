/**
 * R5-WEB-SIMPLE AC2 — the allow-all loopback forward proxy behind the default
 * "open" egress mode.
 *
 * `srt` (sandbox-runtime) has no open-egress setting: `network.allowedDomains` is
 * required and every wildcard-all form (`*`, `*.com`, `*:443`) is rejected by its
 * schema ("Overly broad patterns like "*.com" or "*" are not allowed"). It does
 * document `network.httpProxyPort` — "the external proxy must handle domain
 * filtering" — so the default run policy points it at THIS proxy, which allows
 * every destination. Filesystem and credential denies live in the same policy
 * file and are untouched.
 *
 * Properties that matter:
 *  - Binds `127.0.0.1` only (never `0.0.0.0`: that would be an open proxy for the LAN).
 *  - Supports `CONNECT host:port` (https) and absolute-form `GET http://…` (http).
 *  - On any upstream failure (DNS, refused, reset) the CLIENT socket is destroyed
 *    instead of answering a 502, so `curl` exits non-zero even without `-f`
 *    (never an empty success; the shell's `[exit status: N]` trailer carries it).
 *
 * Known limits (documented in the CHANGELOG): srt's resolved-address check does
 * not run for an external proxy, so the sandboxed shell can reach host loopback/LAN
 * services through it; srt's own SOCKS proxy stays closed (curl's `https://` uses
 * the HTTP proxy).
 */
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

/** A running open-egress proxy. */
export interface OpenEgressProxy {
  /** The loopback port the proxy listens on. */
  readonly port: number;
  /** Stop accepting connections and destroy every open tunnel. */
  close(): Promise<void>;
}

/** Start the allow-all proxy on an ephemeral `127.0.0.1` port. */
export async function startOpenEgressProxy(): Promise<OpenEgressProxy> {
  const sockets = new Set<net.Socket>();
  const track = (s: net.Socket): void => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  };

  const server = http.createServer((req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      req.socket.destroy();
      return;
    }
    const upstream = http.request({
      host: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers: req.headers,
    });
    upstream.on('response', (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    upstream.on('error', () => req.socket.destroy());
    req.pipe(upstream);
  });

  server.on('connection', track);
  server.on('connect', (req, client: net.Socket, head: Buffer) => {
    const sep = (req.url ?? '').lastIndexOf(':');
    const host = (sep === -1 ? req.url : req.url?.slice(0, sep)) ?? '';
    const port = Number(sep === -1 ? 443 : req.url?.slice(sep + 1)) || 443;
    const upstream = net.connect(port, host.replace(/^\[|\]$/g, ''), () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    track(upstream);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  // Never keep the host process alive on its own.
  server.unref();

  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
