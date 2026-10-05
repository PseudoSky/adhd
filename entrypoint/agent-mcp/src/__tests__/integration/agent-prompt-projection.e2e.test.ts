/**
 * agent-prompt-projection.e2e.test.ts — acceptance: "MCP tools may not dump
 * full records of system prompts for agents — a full record must be EXPLICITLY
 * requested."
 *
 * Drives the REAL agent-mcp MCP surface (a real MCP `Client` over an in-memory
 * transport talking to the real `createServer`) against the REAL harness
 * (real better-sqlite3 store, real migrations). The only fakes are the
 * LLM provider / external MCP clients the shared harness already stubs — none
 * of them are on this read path.
 *
 * Teeth: the default `systemPrompt` assertions fail if the projection is
 * reverted to identity (the multi-KB body reappears in the response).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import { buildHarness, type Harness } from './harness.js';
import { createServer } from '../../server.js';

const PROMPT = 'P'.repeat(4096); // deliberately multi-KB

async function connectMcp(harness: Harness): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server: Server = createServer({
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
    { name: 'agent-prompt-projection-e2e', version: '0.0.1' },
    { capabilities: {} }
  );
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function parse<T>(result: {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}): T {
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) throw new Error(text);
  return JSON.parse(text) as T;
}

describe('agent_read / agent_list never dump systemPrompt by default', () => {
  let harness: Harness | undefined;
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
    await harness?.teardown();
    harness = undefined;
  });

  async function seed(client: Client): Promise<void> {
    await client.callTool({
      name: 'agent_create',
      arguments: {
        name: 'projection-agent',
        provider: { type: 'openai', model: 'test-model' },
        systemPrompt: PROMPT,
        permissions: {},
      },
    });
  }

  it('agent_create does not echo the systemPrompt back', async () => {
    harness = await buildHarness();
    const conn = await connectMcp(harness);
    close = conn.close;

    const created = parse<Record<string, unknown>>(
      await conn.client.callTool({
        name: 'agent_create',
        arguments: {
          name: 'create-echo-agent',
          provider: { type: 'openai', model: 'test-model' },
          systemPrompt: PROMPT,
          permissions: {},
        },
      })
    );

    expect(created['name']).toBe('create-echo-agent');
    expect(created).not.toHaveProperty('systemPrompt');
    expect(JSON.stringify(created)).not.toContain(PROMPT);
  });

  it('agent_read default omits systemPrompt but keeps the identifying/config fields', async () => {
    harness = await buildHarness();
    const conn = await connectMcp(harness);
    close = conn.close;
    await seed(conn.client);

    const read = parse<Record<string, unknown>>(
      await conn.client.callTool({
        name: 'agent_read',
        arguments: { name: 'projection-agent' },
      })
    );

    expect(read).not.toHaveProperty('systemPrompt');
    expect(JSON.stringify(read)).not.toContain(PROMPT);
    // Backward-compatible: the non-prompt fields a consumer reads are present.
    expect(read['name']).toBe('projection-agent');
    expect(read['provider']).toMatchObject({ type: 'openai', model: 'test-model' });
    expect(read['version']).toBe(1);
    expect(read['mcpServers']).toBeDefined();
    expect(read['createdAt']).toBeTypeOf('string');
  });

  it('agent_read full:true explicitly returns the systemPrompt', async () => {
    harness = await buildHarness();
    const conn = await connectMcp(harness);
    close = conn.close;
    await seed(conn.client);

    const read = parse<Record<string, unknown>>(
      await conn.client.callTool({
        name: 'agent_read',
        arguments: { name: 'projection-agent', full: true },
      })
    );
    expect(read['systemPrompt']).toBe(PROMPT);
  });

  it("agent_read fields:['systemPrompt'] explicitly returns the body", async () => {
    harness = await buildHarness();
    const conn = await connectMcp(harness);
    close = conn.close;
    await seed(conn.client);

    const read = parse<Record<string, unknown>>(
      await conn.client.callTool({
        name: 'agent_read',
        arguments: { name: 'projection-agent', fields: ['systemPrompt'] },
      })
    );
    expect(read).toEqual({ name: 'projection-agent', systemPrompt: PROMPT });
  });

  it('agent_update default omits systemPrompt and preserves openSessionsNotUpdated', async () => {
    harness = await buildHarness();
    const conn = await connectMcp(harness);
    close = conn.close;
    await seed(conn.client);

    const updated = parse<Record<string, unknown>>(
      await conn.client.callTool({
        name: 'agent_update',
        arguments: {
          name: 'projection-agent',
          patch: { description: 'updated' },
        },
      })
    );

    expect(updated).not.toHaveProperty('systemPrompt');
    expect(JSON.stringify(updated)).not.toContain(PROMPT);
    expect(updated['openSessionsNotUpdated']).toEqual([]);
    expect(updated['description']).toBe('updated');
  });

  it('agent_update full:true explicitly returns the systemPrompt', async () => {
    harness = await buildHarness();
    const conn = await connectMcp(harness);
    close = conn.close;
    await seed(conn.client);

    const updated = parse<Record<string, unknown>>(
      await conn.client.callTool({
        name: 'agent_update',
        arguments: {
          name: 'projection-agent',
          patch: { description: 'updated' },
          full: true,
        },
      })
    );
    expect(updated['systemPrompt']).toBe(PROMPT);
  });

  it('agent_list default omits systemPrompt for every record', async () => {
    harness = await buildHarness();
    const conn = await connectMcp(harness);
    close = conn.close;
    await seed(conn.client);

    const list = parse<Array<Record<string, unknown>>>(
      await conn.client.callTool({ name: 'agent_list', arguments: {} })
    );
    expect(list).toHaveLength(1);
    for (const record of list) {
      expect(record).not.toHaveProperty('systemPrompt');
      expect(record['name']).toBe('projection-agent');
    }
    expect(JSON.stringify(list)).not.toContain(PROMPT);
  });

  it('agent_list full:true explicitly returns the systemPrompt', async () => {
    harness = await buildHarness();
    const conn = await connectMcp(harness);
    close = conn.close;
    await seed(conn.client);

    const list = parse<Array<Record<string, unknown>>>(
      await conn.client.callTool({
        name: 'agent_list',
        arguments: { full: true },
      })
    );
    expect(list).toHaveLength(1);
    expect(list[0]?.['systemPrompt']).toBe(PROMPT);
  });

  it('advertises the opt-in in the agent_read / agent_list tool schemas', async () => {
    harness = await buildHarness();
    const conn = await connectMcp(harness);
    close = conn.close;

    const tools = await conn.client.listTools();
    const read = tools.tools.find((t) => t.name === 'agent_read');
    const update = tools.tools.find((t) => t.name === 'agent_update');
    const list = tools.tools.find((t) => t.name === 'agent_list');

    const readProps = (read?.inputSchema.properties ?? {}) as Record<string, unknown>;
    const updateProps = (update?.inputSchema.properties ?? {}) as Record<string, unknown>;
    const listProps = (list?.inputSchema.properties ?? {}) as Record<string, unknown>;
    expect(readProps).toHaveProperty('full');
    expect(readProps).toHaveProperty('fields');
    expect(updateProps).toHaveProperty('full');
    expect(updateProps).toHaveProperty('fields');
    expect(listProps).toHaveProperty('full');
    expect(listProps).toHaveProperty('fields');
    // The descriptions state the opt-in so an agent knows the body is gated.
    expect(read?.description ?? '').toContain('systemPrompt');
    expect(update?.description ?? '').toContain('systemPrompt');
    expect(list?.description ?? '').toContain('systemPrompt');
  });
});
