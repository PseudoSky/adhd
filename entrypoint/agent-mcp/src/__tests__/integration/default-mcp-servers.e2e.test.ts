/**
 * NAT-TOOL-4 — the REAL agent-mcp host consumes `resolveNativeTooling`
 * (ADR-0008 D1/D4). Replaces the retired definition-creation-time defaults
 * (`buildDefaultMcpServers` / `withDefaultMcpServers`, backlog 97acef07).
 *
 * AC1: the host resolves an agent's `nativeTooling` at VERIFY/task time against
 *      the dispatching cwd — the `agent_verify_mcp` surface sees the resolved
 *      toolset (with the `agent-mcp` dispatch floor skipped in-process).
 * AC2: an explicit `mcpServers` map is preserved and wins for its own name.
 * AC3: the STORED definition carries only declarative `nativeTooling` — no
 *      resolved root is baked in, so the same definition fired from `/P` then
 *      `/Q` yields each root while the stored JSON stays byte-identical.
 *
 * Drives the real server over an in-memory MCP client transport; the only
 * fakes are the orchestrator provider (via the shared harness) — no external
 * process is spawned (the resolved builtins are asserted via the pure resolver
 * and the spawn-free `agent-mcp` dispatch floor; the adopted fs/shell servers
 * are exercised under their dedicated gate).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import type { McpServerConfig } from '@adhd/agent-engine-orchestrator';

import { buildHarness, type Harness } from './harness.js';
import { createServer } from '../../server.js';
import { resolveAgentMcpServers } from '../../defaults.js';

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
    { name: 'native-tooling-host-e2e', version: '0.0.1' },
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

const OPENAI = { type: 'openai' as const, model: 'test-model' };

describe('native-tooling resolution at the real host (NAT-TOOL-4)', () => {
  let harness: Harness | undefined;
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
    await harness?.teardown();
    harness = undefined;
  });

  it('AC1: agent_verify_mcp sees the RESOLVED toolset (dispatch floor, spawn-free)', async () => {
    harness = await buildHarness();
    const conn = await connectMcp(harness);
    close = conn.close;

    await conn.client.callTool({
      name: 'agent_create',
      arguments: {
        name: 'native-verify-agent',
        provider: OPENAI,
        systemPrompt: 'hi',
        nativeTooling: { fs: false, shell: false, dispatch: true },
      },
    });

    const verified = parse<{
      servers: Array<{ name: string; status: string }>;
    }>(
      await conn.client.callTool({
        name: 'agent_verify_mcp',
        arguments: { name: 'native-verify-agent' },
      })
    );

    // Without host-side resolution this would be [] (no stored mcpServers).
    expect(verified.servers.map((s) => s.name)).toEqual(['agent-mcp']);
    expect(verified.servers[0]!.status).toBe('skipped');
  });

  it('AC3: the stored definition keeps only declarative nativeTooling — no baked root', async () => {
    harness = await buildHarness();
    const conn = await connectMcp(harness);
    close = conn.close;

    await conn.client.callTool({
      name: 'agent_create',
      arguments: {
        name: 'portable-agent',
        provider: OPENAI,
        systemPrompt: 'hi',
        nativeTooling: { fs: true, shell: true, dispatch: true },
      },
    });

    const read = parse<{ mcpServers: Record<string, McpServerConfig>; nativeTooling: unknown }>(
      await conn.client.callTool({
        name: 'agent_read',
        arguments: { name: 'portable-agent' },
      })
    );

    // No definition-time server baking (the old `withDefaultMcpServers` bug).
    expect(read.mcpServers).toEqual({});
    expect(read.nativeTooling).toEqual({ fs: true, shell: true, dispatch: true });

    // The SAME stored definition resolves to each dispatching root, byte-identically.
    const storedSnapshot = JSON.stringify(read);
    const dispatchSelf: McpServerConfig = { transport: 'stdio', command: 'npx', args: ['-y', '@adhd/agent-mcp'] };
    const atP = resolveAgentMcpServers(read, { cwd: '/P', dispatchSelf });
    const atQ = resolveAgentMcpServers(read, { cwd: '/Q', dispatchSelf });
    const fsRoot = (s: Record<string, McpServerConfig>): string => {
      const fs = s['fs'];
      if (!fs || fs.transport !== 'stdio') throw new Error('no stdio fs server');
      const args = fs.args ?? [];
      const root = args[args.length - 1];
      if (!root) throw new Error('fs server resolved without a root arg');
      return root;
    };
    expect(fsRoot(atP)).toBe('/P');
    expect(fsRoot(atQ)).toBe('/Q');
    expect(JSON.stringify(read)).toBe(storedSnapshot); // resolution never mutated the read
  });

  it('AC2: an explicit mcpServers map is preserved alongside the native toolset', async () => {
    harness = await buildHarness();
    const conn = await connectMcp(harness);
    close = conn.close;

    await conn.client.callTool({
      name: 'agent_create',
      arguments: {
        name: 'explicit-agent',
        provider: OPENAI,
        systemPrompt: 'hi',
        mcpServers: {
          // A fast-failing local process — proves the EXPLICIT entry is what is
          // probed (a native `fs` would instead spawn the srt-wrapped reference
          // server, which this hermetic test must not do).
          mine: { transport: 'stdio', command: 'true' },
        },
        nativeTooling: { fs: false, shell: false, dispatch: false },
      },
    });

    const verified = parse<{ servers: Array<{ name: string; status: string }> }>(
      await conn.client.callTool({
        name: 'agent_verify_mcp',
        arguments: { name: 'explicit-agent' },
      })
    );
    expect(verified.servers.map((s) => s.name)).toEqual(['mine']);
    // `true` is not an MCP server, so the probe errors — but it WAS probed,
    // proving the explicit config survived and no native `fs`/`shell` was added.
    expect(verified.servers[0]!.status).toBe('error');
  });
});
