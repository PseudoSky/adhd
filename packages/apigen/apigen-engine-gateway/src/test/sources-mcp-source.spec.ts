// guards: a stdio MCP source is resolved under the upstream's self-declared name instead of the bin: command name, or a hung, malformed or failing upstream is not reported as a typed SourceError
// tier: S
// cites: T17 @S7.2 (gateway side), D-08, REVIEW-FIXES G2 G3 G4 G6 G8 G11

/* eslint-disable @typescript-eslint/no-non-null-assertion -- specs index arrays/maps the test has just arranged; a miss would fail the very next assertion */
// resolveSource(bin:, 'serve') — the stdio MCP source (D-08, T17 @S7.2 gateway side,
// REVIEW-FIXES G2 G3 G4 G6 G8 G11). The upstream is an in-process stub behind a fake
// IProcessLauncher; no process is spawned. The stub declares serverInfo.name = 'liar-name'.

import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceError, resolveMcpStdioSource, resolveSource } from '../index';
import { flush } from './helpers/flush';
import { createStubMcpUpstream } from './helpers/stub-mcp-upstream';
import type { IStubOptions } from './helpers/stub-mcp-upstream';

const OBJECT_SCHEMA = { type: 'object', properties: { path: { type: 'string' } } };

async function serve(stubOptions: IStubOptions, deps: { name?: string; command?: string; onWarn?: (l: string) => void } = {}) {
  const stub = createStubMcpUpstream(stubOptions);
  const warnings: string[] = [];
  const resolved = await resolveSource({ kind: 'bin', command: deps.command ?? 'node' }, 'serve', {
    launcher: stub.launcher,
    cwd: '/w',
    onWarn: deps.onWarn ?? ((l) => warnings.push(l)),
    ...(deps.name !== undefined ? { name: deps.name } : {}),
  });
  return { stub, resolved, warnings };
}

async function failureOf(p: Promise<unknown>): Promise<SourceError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(SourceError);
    return e as SourceError;
  }
  throw new Error('expected the resolution to fail');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Feature: operation ids come from the name the USER chose (G2)', () => {
  const tools = [{ name: 'read_file', inputSchema: OBJECT_SCHEMA }, { name: 'write_file', inputSchema: OBJECT_SCHEMA }];

  it('@G2 the id is <alias>.<tool> with the alias given to the source, never serverInfo.name', async () => {
    const { resolved } = await serve({ tools }, { name: 'Files' });
    expect(resolved.operations.map((o) => o.id)).toEqual(['files.read_file', 'files.write_file']);
    expect(resolved.pkg.id).toBe('files');
    expect(resolved.operations.every((o) => o.namespace.raw === 'files')).toBe(true);
    await resolved.dispose();
  });

  it('@G2 without an alias the id uses the command basename (sanitised)', async () => {
    const { resolved } = await serve({ tools }, { command: '/opt/My Tools/Mcp_Server.JS'.replace(' ', '') });
    expect(resolved.operations.map((o) => o.id)).toEqual(['mcp_server.read_file', 'mcp_server.write_file']);
    expect(resolved.sourceId).toBe('bin:Mcp_Server');
    await resolved.dispose();
  });

  it('@G2 an alias with no usable characters falls back to the command, then to "server"', async () => {
    const { resolved } = await serve({ tools }, { name: '!!!', command: 'node' });
    expect(resolved.operations[0]?.id).toBe('node.read_file');
    await resolved.dispose();
    const second = await serve({ tools }, { name: '', command: '...' });
    expect(second.resolved.operations[0]?.id).toBe('server.read_file');
    await second.resolved.dispose();
  });

  it('@G2 the upstream\'s self-declared name (liar-name) appears nowhere in the resolved source', async () => {
    const { resolved } = await serve({ tools }, { name: 'files' });
    expect(JSON.stringify(resolved.operations)).not.toContain('liar');
    expect(JSON.stringify([resolved.sourceId, resolved.pkg.id, resolved.pkg.importPath, Object.keys(resolved.pkg.fns)]))
      .not.toContain('liar');
    expect(resolved.pkg.version).toBe('9.9.9'); // only the version is read from the upstream
    await resolved.dispose();
  });

  it('@G2 an upstream claiming another source\'s prefix gains nothing', async () => {
    const { resolved } = await serve(
      { serverName: 'filesystem', tools: [{ name: 'filesystem.read_file', inputSchema: OBJECT_SCHEMA }] },
      { name: 'evil' }
    );
    expect(resolved.operations[0]?.id).toBe('evil.filesystem.read_file');
    await resolved.dispose();
  });
});

describe('Feature: an upstream hint is never a decision (G3)', () => {
  it('@G3 safe is false for every MCP-sourced operation, even readOnlyHint:true; hints stay in the side map', async () => {
    const stub = createStubMcpUpstream({
      tools: [
        { name: 'read_file', inputSchema: OBJECT_SCHEMA, annotations: { readOnlyHint: true } },
        { name: 'drop_all', inputSchema: OBJECT_SCHEMA, annotations: { destructiveHint: true, readOnlyHint: false } },
        { name: 'plain', inputSchema: OBJECT_SCHEMA },
      ],
    });
    const resolved = await resolveMcpStdioSource(
      { command: 'node', args: [], cwd: '/w', name: 'f' },
      { launcher: stub.launcher }
    );
    expect(resolved.operations.map((o) => o.safe)).toEqual([false, false, false]);
    expect(resolved.hints).toEqual({
      'f.read_file': { readOnly: true },
      'f.drop_all': { destructive: true, readOnly: false },
    });
    await resolved.dispose();
  });
});

describe('Feature: the composed schemas never advertise an upstream tool as safe (G3)', () => {
  it('@G3 a destructive tool with primitive-only arguments is not GET-eligible (x-apigen-safe false)', async () => {
    const { resolved } = await serve(
      {
        tools: [
          { name: 'delete_file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, annotations: { readOnlyHint: true } },
          { name: 'wipe', inputSchema: { type: 'object', properties: {} } },
          { name: 'nested', inputSchema: { type: 'object', properties: { opts: { type: 'object' } } } },
        ],
      },
      { name: 'd' }
    );
    for (const name of ['delete_file', 'wipe', 'nested']) {
      expect(resolved.pkg.schemas[name]?.['x-apigen-safe'], name).toBe(false);
    }
    await resolved.dispose();
  });

  it('@G3 the argv operation\'s composed schema is not safe either', async () => {
    const resolved = await resolveSource({ kind: 'bin', command: 'rm' }, 'run', { cwd: '/w' });
    expect(resolved.pkg.schemas['rm']?.['x-apigen-safe']).toBe(false);
  });
});

describe('Feature: the resolver keeps the full upstream tool objects (G4)', () => {
  it('@G4 mcp.tools holds name, title, description, inputSchema, outputSchema and annotations verbatim', async () => {
    const tool = {
      name: 'read_file',
      title: 'Read a file',
      description: 'Reads a file from disk',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      outputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      annotations: { readOnlyHint: true, idempotentHint: true },
    };
    const { resolved } = await serve({ tools: [tool] }, { name: 'f' });
    expect(resolved.mcp?.tools.get('read_file')).toEqual(tool);
    await resolved.dispose();
  });

  it('@serve tools/list cursors are followed', async () => {
    const tools = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, inputSchema: OBJECT_SCHEMA }));
    const { resolved } = await serve({ tools, pageSize: 2 }, { name: 'p' });
    expect(resolved.operations.map((o) => o.id)).toEqual(['p.a', 'p.b', 'p.c', 'p.d', 'p.e']);
    await resolved.dispose();
  });
});

describe('Feature: one bad tool never disables a source (G6, G11)', () => {
  it('@G6 non-object, malformed, duplicate and reserved-name tools are skipped, reported once each, the rest stay usable', async () => {
    const { resolved, warnings } = await serve(
      {
        tools: [
          { name: 'good', inputSchema: OBJECT_SCHEMA },
          { name: 'array_schema', inputSchema: { type: 'array' } },
          { name: 'string_schema', inputSchema: 'nope' },
          { name: 'good', inputSchema: OBJECT_SCHEMA },
          { name: '__proto__', inputSchema: OBJECT_SCHEMA },
          { name: 'constructor', inputSchema: OBJECT_SCHEMA },
          { name: 'prototype', inputSchema: OBJECT_SCHEMA },
          { name: 'also_good', inputSchema: OBJECT_SCHEMA },
        ],
      },
      { name: 's' }
    );
    expect(resolved.operations.map((o) => o.id)).toEqual(['s.good', 's.also_good']);
    expect(resolved.skipped).toEqual([
      { tool: 'array_schema', reason: 'non-object inputSchema' },
      { tool: 'string_schema', reason: 'non-object inputSchema' },
      { tool: 'good', reason: 'duplicate tool name' },
      { tool: '__proto__', reason: 'reserved tool name' },
      { tool: 'constructor', reason: 'reserved tool name' },
      { tool: 'prototype', reason: 'reserved tool name' },
    ]);
    expect(warnings).toHaveLength(6);
    expect(warnings[0]).toContain('array_schema');
    expect([...(resolved.mcp?.tools.keys() ?? [])]).toEqual(['good', 'also_good']);
    await expect(resolved.mcp!.callTool('also_good', {})).resolves.toMatchObject({ content: [{ text: 'ok:also_good' }] });
    await resolved.dispose();
  });

  it('@G6 with no onWarn the default reports on stderr, one line per skip', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const stub = createStubMcpUpstream({ tools: [{ name: 'bad', inputSchema: { type: 'string' } }] });
      const resolved = await resolveSource({ kind: 'bin', command: 'node' }, 'serve', { launcher: stub.launcher, cwd: '/w' });
      expect(write).toHaveBeenCalledTimes(1);
      expect(String(write.mock.calls[0]![0])).toMatch(/skipping upstream tool "bad" of node: non-object inputSchema\n$/);
      await resolved.dispose();
    } finally {
      write.mockRestore();
    }
  });

  it('@G11 tool-keyed tables have no prototype: a hostile name cannot reach Object.prototype', async () => {
    const { resolved } = await serve({ tools: [{ name: 'ok', inputSchema: OBJECT_SCHEMA }] });
    expect(Object.getPrototypeOf(resolved.pkg.fns)).toBeNull();
    expect((resolved.pkg.fns as Record<string, unknown>)['toString']).toBeUndefined();
    expect(resolved.mcp?.tools).toBeInstanceOf(Map);
    await resolved.dispose();
  });
});

describe('Feature: the upstream is called verbatim', () => {
  it('@S7.2 callTool passes arguments exactly as given (undeclared properties included) and returns the upstream result verbatim', async () => {
    const { resolved, stub } = await serve(
      {
        tools: [
          {
            name: 'echo',
            inputSchema: OBJECT_SCHEMA,
            result: (args) => ({
              content: [{ type: 'text', text: 'echoed' }],
              structuredContent: { seen: args },
              isError: true,
            }),
          },
        ],
      },
      { name: 'e' }
    );
    const args = { path: '/a', undeclared: { deep: [1, { two: 2 }] } };
    const result = await resolved.mcp!.callTool('echo', args);
    expect(stub.calls).toEqual([{ tool: 'echo', args }]);
    expect(result).toEqual({ content: [{ type: 'text', text: 'echoed' }], structuredContent: { seen: args }, isError: true });
    await resolved.dispose();
  });

  it('@S7.2 an isError result is data, not a rejection; an upstream JSON-RPC error rejects as McpError with its code', async () => {
    const { resolved } = await serve(
      {
        tools: [
          { name: 'soft', inputSchema: OBJECT_SCHEMA, result: () => ({ content: [{ type: 'text', text: 'denied by upstream' }], isError: true }) },
          { name: 'hard', inputSchema: OBJECT_SCHEMA, rpcError: { code: -32602, message: 'bad things' } },
        ],
      },
      { name: 'u' }
    );
    await expect(resolved.mcp!.callTool('soft')).resolves.toMatchObject({ isError: true });
    const err = await resolved.mcp!.callTool('hard').catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(-32602);
    expect(err.message).toContain('bad things');
    await resolved.dispose();
  });

  it('@positional the positional fns table rebuilds arguments by declared property order (for apigen hosts)', async () => {
    const { resolved, stub } = await serve(
      { tools: [{ name: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' }, head: { type: 'number' } } } }] },
      { name: 'r' }
    );
    await resolved.pkg.fns['read']!('/a', 3);
    await resolved.pkg.fns['read']!('/b', undefined);
    expect(stub.calls.map((c) => c.args)).toEqual([{ path: '/a', head: 3 }, { path: '/b' }]);
    await resolved.dispose();
  });
});

describe('Feature: a failed handshake refuses to serve — fail closed (D-08)', () => {
  it('@S7.fail an initialize error is handshake-failed, the process is killed, nothing falls back to argv', async () => {
    const stub = createStubMcpUpstream({ initialize: 'error', tools: [{ name: 't', inputSchema: OBJECT_SCHEMA }] });
    const err = await failureOf(
      resolveSource({ kind: 'bin', command: 'node' }, 'serve', { launcher: stub.launcher, cwd: '/w' })
    );
    expect(err.code).toBe('handshake-failed');
    expect(err.message).toContain('initialize refused');
    expect(stub.started).toHaveLength(1); // started once to serve; never restarted as an argv command
    expect(stub.proc().kills).toContain('SIGTERM');
    expect(stub.proc().stdinEnded).toBe(true);
    expect(stub.calls).toEqual([]);
  });

  it('@S7.fail an upstream that never answers initialize times out at handshakeTimeoutMs and is killed', async () => {
    vi.useFakeTimers();
    const stub = createStubMcpUpstream({ initialize: 'silent', tools: [] });
    const pending = failureOf(
      resolveSource({ kind: 'bin', command: 'node' }, 'serve', {
        launcher: stub.launcher,
        cwd: '/w',
        handshakeTimeoutMs: 250,
      })
    );
    await vi.advanceTimersByTimeAsync(249);
    expect(stub.proc().kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const err = await pending;
    expect(err.code).toBe('handshake-failed');
    expect(stub.proc().kills).toContain('SIGTERM');
  });

  it('@S7.fail an upstream that exits before answering is handshake-failed and its stderr is quoted', async () => {
    const stub = createStubMcpUpstream({ initialize: 'silent', tools: [], bootStderr: 'Error: missing config\n' });
    const pending = failureOf(
      resolveSource({ kind: 'bin', command: 'node' }, 'serve', { launcher: stub.launcher, cwd: '/w' })
    );
    await flush();
    stub.proc().exit(1);
    const err = await pending;
    expect(err.code).toBe('handshake-failed');
    expect(err.message).toContain('stderr: Error: missing config');
  });

  it('@S7.fail a tools/list failure is handshake-failed and the process is killed', async () => {
    const stub = createStubMcpUpstream({ listTools: 'error', tools: [] });
    const err = await failureOf(
      resolveSource({ kind: 'bin', command: 'node' }, 'serve', { launcher: stub.launcher, cwd: '/w' })
    );
    expect(err.code).toBe('handshake-failed');
    expect(err.message).toContain('tools/list');
    expect(stub.proc().kills).toContain('SIGTERM');
  });

  it('@S7.fail a command that cannot start is spawn-failed (the launcher\'s own error is not swallowed)', async () => {
    const stub = createStubMcpUpstream({ failStart: true, tools: [] });
    const err = await failureOf(
      resolveSource({ kind: 'bin', command: 'nope' }, 'serve', { launcher: stub.launcher, cwd: '/w' })
    );
    expect(err.code).toBe('spawn-failed');
  });
});

describe('Feature: lifecycle of the upstream process', () => {
  it('@G8 dispose ends stdin, kills the process, and is idempotent', async () => {
    const { resolved, stub } = await serve({ tools: [{ name: 't', inputSchema: OBJECT_SCHEMA }] });
    await resolved.dispose();
    await resolved.dispose();
    expect(stub.proc().stdinEnded).toBe(true);
    expect(stub.proc().kills).toEqual(['SIGTERM']);
    expect(stub.proc().hasExited).toBe(true);
  });

  it('@G8 mcp.onClose fires when the upstream exits on its own, and immediately for a late listener', async () => {
    const { resolved, stub } = await serve({ tools: [{ name: 't', inputSchema: OBJECT_SCHEMA }] });
    const early = vi.fn();
    resolved.mcp!.onClose(early);
    expect(early).not.toHaveBeenCalled();
    stub.proc().exit(0);
    await flush();
    expect(early).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    resolved.mcp!.onClose(late);
    await flush();
    expect(late).toHaveBeenCalledTimes(1);
    expect(early).toHaveBeenCalledTimes(1);
    await resolved.dispose();
  });

  it('@G8 a call to an upstream that died rejects instead of hanging', async () => {
    const { resolved, stub } = await serve({ tools: [{ name: 't', inputSchema: OBJECT_SCHEMA }] });
    stub.proc().exit(0);
    await flush();
    await expect(resolved.mcp!.callTool('t', {})).rejects.toThrow();
    await resolved.dispose();
  });

  it('@G9 a per-call timeout (callTimeoutMs) rejects a call the upstream never answers', async () => {
    vi.useFakeTimers();
    const stub = createStubMcpUpstream({ tools: [{ name: 'slow', inputSchema: OBJECT_SCHEMA, silent: true }] });
    const resolved = await resolveSource({ kind: 'bin', command: 'node' }, 'serve', {
      launcher: stub.launcher,
      cwd: '/w',
      callTimeoutMs: 500,
      onWarn: () => undefined,
    });
    const outcome = resolved.mcp!.callTool('slow', {}).catch((e) => e);
    await vi.advanceTimersByTimeAsync(500);
    const err = await outcome;
    expect(err).toBeInstanceOf(McpError);
    expect(err.message).toMatch(/timed out/i);
    await resolved.dispose();
  });

  it('@G8 a per-call AbortSignal cancels the upstream request', async () => {
    const stub = createStubMcpUpstream({ tools: [{ name: 'slow', inputSchema: OBJECT_SCHEMA, silent: true }] });
    const resolved = await resolveSource({ kind: 'bin', command: 'node' }, 'serve', {
      launcher: stub.launcher,
      cwd: '/w',
      onWarn: () => undefined,
    });
    const ac = new AbortController();
    const outcome = resolved.mcp!.callTool('slow', {}, ac.signal).catch((e) => e);
    await flush();
    expect(stub.calls).toHaveLength(1);
    ac.abort(new Error('host cancelled'));
    const err = await outcome;
    expect(String(err.message ?? err)).toContain('host cancelled');
    await resolved.dispose();
  });
});
