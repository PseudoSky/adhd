/**
 * NAT-TOOL-4 — the agent-mcp host resolves `nativeTooling` at TASK time
 * (ADR-0008 D1/D4) into a keyed `mcpServers` map, with merge precedence
 * `explicit mcpServers > nativeTooling > dispatch self floor`.
 *
 * These are the AC teeth at the host boundary: they FAIL if the resolution,
 * the precedence, the task-time cwd, or the srt default-wrap regresses.
 */
import { describe, expect, it } from 'vitest';
import { effectiveHitl } from '@adhd/agent-base-types';
import type { McpServerConfig } from '@adhd/agent-base-types';

import {
  buildDispatchSelf,
  buildNativeToolingContext,
  resolveAgentMcpServers,
  resolveDefinitionNativeTooling,
  withDefaultMcpServers,
  withResolvedNativeTooling,
  withResolvedNativeToolingSession,
} from '../defaults.js';

type Stdio = Extract<McpServerConfig, { transport: 'stdio' }>;
const stdio = (c: McpServerConfig | undefined): Stdio => {
  if (!c || c.transport !== 'stdio') throw new Error('expected a stdio config');
  return c;
};

const dispatchSelf: McpServerConfig = {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@adhd/agent-mcp'],
};

const def = {
  mcpServers: {} as Record<string, McpServerConfig>,
  nativeTooling: { fs: true, shell: true, dispatch: true } as const,
};

describe('resolveAgentMcpServers — task-time resolution (ADR-0008 D4)', () => {
  it('AC1: {fs:true,shell:true,dispatch:true} yields fs+shell+dispatch keyed servers rooted at the task cwd', () => {
    const servers = resolveAgentMcpServers(def, { cwd: '/P', dispatchSelf });

    expect(Object.keys(servers).sort()).toEqual(['agent-mcp', 'fs', 'shell']);

    const fs = stdio(servers['fs']);
    expect(fs.command).toBe('srt'); // adopted srt wrapper is on by default (D7)
    expect(fs.args).toEqual([
      'npx',
      '-y',
      '@modelcontextprotocol/server-filesystem',
      '/P',
    ]);
    expect(fs.cwd).toBe('/P');

    const shell = stdio(servers['shell']);
    expect(shell.cwd).toBe('/P');
    expect(shell.args).toEqual(['uvx', 'mcp-shell-server']);

    // dispatch surfaces the REAL host-supplied agent-mcp server (never a wrapper).
    expect(servers['agent-mcp']).toEqual(dispatchSelf);
  });

  it('AC2: an explicit mcpServers entry WINS over nativeTooling for the same name', () => {
    const explicitFs: McpServerConfig = {
      transport: 'stdio',
      command: 'my-custom-fs',
      args: ['--root', '/x'],
    };
    const servers = resolveAgentMcpServers(
      { mcpServers: { fs: explicitFs }, nativeTooling: { fs: true, shell: true, dispatch: true } },
      { cwd: '/P', dispatchSelf }
    );
    expect(servers['fs']).toEqual(explicitFs);
    expect(servers['shell']).toBeDefined();
    expect(servers['agent-mcp']).toEqual(dispatchSelf);
  });

  it('AC3: the same definition at /P then /Q differs ONLY in the cwd-derived root; the stored JSON is byte-identical', () => {
    const snapshot = JSON.stringify(def);
    const p = resolveAgentMcpServers(def, { cwd: '/P', dispatchSelf });
    const q = resolveAgentMcpServers(def, { cwd: '/Q', dispatchSelf });

    expect((stdio(p['fs']).args ?? []).at(-1)).toBe('/P');
    expect((stdio(q['fs']).args ?? []).at(-1)).toBe('/Q');
    // Normalizing only the root makes the two byte-identical — the cwd is the
    // sole source of difference (no definition-time root leaked in).
    const pNormalized = JSON.parse(JSON.stringify(p).split('/P').join('/Q'));
    expect(pNormalized).toEqual(q);
    // Resolution NEVER mutates the stored definition.
    expect(JSON.stringify(def)).toBe(snapshot);
  });

  it('{fs:false} omits fs; {dispatch:false} omits the dispatch floor', () => {
    const servers = resolveAgentMcpServers(
      { mcpServers: {}, nativeTooling: { fs: false, shell: true, dispatch: false } },
      { cwd: '/P', dispatchSelf }
    );
    expect(Object.keys(servers)).toEqual(['shell']);
  });

  it('a legacy definition with no nativeTooling behaves as the standardized defaults (D1/D8)', () => {
    const servers = resolveAgentMcpServers(
      { mcpServers: {} },
      { cwd: '/P', dispatchSelf }
    );
    expect(Object.keys(servers).sort()).toEqual(['agent-mcp', 'fs', 'shell']);
  });

  it('dispatch is omitted when no real dispatchSelf exists (a wrapper is never authored)', () => {
    const servers = resolveAgentMcpServers(def, { cwd: '/P' });
    expect(servers['agent-mcp']).toBeUndefined();
    expect(Object.keys(servers).sort()).toEqual(['fs', 'shell']);
  });

  it('a custom McpServerConfig for a member REPLACES the builtin (D3)', () => {
    const custom: McpServerConfig = { transport: 'stdio', command: 'my-fs', args: ['--root', '/x'] };
    const servers = resolveAgentMcpServers(
      { mcpServers: {}, nativeTooling: { fs: custom, shell: false, dispatch: false } },
      { cwd: '/P' }
    );
    expect(servers['fs']).toEqual(custom);
  });

  it('AC(c): the agent_create defaults (no nativeTooling) and an explicit nativeTooling go through ONE path', () => {
    // A legacy definition with NO nativeTooling behaves as the standardized
    // defaults — resolved by the SAME single function, not a second producer.
    const defaults = withDefaultMcpServers({ mcpServers: {} }, { cwd: '/P', dispatchSelf });
    const explicit = withDefaultMcpServers(
      { mcpServers: {}, nativeTooling: { fs: true, shell: true, dispatch: true } },
      { cwd: '/P', dispatchSelf }
    );
    expect(defaults.mcpServers).toEqual(explicit.mcpServers);
    // `resolveAgentMcpServers` is the accessor over that one merge — no second
    // resolution/timing behaviour.
    expect(resolveAgentMcpServers({ mcpServers: {} }, { cwd: '/P', dispatchSelf })).toEqual(
      defaults.mcpServers
    );
  });

  it('withDefaultMcpServers MERGES (explicit > native > dispatch) rather than returning explicit untouched', () => {
    // The old bug: an explicit map made the function a no-op, so native members
    // (and the dispatch floor) were silently dropped. They must now be merged.
    const custom: McpServerConfig = { transport: 'stdio', command: 'my-custom-fs' };
    const merged = withDefaultMcpServers(
      { mcpServers: { fs: custom }, nativeTooling: { fs: true, shell: true, dispatch: true } },
      { cwd: '/P', dispatchSelf }
    );
    expect(merged.mcpServers['fs']).toEqual(custom); // explicit wins for its key
    expect(merged.mcpServers['shell']).toBeDefined(); // native shell still merged
    expect(merged.mcpServers['agent-mcp']).toEqual(dispatchSelf); // dispatch floor still merged
  });

  it('resolveDefinitionNativeTooling returns a NEW object (never mutates the input)', () => {
    const original = {
      name: 'a',
      version: 1,
      provider: { type: 'openai' as const },
      mcpServers: {},
      permissions: {},
      nativeTooling: { fs: true, shell: true, dispatch: true },
    };
    const resolved = resolveDefinitionNativeTooling(original as never, { cwd: '/P', dispatchSelf });
    expect(resolved).not.toBe(original);
    expect(resolved.mcpServers['fs']).toBeDefined();
    expect(original.mcpServers).toEqual({});
  });
});

describe('A1 — server-wide nativeTooling merges BENEATH the agent def (agent wins)', () => {
  it('a server-wide layer changes the resolved toolset when the agent omits it', () => {
    const servers = resolveAgentMcpServers(
      { mcpServers: {} },
      {
        cwd: '/P',
        dispatchSelf,
        defaultNativeTooling: {
          fs: false,
          shell: false,
          dispatch: { allowedTools: ['task'] },
        },
      }
    );
    // TEETH: without the merge these are absent (agent omitted nativeTooling).
    expect((servers['agent-mcp'] as Stdio).allowedTools).toEqual(['task']);
    expect(servers['fs']).toBeUndefined(); // server-wide fs:false honored
    expect(servers['shell']).toBeUndefined();
  });

  it('the agent definition WINS over the server-wide layer, per field', () => {
    const servers = resolveAgentMcpServers(
      { mcpServers: {}, nativeTooling: { dispatch: { disallowedTools: ['task'] } } },
      {
        cwd: '/P',
        dispatchSelf,
        defaultNativeTooling: { dispatch: { allowedTools: ['agent'] } },
      }
    );
    const dispatch = servers['agent-mcp'] as Stdio;
    expect(dispatch.allowedTools).toEqual(['agent']); // server field merged in
    expect(dispatch.disallowedTools).toEqual(['task']); // agent field present
  });

  it('an agent `false` member wins outright over a server-wide object', () => {
    const servers = resolveAgentMcpServers(
      { mcpServers: {}, nativeTooling: { fs: false } },
      { cwd: '/P', dispatchSelf, defaultNativeTooling: { fs: { root: '/server' } } }
    );
    expect(servers['fs']).toBeUndefined();
  });

  it('hitl resolves from the server-wide layer and is carried on the returned definition', () => {
    const resolved = withDefaultMcpServers(
      { mcpServers: {}, nativeTooling: {} },
      { cwd: '/P', dispatchSelf, defaultNativeTooling: { hitl: false } }
    );
    // TEETH: the HITL predicate the orchestrator uses sees the merged value.
    expect(effectiveHitl(resolved)).toBe(false);
  });

  it('agent hitl wins over server-wide hitl', () => {
    const resolved = withDefaultMcpServers(
      { mcpServers: {}, nativeTooling: { hitl: true } },
      { cwd: '/P', dispatchSelf, defaultNativeTooling: { hitl: false } }
    );
    expect(effectiveHitl(resolved)).toBe(true);
  });
});

describe('buildNativeToolingContext / buildDispatchSelf (D1/D9)', () => {
  it('defaults cwd to process.cwd() and dispatchSelf to the documented agent-mcp launch', () => {
    const ctx = buildNativeToolingContext();
    expect(ctx.cwd).toBe(process.cwd());
    expect(ctx.dispatchSelf).toEqual(buildDispatchSelf());
    expect((ctx.dispatchSelf as Stdio).command).toBe('npx');
  });

  it('injects the repo node_modules/.bin on PATH so the srt/npx/uvx children resolve', () => {
    const ctx = buildNativeToolingContext();
    expect(ctx.env?.['PATH']).toMatch(/node_modules[/\\]\.bin/);
  });

  it('buildDispatchSelf honors command/args env overrides', () => {
    const self = buildDispatchSelf({
      ADHD_AGENT_MCP_COMMAND: 'node',
      ADHD_AGENT_MCP_ARGS: '/tmp/agent-mcp.js serve',
    } as NodeJS.ProcessEnv);
    expect(self).toEqual({
      transport: 'stdio',
      command: 'node',
      args: ['/tmp/agent-mcp.js', 'serve'],
    });
  });
});

describe('store wrappers resolve at READ time, leaving the raw store intact', () => {
  const stored = {
    name: 'a',
    version: 1,
    provider: { type: 'openai' as const },
    mcpServers: {},
    permissions: {},
    nativeTooling: { fs: true, shell: true, dispatch: true },
  };
  const rawStore = { read: (_name: string) => stored as never };
  const ctx = () => ({ cwd: '/P', dispatchSelf });

  it('withResolvedNativeTooling resolves read() and preserves the stored definition', () => {
    const wrapped = withResolvedNativeTooling(rawStore, ctx);
    const read = wrapped.read('a') as unknown as { mcpServers: Record<string, McpServerConfig> };
    expect(Object.keys(read.mcpServers).sort()).toEqual(['agent-mcp', 'fs', 'shell']);
    // The raw store still returns the unresolved definition (byte-identical).
    expect(rawStore.read('a')).toBe(stored);
    expect(JSON.stringify(rawStore.read('a'))).toBe(JSON.stringify(stored));
  });

  it('withResolvedNativeToolingSession resolves getAgentDefinition()', () => {
    const sessionStore = { getAgentDefinition: (_id: string) => stored as never };
    const wrapped = withResolvedNativeToolingSession(sessionStore, ctx);
    const read = wrapped.getAgentDefinition('s') as unknown as {
      mcpServers: Record<string, McpServerConfig>;
    };
    expect(read.mcpServers['shell']).toBeDefined();
  });
});
