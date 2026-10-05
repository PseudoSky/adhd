/**
 * default-mcp-servers.spec.ts — backlog daafe2d3.
 *
 * `buildProductionAgentMcpRunner()` must create dispatch agents pre-wired with
 * the memory-server and backlog MCP servers, so a dispatched agent can recall
 * prior findings and read/write backlog items without a per-DAG opt-in.
 * `defaultDispatchMcpServers()` is that value; this asserts its wire shape and
 * its environment overrides.
 */
import { describe, expect, it } from 'vitest';

import { defaultDispatchMcpServers } from '../lib/core.js';

describe('defaultDispatchMcpServers (daafe2d3)', () => {
  it('wires memory-server (sse) + backlog (stdio serve) as the defaults', () => {
    const servers = defaultDispatchMcpServers({} as NodeJS.ProcessEnv);

    expect(Object.keys(servers).sort()).toEqual(['backlog', 'memory-server']);
    expect(servers['memory-server']).toEqual({
      transport: 'sse',
      url: 'http://localhost:3099/sse',
    });

    const backlog = servers['backlog'] as {
      transport: string;
      command: string;
      args: string[];
    };
    expect(backlog.transport).toBe('stdio');
    expect(backlog.command).toBe('node');
    expect(backlog.args[0]).toContain('backlog');
    expect(backlog.args.slice(1)).toEqual(['serve', '--transport', 'mcp']);
  });

  it('honours the environment overrides', () => {
    const servers = defaultDispatchMcpServers({
      ADHD_DISPATCH_MEMORY_MCP_URL: 'http://memory.internal:4123/sse',
      ADHD_DISPATCH_BACKLOG_MCP_ENTRY: '/custom/path/backlog/index.js',
    } as NodeJS.ProcessEnv);

    expect(servers['memory-server']).toEqual({
      transport: 'sse',
      url: 'http://memory.internal:4123/sse',
    });
    expect(
      (servers['backlog'] as { args: string[] }).args[0]
    ).toBe('/custom/path/backlog/index.js');
  });
});
