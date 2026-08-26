#!/usr/bin/env node
/**
 * web-ui-server.mjs — static file server + same-origin API proxy for the
 * backlog web UI prototype.
 *
 * The backlog REST API (`backlog serve --transport http`, apigen fastify
 * mount) registers ONLY operation routes and no CORS handling, so a browser
 * page served from a different origin cannot call it. This server fixes that
 * the zero-config way: it serves the UI from `/` and proxies every
 * `/backlog/*`, `/_batch/*`, `/_meta/*` request to the API origin, so the
 * browser talks to ONE origin and never needs CORS.
 *
 * Pure node:http — no framework, no build step, nothing to install. Run
 * directly (`node web-ui-server.mjs --port 4173 --api http://127.0.0.1:3300`)
 * or through the orchestrator (`tools/run-web-ui.mjs`, which the backlog
 * project's `nx serve` target invokes).
 */
import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, 'web-ui');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Every API route lives under one of these prefixes. */
const PROXY_PREFIXES = ['/backlog/', '/_batch/', '/_meta/'];

/** Hop-by-hop headers that must not be forwarded through the proxy. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);

function parseArgs(argv) {
  const opts = { port: 4173, api: 'http://127.0.0.1:3300', host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--api') opts.api = argv[++i];
    else throw new Error(`web-ui-server: unknown argument "${a}" (expected --port/--host/--api)`);
  }
  return opts;
}

/** Forward a request to the API origin and pipe the response back unchanged.
 *  `agent: false` opens a FRESH upstream connection per request instead of
 *  reusing node's pooled keep-alive sockets (node ≥19 enables the global
 *  agent's keepAlive by default; the API's server closes idle connections
 *  after its own keep-alive timeout, so a pooled socket can go stale between
 *  a browser session's actions and fail on reuse — a browser-only failure
 *  mode curl never hits because it doesn't pool the same way). */
function proxyApi(req, res, url, apiOrigin) {
  const target = new URL(url.pathname + url.search, apiOrigin);
  const upstream = httpRequest(target, {
    method: req.method ?? 'POST',
    headers: { 'content-type': 'application/json' },
    agent: false,
  });
  upstream.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { message: `api proxy error: ${err.message}` } }));
  });
  upstream.on('response', (apiRes) => {
    const headers = {};
    for (const [k, v] of Object.entries(apiRes.headers)) {
      if (!HOP_BY_HOP.has(k)) headers[k] = v;
    }
    res.writeHead(apiRes.statusCode ?? 502, headers);
    apiRes.pipe(res);
  });
  req.pipe(upstream);
}

/** Serve a static file under WEB_ROOT, refusing path traversal. */
async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const abs = normalize(join(WEB_ROOT, rel));
  if (!abs.startsWith(WEB_ROOT) || abs === WEB_ROOT) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  try {
    const body = await readFile(abs);
    const type = MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

const opts = parseArgs(process.argv.slice(2));

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (PROXY_PREFIXES.some((p) => url.pathname.startsWith(p))) {
    proxyApi(req, res, url, opts.api);
    return;
  }
  void serveStatic(res, url.pathname);
});

server.listen(opts.port, opts.host, () => {
  process.stdout.write(`[web-ui] static + proxy (api: ${opts.api}) on http://${opts.host}:${opts.port}/\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
