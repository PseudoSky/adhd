/**
 * mcp-verify.test.ts — backlog 1f352507.
 *
 * `verifyAgentMcpServers` handshake-verifies an agent's `mcpServers` before a
 * real task: it connects each server, lists its tools, and reports either the
 * reachable tool names or a clear per-server connection error — with NO model
 * call (the deps type only exposes the agent store; no provider is reachable).
 *
 * Real components: an actual stdio MCP server child process (a fixture using
 * the SDK), spawned by the real `StdioMcpClient`. The negative case uses a real
 * child process that exits immediately, so the failure is a genuine handshake
 * failure, not a mock.
 */
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { AgentDefinition } from '../validation/index.js';
import { verifyAgentMcpServers } from '../tools/mcp-verify.js';

const FIXTURE = fileURLToPath(
  new URL('./fixtures/verify-echo-server.mjs', import.meta.url)
);

function fakeAgentStore(mcpServers: AgentDefinition['mcpServers']) {
  return {
    read: (name: string): AgentDefinition =>
      ({
        name,
        version: 1,
        provider: { type: 'claudecli' },
        mcpServers,
        permissions: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }) as AgentDefinition,
  };
}

describe('verifyAgentMcpServers — handshake before a real task (1f352507)', () => {
  it('connects a real stdio server and returns its reachable tool names', async () => {
    const result = await verifyAgentMcpServers(
      { name: 'verified' },
      { agentStore: fakeAgentStore({
        echo: {
          transport: 'stdio',
          command: process.execPath,
          args: [FIXTURE],
        },
      }) }
    );

    expect(result.agent).toBe('verified');
    expect(result.servers).toHaveLength(1);
    const echo = result.servers[0];
    expect(echo.name).toBe('echo');
    expect(echo.status).toBe('verified');
    expect(echo.ok).toBe(true);
    expect(echo.tools).toContain('echo');
    expect(echo.error).toBeUndefined();
    expect(echo.skipped).toBeUndefined();
  });

  it('reports a clear per-server error for a server that cannot handshake', async () => {
    const result = await verifyAgentMcpServers(
      { name: 'broken' },
      { agentStore: fakeAgentStore({
        // A real child process that exits immediately without speaking MCP.
        dead: {
          transport: 'stdio',
          command: process.execPath,
          args: ['-e', 'process.exit(1)'],
        },
      }) }
    );

    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].status).toBe('error');
    expect(result.servers[0].ok).toBe(false);
    expect(result.servers[0].error).toBeTruthy();
  });

  it('verifies each server independently — one bad server does not hide a good one', async () => {
    const result = await verifyAgentMcpServers(
      { name: 'mixed' },
      { agentStore: fakeAgentStore({
        good: {
          transport: 'stdio',
          command: process.execPath,
          args: [FIXTURE],
        },
        bad: {
          transport: 'stdio',
          command: process.execPath,
          args: ['-e', 'process.exit(1)'],
        },
      }) }
    );

    const byName = Object.fromEntries(result.servers.map((s) => [s.name, s]));
    expect(byName.good.status).toBe('verified');
    expect(byName.good.ok).toBe(true);
    expect(byName.good.tools).toContain('echo');
    expect(byName.bad.status).toBe('error');
    expect(byName.bad.ok).toBe(false);
    expect(byName.bad.error).toBeTruthy();
  });

  it('skips the self-referential agent-mcp entry (handled in-process, never spawned)', async () => {
    const result = await verifyAgentMcpServers(
      { name: 'delegator' },
      { agentStore: fakeAgentStore({
        'agent-mcp': { transport: 'stdio', command: '/nonexistent/agent-mcp' },
      }) }
    );

    expect(result.servers).toHaveLength(1);
    // The tri-state disambiguates "skipped" from "verified": the old
    // `ok:true + skipped` pair could not tell a consumer which it was.
    expect(result.servers[0].status).toBe('skipped');
    expect(result.servers[0].ok).toBe(true);
    expect(result.servers[0].skipped).toBeTruthy();
    expect(result.servers[0].error).toBeUndefined();
    expect(result.servers[0].tools).toEqual([]);
  });

  it('returns an empty server list when the agent configures none', async () => {
    const result = await verifyAgentMcpServers(
      { name: 'bare' },
      { agentStore: fakeAgentStore({}) }
    );
    expect(result.servers).toEqual([]);
  });
});
