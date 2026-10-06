/**
 * provider-selection.e2e.test.ts — 5ad2cf37 (D-G(2)): un-weld agent from provider,
 * session-held binding, resolveSelection, fail closed.
 *
 * The ticket's single AC sentence, split into numbered clauses:
 *   5ad2cf37 AC1 — agent with NO provider -> `session_update` via the MCP tool ->
 *                  `task`; the WIRE string `claude-sonnet-4-6` reaches the model API
 *                  (the canonical slug `claude_sonnet_4_6` must not).
 *   5ad2cf37 AC2 — negative control: without the session tier the task fails with
 *                  NO_PROVIDER_SELECTED — never a silent `claudecli`.
 *   5ad2cf37 AC3 — reopen-persistence: the binding survives a host restart (the SQLite
 *                  file reopened by a NEW store/server stack) and is read on the next task.
 *   (AC4, the global tier, is provider-selection-global.e2e.test.ts.)
 *
 * REAL: MCP Client <-> real createServer over an in-memory transport, real
 * better-sqlite3 file + real migrations (incl. 0011), real seeded provider registry
 * DB, real orchestrator + real AnthropicProvider + the real Anthropic SDK. The ONLY
 * fake is the external boundary: a local HTTP server standing in for api.anthropic.com
 * that records the request body's `model`.
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { MIGRATIONS_FOLDER, runMigrationsOn } from '@adhd/agent-core-provider';
import {
  createProviderRegistry,
  seedProviderRegistry,
  type ProviderRegistry,
} from '@adhd/agent-engine-orchestrator';

import { buildHarness, type Harness } from './harness.js';
import { createServer } from '../../server.js';

const SSE_FRAMES = [
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }],
  ['message_stop', { type: 'message_stop' }],
] as const;

interface MockAnthropic {
  models: string[];
  close: () => Promise<void>;
  url: string;
}

async function startMockAnthropic(): Promise<MockAnthropic> {
  const models: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        models.push((JSON.parse(body) as { model: string }).model);
      } catch {
        models.push('<unparseable>');
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [event, data] of SSE_FRAMES) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    models,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function parse<T>(result: { content?: Array<{ type: string; text?: string }>; isError?: boolean }): T {
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) throw new Error(text);
  return JSON.parse(text) as T;
}

let tmp: string;
let mock: MockAnthropic;
let registry: ProviderRegistry;
let registrySqlite: Database.Database;
const savedEnv: Record<string, string | undefined> = {};
const open: Array<() => Promise<void>> = [];

async function connect(h: Harness): Promise<Client> {
  const server: Server = createServer({
    agentStore: h.agentStore,
    sessionStore: h.sessionStore,
    taskStore: h.taskStore,
    queue: h.queue,
    policy: h.policy,
    orchestrator: h.orchestrator,
    hooks: h.hooks,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: h.db as any,
    dagEngine: h.dagEngine,
    providerRegistry: registry,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'provider-selection-e2e', version: '0.0.1' }, { capabilities: {} });
  await client.connect(ct);
  open.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-selection-e2e-'));
  mock = await startMockAnthropic();
  for (const k of ['ADHD_AGENT_ANTHROPIC_SECRET', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY']) {
    savedEnv[k] = process.env[k];
  }
  process.env['ADHD_AGENT_ANTHROPIC_SECRET'] = 'sk-ant-api-e2e';
  process.env['ANTHROPIC_BASE_URL'] = mock.url;

  registrySqlite = new Database(path.join(tmp, 'registry.db'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rdb = drizzle(registrySqlite) as any;
  runMigrationsOn(registrySqlite, rdb, MIGRATIONS_FOLDER);
  seedProviderRegistry(rdb);
  registry = createProviderRegistry(rdb);
});

afterEach(async () => {
  while (open.length) await open.pop()?.();
  await mock.close();
  registrySqlite.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function bootHarness(dbPath: string): Promise<Harness> {
  return buildHarness({ dbPath, skipOrphanScan: true });
}

describe('5ad2cf37 — provider-less agent, session-held binding, fail closed', () => {
  it('AC1+AC3: agent_create(no provider) -> agent -> session_update -> restart -> task sends the WIRE string', async () => {
    const dbPath = path.join(tmp, 'agent-mcp.db');
    const first = await bootHarness(dbPath);
    const c1 = await connect(first);

    parse(await c1.callTool({ name: 'agent_create', arguments: { name: 'unwelded', permissions: {}, systemPrompt: 'be brief' } }));
    const { session_id } = parse<{ session_id: string }>(await c1.callTool({ name: 'agent', arguments: { name: 'unwelded' } }));
    const updated = parse<{ selection: { providerType: string; modelRef: string } }>(
      await c1.callTool({ name: 'session_update', arguments: { session_id, provider: 'anthropic', model: 'claude_sonnet_4_6' } })
    );
    expect(updated.selection).toEqual({ providerType: 'anthropic', modelRef: 'claude_sonnet_4_6' });

    // Host restart: close every handle on the first stack; a NEW store/server stack
    // reopens the SAME sqlite file — the file is the only carried state.
    while (open.length) await open.pop()?.();
    first.rawSqlite.pragma('wal_checkpoint(TRUNCATE)');
    first.rawSqlite.close();

    const second = await bootHarness(dbPath);
    const c2 = await connect(second);
    expect(second.sessionStore.getSelection(session_id)).toEqual({
      providerType: 'anthropic',
      modelRef: 'claude_sonnet_4_6',
    });
    const out = parse<{ status: string; result?: string }>(
      await c2.callTool({ name: 'task', arguments: { session_id, prompt: 'ping' } })
    );
    expect(out.status).toBe('completed');
    expect(out.result).toBe('pong');
    // The consumer-visible outcome: the model API saw the WIRE string.
    expect(mock.models).toEqual(['claude-sonnet-4-6']);
    await second.teardown();
  });

  it('AC2 (negative control): no session binding -> NO_PROVIDER_SELECTED, no model call, never claudecli', async () => {
    const h = await bootHarness(path.join(tmp, 'agent-mcp.db'));
    const c = await connect(h);
    parse(await c.callTool({ name: 'agent_create', arguments: { name: 'unwelded', permissions: {} } }));
    const { session_id } = parse<{ session_id: string }>(await c.callTool({ name: 'agent', arguments: { name: 'unwelded' } }));

    const res = await c.callTool({ name: 'task', arguments: { session_id, prompt: 'ping' } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('NO_PROVIDER_SELECTED');
    expect(mock.models).toEqual([]);
    // fail closed BEFORE any task row exists
    expect(h.taskStore.list({} as never)).toHaveLength(0);
    await h.teardown();
  });

  it('session_update rejects an empty update and a closed session', async () => {
    const h = await bootHarness(path.join(tmp, 'agent-mcp.db'));
    const c = await connect(h);
    parse(await c.callTool({ name: 'agent_create', arguments: { name: 'unwelded', permissions: {} } }));
    const { session_id } = parse<{ session_id: string }>(await c.callTool({ name: 'agent', arguments: { name: 'unwelded' } }));
    const empty = await c.callTool({ name: 'session_update', arguments: { session_id } });
    expect(empty.isError).toBe(true);
    await c.callTool({ name: 'session_close', arguments: { session_id } });
    const closed = await c.callTool({ name: 'session_update', arguments: { session_id, model: 'x' } });
    expect(closed.isError).toBe(true);
    expect(JSON.stringify(closed.content)).toContain('is closed');
    await h.teardown();
  });
});
