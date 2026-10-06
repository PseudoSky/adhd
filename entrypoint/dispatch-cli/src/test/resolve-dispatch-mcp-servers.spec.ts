/**
 * resolve-dispatch-mcp-servers.spec.ts — NAT-TOOL-5 rework (ADR-0008 D4/D8).
 *
 * The dispatch host STORES only the DECLARATIVE toolset on a dispatch-created
 * agent: the explicit `mcpServers` half (`memory-server` + `backlog`) plus a
 * declarative `nativeTooling` (`{fs?, shell?, dispatch?, hitl?}`). It NEVER
 * writes a resolved fs/shell root onto the definition; the spawned agent-mcp
 * child resolves `nativeTooling` at TASK time against its own cwd (D4, D9).
 *
 * ACs (each revert-failing):
 *  A. a dispatch-created agent's stored definition is byte-identical across
 *     fires — the host writes no resolved root, and reuse performs no write.
 *  B. the fs root resolves to each dispatching cwd (the child does the
 *     resolving; the host only threads the cwd — see the e2e for the end-to-end
 *     proof).
 *  C. no resolved fs-root/absolute-cwd is written into a stored `mcpServers`.
 *  D. the explicit memory/backlog servers are present and win (D1).
 *
 * Hermetic: `ADHD_DISPATCH_BACKLOG_MCP_ENTRY` pins the backlog entry, so no
 * built backlog / spawn is needed (the fs/shell servers are never spawned here).
 */
import { describe, expect, it } from 'vitest';

import type { IMcpToolClient, McpCallToolResult } from '@adhd/dispatch-orchestrator';
import type { DispatchUnit } from '@adhd/dispatch-base-spec';
import type { McpServerConfig } from '@adhd/agent-base-types';

import {
  buildProductionAgentMcpRunner,
  DEFAULT_DISPATCH_NATIVE_TOOLING,
  resolveDispatchMcpServers,
  resolveDispatchNativeTooling,
  resolveProductionRunnerCwd,
} from '../lib/core.js';

/** Hermetic env: a synthetic backlog entry so `defaultDispatchMcpServers` never
 *  depends on a built backlog. */
const ENV = {
  ADHD_DISPATCH_BACKLOG_MCP_ENTRY: '/tmp/adhd-nat-tool-5/synthetic/backlog/index.js',
} as NodeJS.ProcessEnv;

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
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                name: 'preexisting',
                mcpServers: {},
                nativeTooling: DEFAULT_DISPATCH_NATIVE_TOOLING,
              }),
            },
          ],
        };
      }
      return {
        isError: true,
        content: [{ type: 'text', text: "[AGENT_NOT_FOUND] Agent 'preexisting' not found" }],
      };
    }
    if (params.name === 'agent_create') {
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

describe('resolveDispatchMcpServers — the explicit half ONLY (D1/D4/D8)', () => {
  it('AC-D: returns memory-server + backlog and NOTHING native (no fs/shell/agent-mcp)', () => {
    const map = resolveDispatchMcpServers({ env: ENV });

    expect(Object.keys(map).sort()).toEqual(['backlog', 'memory-server']);
    expect(map['memory-server']).toMatchObject({ transport: 'sse' });
    expect(map['backlog']).toMatchObject({ transport: 'stdio', command: 'node' });
    // No native member, and no dispatch self server, is ever produced here.
    expect(map['fs']).toBeUndefined();
    expect(map['shell']).toBeUndefined();
    expect(map['agent-mcp']).toBeUndefined();
  });

  it('AC-C: the returned map carries NO absolute cwd / fs root', () => {
    const map = resolveDispatchMcpServers({ env: ENV });
    const serialized = JSON.stringify(map);
    expect(serialized).not.toContain('server-filesystem');
    expect(serialized).not.toContain('mcp-shell-server');
    // A dispatching cwd is never present (the explicit half is cwd-independent).
    expect(serialized).not.toContain('/P');
  });

  it('AC-D: caller-supplied explicit servers are merged and WIN per key', () => {
    const customMemory: McpServerConfig = { transport: 'sse', url: 'http://explicit/sse' };
    const map = resolveDispatchMcpServers({
      env: ENV,
      explicit: { 'memory-server': customMemory },
    });
    expect(map['memory-server']).toEqual(customMemory);
    expect(map['backlog']).toBeDefined();
  });
});

describe('resolveDispatchNativeTooling — declarative, never resolved (D3/D4/D8)', () => {
  it('AC-B/D: defaults to the standardized {fs,shell,dispatch} declarative config', () => {
    expect(resolveDispatchNativeTooling()).toEqual({
      fs: true,
      shell: true,
      dispatch: true,
    });
    expect(DEFAULT_DISPATCH_NATIVE_TOOLING).toEqual({
      fs: true,
      shell: true,
      dispatch: true,
    });
  });

  it('AC-B: a caller override is stored VERBATIM — a declarative root override is NOT expanded', () => {
    const override = { fs: { root: '/CUSTOM' }, shell: false, dispatch: true } as const;
    // Returns the declarative config as-is; no fs server is resolved here.
    expect(resolveDispatchNativeTooling({ nativeTooling: override })).toEqual(override);
  });
});

describe('buildProductionAgentMcpRunner — stores declarative, threads cwd (AC-A/AC-B/AC-C)', () => {
  it('AC-B: threads the dispatching cwd to the spawned agent-mcp child', () => {
    const runner = buildProductionAgentMcpRunner(ENV, {
      cwd: '/P',
      clientFactory: () => new RecordingClient(),
    });
    expect(runner.cwd).toBe('/P');
  });

  it('AC-A/AC-C/AC-D: the agent_create payload stores declarative nativeTooling + only the explicit mcpServers', async () => {
    const client = new RecordingClient(false);
    const runner = buildProductionAgentMcpRunner(ENV, {
      cwd: '/P',
      createAgentsIfMissing: true,
      clientFactory: () => client,
    });

    await runner.ensureAgent(UNIT);

    const create = client.calls.find((c) => c.name === 'agent_create');
    expect(create).toBeDefined();
    const args = create?.arguments ?? {};

    // Declarative nativeTooling is stored verbatim.
    expect(args['nativeTooling']).toEqual({ fs: true, shell: true, dispatch: true });

    // mcpServers carries ONLY the explicit half; no fs/shell/dispatch, no root.
    const map = args['mcpServers'] as Record<string, McpServerConfig>;
    expect(Object.keys(map).sort()).toEqual(['backlog', 'memory-server']);
    const serialized = JSON.stringify(map);
    expect(serialized).not.toContain('server-filesystem');
    expect(serialized).not.toContain('mcp-shell-server');
    expect(serialized).not.toContain('/P'); // cwd never baked into the stored map
    expect(serialized).not.toContain('"cwd"');
  });

  it('AC-A: reuse performs NO write — the stored definition is never mutated', async () => {
    const client = new RecordingClient(true);
    const runner = buildProductionAgentMcpRunner(ENV, {
      cwd: '/Q',
      clientFactory: () => client,
    });

    await runner.ensureAgent(UNIT);

    // NEGATIVE CONTROL: reintroducing the pre-rework agent_update re-assert makes
    // this see ['agent_read','agent_update'] and fail.
    expect(client.calls.map((c) => c.name)).toEqual(['agent_read']);
  });

  it('AC-B: a caller nativeTooling override is what gets stored (declarative, unexpanded)', async () => {
    const client = new RecordingClient(false);
    const runner = buildProductionAgentMcpRunner(ENV, {
      cwd: '/P',
      createAgentsIfMissing: true,
      nativeTooling: { fs: false, shell: false, dispatch: true },
      clientFactory: () => client,
    });

    await runner.ensureAgent(UNIT);

    const create = client.calls.find((c) => c.name === 'agent_create');
    expect(create?.arguments?.['nativeTooling']).toEqual({
      fs: false,
      shell: false,
      dispatch: true,
    });
  });
});

describe('resolveProductionRunnerCwd (--tools-root consistency)', () => {
  it('uses --tools-root when supplied, else the dispatching process.cwd()', () => {
    expect(resolveProductionRunnerCwd('/T')).toBe('/T');
    expect(resolveProductionRunnerCwd()).toBe(process.cwd());
  });
});
