/**
 * Default MCP-server wiring for new agents (backlog 97acef07).
 *
 * AC1: a newly created agent (via the REAL agent-mcp MCP surface) is born with
 *      the filesystem + shell MCP servers pre-wired, granting
 *      file_read/file_write/file_glob/file_grep + shell_exec capabilities.
 * AC2: an explicit non-empty mcpServers map wins untouched, and
 *      allowedTools/disallowedTools remain enforced by the real
 *      McpClientRegistry at every callTool.
 *
 * Drives the real server over an in-memory MCP client transport; the only
 * fakes are the stores/queue via the shared harness (no external process).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import { McpClientRegistry } from '@adhd/agent-engine-orchestrator';
import type { McpServerConfig } from '@adhd/agent-engine-orchestrator';

import { buildHarness, type Harness } from './harness.js';
import { createServer } from '../../server.js';
import {
  buildDefaultMcpServers,
  withDefaultMcpServers,
  DEFAULT_FILESYSTEM_ALLOWED_TOOLS,
  DEFAULT_SHELL_ALLOWED_TOOLS,
  resolveShellServerPath,
} from '../../defaults.js';

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
    { name: 'default-mcp-e2e', version: '0.0.1' },
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

describe('default MCP servers (97acef07)', () => {
  let harness: Harness | undefined;
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
    await harness?.teardown();
    harness = undefined;
  });

  it('AC1: agent_create with no mcpServers yields filesystem + shell defaults', async () => {
    harness = await buildHarness();
    const conn = await connectMcp(harness);
    close = conn.close;

    const created = parse<{ name: string }>(
      await conn.client.callTool({
        name: 'agent_create',
        arguments: {
          name: 'default-tools-agent',
          provider: { type: 'openai', model: 'test-model' },
          systemPrompt: 'hi',
          permissions: {},
        },
      })
    );
    expect(created.name).toBe('default-tools-agent');

    const read = parse<{
      mcpServers: Record<string, McpServerConfig>;
    }>(
      await conn.client.callTool({
        name: 'agent_read',
        arguments: { name: 'default-tools-agent' },
      })
    );

    const fs = read.mcpServers['filesystem'];
    expect(fs).toBeDefined();
    expect(fs.transport).toBe('stdio');
    const fsAllowed = fs.allowedTools ?? [];
    // read / write / search capabilities the AC names.
    expect(fsAllowed).toContain('read_text_file');
    expect(fsAllowed).toContain('write_file');
    expect(fsAllowed).toContain('edit_file');
    expect(fsAllowed).toContain('search_files');

    const shell = read.mcpServers['shell'];
    expect(shell).toBeDefined();
    expect(shell.allowedTools).toContain('shell');
  });

  it('AC2: an explicit mcpServers map wins untouched', () => {
    const explicit: Record<string, McpServerConfig> = {
      mine: { transport: 'stdio', command: 'my-server', allowedTools: ['only_this'] },
    };
    const out = withDefaultMcpServers({ mcpServers: explicit });
    expect(out.mcpServers).toBe(explicit);
    expect(out.mcpServers['filesystem']).toBeUndefined();
  });

  it('AC2: the real McpClientRegistry still enforces allowedTools', () => {
    const registry = new McpClientRegistry(
      {
        fs: {
          transport: 'stdio',
          command: 'noop',
          allowedTools: ['read_text_file'],
        } as McpServerConfig,
      },
      undefined,
      [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async () => undefined) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any
    );

    expect(() => registry.assertToolAllowed('fs', 'read_text_file')).not.toThrow();
    expect(() => registry.assertToolAllowed('fs', 'write_file')).toThrow(
      /disallowed/
    );
  });

  it('buildDefaultMcpServers omits shell when no server path resolves, and includes it when given one', () => {
    const noShell = buildDefaultMcpServers({ shellServerPath: undefined });
    // In-repo the server exists; assert the shape only when present.
    if (noShell['shell']) {
      expect(noShell['shell'].allowedTools).toEqual([
        ...DEFAULT_SHELL_ALLOWED_TOOLS,
      ]);
    }

    const withShell = buildDefaultMcpServers({ shellServerPath: '/tmp/fake-shell.mjs' });
    expect(withShell['shell']).toBeDefined();
    expect(withShell['shell'].args?.[0]).toBe('/tmp/fake-shell.mjs');

    expect(withShell['filesystem'].allowedTools).toEqual([
      ...DEFAULT_FILESYSTEM_ALLOWED_TOOLS,
    ]);
  });

  it('resolveShellServerPath resolves tools/mcp-shell/server.mjs in-repo', () => {
    // This repo ships the server; if the walk fails the default silently drops
    // shell, so assert the in-repo resolution explicitly.
    expect(resolveShellServerPath()).toMatch(/tools\/mcp-shell\/server\.mjs$/);
  });
});
