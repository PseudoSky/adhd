/**
 * provider-selection-global.e2e.test.ts — 5ad2cf37 AC4 (D-G(2) global tier).
 *
 *   5ad2cf37 AC4 — an agent with no provider and a session with no binding resolves
 *                  from the host-wide default (ADHD_AGENT_DEFAULT_PROVIDER /
 *                  ADHD_AGENT_DEFAULT_MODEL -> EngineConfig.defaultSelection) and the
 *                  WIRE string reaches the model API.
 *
 * Own file: the default is read from process.env when the config singleton is first
 * imported, so it must be set before any import (vi.hoisted) and cannot share a file
 * with the AC2 "no default => fail closed" control.
 *
 * REAL: MCP Client <-> real createServer, real stores/migrations, real seeded registry,
 * real orchestrator + Anthropic SDK. Fake: the local stand-in for api.anthropic.com.
 */
import { vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  process.env['ADHD_AGENT_DEFAULT_PROVIDER'] = 'anthropic';
  process.env['ADHD_AGENT_DEFAULT_MODEL'] = 'claude_opus_4_8';
  process.env['ADHD_AGENT_ANTHROPIC_SECRET'] = 'sk-ant-api-e2e';
  return true;
});

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MIGRATIONS_FOLDER, runMigrationsOn } from '@adhd/agent-core-provider';
import { createProviderRegistry, seedProviderRegistry } from '@adhd/agent-engine-orchestrator';

import { buildHarness } from './harness.js';
import { createServer } from '../../server.js';

const FRAMES = [
  { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
];

afterAll(() => {
  for (const k of ['ADHD_AGENT_DEFAULT_PROVIDER', 'ADHD_AGENT_DEFAULT_MODEL', 'ADHD_AGENT_ANTHROPIC_SECRET', 'ANTHROPIC_BASE_URL']) {
    delete process.env[k];
  }
});

describe('5ad2cf37 AC4 — global tier', () => {
  it('a provider-less agent with no session binding runs on the host default, WIRE string sent', async () => {
    expect(hoisted).toBe(true);
    const models: string[] = [];
    const api = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        models.push((JSON.parse(body) as { model: string }).model);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const f of FRAMES) res.write(`event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`);
        res.end();
      });
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    process.env['ANTHROPIC_BASE_URL'] = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-selection-global-'));
    const rsql = new Database(path.join(tmp, 'registry.db'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rdb = drizzle(rsql) as any;
    runMigrationsOn(rsql, rdb, MIGRATIONS_FOLDER);
    seedProviderRegistry(rdb);

    const h = await buildHarness({ skipOrphanScan: true });
    const server = createServer({
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
      providerRegistry: createProviderRegistry(rdb),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 'global-tier-e2e', version: '0.0.1' }, { capabilities: {} });
    await client.connect(ct);

    const text = (r: { content?: Array<{ text?: string }> }): string => r.content?.[0]?.text ?? '';
    await client.callTool({ name: 'agent_create', arguments: { name: 'g', permissions: {} } });
    const { session_id } = JSON.parse(text(await client.callTool({ name: 'agent', arguments: { name: 'g' } }))) as { session_id: string };
    const out = JSON.parse(text(await client.callTool({ name: 'task', arguments: { session_id, prompt: 'ping' } }))) as { status: string };

    expect(out.status).toBe('completed');
    expect(models).toEqual(['claude-opus-4-8']);

    await client.close();
    await server.close();
    await h.teardown();
    rsql.close();
    await new Promise<void>((r) => api.close(() => r()));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
