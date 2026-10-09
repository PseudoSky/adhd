/**
 * c536ce29 W3 - inbound raw capture (TRC-AC23, TRC-AC24, W3-AC-A).
 *
 * A real MCP `Client` drives the real `createServer` over the SDK's in-memory transport against real
 * stores; the HTTP route variants run on real loopback `http` servers (the real `startSseServer` and
 * the real `startServer` streamable-HTTP route with a real MCP HTTP client). Nothing here spawns a
 * process or reaches a third-party network. The assertion is on the api channel's durable file.
 *
 * Red -> green: remove the `withApiLog(` wrapper (or `noteToolError`) from server.ts and the AC23
 * tests fail; the identityRedactor tests prove the canary scans have teeth.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { HookRegistry } from '@adhd/agent-engine-orchestrator';
import { identityRedactor, type Redactor } from '@adhd/agent-plugin-tracing';
import { SessionStore, TaskStore } from '@adhd/agent-store-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { env } from '../config.js';
import { createServer, type ServerDeps } from '../server.js';
import { AgentStore } from '../store/agent-store.js';
import { startSseServer } from '../streaming/sse-server.js';
import { closeLogChannels, getLogChannels, initLogChannels, noopLogChannel } from '../wire/channels.js';
import { noteToolError, withApiLog, withHttpApiLog } from '../wire/api-log.js';
import { openDb, type ITestDb } from './pricing-fixtures.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSONL records are untyped by nature
type Rec = Record<string, any> & { event: string };

/** Built at runtime so the secret scanner never sees a literal. */
const CANARY = ['sk', 'canary', 'w3', 'tool', 'ARG', '9f3a1c7e'].join('-');
const HEADER_CANARY = ['hdr', 'canary', 'w3', '5d2b8e41'].join('-');
const QUERY_CANARY = ['qry', 'canary', 'w3', '77aa01bc'].join('-');

let cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
  await closeLogChannels();
});

/** Installs real process-wide channels over a temp dir; returns a reader for the api file. */
function installChannels(opts: { redactor?: Redactor } = {}): { records(): Promise<Rec[]>; text(): Promise<string> } {
  const root = mkdtempSync(join(tmpdir(), 'w3-api-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const roots = { root, api: join(root, 'api'), ops: join(root, 'ops'), trace: join(root, 'trace'), temp: join(root, 'tmp') };
  initLogChannels({
    roots,
    logging: { ...env.config.logging, api: 'on' },
    knownSecrets: [CANARY, HEADER_CANARY, QUERY_CANARY],
    stderr: { write: () => undefined },
    ...(opts.redactor ? { redactor: opts.redactor } : {}),
  });
  const text = async (): Promise<string> => {
    await getLogChannels().flush();
    return readdirSync(roots.api)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => readFileSync(join(roots.api, f), 'utf8'))
      .join('');
  };
  return {
    text,
    records: async () =>
      (await text())
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Rec),
  };
}

function makeDeps(): ServerDeps {
  const o: ITestDb = openDb();
  cleanups.push(() => o.sqlite.close());
  const hooks = new HookRegistry();
  return {
    agentStore: new AgentStore(o.db, hooks),
    sessionStore: new SessionStore(o.db, hooks),
    taskStore: new TaskStore(o.db),
    hooks,
    db: o.db,
  } as unknown as ServerDeps;
}

async function connect(): Promise<Client> {
  const server = createServer(makeDeps());
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-host', version: '0.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanups.push(() => client.close(), () => server.close());
  return client;
}

const byTool = (recs: Rec[], tool: string): Rec[] => recs.filter((r) => r.tool === tool);

describe('c536ce29 TRC-AC23 every tool writes a raw request and response/error record', () => {
  it('c536ce29 TRC-AC23: each advertised tool, called through the real server, leaves one mcp.request and one mcp.response with a shared call_id', async () => {
    const log = installChannels();
    const client = await connect();
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools.length).toBeGreaterThanOrEqual(19);
    for (const name of tools) await client.callTool({ name, arguments: {} });

    const recs = await log.records();
    for (const name of tools) {
      const mine = byTool(recs, name);
      const req = mine.filter((r) => r.event === 'mcp.request');
      const res = mine.filter((r) => r.event === 'mcp.response' || r.event === 'mcp.error');
      expect(req, `${name} request`).toHaveLength(1);
      expect(res, `${name} response`).toHaveLength(1);
      expect(res[0]?.call_id).toBe(req[0]?.call_id);
      expect(req[0]?.body).toBeDefined();
      expect(res[0]?.duration_ms).toEqual(expect.any(Number));
    }
  });

  it('c536ce29 TRC-AC23: a tool that throws (rejected agent_create) leaves the raw args and the ORIGINAL swallowed error, and the caller still gets isError', async () => {
    const log = installChannels();
    const client = await connect();
    const out = await client.callTool({ name: 'agent_create', arguments: { not_a_field: 1 } });
    expect(out.isError).toBe(true);

    const recs = byTool(await log.records(), 'agent_create');
    const req = recs.find((r) => r.event === 'mcp.request');
    const res = recs.find((r) => r.event === 'mcp.response');
    expect(req?.body).toContain('not_a_field');
    expect(res?.is_error).toBe(true);
    expect(res?.error_class).toBe('ZodError');
    expect(res?.error_stack).toEqual(expect.any(String));
    expect(res?.body).toContain('isError');
  });

  it('c536ce29 TRC-AC23: an unknown tool name (default branch) is logged too', async () => {
    const log = installChannels();
    const client = await connect();
    const out = await client.callTool({ name: 'no_such_tool', arguments: {} });
    expect(out.isError).toBe(true);
    const recs = byTool(await log.records(), 'no_such_tool');
    expect(recs.map((r) => r.event)).toEqual(['mcp.request', 'mcp.response']);
    expect(recs[1]?.is_error).toBe(true);
  });

  it('c536ce29 TRC-AC23: a successful call logs the result payload and call_id', async () => {
    const log = installChannels();
    const client = await connect();
    const out = await client.callTool({ name: 'guide', arguments: {} });
    expect(out.isError).toBeFalsy();
    const res = byTool(await log.records(), 'guide').find((r) => r.event === 'mcp.response');
    expect(res?.is_error).toBe(false);
    expect(String(res?.body).length).toBeGreaterThan(0);
    expect(res?.call_id).toEqual(expect.any(String));
  });

  it('c536ce29 TRC-AC23: a handler that itself throws writes mcp.error and rethrows the same error', async () => {
    const log = installChannels();
    const boom = new Error('handler boom');
    const wrapped = withApiLog(async (_r: { params: { name: string } }, _e: { sessionId?: string }): Promise<never> => {
      throw boom;
    });
    await expect(wrapped({ params: { name: 'x_tool' } }, { sessionId: 'sess-1' })).rejects.toBe(boom);
    const recs = byTool(await log.records(), 'x_tool');
    expect(recs.map((r) => r.event)).toEqual(['mcp.request', 'mcp.error']);
    expect(recs[1]).toMatchObject({ error_message: 'handler boom', mcp_session_id: 'sess-1' });
  });

  it('c536ce29 TRC-AC24: a secret canary in tool args never reaches the file; identityRedactor control shows the scan has teeth', async () => {
    const log = installChannels();
    const client = await connect();
    await client.callTool({ name: 'agent_create', arguments: { name: 'a', secretish: CANARY } });
    const text = await log.text();
    expect(text).toContain('secretish');
    expect(text).not.toContain(CANARY);
    await closeLogChannels();

    const control = installChannels({ redactor: identityRedactor });
    const client2 = await connect();
    await client2.callTool({ name: 'agent_create', arguments: { name: 'a', secretish: CANARY } });
    expect(await control.text()).toContain(CANARY);
  });
});

describe('c536ce29 W3-AC-A inert channel changes nothing', () => {
  it('c536ce29 W3-AC-A: with a noop channel the wrapper returns the handler result by identity and rethrows by identity', async () => {
    const result = { content: [{ type: 'text', text: 'x' }] };
    const ok = withApiLog(async (_r: { params: { name: string } }, _e: object) => result, noopLogChannel());
    expect(await ok({ params: { name: 't' } }, {})).toBe(result);
    const boom = new Error('b');
    const bad = withApiLog(async (_r: { params: { name: string } }, _e: object): Promise<never> => {
      throw boom;
    }, noopLogChannel());
    await expect(bad({ params: { name: 't' } }, {})).rejects.toBe(boom);
    expect(() => noteToolError(new Error('outside a call'))).not.toThrow();
  });

  it('c536ce29 W3-AC-A: tool results through the real server are identical with logging inert and logging on', async () => {
    const names = ['guide', 'agent_list', 'agent_create', 'no_such_tool'];
    const inertClient = await connect(); // no channels installed => inert
    const inert = await Promise.all(names.map((name) => inertClient.callTool({ name, arguments: {} })));
    installChannels();
    const liveClient = await connect();
    const live = await Promise.all(names.map((name) => liveClient.callTool({ name, arguments: {} })));
    expect(JSON.stringify(live)).toBe(JSON.stringify(inert));
  });

  it('c536ce29 W3-AC-A: the HTTP wrapper with a noop channel hands the listener the original req/res', () => {
    let seen: unknown[] = [];
    const wrapped = withHttpApiLog('t', (req, res) => {
      seen = [req, res];
    }, noopLogChannel());
    const req = { headers: {} } as http.IncomingMessage;
    const res = {} as http.ServerResponse;
    wrapped(req, res);
    expect(seen[0]).toBe(req);
    expect(seen[1]).toBe(res);
  });
});

async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe('c536ce29 TRC-AC24 HTTP route variants write raw inbound records', () => {
  it('c536ce29 TRC-AC24: the SSE/gateway routes log request + response; canaries in query, header and body never reach the file', async () => {
    const log = installChannels();
    const o = openDb();
    cleanups.push(() => o.sqlite.close());
    const started = await startSseServer(new TaskStore(o.db), 0, '127.0.0.1');
    cleanups.push(() => new Promise<void>((r) => started.server.close(() => r())));
    const base = `http://127.0.0.1:${started.port}`;

    const models = await fetch(`${base}/v1/models`, { headers: { 'x-canary': HEADER_CANARY } });
    expect(models.status).toBe(503);
    await models.text();
    const chat = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-canary': HEADER_CANARY },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: `hello ${CANARY}` }] }),
    });
    expect(chat.status).toBe(503);
    await chat.text();
    const missing = await fetch(`${base}/nope?key=${QUERY_CANARY}`);
    expect(missing.status).toBe(404);
    await missing.text();

    const inboundOf = async (): Promise<Rec[]> => (await log.records()).filter((r) => String(r.event).startsWith('http.inbound'));
    const deadline = Date.now() + 5000;
    while ((await inboundOf()).filter((r) => r.event === 'http.inbound.response').length < 3 && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    const recs = await inboundOf();
    const reqs = recs.filter((r) => r.event === 'http.inbound.request');
    const ress = recs.filter((r) => r.event === 'http.inbound.response');
    expect(reqs).toHaveLength(3);
    expect(ress).toHaveLength(3);
    expect(reqs.every((r) => r.route === 'sse-gateway')).toBe(true);
    const chatReq = reqs.find((r) => r.method === 'POST');
    expect(chatReq?.body).toContain('hello');
    expect(chatReq?.headers['x-canary']).toBeDefined();
    const missingReq = reqs.find((r) => String(r.url).includes('/nope'));
    expect(missingReq?.url).toContain('key=[REDACTED');
    const chatRes = ress.find((r) => r.call_id === chatReq?.call_id);
    expect(chatRes).toMatchObject({ status: 503 });
    expect(chatRes?.body).toContain('Gateway not yet initialized');

    const text = await log.text();
    for (const c of [CANARY, HEADER_CANARY, QUERY_CANARY]) expect(text).not.toContain(c);
    await closeLogChannels();

    const control = installChannels({ redactor: identityRedactor });
    const again = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-canary': HEADER_CANARY },
      body: JSON.stringify({ messages: [{ content: `hello ${CANARY}` }] }),
    });
    await again.text();
    const deadline2 = Date.now() + 5000;
    while (!(await control.text()).includes('http.inbound.response') && Date.now() < deadline2) {
      await new Promise((r) => setImmediate(r));
    }
    const ctl = await control.text();
    expect(ctl).toContain(CANARY);
    expect(ctl).toContain(HEADER_CANARY);
  });

  it('c536ce29 TRC-AC24: the streamable-HTTP MCP route logs the HTTP exchange and each tool call carries the mcp-session-id', async () => {
    const port = await freePort();
    // `env.config.transport` is resolved at module load: load a fresh module graph under the http env.
    const saved = { t: process.env.ADHD_AGENT_TRANSPORT, p: process.env.ADHD_AGENT_PORT, h: process.env.ADHD_AGENT_HOST };
    process.env.ADHD_AGENT_TRANSPORT = 'http';
    process.env.ADHD_AGENT_PORT = String(port);
    process.env.ADHD_AGENT_HOST = '127.0.0.1';
    vi.resetModules();
    const fresh = {
      server: await import('../server.js'),
      channels: await import('../wire/channels.js'),
      config: await import('../config.js'),
    };
    for (const [k, v] of [['ADHD_AGENT_TRANSPORT', saved.t], ['ADHD_AGENT_PORT', saved.p], ['ADHD_AGENT_HOST', saved.h]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    cleanups.push(() => fresh.channels.closeLogChannels());
    const root = mkdtempSync(join(tmpdir(), 'w3-api-http-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const roots = { root, api: join(root, 'api'), ops: join(root, 'ops'), trace: join(root, 'trace'), temp: join(root, 'tmp') };
    fresh.channels.initLogChannels({
      roots,
      logging: { ...fresh.config.env.config.logging, api: 'on' },
      knownSecrets: [CANARY, QUERY_CANARY],
      stderr: { write: () => undefined },
    });
    const readText = async (): Promise<string> => {
      await fresh.channels.getLogChannels().flush();
      return readdirSync(roots.api).filter((f) => f.endsWith('.jsonl')).map((f) => readFileSync(join(roots.api, f), 'utf8')).join('');
    };

    const started = await fresh.server.startServer(makeDeps());
    cleanups.push(() => started.close());
    expect(started.httpServer).toBeDefined();

    const client = new Client({ name: 'http-host', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/?key=${QUERY_CANARY}`));
    await client.connect(transport);
    cleanups.push(() => client.close());
    await client.callTool({ name: 'guide', arguments: {} });
    await client.callTool({ name: 'agent_create', arguments: { secretish: CANARY } });

    const sid = transport.sessionId;
    expect(sid).toEqual(expect.any(String));
    const text = await readText();
    const recs = text.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as Rec);
    const tool = recs.filter((r) => r.event === 'mcp.request' && (r.tool === 'guide' || r.tool === 'agent_create'));
    expect(tool).toHaveLength(2);
    expect(tool.every((r) => r.mcp_session_id === sid)).toBe(true);
    const inbound = recs.filter((r) => r.event === 'http.inbound.request' && r.route === 'mcp-http');
    expect(inbound.length).toBeGreaterThanOrEqual(3);
    expect(inbound.some((r) => r.mcp_session_id === sid)).toBe(true);
    expect(inbound.some((r) => String(r.body ?? '').includes('"initialize"'))).toBe(true);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(QUERY_CANARY);
  });
});
