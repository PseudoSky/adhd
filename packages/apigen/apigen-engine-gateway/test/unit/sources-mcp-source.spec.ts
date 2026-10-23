// guards: an MCP upstream's tools/list is translated to anything but IR carrying the host mcp and the binding mcp:<name> (ids under the upstream's own name, a trusted safety hint, lost tool metadata), or a hung, malformed or failing upstream is not reported as the typed gateway unavailable ApiError
// tier: S
// cites: policy-core REMEDIATION-PLAN T-R7 AC1 (R7a), T17 @S7.2 (gateway side), D-08, REVIEW-FIXES G2 G3 G4 G6 G8 G11
// teeth: red: npx vitest run src/test/sources-mcp-source.spec.ts -> exit 1; the mcp-upstream-adapter/extractors mutations below also run this file; its own lifecycle assertions (handshake -> unavailable) fail on an untyped start error

/* eslint-disable @typescript-eslint/no-non-null-assertion -- specs index arrays/maps the test has just arranged; a miss would fail the very next assertion */
// operationsFromMcpTools (the pure translator) and openMcpStdioUpstream (the started, handshaken
// connection), D-08 / T17 @S7.2 gateway side, REVIEW-FIXES G2 G3 G4 G6 G8 G11. The upstream is an
// in-process stub behind a fake IProcessLauncher; no process is spawned. The stub declares
// serverInfo.name = 'liar-name'.

import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@adhd/apigen-base-errors';
import { buildId, tokenize } from '@adhd/apigen-core-client';
import {
  MCP_HOST,
  isGatewayError,
  mcpBindingOf,
  openMcpStdioUpstream,
  operationsFromMcpTools,
} from '../../src/index';
import type { IOpenedMcpUpstream } from '../../src/index';
import { flush } from '../../src/test/helpers/flush';
import { createStubMcpUpstream } from '../../src/test/helpers/stub-mcp-upstream';
import type { IStubOptions } from '../../src/test/helpers/stub-mcp-upstream';

const OBJECT_SCHEMA = { type: 'object', properties: { path: { type: 'string' } } };

/** Opens the stub upstream through the real stdio client; the caller disposes. */
async function open(stubOptions: IStubOptions, deps: { handshakeTimeoutMs?: number; callTimeoutMs?: number } = {}) {
  const stub = createStubMcpUpstream(stubOptions);
  const upstream = await openMcpStdioUpstream({ command: 'node', args: ['stub.js'], cwd: '/w' }, 'mcp:node', {
    launcher: stub.launcher,
    ...deps,
  });
  return { stub, upstream };
}

/** `tools/list` of a stub, translated: what an extractor or the adapter does after `open`. */
async function translate(stubOptions: IStubOptions, name: string) {
  const { stub, upstream } = await open(stubOptions);
  const warnings: string[] = [];
  const translation = operationsFromMcpTools(upstream.rawTools, name, (line) => warnings.push(line));
  return { stub, upstream, warnings, ...translation };
}

async function failureOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    expect(isGatewayError(e)).toBe(true);
    return e as Error & { code: string; details: { gatewayCode: string; host: string; operationId: string } };
  }
  throw new Error('expected the open to fail');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Feature: an MCP upstream translates to IR with a producer tag and a binding (R7a)', () => {
  const tools = [
    { name: 'read_file', inputSchema: OBJECT_SCHEMA },
    { name: 'write_file', inputSchema: OBJECT_SCHEMA },
  ];

  it('@T-R7 the id is the core buildId rendering of source and tool; host is mcp and binding is mcp:<name>', async () => {
    const { operations, upstream } = await translate({ tools }, 'notes');
    expect(operations.map((o) => o.id)).toEqual(['notes/read-file', 'notes/write-file']);
    // the very string the core id builder renders for the same segments (no local re-implementation)
    const ns = { raw: 'notes', words: tokenize('notes') };
    const tail = { raw: 'read_file', words: tokenize('read_file') };
    expect(operations[0]!.id).toBe(buildId(ns, [tail]));
    for (const op of operations) {
      expect(op.host).toBe(MCP_HOST);
      expect(op.host).toBe('mcp');
      expect(op.binding).toBe(mcpBindingOf('notes'));
      expect(op.binding).toBe('mcp:notes');
      expect(op.namespace.raw).toBe('notes');
      expect(op).toMatchObject({ kind: 'action', async: true, streaming: false, hasCtx: false });
    }
    expect(operations[0]!.path[0]!.raw).toBe('read_file'); // the raw upstream tool name rides on the path tail
    await upstream.dispose();
  });

  it('@T-R7 the retired "." separator is gone from every id (BA-5)', async () => {
    const { operations, upstream } = await translate({ tools }, 'notes');
    expect(operations.every((o) => !o.id.includes('.') && o.id.includes('/'))).toBe(true);
    await upstream.dispose();
  });

  it('@G2 the namespace is the name the USER chose; the upstream\'s self-declared name appears nowhere in the IR', async () => {
    const { operations, upstream } = await translate({ tools }, 'files');
    expect(JSON.stringify(operations)).not.toContain('liar');
    expect(operations.every((o) => o.namespace.raw === 'files')).toBe(true);
    await upstream.dispose();
  });

  it('@G2 an upstream tool claiming another source\'s prefix gains no namespace', async () => {
    const { operations, upstream } = await translate(
      { serverName: 'filesystem', tools: [{ name: 'filesystem.read_file', inputSchema: OBJECT_SCHEMA }] },
      'evil'
    );
    expect(operations[0]!.namespace.raw).toBe('evil');
    expect(operations[0]!.id.startsWith('evil/')).toBe(true);
    expect(operations[0]!.path[0]!.raw).toBe('filesystem.read_file');
    await upstream.dispose();
  });

  it('@T-R7 the tool presentation (title, description, outputSchema, annotations) is carried onto Operation.tool', async () => {
    const tool = {
      name: 'read_file',
      title: 'Read a file',
      description: 'Reads a file from disk',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      outputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      annotations: { readOnlyHint: true, idempotentHint: true },
    };
    const { operations, upstream } = await translate({ tools: [tool] }, 'f');
    expect(operations[0]!.tool).toEqual({
      title: 'Read a file',
      description: 'Reads a file from disk',
      outputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      annotations: { readOnlyHint: true, idempotentHint: true },
    });
    expect(operations[0]!.input).toEqual(tool.inputSchema);
    expect(operations[0]!.output).toEqual({}); // the upstream result is a CallToolResult, not an instance of outputSchema
    await upstream.dispose();
  });

  it('@T-R7 a tool with no presentation carries no tool block; an empty description is dropped', () => {
    const { operations } = operationsFromMcpTools(
      [{ name: 'bare', description: '', inputSchema: OBJECT_SCHEMA }],
      'f',
      () => undefined
    );
    expect(operations[0]!.tool).toBeUndefined();
  });

  it('@T-R7 the carried tool objects are copies: mutating the IR cannot reach the upstream tool table', () => {
    const raw = [
      { name: 'a', inputSchema: OBJECT_SCHEMA, annotations: { readOnlyHint: true }, outputSchema: { type: 'object' } },
    ];
    const { operations, tools } = operationsFromMcpTools(raw, 'f', () => undefined);
    (operations[0]!.tool!.annotations as Record<string, unknown>)['readOnlyHint'] = false;
    (operations[0]!.tool!.outputSchema as Record<string, unknown>)['type'] = 'string';
    expect(tools.get('a')!.annotations).toEqual({ readOnlyHint: true });
    expect(tools.get('a')!.outputSchema).toEqual({ type: 'object' });
  });

  it('@G4 the translation keeps the full upstream tool objects by upstream name, in tools/list order', async () => {
    const tool = {
      name: 'read_file',
      title: 'Read a file',
      description: 'Reads a file from disk',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      outputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      annotations: { readOnlyHint: true, idempotentHint: true },
    };
    const { tools: kept, upstream } = await translate({ tools: [tool, { name: 'z', inputSchema: OBJECT_SCHEMA }] }, 'f');
    expect(kept.get('read_file')).toEqual(tool);
    expect([...kept.keys()]).toEqual(['read_file', 'z']);
    await upstream.dispose();
  });

  it('@serve tools/list cursors are followed across pages', async () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, inputSchema: OBJECT_SCHEMA }));
    const { operations, upstream } = await translate({ tools: many, pageSize: 2 }, 'p');
    expect(operations.map((o) => o.id)).toEqual(['p/a', 'p/b', 'p/c', 'p/d', 'p/e']);
    await upstream.dispose();
  });
});

describe('Feature: an upstream hint is never a decision (G3)', () => {
  it('@G3 safe is false for every MCP-sourced operation, even readOnlyHint:true; the hints stay in the side map', async () => {
    const { operations, hints, upstream } = await translate(
      {
        tools: [
          { name: 'read_file', inputSchema: OBJECT_SCHEMA, annotations: { readOnlyHint: true } },
          { name: 'drop_all', inputSchema: OBJECT_SCHEMA, annotations: { destructiveHint: true, readOnlyHint: false } },
          { name: 'plain', inputSchema: OBJECT_SCHEMA },
        ],
      },
      'f'
    );
    expect(operations.map((o) => o.safe)).toEqual([false, false, false]);
    expect(hints).toEqual({
      'f/read-file': { readOnly: true },
      'f/drop-all': { destructive: true, readOnly: false },
    });
    await upstream.dispose();
  });
});

describe('Feature: one bad tool never disables a source (G6, G11)', () => {
  it('@G6 non-object, malformed, duplicate and reserved-name tools are skipped, reported once each, the rest stay usable', async () => {
    const { operations, skipped, warnings, tools, upstream } = await translate(
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
      's'
    );
    expect(operations.map((o) => o.id)).toEqual(['s/good', 's/also-good']);
    expect(skipped).toEqual([
      { tool: 'array_schema', reason: 'non-object inputSchema' },
      { tool: 'string_schema', reason: 'non-object inputSchema' },
      { tool: 'good', reason: 'duplicate tool name' },
      { tool: '__proto__', reason: 'reserved tool name' },
      { tool: 'constructor', reason: 'reserved tool name' },
      { tool: 'prototype', reason: 'reserved tool name' },
    ]);
    expect(warnings).toHaveLength(6);
    expect(warnings[0]).toBe('apigen-gateway: skipping upstream tool "array_schema" of s: non-object inputSchema');
    expect([...tools.keys()]).toEqual(['good', 'also_good']);
    await upstream.dispose();
  });

  it('@G6 two tools whose names render to the same id keep the first and skip the second, naming both', () => {
    const warnings: string[] = [];
    const { operations, skipped } = operationsFromMcpTools(
      [
        { name: 'read_file', inputSchema: OBJECT_SCHEMA },
        { name: 'readFile', inputSchema: OBJECT_SCHEMA },
      ],
      'f',
      (line) => warnings.push(line)
    );
    expect(operations.map((o) => o.id)).toEqual(['f/read-file']);
    expect(skipped).toEqual([
      { tool: 'readFile', reason: 'operation id "f/read-file" already taken by tool "read_file"' },
    ]);
    expect(warnings).toHaveLength(1);
  });

  it('@G6 an entry that is not a tool at all is skipped as <unnamed>; an object-schema tool with a bad field is an invalid definition', () => {
    const { operations, skipped } = operationsFromMcpTools(
      [null, 42, { inputSchema: { type: 'object' } }, { name: 'ok', inputSchema: OBJECT_SCHEMA }, { name: 'bad', inputSchema: { type: 'object' }, title: 7 }],
      'f',
      () => undefined
    );
    expect(operations.map((o) => o.id)).toEqual(['f/ok']);
    expect(skipped).toEqual([
      { tool: '<unnamed>', reason: 'non-object inputSchema' },
      { tool: '<unnamed>', reason: 'non-object inputSchema' },
      { tool: '<unnamed>', reason: 'invalid tool definition' },
      { tool: 'bad', reason: 'invalid tool definition' },
    ]);
  });

  it('@G11 a hostile tool name cannot reach Object.prototype: the table is a Map and the IR is plain data', () => {
    const { tools, operations } = operationsFromMcpTools(
      [{ name: 'ok', inputSchema: OBJECT_SCHEMA }, { name: '__proto__', inputSchema: OBJECT_SCHEMA }],
      'f',
      () => undefined
    );
    expect(tools).toBeInstanceOf(Map);
    expect(tools.has('__proto__')).toBe(false);
    expect(operations).toHaveLength(1);
    expect(({} as Record<string, unknown>)['inputSchema']).toBeUndefined();
  });

  it('@T-R7 a pure translation starts and talks to nothing: it runs on raw data with no launcher at all', () => {
    const { operations } = operationsFromMcpTools([{ name: 't', inputSchema: OBJECT_SCHEMA }], 'remote-ready', () => undefined);
    expect(operations[0]!.binding).toBe('mcp:remote-ready');
  });
});

describe('Feature: the upstream is called verbatim', () => {
  it('@S7.2 callTool passes arguments exactly as given (undeclared properties included) and returns the upstream result verbatim', async () => {
    const { upstream, stub } = await open({
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
    });
    const args = { path: '/a', undeclared: { deep: [1, { two: 2 }] } };
    const result = await upstream.callTool('echo', args);
    expect(stub.calls).toEqual([{ tool: 'echo', args }]);
    expect(result).toEqual({ content: [{ type: 'text', text: 'echoed' }], structuredContent: { seen: args }, isError: true });
    await upstream.dispose();
  });

  it('@S7.2 an isError result is data, not a rejection; an upstream JSON-RPC error rejects as McpError with its code', async () => {
    const { upstream } = await open({
      tools: [
        { name: 'soft', inputSchema: OBJECT_SCHEMA, result: () => ({ content: [{ type: 'text', text: 'denied by upstream' }], isError: true }) },
        { name: 'hard', inputSchema: OBJECT_SCHEMA, rpcError: { code: -32602, message: 'bad things' } },
      ],
    });
    await expect(upstream.callTool('soft')).resolves.toMatchObject({ isError: true });
    const err = await upstream.callTool('hard').catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(-32602);
    expect(err.message).toContain('bad things');
    await upstream.dispose();
  });
});

describe('Feature: a failed handshake refuses to serve — fail closed (D-08)', () => {
  it('@S7.fail an initialize error is the gateway unavailable error for the binding at (start); the process is killed', async () => {
    const stub = createStubMcpUpstream({ initialize: 'error', tools: [{ name: 't', inputSchema: OBJECT_SCHEMA }] });
    const err = await failureOf(
      openMcpStdioUpstream({ command: 'node', args: [], cwd: '/w' }, 'mcp:node', { launcher: stub.launcher })
    );
    expect(err.code).toBe('internal');
    expect(err.details).toMatchObject({ gatewayCode: 'unavailable', host: 'mcp:node', operationId: '(start)' });
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
      openMcpStdioUpstream({ command: 'node', args: [], cwd: '/w' }, 'mcp:node', {
        launcher: stub.launcher,
        handshakeTimeoutMs: 250,
      })
    );
    await vi.advanceTimersByTimeAsync(249);
    expect(stub.proc().kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const err = await pending;
    expect(err.details.gatewayCode).toBe('unavailable');
    expect(stub.proc().kills).toContain('SIGTERM');
  });

  it('@S7.fail an upstream that exits before answering is unavailable and its stderr is quoted', async () => {
    const stub = createStubMcpUpstream({ initialize: 'silent', tools: [], bootStderr: 'Error: missing config\n' });
    const pending = failureOf(
      openMcpStdioUpstream({ command: 'node', args: [], cwd: '/w' }, 'mcp:node', { launcher: stub.launcher })
    );
    await flush();
    stub.proc().exit(1);
    const err = await pending;
    expect(err.details.gatewayCode).toBe('unavailable');
    expect(err.message).toContain('stderr: Error: missing config');
  });

  it('@S7.fail a tools/list failure is unavailable and the process is killed', async () => {
    const stub = createStubMcpUpstream({ listTools: 'error', tools: [] });
    const err = await failureOf(
      openMcpStdioUpstream({ command: 'node', args: [], cwd: '/w' }, 'mcp:node', { launcher: stub.launcher })
    );
    expect(err.details.gatewayCode).toBe('unavailable');
    expect(err.message).toContain('tools/list');
    expect(stub.proc().kills).toContain('SIGTERM');
  });

  it('@S7.fail a command that cannot start is unavailable for the binding (the launcher\'s own reason is kept)', async () => {
    const stub = createStubMcpUpstream({ failStart: true, tools: [] });
    const err = await failureOf(
      openMcpStdioUpstream({ command: 'nope', args: [], cwd: '/w' }, 'mcp:nope', { launcher: stub.launcher })
    );
    expect(err.details).toMatchObject({ gatewayCode: 'unavailable', host: 'mcp:nope', operationId: '(start)' });
    expect(err.message).toContain('cannot start nope: ENOENT');
  });

  it('@S7.fail an ApiError the launcher itself raised (a confining launcher\'s refusal) passes through unchanged', async () => {
    const apiRefusal = new ApiError('permission_denied', 'sandbox refused');
    const launcher = {
      async start(): Promise<never> {
        throw apiRefusal;
      },
    };
    await expect(
      openMcpStdioUpstream({ command: 'node', args: [], cwd: '/w' }, 'mcp:node', { launcher })
    ).rejects.toBe(apiRefusal);
  });
});

describe('Feature: lifecycle of the upstream process', () => {
  it('@G8 dispose ends stdin, kills the process, and is idempotent', async () => {
    const { upstream, stub } = await open({ tools: [{ name: 't', inputSchema: OBJECT_SCHEMA }] });
    await upstream.dispose();
    await upstream.dispose();
    expect(stub.proc().stdinEnded).toBe(true);
    expect(stub.proc().kills).toEqual(['SIGTERM']);
    expect(stub.proc().hasExited).toBe(true);
    expect(upstream.isClosed()).toBe(true);
  });

  it('@G8 onClose fires when the upstream exits on its own, and (asynchronously) for a late listener', async () => {
    const { upstream, stub } = await open({ tools: [{ name: 't', inputSchema: OBJECT_SCHEMA }] });
    const early = vi.fn();
    upstream.onClose(early);
    expect(early).not.toHaveBeenCalled();
    expect(upstream.isClosed()).toBe(false);
    stub.proc().exit(0);
    await flush();
    expect(early).toHaveBeenCalledTimes(1);
    expect(upstream.isClosed()).toBe(true);
    const late = vi.fn();
    upstream.onClose(late);
    expect(late).not.toHaveBeenCalled(); // never synchronously
    await flush();
    expect(late).toHaveBeenCalledTimes(1);
    expect(early).toHaveBeenCalledTimes(1);
    await upstream.dispose();
  });

  it('@G8 a call to an upstream that died rejects instead of hanging', async () => {
    const { upstream, stub } = await open({ tools: [{ name: 't', inputSchema: OBJECT_SCHEMA }] });
    stub.proc().exit(0);
    await flush();
    await expect(upstream.callTool('t', {})).rejects.toThrow();
    await upstream.dispose();
  });

  it('@G8 ping round-trips while the upstream is up and rejects once it is gone', async () => {
    const { upstream, stub } = await open({ tools: [] });
    await expect(upstream.ping()).resolves.toBeUndefined();
    stub.proc().exit(0);
    await flush();
    await expect(upstream.ping()).rejects.toThrow();
    await upstream.dispose();
  });

  it('@G9 a per-call timeout (callTimeoutMs) rejects a call the upstream never answers with an McpError', async () => {
    vi.useFakeTimers();
    const { upstream } = await open(
      { tools: [{ name: 'slow', inputSchema: OBJECT_SCHEMA, silent: true }] },
      { callTimeoutMs: 500 }
    );
    const outcome = upstream.callTool('slow', {}).catch((e) => e);
    await vi.advanceTimersByTimeAsync(500);
    const err = await outcome;
    expect(err).toBeInstanceOf(McpError);
    expect(err.message).toMatch(/timed out/i);
    await upstream.dispose();
  });

  it('@G8 a per-call AbortSignal cancels the upstream request', async () => {
    const { upstream, stub } = await open({ tools: [{ name: 'slow', inputSchema: OBJECT_SCHEMA, silent: true }] });
    const ac = new AbortController();
    const outcome = upstream.callTool('slow', {}, ac.signal).catch((e) => e);
    await flush();
    expect(stub.calls).toHaveLength(1);
    ac.abort(new Error('host cancelled'));
    const err = await outcome;
    expect(String(err.message ?? err)).toContain('host cancelled');
    await upstream.dispose();
  });

  it('@G8 the serverVersion is read from the upstream, nothing else about it', async () => {
    const { upstream } = await open({ tools: [] });
    expect((upstream as IOpenedMcpUpstream).serverVersion).toBe('9.9.9');
    await upstream.dispose();
  });
});
