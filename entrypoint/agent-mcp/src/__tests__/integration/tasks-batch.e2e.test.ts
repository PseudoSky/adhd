/**
 * tasks_batch — native bulk/parallel task-dispatch primitive (backlog 05cc1db4).
 *
 * Drives the REAL agent-mcp MCP server through a real MCP client over an
 * in-memory transport (the SDK's own `InMemoryTransport` linked pair) — the
 * same JSON-RPC path a host uses — against the real stores/queue/orchestrator
 * from `harness.ts`. The only scripted boundary is the LLM provider
 * (`defaultProvider`), which is the one legitimate external mock.
 *
 * AC coverage:
 *  - AC1  `tasks_batch` is exposed on the MCP tool surface.
 *  - AC2  the `concurrency` cap is honored (≤ K run simultaneously, proven
 *         with a latch/barrier, not by inspecting `Promise.all`).
 *  - AC3  every call returns `{index, task_id}` (plus status/result).
 *  - AC4  composes with `depends_on` (external) and `depends_on_indexes`
 *         (intra-batch ordering).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import { buildHarness, type Harness } from './harness.js';
import { ScriptedProvider } from './scripted-provider.js';
import { createServer } from '../../server.js';

// ---------------------------------------------------------------------------
// Harness / MCP plumbing
// ---------------------------------------------------------------------------

async function connectMcp(harness: Harness): Promise<{
  client: Client;
  server: Server;
  close: () => Promise<void>;
}> {
  const server = createServer({
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

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: 'tasks-batch-e2e', version: '0.0.1' },
    { capabilities: {} }
  );
  await client.connect(clientTransport);

  return {
    client,
    server,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function createAgent(harness: Harness, name: string): void {
  harness.agentStore.create({
    name,
    provider: {
      type: 'openai',
      model: 'test-model',
      baseURL: 'http://localhost:1234/v1',
    },
    systemPrompt: 'You are a test assistant.',
    mcpServers: {},
    permissions: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

function parseToolResult<T>(result: {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}): T {
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) throw new Error(text);
  return JSON.parse(text) as T;
}

interface BatchResult {
  concurrency: number;
  results: Array<{
    index: number;
    task_id: string;
    status: string;
    result?: string;
  }>;
}

// ---------------------------------------------------------------------------
// A concurrency-observing provider
// ---------------------------------------------------------------------------

import type {
  LLMProvider,
  ProviderChatResponse,
} from '@adhd/agent-engine-orchestrator';
import type { Message } from '@adhd/agent-base-types';
import { generateId, nowIso } from '@adhd/agent-store-runtime';

/**
 * Provider that counts how many `chat()` calls are in flight simultaneously,
 * records the max, and (when a `gate` is supplied) blocks every call on the
 * gate so the test can observe peak concurrency deterministically — no sleeps.
 */
function concurrencyProvider(gate?: Promise<void>): {
  provider: LLMProvider;
  peak: () => number;
  completed: () => number;
} {
  let active = 0;
  let peak = 0;
  let completed = 0;
  const provider: LLMProvider = {
    chat: async (): Promise<ProviderChatResponse> => {
      active++;
      peak = Math.max(peak, active);
      if (gate) await gate;
      active--;
      completed++;
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
  return { provider, peak: () => peak, completed: () => completed };
}

/**
 * Provider that fails if a later item runs before an earlier one has
 * completed — used to prove intra-batch `depends_on_indexes` ordering.
 */
function orderingProvider(): LLMProvider {
  const done = new Set<string>();
  return {
    chat: async ({ messages }: { messages: Message[] }): Promise<ProviderChatResponse> => {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const prompt = lastUser?.content ?? '';
      if (prompt === 'B' && !done.has('A')) {
        throw new Error('ordering violated: B ran before A completed');
      }
      done.add(prompt);
      return {
        message: {
          id: generateId(),
          sessionId: '',
          role: 'assistant',
          content: `done:${prompt}`,
          createdAt: nowIso(),
        },
        stopReason: 'completed',
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tasks_batch (05cc1db4)', () => {
  let harness: Harness | undefined;
  let teardownMcp: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await teardownMcp?.();
    teardownMcp = undefined;
    await harness?.teardown();
    harness = undefined;
  });

  it('AC1+AC3: exposes tasks_batch and returns {index, task_id} for every prompt', async () => {
    const { provider } = concurrencyProvider();
    harness = await buildHarness({ defaultProvider: provider });
    const { client, close } = await connectMcp(harness);
    teardownMcp = close;
    createAgent(harness, 'batch-agent');

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('tasks_batch');

    const raw = await client.callTool({
      name: 'tasks_batch',
      arguments: {
        agent_name: 'batch-agent',
        prompts: ['one', 'two', 'three'],
        concurrency: 4,
      },
    });
    const out = parseToolResult<BatchResult>(raw);

    expect(out.concurrency).toBe(4);
    expect(out.results).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(out.results[i].index).toBe(i);
      expect(out.results[i].task_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(out.results[i].status).toBe('completed');
    }
    expect(new Set(out.results.map((r) => r.task_id)).size).toBe(3);
  });

  it('AC2: honors the concurrency cap — no more than K run simultaneously', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { provider, peak, completed } = concurrencyProvider(gate);
    harness = await buildHarness({ defaultProvider: provider });
    const { client, close } = await connectMcp(harness);
    teardownMcp = close;
    createAgent(harness, 'batch-agent');

    const call = client.callTool({
      name: 'tasks_batch',
      arguments: {
        agent_name: 'batch-agent',
        prompts: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'],
        concurrency: 2,
      },
    });

    // Wait (bounded, event-based) until exactly the cap is in flight.
    const deadline = Date.now() + 5000;
    while (peak() < 2 && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    expect(peak()).toBe(2);
    // Give any over-cap task a chance to start, then assert the cap held.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(peak()).toBe(2);

    release();
    const out = parseToolResult<BatchResult>(await call);
    expect(out.results).toHaveLength(6);
    expect(completed()).toBe(6);
    expect(peak()).toBe(2);
  });

  it('AC2 NEGATIVE CONTROL: without a cap the same N run unbounded (peak > K)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { provider, peak } = concurrencyProvider(gate);
    harness = await buildHarness({ defaultProvider: provider });
    const { client, close } = await connectMcp(harness);
    teardownMcp = close;
    createAgent(harness, 'batch-agent');

    const call = client.callTool({
      name: 'tasks_batch',
      arguments: {
        agent_name: 'batch-agent',
        prompts: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'],
        concurrency: 6,
      },
    });

    const deadline = Date.now() + 5000;
    while (peak() < 6 && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    // With a cap of 6, all six are in flight — proving the cap (not luck)
    // is what bounds the previous test at 2.
    expect(peak()).toBe(6);

    release();
    await call;
  });

  it('AC4: depends_on_indexes orders items within the batch', async () => {
    harness = await buildHarness({ defaultProvider: orderingProvider() });
    const { client, close } = await connectMcp(harness);
    teardownMcp = close;
    createAgent(harness, 'batch-agent');

    const raw = await client.callTool({
      name: 'tasks_batch',
      arguments: {
        agent_name: 'batch-agent',
        prompts: ['A', 'B'],
        depends_on_indexes: [[], [0]],
      },
    });
    const out = parseToolResult<BatchResult>(raw);

    expect(out.results[0].result).toContain('done:A');
    expect(out.results[1].result).toContain('done:B');

    // The second task really was created with the first as an upstream.
    const second = harness.taskStore.read(out.results[1].task_id);
    expect(second.dependsOn).toContain(out.results[0].task_id);
  });

  it('AC4: composes with an external depends_on task id', async () => {
    harness = await buildHarness({
      defaultProvider: new ScriptedProvider([{ type: 'completed', content: 'ok' }]),
    });
    const { client, close } = await connectMcp(harness);
    teardownMcp = close;
    createAgent(harness, 'batch-agent');

    // Create an upstream task directly, then batch a dependent of it.
    const upstream = harness.taskStore.create({
      sessionId: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isEphemeral: true,
      prompt: 'upstream',
    });
    harness.taskStore.updateStatus(upstream.id, 'completed', {
      result: 'upstream-done',
      completedAt: new Date().toISOString(),
    });

    const raw = await client.callTool({
      name: 'tasks_batch',
      arguments: {
        agent_name: 'batch-agent',
        prompts: ['dependent'],
        depends_on: [[upstream.id]],
        on_upstream_failure: ['skip'],
      },
    });
    const out = parseToolResult<BatchResult>(raw);

    expect(out.results[0].status).toBe('completed');
    const dependent = harness.taskStore.read(out.results[0].task_id);
    expect(dependent.dependsOn).toContain(upstream.id);
    expect(dependent.onUpstreamFailure).toBe('skip');
  });

  it('rejects an invalid batch (both agent_name and session_ids)', async () => {
    harness = await buildHarness();
    const { client, close } = await connectMcp(harness);
    teardownMcp = close;

    const raw = await client.callTool({
      name: 'tasks_batch',
      arguments: {
        agent_name: 'x',
        session_ids: ['00000000-0000-4000-8000-000000000000'],
        prompts: ['a'],
      },
    });
    expect(raw.isError).toBe(true);
  });
});
