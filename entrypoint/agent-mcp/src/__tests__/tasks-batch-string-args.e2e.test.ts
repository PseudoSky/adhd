/**
 * tasks_batch string-typed arguments (backlog 932604a0 / plan f52586fc R9).
 *
 * Drives the REAL agent-mcp MCP server through a real MCP client over the
 * SDK's in-memory transport (same JSON-RPC path a host uses) against the real
 * stores/queue/orchestrator from `integration/harness.ts`. The only scripted
 * boundary is the LLM provider. Sends the exact R4 C1 argument shape: a numeric
 * string `concurrency` and a stringified-JSON `prompts` array.
 *
 * AC coverage: R9.AC4 (end to end, concurrency 2 reaches tasksBatch and the
 * decoded array is dispatched), R9.AC5 (tools/list still advertises integer /
 * array), R9.AC3 (malformed input is still an error through the real server),
 * R9.AC6 (e2e case).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { LLMProvider, ProviderChatResponse } from '@adhd/agent-engine-orchestrator';
import { generateId, nowIso } from '@adhd/agent-store-runtime';

import { buildHarness, type Harness } from './integration/harness.js';
import { createServer } from '../server.js';

const provider: LLMProvider = {
  chat: async (): Promise<ProviderChatResponse> => ({
    message: {
      id: generateId(),
      sessionId: '',
      role: 'assistant',
      content: 'done',
      createdAt: nowIso(),
    },
    stopReason: 'completed',
  }),
};

describe('932604a0 R9 tasks_batch string-typed arguments (real MCP client)', () => {
  let harness: Harness | undefined;
  let server: Server | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await server?.close();
    await harness?.teardown();
    client = undefined;
    server = undefined;
    harness = undefined;
  });

  async function connect(): Promise<Client> {
    harness = await buildHarness({ defaultProvider: provider });
    harness.agentStore.create({
      name: 'worker',
      provider: { type: 'openai', model: 'test-model', baseURL: 'http://localhost:1234/v1' },
      systemPrompt: 'You are a test assistant.',
      mcpServers: {},
      permissions: {},
      nativeTooling: { fs: false, shell: false, dispatch: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    server = createServer({
      agentStore: harness.agentStore,
      sessionStore: harness.sessionStore,
      taskStore: harness.taskStore,
      queue: harness.queue,
      policy: harness.policy,
      orchestrator: harness.orchestrator,
      hooks: harness.hooks,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: harness.db as any,
      dagEngine: harness.dagEngine,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: 'tasks-batch-string-args', version: '0.0.1' }, { capabilities: {} });
    await client.connect(ct);
    return client;
  }

  it('932604a0 R9.AC4/AC6: the R4 C1 shape (concurrency "2", stringified prompts) is not an error', async () => {
    const c = await connect();
    const res = await c.callTool({
      name: 'tasks_batch',
      arguments: {
        agent_name: 'worker',
        concurrency: '2',
        prompts: '["first task","second task","third task"]',
      },
    });
    const text = (res.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(res.isError, text).toBeFalsy();
    const out = JSON.parse(text) as {
      concurrency: number;
      results: Array<{ index: number; status: string }>;
    };
    expect(out.concurrency).toBe(2);
    expect(out.results).toHaveLength(3);
    expect(out.results.every((r) => r.status === 'completed')).toBe(true);
  });

  it('932604a0 R9.AC3: malformed stringified prompts is still an error through the real server', async () => {
    const c = await connect();
    const res = await c.callTool({
      name: 'tasks_batch',
      arguments: { agent_name: 'worker', concurrency: 'abc', prompts: 'not json' },
    });
    expect(res.isError).toBe(true);
  });

  it('932604a0 R9.AC5: tools/list still advertises concurrency as integer and prompts as array', async () => {
    const c = await connect();
    const tool = (await c.listTools()).tools.find((t) => t.name === 'tasks_batch');
    const props = (tool?.inputSchema as { properties: Record<string, { type?: string }> }).properties;
    expect(props['concurrency']?.type).toBe('integer');
    expect(props['prompts']?.type).toBe('array');
  });
});
