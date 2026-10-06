/**
 * resolve-dispatch-mcp-servers.spec.ts — NAT-TOOL-5 (ADR-0008 D4): the DISPATCH
 * HOST resolves native tooling at the dispatching cwd and threads it (+ cwd) to
 * the runner.
 *
 * ACs (each revert-failing):
 *  1. A dispatched agent launched from `/P` gets an fs root `/P` and a shell
 *     cwd `/P`; backlog + memory servers are present.
 *  2. Firing from `/P` vs `/Q` roots fs/shell at each cwd (portability at the
 *     dispatch-host layer).
 *  3. Explicit `mcpServers` win over `nativeTooling`.
 *  4. No second producer: the map is EXACTLY `resolveNativeToolingMap` merged
 *     with the explicit half — never a hand-built fs/shell config.
 *
 * Hermetic: `ADHD_DISPATCH_BACKLOG_MCP_ENTRY` pins the backlog entry, so no
 * built backlog / spawn is needed (the fs/shell servers are never spawned here).
 */
import { describe, expect, it } from 'vitest';

import { resolveNativeToolingMap } from '@adhd/agent-core-native-tooling';
import type { IMcpToolClient, McpCallToolResult } from '@adhd/dispatch-orchestrator';
import type { DispatchUnit } from '@adhd/dispatch-base-spec';
import type { McpServerConfig } from '@adhd/agent-base-types';

import {
  buildProductionAgentMcpRunner,
  resolveDispatchMcpServers,
  resolveProductionRunnerCwd,
} from '../lib/core.js';

/** Hermetic env: a synthetic backlog entry so `defaultDispatchMcpServers` never
 *  depends on a built backlog, and a pinned dispatch-self launch. */
const ENV = {
  ADHD_DISPATCH_BACKLOG_MCP_ENTRY: '/tmp/adhd-nat-tool-5/synthetic/backlog/index.js',
} as NodeJS.ProcessEnv;

function stdio(map: Record<string, McpServerConfig>, key: string): Extract<McpServerConfig, { transport: 'stdio' }> {
  const cfg = map[key];
  if (!cfg || cfg.transport !== 'stdio') throw new Error(`no stdio '${key}' server`);
  return cfg;
}

/** The resolved fs ROOT: the last argv element (the resolver appends the root). */
function fsRoot(map: Record<string, McpServerConfig>): string {
  const args = stdio(map, 'fs').args ?? [];
  const root = args[args.length - 1];
  if (!root) throw new Error('fs server resolved without a root arg');
  return root;
}

/** Records `agent_read`/`agent_create`/`agent_update` calls; drives ensureAgent. */
class RecordingClient implements IMcpToolClient {
  readonly calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  connectCount = 0;
  closeCount = 0;
  constructor(private readonly agentExists = false) {}
  async connect(): Promise<void> {
    this.connectCount += 1;
  }
  async callTool(
    params: { name: string; arguments?: Record<string, unknown> }
  ): Promise<McpCallToolResult> {
    this.calls.push({ name: params.name, arguments: params.arguments });
    if (params.name === 'agent_read') {
      if (this.agentExists) {
        return { content: [{ type: 'text', text: JSON.stringify({ name: 'preexisting' }) }] };
      }
      return {
        isError: true,
        content: [{ type: 'text', text: "[AGENT_NOT_FOUND] Agent 'preexisting' not found" }],
      };
    }
    if (params.name === 'agent_create' || params.name === 'agent_update') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ...params.arguments, version: 1 }) }],
      };
    }
    throw new Error(`RecordingClient: unexpected tool '${params.name}'`);
  }
  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

const UNIT = {
  agent_name: 'preexisting',
  provider: null,
  systemPrompt: 'sys',
} as unknown as DispatchUnit;

describe('resolveDispatchMcpServers (NAT-TOOL-5)', () => {
  it('AC1: roots fs + shell at the dispatching cwd and includes backlog + memory', () => {
    const map = resolveDispatchMcpServers({ cwd: '/P', env: ENV });

    expect(Object.keys(map).sort()).toEqual(
      ['agent-mcp', 'backlog', 'fs', 'memory-server', 'shell'].sort()
    );
    // fs root AND shell child cwd are the dispatching cwd.
    expect(fsRoot(map)).toBe('/P');
    expect(stdio(map, 'fs').cwd).toBe('/P');
    expect(stdio(map, 'shell').cwd).toBe('/P');
    // backlog + memory are the explicit half.
    expect(map['memory-server']).toMatchObject({ transport: 'sse' });
    expect(map['backlog']).toMatchObject({ transport: 'stdio', command: 'node' });
    // dispatch self is the REAL agent-mcp launch config (D1), never a wrapper.
    expect(map['agent-mcp']).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@adhd/agent-mcp'],
    });
  });

  it('AC2: the SAME call from /P vs /Q roots each cwd (dispatch-host portability)', () => {
    const atP = resolveDispatchMcpServers({ cwd: '/P', env: ENV });
    const atQ = resolveDispatchMcpServers({ cwd: '/Q', env: ENV });

    expect(fsRoot(atP)).toBe('/P');
    expect(stdio(atP, 'shell').cwd).toBe('/P');
    expect(fsRoot(atQ)).toBe('/Q');
    expect(stdio(atQ, 'shell').cwd).toBe('/Q');
  });

  it('AC3: explicit mcpServers WIN over the native toolset', () => {
    const customFs: McpServerConfig = { transport: 'stdio', command: 'my-fs', args: ['/custom'] };
    const customMemory: McpServerConfig = { transport: 'sse', url: 'http://explicit/sse' };

    const map = resolveDispatchMcpServers({
      cwd: '/P',
      env: ENV,
      explicit: { fs: customFs, 'memory-server': customMemory },
    });

    expect(map['fs']).toEqual(customFs);
    expect(map['memory-server']).toEqual(customMemory);
    // A non-overridden native member is still present (explicit wins per key).
    expect(stdio(map, 'shell').cwd).toBe('/P');
    expect(fsRoot(map)).not.toBe('/P'); // the custom fs replaced the builtin
  });

  it('AC3: a nativeTooling member set to false is omitted; an override is honoured', () => {
    const off = resolveDispatchMcpServers({
      cwd: '/P',
      env: ENV,
      nativeTooling: { fs: false, shell: false, dispatch: false },
    });
    expect(Object.keys(off).sort()).toEqual(['backlog', 'memory-server']);

    const override = resolveDispatchMcpServers({
      cwd: '/P',
      env: ENV,
      nativeTooling: { fs: { root: '/CUSTOM' } },
    });
    expect(fsRoot(override)).toBe('/CUSTOM');
    expect(stdio(override, 'shell').cwd).toBe('/P');
  });

  it('AC4: the builtin members are byte-equal to resolveNativeToolingMap — no second producer', () => {
    const native = resolveNativeToolingMap(undefined, {
      cwd: '/P',
      dispatchSelf: { transport: 'stdio', command: 'npx', args: ['-y', '@adhd/agent-mcp'] },
    });
    const map = resolveDispatchMcpServers({ cwd: '/P', env: ENV });
    for (const key of Object.keys(native)) {
      expect(map[key]).toEqual(native[key]);
    }
  });
});

describe('buildProductionAgentMcpRunner — cwd threading (NAT-TOOL-5 AC1/AC3)', () => {
  it('threads the dispatching cwd to the spawned agent-mcp child', () => {
    const runner = buildProductionAgentMcpRunner(ENV, {
      cwd: '/P',
      clientFactory: () => new RecordingClient(),
    });
    expect(runner.cwd).toBe('/P');
  });

  it('roots the resolved map at the cwd — the map actually sent to agent_create', async () => {
    const client = new RecordingClient(false);
    const runner = buildProductionAgentMcpRunner(ENV, {
      cwd: '/P',
      createAgentsIfMissing: true,
      clientFactory: () => client,
    });

    await runner.ensureAgent(UNIT);

    const create = client.calls.find((c) => c.name === 'agent_create');
    expect(create).toBeDefined();
    const map = create?.arguments?.['mcpServers'] as Record<string, McpServerConfig>;
    expect(fsRoot(map)).toBe('/P');
    expect(stdio(map, 'shell').cwd).toBe('/P');
    expect(Object.keys(map).sort()).toEqual(
      ['agent-mcp', 'backlog', 'fs', 'memory-server', 'shell'].sort()
    );
  });

  it('AC2: re-asserts the CURRENT cwd on an already-existing agent (reuse)', async () => {
    const client = new RecordingClient(true);
    const runner = buildProductionAgentMcpRunner(ENV, {
      cwd: '/Q',
      clientFactory: () => client,
    });

    await runner.ensureAgent(UNIT);

    expect(client.calls.map((c) => c.name)).toEqual(['agent_read', 'agent_update']);
    const update = client.calls.find((c) => c.name === 'agent_update');
    const patch = update?.arguments?.['patch'] as { mcpServers: Record<string, McpServerConfig> };
    expect(fsRoot(patch.mcpServers)).toBe('/Q');
    expect(stdio(patch.mcpServers, 'shell').cwd).toBe('/Q');
  });
});

describe('resolveProductionRunnerCwd (NAT-TOOL-5 AC3 — --tools-root consistency)', () => {
  it('uses --tools-root when supplied, else the dispatching process.cwd()', () => {
    expect(resolveProductionRunnerCwd('/T')).toBe('/T');
    expect(resolveProductionRunnerCwd()).toBe(process.cwd());
  });
});
