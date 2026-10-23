// PARITY-INSTRUMENT-ONLY
// Wire-capture reverse proxy for the CLI-parity instrument (R6B-proxy).
//
// ONE proxy for all three arms (A native `claude -p`, B agent-mcp claudecli, C agent-mcp anthropic) and every agent-mcp provider
// (anthropic, openai, deepseek). Clients set their base URL to http://127.0.0.1:PORT/<arm>/<provider>; the rest of the path
// (/v1/messages, /v1/chat/completions, anything else) is appended after it and forwarded verbatim to that provider's upstream.
//
// TRANSPARENT: the request body is piped to the upstream as it arrives, the response is written to the client chunk-by-chunk as it
// arrives (no buffering of SSE), request headers are forwarded unchanged except `host` (accept-encoding is KEPT), status and response
// headers are forwarded unchanged, upstream errors and 429s pass through verbatim. Nothing is ever rewritten. The log copy of a
// compressed body is decoded AFTER the fact from a tee of the raw bytes; the forwarded bytes are never decoded.
//
// LOGGING: JSONL per (arm, provider) at <outDir>/proxy-<arm>-<provider>.jsonl with events session_start / raw_request / raw_response /
// turn (the per-session event shape ~/dev/ai/content-first/proxy/query.py reads). REQUEST HEADERS ARE NEVER RECORDED (credentials travel
// in them) and set-cookie is dropped from the response headers; bodies are verbatim. Logging is asynchronous and happens off the
// forwarding path.
//
// Usage: OUT_DIR=<dir> [PORT=0] node capture-proxy.mjs   (prints {"port":N,"url":"http://127.0.0.1:N"}); overridable upstreams:
//   PARITY_UPSTREAM_ANTHROPIC / PARITY_UPSTREAM_OPENAI / PARITY_UPSTREAM_DEEPSEEK.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PROVIDERS = ['anthropic', 'openai', 'deepseek'];
export const DEFAULT_UPSTREAMS = { anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com', deepseek: 'https://api.deepseek.com' };
const ROUTE_RE = /^\/([A-Za-z0-9_-]+)\/(anthropic|openai|deepseek)(\/[^]*)?$/;
const agents = { http: new http.Agent({ keepAlive: true }), https: new https.Agent({ keepAlive: true }) };

/** Upstream map from env, falling back to the public endpoints. */
export function upstreamsFromEnv(env = process.env) {
  return Object.fromEntries(PROVIDERS.map((p) => [p, env[`PARITY_UPSTREAM_${p.toUpperCase()}`] || DEFAULT_UPSTREAMS[p]]));
}

/** Decode a copy of a body for the log only. Returns the decoded Buffer, or null when the encoding is unknown/undecodable. */
export function decodeForLog(buf, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  try {
    if (!enc || enc === 'identity') return buf;
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
    if (enc === 'deflate') return zlib.inflateSync(buf);
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
    if (enc === 'zstd' && typeof zlib.zstdDecompressSync === 'function') return zlib.zstdDecompressSync(buf);
  } catch { /* fall through */ }
  return null;
}

/** The usage object of a response body: JSON `usage`, or for SSE the merged Anthropic message_start/message_delta usage, or the last OpenAI chunk carrying `usage`. */
export function extractUsage(text) {
  if (!text) return null;
  if (/^\s*(event:|data:)/m.test(text)) {
    let merged = null; let last = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim(); if (!d || d === '[DONE]') continue;
      let j; try { j = JSON.parse(d); } catch { continue; }
      if (j?.type === 'message_start' && j.message?.usage) merged = { ...merged, ...j.message.usage };
      else if (j?.type === 'message_delta' && j.usage) merged = { ...merged, ...j.usage };
      else if (j?.usage) last = j.usage;
    }
    return merged ?? last;
  }
  try { const j = JSON.parse(text); return j?.usage ?? j?.message?.usage ?? null; } catch { return null; }
}

const isTextual = (ct) => /json|text|event-stream|xml|javascript/i.test(String(ct || ''));
function bodyRecord(buf, contentType, encoding) {
  const dec = decodeForLog(buf, encoding);
  const out = { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  if (encoding && String(encoding).toLowerCase() !== 'identity') out.contentEncoding = encoding;
  if (!dec) { out.bodyBase64 = buf.toString('base64'); out.decoded = false; return out; }
  const text = dec.toString('utf8');
  if (/json/i.test(String(contentType || '')) || /^\s*[{[]/.test(text)) { try { return { ...out, decodedBytes: dec.length, body: JSON.parse(text), bodyKind: 'json' }; } catch { /* not json */ } }
  if (isTextual(contentType) && !text.includes('�')) return { ...out, decodedBytes: dec.length, bodyText: text, bodyKind: 'text' };
  return { ...out, decodedBytes: dec.length, bodyBase64: dec.toString('base64'), bodyKind: 'base64' };
}

/**
 * Start the proxy. Returns { port, url, baseUrl(arm, provider), close(), flush(), stats }.
 * @param {{outDir:string, upstreams?:Partial<Record<string,string>>, host?:string, port?:number, sessionId?:string, buffered?:boolean}} o
 *  `buffered` exists ONLY as a negative control for the incremental-streaming test (it buffers the whole response before writing it).
 */
export async function startCaptureProxy(o) {
  const outDir = path.resolve(o.outDir); fs.mkdirSync(outDir, { recursive: true });
  const upstreams = { ...upstreamsFromEnv({}), ...(o.upstreams || {}) };
  const sessionId = o.sessionId || crypto.randomUUID();
  const seqs = new Map(); const started = new Set(); const queues = new Map();
  const append = (file, ev) => {
    const prev = queues.get(file) || Promise.resolve();
    const next = prev.then(() => fs.promises.appendFile(file, JSON.stringify(ev) + '\n')).catch(() => {});
    queues.set(file, next); return next;
  };
  const emit = (arm, provider, ev) => {
    const file = path.join(outDir, `proxy-${arm}-${provider}.jsonl`);
    if (!started.has(file)) { started.add(file); append(file, { type: 'session_start', ts: new Date().toISOString(), session: sessionId, arm, provider, upstream: new URL(upstreams[provider]).origin }); }
    return append(file, { ts: new Date().toISOString(), arm, provider, ...ev });
  };
  const stats = { requests: 0, notFound: 0 };

  const server = http.createServer((req, res) => {
    const m = ROUTE_RE.exec(req.url || '');
    if (!m) { stats.notFound++; res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'capture-proxy: unknown route; expected /<arm>/<anthropic|openai|deepseek>/<path>' })); req.resume(); return; }
    const [, arm, provider, rest = '/'] = m;
    const up = new URL(upstreams[provider]);
    const seq = (seqs.get(`${arm}/${provider}`) || 0) + 1; seqs.set(`${arm}/${provider}`, seq); stats.requests++;
    const t0 = performance.now(); let tFirst = null; let model = null;
    const reqChunks = []; let reqBytes = 0;
    const headers = { ...req.headers, host: up.host };
    const lib = up.protocol === 'https:' ? https : http;
    const basePath = up.pathname.replace(/\/$/, '');
    let finished = false;
    const proxied = lib.request({ protocol: up.protocol, hostname: up.hostname, port: up.port || undefined, method: req.method, path: basePath + rest, headers, agent: up.protocol === 'https:' ? agents.https : agents.http }, (ur) => {
      const chunks = []; let bytes = 0; const held = [];
      res.writeHead(ur.statusCode, ur.statusMessage, ur.headers);
      ur.on('data', (c) => {
        if (tFirst === null) tFirst = performance.now();
        chunks.push(c); bytes += c.length;
        if (o.buffered) held.push(c); else res.write(c);
      });
      ur.on('end', () => {
        finished = true;
        if (o.buffered) for (const c of held) res.write(c);
        res.end();
        const tEnd = performance.now(); const raw = Buffer.concat(chunks);
        const rh = { ...ur.headers }; delete rh['set-cookie'];
        const rec = bodyRecord(raw, ur.headers['content-type'], ur.headers['content-encoding']);
        const text = rec.bodyText ?? (rec.body !== undefined ? JSON.stringify(rec.body) : '');
        emit(arm, provider, { type: 'raw_response', seq, status: ur.statusCode, headers: rh, ...rec, usage: extractUsage(text) });
        emit(arm, provider, { type: 'turn', seq, model, ms_first_byte: tFirst === null ? null : +(tFirst - t0).toFixed(2), ms_total: +(tEnd - t0).toFixed(2), status: ur.statusCode, request_bytes: reqBytes, response_bytes: bytes, path: rest.split('?')[0] });
      });
      ur.on('error', () => { /* socket reset: res closes below */ res.destroy(); });
    });
    proxied.on('error', (e) => {
      finished = true;
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'capture-proxy: upstream unreachable', code: e.code || null })); } else res.destroy();
      emit(arm, provider, { type: 'turn', seq, model, ms_first_byte: null, ms_total: +(performance.now() - t0).toFixed(2), status: 502, request_bytes: reqBytes, response_bytes: 0, path: rest.split('?')[0], error: e.code || String(e.message) });
    });
    res.on('close', () => { if (!finished) proxied.destroy(); });
    req.on('data', (c) => { reqChunks.push(c); reqBytes += c.length; });
    req.on('end', () => {
      const raw = Buffer.concat(reqChunks); const rec = bodyRecord(raw, req.headers['content-type'], req.headers['content-encoding']);
      model = rec.body && typeof rec.body === 'object' ? rec.body.model ?? null : null;
      emit(arm, provider, { type: 'raw_request', seq, method: req.method, path: rest.split('?')[0], ...rec });
    });
    req.pipe(proxied);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(o.port ?? 0, o.host || '127.0.0.1', resolve); });
  const port = server.address().port; const url = `http://${o.host || '127.0.0.1'}:${port}`;
  const flush = () => Promise.all([...queues.values()]);
  return {
    port, url, outDir, sessionId, stats,
    /** The base URL a client of `provider` for `arm` should be configured with (append /v1 yourself where the SDK needs it). */
    baseUrl: (arm, provider) => `${url}/${arm}/${provider}`,
    flush,
    close: async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(() => r())); await flush(); },
  };
}

const p50 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/**
 * Self-calibration against a local mock (no model call): p50 added latency of the proxy for a small JSON POST and for an SSE response
 * (time to first chunk and total). Direct and proxied requests are interleaved so drift cancels. `outDir` receives the proxy's own log.
 */
export async function measureOverhead({ outDir, n = 40 } = {}) {
  const sse = ['data: {"a":1}\n\n', 'data: {"b":2}\n\n', 'data: [DONE]\n\n'];
  const mock = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      if (req.url.endsWith('/sse')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const c of sse) res.write(c); res.end(); }
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"usage":{"input_tokens":1}}'); }
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const proxy = await startCaptureProxy({ outDir, upstreams: { anthropic: `http://127.0.0.1:${mock.address().port}` }, sessionId: 'overhead-calibration' });
  const agent = new http.Agent({ keepAlive: true });
  const hit = (base, pth) => new Promise((resolve, reject) => {
    const u = new URL(base + pth); const t0 = performance.now(); let tf = null;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', agent, headers: { 'content-type': 'application/json' } }, (res) => {
      res.on('data', () => { if (tf === null) tf = performance.now(); }); res.on('end', () => resolve({ first: tf - t0, total: performance.now() - t0 }));
    });
    r.on('error', reject); r.end('{"model":"calibration","messages":[]}');
  });
  const direct = { json: [], sse: [] }; const via = { json: [], sse: [] };
  const mockBase = `http://127.0.0.1:${mock.address().port}`;
  for (let i = 0; i < n + 5; i++) {
    for (const kind of ['json', 'sse']) {
      const d = await hit(mockBase, `/v1/${kind}`); const v = await hit(proxy.baseUrl('X', 'anthropic'), `/v1/${kind}`);
      if (i >= 5) { direct[kind].push(d); via[kind].push(v); }   // first 5 warm the keep-alive sockets
    }
  }
  agent.destroy(); await proxy.close(); await new Promise((r) => mock.close(() => r()));
  const d = (kind, f) => +(p50(via[kind].map((x) => x[f])) - p50(direct[kind].map((x) => x[f]))).toFixed(3);
  return { n, jsonTotalMs: d('json', 'total'), sseFirstChunkMs: d('sse', 'first'), sseTotalMs: d('sse', 'total'), directJsonTotalP50Ms: +p50(direct.json.map((x) => x.total)).toFixed(3), viaJsonTotalP50Ms: +p50(via.json.map((x) => x.total)).toFixed(3), unit: 'p50 added ms (proxied minus direct), local mock, logging on' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = process.env.OUT_DIR;
  if (!outDir) { console.error('capture-proxy: OUT_DIR is required'); process.exit(2); }
  const px = await startCaptureProxy({ outDir, upstreams: upstreamsFromEnv(), port: Number(process.env.PORT || 0) });
  console.log(JSON.stringify({ port: px.port, url: px.url, outDir: px.outDir }));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { px.close().then(() => process.exit(0)); });
}
