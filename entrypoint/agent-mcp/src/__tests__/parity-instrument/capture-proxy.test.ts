import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { loadParity } from './load';

/**
 * R6B-proxy (unit lane): the wire-capture proxy (parity/capture-proxy.mjs), its offline reader (parity/wire-diff.mjs) and the driver's opt-in wiring
 * (parity/drive.mjs captureEnv). Servers run in-process on 127.0.0.1 (no subprocess, no model, no network): a local mock upstream speaks the Anthropic SSE
 * and the OpenAI chat SSE wire formats. Credentials used are synthetic.
 *   AC1 routing   AC2 transparency (bytes, headers, 429, streaming incremental)   AC3 logging (shape, usage, no credential)
 *   AC4 wiring (default OFF, per-arm env)   AC5 wire-diff on mock logs   AC6 negative controls
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const CP: Any = await loadParity('capture-proxy.mjs');
const WD: Any = await loadParity('wire-diff.mjs');
const D: Any = await loadParity('drive.mjs');

const SECRET = 'sk-ant-api03-SYNTHETIC-SECRET-do-not-log-0123456789'; // pragma: allowlist secret gitleaks:allow (synthetic canary; the test proves it is never logged)
const BEARER = 'Bearer sk-openai-SYNTHETIC-BEARER-9876543210';
const WORK = path.join(os.tmpdir(), 'r6b-proxy-unit');
let counter = 0;
const freshDir = () => { const d = path.join(WORK, `t${process.pid}-${counter++}`); fs.mkdirSync(d, { recursive: true }); return d; };
afterAll(() => { fs.rmSync(WORK, { recursive: true, force: true }); });

const ANTH_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":120,"cache_read_input_tokens":100,"cache_creation_input_tokens":7,"output_tokens":1}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];
const OPENAI_SSE = [
  'data: {"id":"c1","choices":[{"delta":{"content":"he"}}]}\n\n',
  'data: {"id":"c1","choices":[{"delta":{"content":"llo"}}]}\n\n',
  'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":50,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":32}}}\n\n',
  'data: [DONE]\n\n',
];

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer };
/** Local mock upstream. `/v1/messages` + `/v1/chat/completions` stream SSE, `/gz` answers gzip JSON, `/limit` answers 429, `/gate` streams its first chunk then waits on a latch. */
async function startMock() {
  const seen: Seen[] = [];
  let release!: () => void; const latch = new Promise<void>((r) => { release = r; });
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = []; req.on('data', (c) => parts.push(c));
    req.on('end', async () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(parts) });
      const u = req.url!.split('?')[0];
      if (u.endsWith('/v1/messages')) { res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_1' }); for (const c of ANTH_SSE) res.write(c); res.end(); }
      else if (u.endsWith('/chat/completions')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const c of OPENAI_SSE) res.write(c); res.end(); }
      else if (u === '/gz') { const z = zlib.gzipSync(Buffer.from('{"usage":{"input_tokens":3,"output_tokens":4},"ok":true}')); res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(z.length) }); res.end(z); }
      else if (u === '/limit') { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '17' }); res.end('{"error":{"type":"rate_limit_error"}}'); }
      else if (u === '/gate') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"first":true}\n\n'); await latch; res.write('data: {"second":true}\n\n'); res.end(); }
      else { res.writeHead(404); res.end('nope'); }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, seen, release, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

type Resp = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };
const call = (base: string, p: string, opts: { method?: string; body?: string | Buffer; headers?: Record<string, string> } = {}) => new Promise<Resp>((resolve, reject) => {
  const u = new URL(base + p);
  const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method ?? 'POST', headers: opts.headers }, (res) => {
    const parts: Buffer[] = []; res.on('data', (c) => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(parts) }));
  });
  r.on('error', reject); r.end(opts.body);
});
const AUTH = { 'content-type': 'application/json', 'x-api-key': SECRET, authorization: BEARER };

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });
async function rig(proxyOpts: Record<string, unknown> = {}) {
  const mock = await startMock(); const outDir = freshDir();
  const proxy = await CP.startCaptureProxy({ outDir, upstreams: { anthropic: mock.url, openai: mock.url, deepseek: `${mock.url}/ds-prefix` }, ...proxyOpts });
  closers.push(() => proxy.close(), () => mock.close());
  return { mock, proxy, outDir };
}
const events = (outDir: string, file: string) => fs.readFileSync(path.join(outDir, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const allLogText = (outDir: string) => fs.readdirSync(outDir).map((f) => fs.readFileSync(path.join(outDir, f), 'utf8')).join('\n');

describe('R6B-proxy AC1: routing', () => {
  it('routes /<arm>/<provider>/<rest> to that provider upstream, keeping path and query', async () => {
    const { mock, proxy } = await rig();
    for (const arm of ['A', 'B', 'C', 'My_label-2']) {
      const r = await call(proxy.baseUrl(arm, 'anthropic'), '/v1/messages?beta=true', { body: '{"model":"m"}', headers: AUTH });
      expect(r.status).toBe(200);
    }
    expect(mock.seen.map((s) => s.url)).toEqual(Array(4).fill('/v1/messages?beta=true'));
    await call(proxy.baseUrl('C', 'openai'), '/v1/chat/completions', { body: '{"model":"gpt"}', headers: AUTH });
    await call(proxy.baseUrl('C', 'deepseek'), '/v1/chat/completions', { body: '{"model":"ds"}', headers: AUTH });   // deepseek upstream carries a path prefix
    expect(mock.seen.slice(4).map((s) => s.url)).toEqual(['/v1/chat/completions', '/ds-prefix/v1/chat/completions']);
  });

  it('answers 404 for an unknown provider, a bad arm label or a missing provider, and never forwards', async () => {
    const { mock, proxy } = await rig();
    for (const p of ['/A/gemini/v1/messages', '/A/v1/messages', '/v1/messages', '/', '/bad arm/anthropic/v1/messages', '/A/anthropicx/v1/messages']) {
      const r = await call(proxy.url, p.replace(' ', '%20'), { body: '{}' });
      expect(r.status, p).toBe(404);
    }
    expect(mock.seen).toHaveLength(0);
    expect(proxy.stats.notFound).toBe(6);
  });
});

describe('R6B-proxy AC2: transparency', () => {
  it('delivers the response body byte-identically (SSE) with status and headers unchanged', async () => {
    const { proxy } = await rig();
    const direct = Buffer.from(ANTH_SSE.join(''));
    const r = await call(proxy.baseUrl('A', 'anthropic'), '/v1/messages', { body: '{"model":"m","stream":true}', headers: AUTH });
    expect(r.body.equals(direct)).toBe(true);
    expect(r.headers['content-type']).toBe('text/event-stream');
    expect(r.headers['request-id']).toBe('req_1');
    const o = await call(proxy.baseUrl('A', 'openai'), '/v1/chat/completions', { body: '{"model":"m"}', headers: AUTH });
    expect(o.body.equals(Buffer.from(OPENAI_SSE.join('')))).toBe(true);
  });

  it('forwards request headers unchanged except host (accept-encoding KEPT) and the request body byte-identically', async () => {
    const { mock, proxy } = await rig();
    const body = Buffer.from('{"model":"m","messages":[{"role":"user","content":"café ☃"}]}');
    await call(proxy.baseUrl('B', 'anthropic'), '/v1/messages', { body, headers: { ...AUTH, 'accept-encoding': 'gzip, br', 'anthropic-beta': 'x-1', 'user-agent': 'claude-cli/9' } });
    const s = mock.seen[0];
    expect(s.body.equals(body)).toBe(true);
    expect(s.headers['accept-encoding']).toBe('gzip, br');
    expect(s.headers['x-api-key']).toBe(SECRET);
    expect(s.headers.authorization).toBe(BEARER);
    expect(s.headers['anthropic-beta']).toBe('x-1');
    expect(s.headers['user-agent']).toBe('claude-cli/9');
    expect(s.headers.host).toBe(new URL(mock.url).host);
  });

  it('never decodes on the forward path: a gzip response reaches the client as the same compressed bytes with content-encoding intact', async () => {
    const { proxy, outDir } = await rig();
    const r = await call(proxy.baseUrl('A', 'anthropic'), '/gz', { body: '{"model":"m"}', headers: { ...AUTH, 'accept-encoding': 'gzip' } });
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(zlib.gunzipSync(r.body).toString()).toBe('{"usage":{"input_tokens":3,"output_tokens":4},"ok":true}');
    expect(r.body.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))).toBe(true);
    await proxy.flush();
    const resp = events(outDir, 'proxy-A-anthropic.jsonl').find((e) => e.type === 'raw_response');
    expect(resp.body).toEqual({ usage: { input_tokens: 3, output_tokens: 4 }, ok: true });   // the LOG copy is decoded
    expect(resp.contentEncoding).toBe('gzip');
    expect(resp.usage).toEqual({ input_tokens: 3, output_tokens: 4 });
  });

  it('passes a 429 through verbatim (status, retry-after, body) and logs it', async () => {
    const { proxy, outDir } = await rig();
    const r = await call(proxy.baseUrl('C', 'anthropic'), '/limit', { body: '{"model":"m"}', headers: AUTH });
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('17');
    expect(r.body.toString()).toBe('{"error":{"type":"rate_limit_error"}}');
    await proxy.flush();
    expect(events(outDir, 'proxy-C-anthropic.jsonl').find((e) => e.type === 'turn').status).toBe(429);
  });

  it('answers 502 (and logs it) when the upstream is unreachable', async () => {
    const outDir = freshDir();
    const proxy = await CP.startCaptureProxy({ outDir, upstreams: { anthropic: 'http://127.0.0.1:1' } });
    closers.push(() => proxy.close());
    const r = await call(proxy.baseUrl('A', 'anthropic'), '/v1/messages', { body: '{}' });
    expect(r.status).toBe(502);
    await proxy.flush();
    expect(events(outDir, 'proxy-A-anthropic.jsonl').find((e) => e.type === 'turn').status).toBe(502);
  });

  // The incremental proof: the mock writes chunk 1 then BLOCKS on a latch that only this test releases, and only after the client has seen chunk 1.
  // A proxy that buffers the response can never show the client chunk 1 before the release.
  const firstChunkBeforeRelease = async (proxyOpts: Record<string, unknown>, deadlineMs: number) => {
    const { mock, proxy } = await rig(proxyOpts);
    const u = new URL(proxy.baseUrl('A', 'anthropic') + '/gate');
    let sawFirst!: () => void; const first = new Promise<boolean>((r) => { sawFirst = () => r(true); });
    const done = new Promise<string>((resolve, reject) => {
      const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST' }, (res) => {
        let acc = ''; res.on('data', (c) => { acc += c; if (acc.includes('"first"')) sawFirst(); }); res.on('end', () => resolve(acc));
      });
      req.on('error', reject); req.end('{}');
    });
    const outcome = await Promise.race([first, new Promise<boolean>((r) => { setTimeout(() => r(false), deadlineMs).unref(); })]);
    mock.release();                       // let the mock finish either way so nothing hangs
    const full = await done;
    return { outcome, full };
  };
  it('streams incrementally: the client sees chunk 1 while the upstream is still holding the response open', async () => {
    const { outcome, full } = await firstChunkBeforeRelease({}, 5000);
    expect(outcome).toBe(true);
    expect(full).toBe('data: {"first":true}\n\ndata: {"second":true}\n\n');
  });
  it('AC6 negative control: a proxy that buffers the response fails the incremental test', async () => {
    const { outcome, full } = await firstChunkBeforeRelease({ buffered: true }, 400);
    expect(outcome).toBe(false);                                   // the incremental assertion above would be RED for this variant
    expect(full).toBe('data: {"first":true}\n\ndata: {"second":true}\n\n');   // still byte-correct, only late
  });
});

describe('R6B-proxy AC3: logging', () => {
  it('writes one proxy-<arm>-<provider>.jsonl per pair with session_start / raw_request / raw_response / turn', async () => {
    const { proxy, outDir } = await rig({ sessionId: 'sess-1' });
    await call(proxy.baseUrl('A', 'anthropic'), '/v1/messages', { body: JSON.stringify({ model: 'claude-x', system: 'S', messages: [{ role: 'user', content: 'q' }] }), headers: AUTH });
    await call(proxy.baseUrl('A', 'anthropic'), '/v1/messages', { body: '{"model":"claude-y"}', headers: AUTH });
    await call(proxy.baseUrl('C', 'openai'), '/v1/chat/completions', { body: '{"model":"gpt-z","messages":[]}', headers: { ...AUTH, authorization: BEARER } });
    await proxy.flush();
    expect(fs.readdirSync(outDir).sort()).toEqual(['proxy-A-anthropic.jsonl', 'proxy-C-openai.jsonl']);
    const a = events(outDir, 'proxy-A-anthropic.jsonl');
    expect(a.map((e) => e.type)).toEqual(['session_start', 'raw_request', 'raw_response', 'turn', 'raw_request', 'raw_response', 'turn']);
    expect(a[0]).toMatchObject({ type: 'session_start', session: 'sess-1', arm: 'A', provider: 'anthropic', upstream: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) });
    const req1 = a.find((e) => e.type === 'raw_request' && e.seq === 1);
    expect(req1.body).toEqual({ model: 'claude-x', system: 'S', messages: [{ role: 'user', content: 'q' }] });
    expect(req1).toMatchObject({ bodyKind: 'json', method: 'POST', path: '/v1/messages' });
    const resp1 = a.find((e) => e.type === 'raw_response' && e.seq === 1);
    expect(resp1.bodyText).toBe(ANTH_SSE.join(''));            // verbatim SSE
    expect(resp1.usage).toEqual({ input_tokens: 120, cache_read_input_tokens: 100, cache_creation_input_tokens: 7, output_tokens: 9 });
    const turn1 = a.find((e) => e.type === 'turn' && e.seq === 1);
    expect(turn1).toMatchObject({ arm: 'A', provider: 'anthropic', seq: 1, model: 'claude-x', status: 200, request_bytes: Buffer.byteLength(JSON.stringify(req1.body)), response_bytes: Buffer.byteLength(ANTH_SSE.join('')) });
    expect(turn1.ms_first_byte).toBeGreaterThanOrEqual(0); expect(turn1.ms_total).toBeGreaterThanOrEqual(turn1.ms_first_byte);
    expect(a.find((e) => e.type === 'turn' && e.seq === 2).model).toBe('claude-y');
    const o = events(outDir, 'proxy-C-openai.jsonl');
    expect(o.find((e) => e.type === 'raw_response').usage).toEqual({ prompt_tokens: 50, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 32 } });
  });

  it('records a non-JSON request body as base64', async () => {
    const { proxy, outDir } = await rig();
    const bin = Buffer.from([0, 255, 1, 254, 2]);
    await call(proxy.baseUrl('A', 'anthropic'), '/v1/messages', { body: bin, headers: { 'content-type': 'application/octet-stream' } });
    await proxy.flush();
    const rq = events(outDir, 'proxy-A-anthropic.jsonl').find((e) => e.type === 'raw_request');
    expect(rq.bodyKind).toBe('base64'); expect(Buffer.from(rq.bodyBase64, 'base64').equals(bin)).toBe(true);
  });

  it('never records a request header or a credential anywhere in any log', async () => {
    const { proxy, outDir } = await rig();
    for (const [prov, p] of [['anthropic', '/v1/messages'], ['openai', '/v1/chat/completions'], ['deepseek', '/v1/chat/completions']] as const) {
      await call(proxy.baseUrl('B', prov), p, { body: '{"model":"m","messages":[{"role":"user","content":"hello"}]}', headers: { ...AUTH, cookie: 'session=SYNTHETIC-COOKIE' } });
    }
    await proxy.flush();
    const text = allLogText(outDir);
    expect(text.length).toBeGreaterThan(500);
    for (const needle of [SECRET, 'SYNTHETIC-BEARER', 'SYNTHETIC-COOKIE', 'sk-ant-', 'x-api-key', '"authorization"', '"cookie"']) expect(text, needle).not.toContain(needle);
    // a request log event has no `headers` key at all (response events carry response headers only)
    for (const f of fs.readdirSync(outDir)) for (const e of events(outDir, f)) if (e.type === 'raw_request') expect(Object.keys(e)).not.toContain('headers');
  });

  it('AC6 negative control: the credential scan has teeth (a log that echoed request headers would be caught)', async () => {
    const outDir = freshDir();
    fs.writeFileSync(path.join(outDir, 'proxy-X-anthropic.jsonl'), JSON.stringify({ type: 'raw_request', headers: { 'x-api-key': SECRET } }) + '\n');
    expect(allLogText(outDir)).toContain(SECRET);
  });

  it('measureOverhead reports finite p50 added latency against a local mock', async () => {
    const o = await CP.measureOverhead({ outDir: freshDir(), n: 20 });
    for (const k of ['jsonTotalMs', 'sseFirstChunkMs', 'sseTotalMs']) { expect(Number.isFinite(o[k]), k).toBe(true); expect(o[k], k).toBeLessThan(250); }
    expect(o.unit).toMatch(/p50/);
  });
});

describe('R6B-proxy AC5: wire-diff on mock-generated logs', () => {
  const SYS_A = 'You are a coding agent.';
  const body = (system: string, tools: string[], extra: Record<string, unknown> = {}) => JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 100, system, tools: tools.map((name) => ({ name, description: 'd', input_schema: { type: 'object' } })), messages: [{ role: 'user', content: 'task' }], stream: true, ...extra });
  async function generate(sysC = SYS_A) {
    const { proxy, outDir } = await rig();
    await call(proxy.baseUrl('A', 'anthropic'), '/v1/messages', { body: body('hello side', []), headers: AUTH });          // tool-less side call must not be taken as "first"
    await call(proxy.baseUrl('A', 'anthropic'), '/v1/messages', { body: body(SYS_A, ['Bash', 'Read', 'Edit']), headers: AUTH });
    await call(proxy.baseUrl('B', 'anthropic'), '/v1/messages', { body: body(SYS_A, ['Bash', 'Read', 'mcp__agent__spawn']), headers: AUTH });
    await call(proxy.baseUrl('C', 'anthropic'), '/v1/messages', { body: body(sysC, ['Bash', 'read_file']), headers: AUTH });
    await call(proxy.baseUrl('C', 'anthropic'), '/v1/messages', { body: body(sysC, ['Bash', 'read_file'], { messages: [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'y' }] }), headers: AUTH });
    await proxy.flush();
    return outDir;
  }
  it('prints per-arm system/tools/messages/usage and the cross-arm delta', async () => {
    const dir = await generate();
    const files = WD.resolveWireFiles([dir]);
    expect(files.map((f: string) => path.basename(f))).toEqual(['proxy-A-anthropic.jsonl', 'proxy-B-anthropic.jsonl', 'proxy-C-anthropic.jsonl']);
    const an = WD.analyzeWire(files);
    expect(an.arms.A.requests).toHaveLength(2);
    expect(an.arms.A.first.tools).toEqual(['Bash', 'Read', 'Edit']);       // first request that declares tools
    expect(an.arms.A.first.system).toBe(SYS_A);
    expect(an.arms.A.first.toolsBytes).toBeGreaterThan(50);
    expect(an.arms.C.requests.map((r: Any) => r.messageCount)).toEqual([1, 3]);
    expect(an.arms.C.turns[0]).toMatchObject({ input: 120, cacheRead: 100, cacheCreate: 7, output: 9 });
    const d = WD.diffFirstRequests(an);
    expect(d.systemEqualAll).toBe(true);
    expect(d.differing.map((r: Any) => r.tool).sort()).toEqual(['Edit', 'Read', 'mcp__agent__spawn', 'read_file']);
    expect(d.toolMatrix.find((r: Any) => r.tool === 'Bash').present).toEqual({ A: true, B: true, C: true });
    expect(d.toolMatrix.find((r: Any) => r.tool === 'Read').present).toEqual({ A: true, B: true, C: false });
    const text: string = WD.renderWireDiff(an);
    expect(text).toContain('== arm A');
    expect(text).toContain('tools: 3');
    expect(text).toContain('system text equal across all arms: YES');
    expect(text).toMatch(/Read\s+A:yes\s+B:yes\s+C:no/);
    expect(text).toMatch(/read_file\s+A:no\s+B:no\s+C:yes/);
    expect(text).toContain('cacheRead');
  });
  it('AC6 negative control: a differing system text is reported as NOT equal, with the first differing offset', async () => {
    const dir = await generate('You are a DIFFERENT agent.');
    const d = WD.diffFirstRequests(WD.analyzeWire(WD.resolveWireFiles([dir])));
    expect(d.systemEqualAll).toBe(false);
    const ac = d.systemPairs.find((p: Any) => p.a === 'A' && p.b === 'C');
    expect(ac.equal).toBe(false); expect(ac.firstDiffAt).toBe('You are a '.length);
    expect(WD.renderWireDiff(WD.analyzeWire(WD.resolveWireFiles([dir])))).toContain('system text equal across all arms: NO');
  });
  it('reads OpenAI chat bodies (system role, function tools) and accepts explicit file paths', async () => {
    const { proxy, outDir } = await rig();
    await call(proxy.baseUrl('C', 'openai'), '/v1/chat/completions', { body: JSON.stringify({ model: 'gpt', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'u' }], tools: [{ type: 'function', function: { name: 'shell', parameters: {} } }] }), headers: AUTH });
    await proxy.flush();
    const an = WD.analyzeWire(WD.resolveWireFiles([path.join(outDir, 'proxy-C-openai.jsonl')]));
    expect(an.arms.C.first).toMatchObject({ kind: 'openai-chat', system: 'SYS', tools: ['shell'], messageCount: 1 });
    expect(an.arms.C.turns[0]).toMatchObject({ input: 50, cacheRead: 32, output: 4 });
  });
});

describe('R6B-proxy AC4: driver wiring (capture is opt-in, default OFF)', () => {
  const ctxFor = (arm: string, capture: Any) => {
    const opts = { ...D.parseArgs([]), round: 'R898', out: path.join(WORK, 'drv'), outExplicit: true };
    const ctx = D.makeCtx(opts, [], { arm, rep: 1 }, false);
    if (capture) ctx.capture = capture;
    return ctx;
  };
  const fake = { baseUrl: (arm: string, prov: string) => `http://127.0.0.1:7777/${arm}/${prov}` };

  it('default is OFF: parseArgs.capture false, no capture env, no capture key in effectiveConfig, env builders unchanged', () => {
    const saved = process.env.PARITY_CAPTURE; delete process.env.PARITY_CAPTURE;
    try {
      expect(D.parseArgs([]).capture).toBe(false);
      for (const arm of ['A', 'B', 'C']) {
        const ctx = ctxFor(arm, null);
        expect(D.captureEnv(ctx)).toEqual({});
        expect(D.effectiveConfig(ctx)).not.toHaveProperty('capture');
        const env = arm === 'A' ? D.armAEnv(ctx) : D.serverEnv(ctx, '/s', '/l');
        expect(Object.keys(env).filter((k) => /BASE_URL/.test(k))).toEqual([]);
      }
    } finally { if (saved !== undefined) process.env.PARITY_CAPTURE = saved; }
  });
  it('--capture and PARITY_CAPTURE=1 turn it on', () => {
    expect(D.parseArgs(['--capture']).capture).toBe(true);
    const saved = process.env.PARITY_CAPTURE; process.env.PARITY_CAPTURE = '1';
    try { expect(D.parseArgs([]).capture).toBe(true); } finally { if (saved === undefined) delete process.env.PARITY_CAPTURE; else process.env.PARITY_CAPTURE = saved; }
    expect(D.effectiveConfig({ ...ctxFor('B', null), opts: { capture: true } }).capture).toMatch(/wire capture ON/);
  });
  it('routes each arm through its own /<arm>/anthropic prefix: A claude spawn env, B and C agent-mcp server env', () => {
    expect(D.armAEnv(ctxFor('A', fake)).ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:7777/A/anthropic');
    for (const arm of ['B', 'C']) {
      const env = D.serverEnv(ctxFor(arm, fake), '/s', '/l');
      expect(env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:7777/${arm}/anthropic`);
      expect(env.ADHD_AGENT_OPENAI_BASE_URL).toBe(`http://127.0.0.1:7777/${arm}/openai/v1`);
      expect(env.ADHD_AGENT_DEEPSEEK_BASE_URL).toBe(`http://127.0.0.1:7777/${arm}/deepseek/v1`);
    }
    expect(D.armAEnv(ctxFor('A', fake))).not.toHaveProperty('ADHD_AGENT_OPENAI_BASE_URL');
  });
});
