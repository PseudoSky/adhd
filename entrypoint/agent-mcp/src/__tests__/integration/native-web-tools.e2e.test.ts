/**
 * Provider-native web tools in the default dispatched-agent toolset
 * (backlog 1abd2d84).
 *
 * AC1: a dispatched agent can run a real web search/fetch — provable through
 *      the REAL agent-mcp surface. The `task` tool is invoked over a real
 *      in-memory MCP transport against the real orchestrator + real Anthropic
 *      provider; the captured Anthropic request carries the type-tagged
 *      server-side `web_search`/`web_fetch` entries, and the provider's
 *      inline result flows back as the task result. The only mocked boundary
 *      is the Anthropic SDK itself (the paid external service).
 *
 * Negative control: `nativeWebTools:false` removes them from the request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import { buildHarness, type Harness } from './harness.js';
import { createServer } from '../../server.js';

// ---------------------------------------------------------------------------
// Anthropic SDK boundary (the only mock)
// ---------------------------------------------------------------------------

interface CapturedRequest {
  tools?: Array<Record<string, unknown>>;
}

const h = vi.hoisted(() => ({
  lastRequest: undefined as CapturedRequest | undefined,
  respond: undefined as
    | undefined
    | (() => {
        content: Array<Record<string, unknown>>;
        stop_reason: string;
        usage: Record<string, number>;
      }),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_opts: any) {
      /* no-op */
    }
    messages = {
      stream: (req: CapturedRequest) => {
        h.lastRequest = req;
        return {
          finalMessage: async () =>
            h.respond
              ? h.respond()
              : {
                  content: [{ type: 'text', text: 'no-web-tools' }],
                  stop_reason: 'end_turn',
                  usage: { input_tokens: 10, output_tokens: 5 },
                },
        };
      },
    };
  }
  return { default: FakeAnthropic };
});

// ---------------------------------------------------------------------------
// MCP plumbing
// ---------------------------------------------------------------------------

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
    { name: 'native-web-e2e', version: '0.0.1' },
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

function createAnthropicAgent(
  harness: Harness,
  name: string,
  nativeWebTools?: boolean
): void {
  harness.agentStore.create({
    name,
    provider: {
      type: 'anthropic',
      model: 'claude-sonnet-4-6',
      env: { secret: 'ADHD_AGENT_ANTHROPIC_SECRET' },
    },
    systemPrompt: 'You are a test agent.',
    mcpServers: {},
    permissions: {},
    ...(nativeWebTools !== undefined ? { nativeWebTools } : {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

function serverSideNames(req: CapturedRequest | undefined): string[] {
  return (req?.tools ?? [])
    .filter((t) => typeof t['type'] === 'string' && !('input_schema' in t))
    .map((t) => String(t['name']));
}

describe('native web tools in the default toolset (1abd2d84)', () => {
  let harness: Harness | undefined;
  let close: (() => Promise<void>) | undefined;
  const prevSecret = process.env['ADHD_AGENT_ANTHROPIC_SECRET'];

  beforeEach(() => {
    process.env['ADHD_AGENT_ANTHROPIC_SECRET'] = 'sk-ant-api-test-fake';
    h.lastRequest = undefined;
    h.respond = undefined;
  });

  afterEach(async () => {
    await close?.();
    close = undefined;
    await harness?.teardown();
    harness = undefined;
    if (prevSecret === undefined) delete process.env['ADHD_AGENT_ANTHROPIC_SECRET'];
    else process.env['ADHD_AGENT_ANTHROPIC_SECRET'] = prevSecret;
  });

  it('AC1: a dispatched Anthropic agent advertises web_search + web_fetch and returns the inline result', async () => {
    harness = await buildHarness({ skipOrphanScan: true });
    const conn = await connectMcp(harness);
    close = conn.close;
    createAnthropicAgent(harness, 'web-agent');

    h.respond = () => ({
      content: [{ type: 'text', text: 'web result: 42' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 20, output_tokens: 7 },
    });

    const out = parse<{ status: string; result?: string }>(
      await conn.client.callTool({
        name: 'task',
        arguments: { agent_name: 'web-agent', prompt: 'search the web for 42' },
      })
    );

    // The request the REAL Anthropic provider built carries the server-side
    // web tools (type-tagged, no input_schema).
    const names = serverSideNames(h.lastRequest);
    expect(names).toContain('web_search');
    expect(names).toContain('web_fetch');
    const search = (h.lastRequest?.tools ?? []).find(
      (t) => t['name'] === 'web_search'
    );
    expect(search?.['type']).toBe('web_search_20250305');

    // And the provider's inline (server-executed) result is the task result.
    expect(out.status).toBe('completed');
    expect(out.result).toContain('web result: 42');
  });

  it('NEGATIVE CONTROL: nativeWebTools:false removes the server-side web tools', async () => {
    harness = await buildHarness({ skipOrphanScan: true });
    const conn = await connectMcp(harness);
    close = conn.close;
    createAnthropicAgent(harness, 'no-web-agent', false);

    h.respond = () => ({
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 },
    });

    await conn.client.callTool({
      name: 'task',
      arguments: { agent_name: 'no-web-agent', prompt: 'hi' },
    });

    expect(serverSideNames(h.lastRequest)).toEqual([]);
  });
});
