/**
 * The pinned transport of `executeWebFetch` over a REAL socket (backlog bc799330 AC1/AC2/AC3, cbad68d4 AC2).
 *
 * One local HTTP server is the fetch target. Its loopback address is - correctly - refused when addressed
 * directly, so the lab scaffold (fixtures/web-fetch-lab.ts) points the engine's pinned connection at it while
 * the resolver answers a public address: everything else (request building, Host/pin, response wrapping, body
 * cap, redirect cancel) is the production code on a real socket. ADR-0009 e2e lane; not env-gated.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { WEB_FETCH_MAX_BYTES, WEB_FETCH_TRUNCATION_MARKER, executeWebFetch, type WebFetchRequestFn } from '../tools/web-fetch.js';
import { LAB_HOST, LAB_PUBLIC_IP, lab, labRequest, labUrl } from './fixtures/web-fetch-lab.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server | undefined;
const hits: Array<{ host: string | undefined; url: string | undefined }> = [];

async function serve(handler: Handler): Promise<number> {
  hits.length = 0;
  server = createServer((req, res) => {
    hits.push({ host: req.headers.host, url: req.url });
    handler(req, res);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  lab.port = port;
  lab.seen = [];
  return port;
}
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
  }
  server = undefined;
});

const publicDns = async (): Promise<Array<{ address: string; family: 4 }>> => [{ address: LAB_PUBLIC_IP, family: 4 }];
const labReq: WebFetchRequestFn = labRequest(httpRequest) as unknown as WebFetchRequestFn;
const html = (body: string): Handler => (_q, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
};

describe('bc799330 AC2: pinned connection over a real socket', () => {
  it('bc799330 AC2: the engine connects to the validated IP and the server sees the original name as Host', async () => {
    const port = await serve(html('<title>Pinned</title><p>over a real socket</p>'));
    const out = (await executeWebFetch({ url: labUrl(port, '/p?q=1') }, { resolve: publicDns, request: labReq })) as {
      content: { title: string; source: { data: string } };
    };
    expect(out.content.title).toBe('Pinned');
    expect(out.content.source.data).toContain('over a real socket');
    expect(hits).toEqual([{ host: `${LAB_HOST}:${port}`, url: '/p?q=1' }]);
    expect(lab.seen.map((o) => o.host)).toEqual([LAB_PUBLIC_IP]);
  });

  it('bc799330 AC2: a redirect to a name that resolves PRIVATE is refused after exactly one request reached the server', async () => {
    const port = await serve((_q, res) => {
      res.writeHead(302, { location: 'http://internal.example.test/admin', 'content-type': 'text/html' });
      res.end('<p>moved</p>'.repeat(1000)); // a buffered body is cancelled with the hop: must not surface as an uncaught error
    });
    const dns = async (h: string) => [{ address: h === 'internal.example.test' ? '10.9.8.7' : LAB_PUBLIC_IP, family: 4 as const }];
    await expect(executeWebFetch({ url: labUrl(port) }, { resolve: dns, request: labReq })).rejects.toThrow(
      /internal\.example\.test resolves to 10\.9\.8\.7, which is a private \(RFC1918\) address/
    );
    expect(hits).toHaveLength(1);
    expect(lab.seen).toHaveLength(1);
  });

  it('bc799330 AC2: a redirect between two public names is followed over the socket, each hop pinned to its own validated IP', async () => {
    const port = await serve((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: `http://second.example.test:${lab.port}/end` });
        res.end();
      } else html('<p>arrived</p>')(req, res);
    });
    const dns = async (h: string) => [{ address: h === 'second.example.test' ? '93.184.216.35' : LAB_PUBLIC_IP, family: 4 as const }];
    const out = (await executeWebFetch({ url: labUrl(port, '/start') }, { resolve: dns, request: labReq })) as { url: string; content: { source: { data: string } } };
    expect(out.url).toBe(`http://second.example.test:${port}/end`);
    expect(out.content.source.data).toContain('arrived');
    expect(lab.seen.map((o) => o.host)).toEqual([LAB_PUBLIC_IP, '93.184.216.35']);
    expect(hits.map((h) => h.host)).toEqual([`${LAB_HOST}:${port}`, `second.example.test:${port}`]);
  });

  it('bc799330 AC2: a body over the byte cap is truncated with the marker and the socket is torn down without an uncaught error', async () => {
    const port = await serve((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('a'.repeat(WEB_FETCH_MAX_BYTES));
      res.write('B'.repeat(WEB_FETCH_MAX_BYTES));
      res.end('c'.repeat(WEB_FETCH_MAX_BYTES));
    });
    const out = (await executeWebFetch({ url: labUrl(port) }, { resolve: publicDns, request: labReq })) as { content: { source: { data: string } } };
    expect(out.content.source.data.endsWith(WEB_FETCH_TRUNCATION_MARKER)).toBe(true);
    expect(out.content.source.data).not.toContain('B');
  });

  it('cbad68d4 AC2: ordinary HTML is extracted identically over the real socket', async () => {
    const port = await serve(html('<html><head><meta name="description" content="d"><title>T</title><script>x()</script></head><body><h1>H</h1><p>one</p></body></html>'));
    const out = (await executeWebFetch({ url: labUrl(port) }, { resolve: publicDns, request: labReq })) as { content: { source: { data: string } } };
    expect(out.content.source.data).toBe('---\nmeta-description: d\ntitle: T\n---\n\nH\none');
  });
});

describe('bc799330 AC1/AC3: the DEFAULT resolver and transport (no seams) refuse the local fixture', () => {
  it('bc799330 AC1: the loopback literal is refused and the server is never contacted', async () => {
    const port = await serve(html('<p>secret</p>'));
    await expect(executeWebFetch({ url: `http://127.0.0.1:${port}/` })).rejects.toThrow(/127\.0\.0\.1 is a loopback address/);
    expect(hits).toHaveLength(0);
  });

  it('bc799330 AC1: the NAME localhost, resolved by the real dns.lookup, is refused and the server is never contacted', async () => {
    const port = await serve(html('<p>secret</p>'));
    await expect(executeWebFetch({ url: `http://localhost:${port}/` })).rejects.toThrow(/localhost resolves to (127\.0\.0\.1|::1), which is a loopback address/);
    expect(hits).toHaveLength(0);
  });

  it('bc799330 AC3: allow-listing localhost does not authorise it', async () => {
    const port = await serve(html('<p>secret</p>'));
    await expect(executeWebFetch({ url: `http://localhost:${port}/` }, { allowedDomains: ['localhost', '127.0.0.1', '*'] })).rejects.toThrow(/loopback address/);
    expect(hits).toHaveLength(0);
  });
});
