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
import type {
  LLMProvider,
  ProviderChatRequest,
  ProviderChatResponse,
} from '@adhd/agent-engine-orchestrator';
import { generateId, nowIso } from '@adhd/agent-store-runtime';

import { buildHarness, type Harness } from './integration/harness.js';
import { createServer } from '../server.js';

/**
 * Scripted provider that records the last user prompt of every `chat()` call,
 * tracks in-flight calls and their peak, and (when a gate is supplied) parks
 * every call on the gate so the test observes the concurrency cap
 * deterministically (latch, no sleeps).
 */
function recordingProvider(gate?: Promise<void>): {
  provider: LLMProvider;
  prompts: string[];
  peak: () => number;
} {
  const prompts: string[] = [];
  let active = 0;
  let peak = 0;
  const provider: LLMProvider = {
    chat: async ({ messages }: ProviderChatRequest): Promise<ProviderChatResponse> => {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      prompts.push(lastUser?.content ?? '');
      active++;
      peak = Math.max(peak, active);
      if (gate) await gate;
      active--;
      return {
        message: {
          id: generateId(),
          sessionId: '',
          role: 'assistant',
          content: 'done',
          createdAt: nowIso(),
        },
        stopReason: 'completed',
      };
    },
  };
  return { provider, prompts, peak: () => peak };
}

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

  async function connect(provider: LLMProvider): Promise<Client> {
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

  it('932604a0 R9.AC4/AC6: the R4 C1 shape dispatches the three decoded prompts with the cap of 2 enforced', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { provider, prompts, peak } = recordingProvider(gate);
    const c = await connect(provider);
    const call = c.callTool({
      name: 'tasks_batch',
      arguments: {
        agent_name: 'worker',
        concurrency: '2',
        prompts: '["first task","second task","third task"]',
      },
    });

    // Wait (bounded, event-based) until the cap is reached, then give an
    // over-cap task every chance to start before asserting it did not.
    const deadline = Date.now() + 5000;
    while (peak() < 2 && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    expect(peak()).toBe(2);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(peak()).toBe(2);
    expect(prompts).toHaveLength(2);

    release();
    const res = await call;
    const text = (res.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(res.isError, text).toBeFalsy();
    const out = JSON.parse(text) as {
      concurrency: number;
      results: Array<{ index: number; status: string }>;
    };
    expect(out.concurrency).toBe(2);
    expect(out.results).toHaveLength(3);
    expect(out.results.every((r) => r.status === 'completed')).toBe(true);
    expect(peak()).toBe(2);
    expect([...prompts].sort()).toEqual(['first task', 'second task', 'third task']);
  });

  it('932604a0 R9.AC3: a non-numeric concurrency string is an error naming concurrency (prompts valid)', async () => {
    const { provider } = recordingProvider();
    const c = await connect(provider);
    const res = await c.callTool({
      name: 'tasks_batch',
      arguments: { agent_name: 'worker', concurrency: 'abc', prompts: ['p'] },
    });
    const text = (res.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(res.isError).toBe(true);
    expect(text).toContain('concurrency must be an integer or an integer string');
  });

  it('932604a0 R9.AC3: malformed stringified prompts is an error naming prompts (concurrency valid)', async () => {
    const { provider } = recordingProvider();
    const c = await connect(provider);
    const res = await c.callTool({
      name: 'tasks_batch',
      arguments: { agent_name: 'worker', concurrency: '2', prompts: 'not json' },
    });
    const text = (res.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(res.isError).toBe(true);
    expect(text).toContain('prompts must be an array or a JSON-array string');
  });

  it('932604a0 R9.AC5: tools/list still advertises concurrency as integer and prompts as array', async () => {
    const c = await connect(recordingProvider().provider);
    const tool = (await c.listTools()).tools.find((t) => t.name === 'tasks_batch');
    const props = (tool?.inputSchema as { properties: Record<string, { type?: string }> }).properties;
    expect(props['concurrency']?.type).toBe('integer');
    expect(props['prompts']?.type).toBe('array');
  });
});
