// guards: the MCP passthrough forwards a tools/call to the upstream that the policy Layer refused, drops or rewrites an upstream result or error, or outlives the host's stdin EOF
// tier: S
// cites: T08b and T17 @S7.2 (gateway side), D-21, REVIEW-FIXES G2 G3 G4 G5 G7 G8

/* eslint-disable @typescript-eslint/no-non-null-assertion -- specs index arrays/maps the test has just arranged; a miss would fail the very next assertion */
// serveMcpPassthrough (D-21, T08b, T17 @S7.2 gateway side, REVIEW-FIXES G2 G3 G4 G5 G7 G8).
//
// A real SDK `Client` talks to the real passthrough `Server` over the SDK's InMemoryTransport
// pair; the upstream is the in-process stub behind a fake IProcessLauncher (it declares
// serverInfo.name = 'liar-name' and logs every tools/call it receives). Only the process
// boundary is faked. The Layer is a hand-written `--use` plugin standing in for the policy
// Layer (its own tests live with it).

import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@adhd/apigen-base-errors';
import { LayerContext } from '@adhd/apigen-engine-runtime';
import type { Call, UsePlugin } from '@adhd/apigen-engine-runtime';
import {
  createStdioHostTransport,
  resolveSource,
  serveMcpPassthrough,
  type IPassthroughErrorContext,
  type IPassthroughServer,
  type IResolvedSource,
} from '../index';
import { createFakeLauncher } from './helpers/fake-launcher';
import { flush, settle } from './helpers/flush';
import { createStubMcpUpstream } from './helpers/stub-mcp-upstream';
import type { IStubOptions, IStubMcpUpstream } from './helpers/stub-mcp-upstream';

const FILE_SCHEMA = {
  type: 'object',
  properties: { path: { type: 'string' }, head: { type: 'number' } },
  required: ['path'],
};

const TOOLS: IStubOptions['tools'] = [
  {
    name: 'read_file',
    title: 'Read a file',
    description: 'Reads a file',
    inputSchema: FILE_SCHEMA,
    outputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    annotations: { readOnlyHint: true },
    result: (args) => ({ content: [{ type: 'text', text: `read ${String(args?.['path'])}` }], structuredContent: { text: 'contents' } }),
  },
  { name: 'write_file', description: 'Writes a file', inputSchema: FILE_SCHEMA, annotations: { destructiveHint: true } },
  { name: 'ping', inputSchema: { type: 'object', properties: {} } },
];

type LayerFn = (call: Call, next: () => Promise<unknown>) => Promise<unknown>;

function plugin(id: string, layer: LayerFn): UsePlugin {
  return { id, capabilities: { layer: { layer: (call, next) => layer(call as Call, next) } } };
}

/** A policy-shaped Layer: refuses the listed operation ids with a permission_denied ApiError. */
function denying(ids: readonly string[], seen: Call[] = []): UsePlugin {
  return plugin('deny', async (call, next) => {
    seen.push(call);
    if (ids.includes(call.operation.id)) {
      throw new ApiError('permission_denied', `permission_denied: ${call.operation.id} is not allowed`);
    }
    return next();
  });
}

interface IRig {
  stub: IStubMcpUpstream;
  source: IResolvedSource;
  client: Client;
  server: IPassthroughServer;
  abort: AbortController;
  errors: Array<{ error: unknown; ctx: IPassthroughErrorContext }>;
  hostClosed: () => number;
}

const rigs: IRig[] = [];

async function rig(
  options: { stub?: Partial<IStubOptions>; plugins?: readonly UsePlugin[]; name?: string } = {}
): Promise<IRig> {
  const stub = createStubMcpUpstream({ tools: TOOLS, ...options.stub });
  const source = await resolveSource({ kind: 'bin', command: 'node' }, 'serve', {
    launcher: stub.launcher,
    cwd: '/w',
    name: options.name ?? 'files',
    onWarn: () => undefined,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const abort = new AbortController();
  const errors: IRig['errors'] = [];
  const server = await serveMcpPassthrough({
    source,
    usePlugins: options.plugins ?? [],
    serverInfo: { name: 'adhd-policy', version: '0.0.0-test' },
    transport: serverTransport,
    signal: abort.signal,
    onError: (error, ctx) => errors.push({ error, ctx }),
  });
  const client = new Client({ name: 'host', version: '0.0.0' }, { capabilities: {} });
  let closed = 0;
  client.onclose = () => {
    closed += 1;
  };
  await client.connect(clientTransport);
  const r: IRig = { stub, source, client, server, abort, errors, hostClosed: () => closed };
  rigs.push(r);
  return r;
}

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    r.abort.abort();
    await r.server.closed;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const textOf = (r: CallToolResult): string => (r.content[0] as { text: string }).text;

describe('Feature: tools/list shows the upstream tools unchanged (D-08, G4)', () => {
  it('@S7.2 the host sees the upstream tool objects verbatim: names, title, description, schemas, annotations', async () => {
    const { client, source } = await rig({ plugins: [denying(['files.write_file'])] });
    const listed = await client.listTools();
    expect(listed.tools).toEqual([...(source.mcp?.tools.values() ?? [])]);
    expect(listed.tools.map((t) => t.name)).toEqual(['read_file', 'write_file', 'ping']);
    const read = listed.tools[0]!;
    expect(read).toMatchObject({
      title: 'Read a file',
      description: 'Reads a file',
      inputSchema: FILE_SCHEMA,
      outputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      annotations: { readOnlyHint: true },
    });
  });

  it('@S7.2 a tool the policy would deny is still listed (the call is refused, the tool is not hidden)', async () => {
    const { client } = await rig({ plugins: [denying(['files.write_file'])] });
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('write_file');
  });

  it('@G2 names are the upstream names, never prefixed with the source name or serverInfo.name', async () => {
    const { client } = await rig({ name: 'evil' });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(['read_file', 'write_file', 'ping']);
    expect(JSON.stringify(names)).not.toContain('liar');
  });

  it('@G6 a bad upstream tool is skipped, never advertised, and the rest are served', async () => {
    const { client, stub } = await rig({
      stub: {
        tools: [
          { name: '__proto__', inputSchema: FILE_SCHEMA },
          { name: 'bad', inputSchema: { type: 'string' } },
          { name: 'good', inputSchema: FILE_SCHEMA },
        ],
      },
    });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['good']);
    await expect(client.callTool({ name: 'bad', arguments: {} })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(stub.calls).toEqual([]);
  });

  it('@S7.2 the host\'s initialize shows the gateway\'s own serverInfo, not the upstream\'s', async () => {
    const { client } = await rig();
    expect(client.getServerVersion()).toMatchObject({ name: 'adhd-policy', version: '0.0.0-test' });
  });
});

describe('Feature: the allowed call reaches the upstream untouched (G5)', () => {
  it('@S7.2 the Layer sees <sourceName>.<tool> and the FLAT arguments; the upstream gets them verbatim and its result comes back verbatim', async () => {
    const seen: Call[] = [];
    const snapshots: Array<{ id: string; args: unknown; transport: unknown; envelope: unknown; safe: unknown }> = [];
    const watcher = plugin('watch', async (call, next) => {
      seen.push(call);
      snapshots.push({
        id: call.operation.id,
        args: structuredClone(call.domainArgs),
        transport: call.transport,
        envelope: structuredClone(call.envelope),
        safe: call.operation.safe,
      });
      return next();
    });
    const { client, stub } = await rig({ plugins: [watcher] });
    const args = { path: '/etc/hosts', head: 2, undeclared: { deep: [1, { two: 2 }] } };

    const result = (await client.callTool({ name: 'read_file', arguments: args })) as CallToolResult;

    expect(snapshots).toEqual([{ id: 'files.read_file', args, transport: 'mcp', envelope: {}, safe: false }]);
    expect(seen[0]!.ctx).toBeInstanceOf(LayerContext);
    expect(stub.calls).toEqual([{ tool: 'read_file', args }]);
    expect(result.content).toEqual([{ type: 'text', text: 'read /etc/hosts' }]);
    expect(result.structuredContent).toEqual({ text: 'contents' });
  });

  it('@G5 no positional dispatch and no validate layer: arguments that violate the upstream schema are forwarded as given', async () => {
    const { client, stub } = await rig();
    const args = { path: 42, extra: true };
    await client.callTool({ name: 'write_file', arguments: args });
    expect(stub.calls).toEqual([{ tool: 'write_file', args }]);
  });

  it('@G5 a call without arguments reaches the upstream without arguments', async () => {
    const { client, stub } = await rig();
    await client.callTool({ name: 'ping' });
    expect(stub.calls).toEqual([{ tool: 'ping', args: undefined }]);
  });

  it('@S7.2 a Layer that forces a value (policy "set") changes what the upstream receives', async () => {
    const forcer = plugin('force', async (call, next) => {
      call.domainArgs['tag'] = 'policy';
      return next();
    });
    const { client, stub } = await rig({ plugins: [forcer] });
    await client.callTool({ name: 'write_file', arguments: { path: '/a', tag: 'mine' } });
    expect(stub.calls).toEqual([{ tool: 'write_file', args: { path: '/a', tag: 'policy' } }]);
  });

  it('@S7.2 a forced value reaches the upstream even when the host sent NO arguments', async () => {
    const forcer = plugin('force', async (call, next) => {
      call.domainArgs['tag'] = 'policy';
      return next();
    });
    const { client, stub } = await rig({ plugins: [forcer] });
    await client.callTool({ name: 'ping' });
    expect(stub.calls).toEqual([{ tool: 'ping', args: { tag: 'policy' } }]);
  });

  it('@G5 an upstream isError result is returned as the upstream returned it', async () => {
    const { client } = await rig({
      stub: {
        tools: [{ name: 'soft', inputSchema: FILE_SCHEMA, result: () => ({ content: [{ type: 'text', text: 'no such file' }], isError: true }) }],
      },
    });
    const result = (await client.callTool({ name: 'soft', arguments: {} })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('no such file');
  });
});

describe('Feature: Layers run on every tools/call and a denial never reaches the upstream', () => {
  it('@S7.2 a denied call is an isError result carrying the reason; the upstream call count is 0', async () => {
    const { client, stub } = await rig({ plugins: [denying(['files.write_file'])] });
    const result = (await client.callTool({ name: 'write_file', arguments: { path: '/a' } })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('permission_denied: files.write_file is not allowed');
    expect(stub.calls).toHaveLength(0);
  });

  it('@S7.2 the Layer runs per call: allowed, denied and allowed again leave exactly the allowed calls upstream', async () => {
    const seen: Call[] = [];
    const { client, stub } = await rig({ plugins: [denying(['files.write_file'], seen)] });
    await client.callTool({ name: 'read_file', arguments: { path: '/1' } });
    await client.callTool({ name: 'write_file', arguments: { path: '/2' } });
    await client.callTool({ name: 'read_file', arguments: { path: '/3' } });
    expect(seen.map((c) => c.operation.id)).toEqual(['files.read_file', 'files.write_file', 'files.read_file']);
    expect(stub.calls.map((c) => c.args)).toEqual([{ path: '/1' }, { path: '/3' }]);
    expect(new Set(seen.map((c) => c.ctx)).size).toBe(3); // a fresh LayerContext per call
  });

  it('@S7.2 the first plugin is outermost; a denial by the inner one unwinds through the outer', async () => {
    const trace: string[] = [];
    const outer = plugin('outer', async (_c, next) => {
      trace.push('outer-in');
      try {
        return await next();
      } finally {
        trace.push('outer-out');
      }
    });
    const inner = plugin('inner', async (call, next) => {
      trace.push('inner-in');
      if (call.operation.id === 'files.write_file') throw new ApiError('permission_denied', 'inner says no');
      return next();
    });
    const { client, stub } = await rig({ plugins: [outer, inner] });
    const result = (await client.callTool({ name: 'write_file', arguments: {} })) as CallToolResult;
    expect(textOf(result)).toBe('inner says no');
    expect(trace).toEqual(['outer-in', 'inner-in', 'outer-out']);
    expect(stub.calls).toHaveLength(0);
  });

  it('@S7.2 a plugin without a layer capability contributes nothing', async () => {
    const { client, stub } = await rig({ plugins: [{ id: 'mount-only', capabilities: {} }, { id: 'bare' }] });
    await client.callTool({ name: 'ping' });
    expect(stub.calls).toHaveLength(1);
  });

  it('@S7.2 with NO Layer at all the call goes straight through (the negative control for every refusal above)', async () => {
    const { client, stub } = await rig();
    const result = (await client.callTool({ name: 'write_file', arguments: { path: '/a' } })) as CallToolResult;
    expect(result.isError).toBeUndefined();
    expect(stub.calls).toHaveLength(1);
  });

  it('@S7.2 an unknown tool is a JSON-RPC InvalidParams error and no Layer or upstream call happens', async () => {
    const seen: Call[] = [];
    const { client, stub } = await rig({ plugins: [denying([], seen)] });
    const err = await client.callTool({ name: 'nope', arguments: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(ErrorCode.InvalidParams);
    expect(seen).toHaveLength(0);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('Feature: failures are generic to the host and detailed to onError (G7)', () => {
  it('@G7 a Layer crash is a generic isError result, reaches onError with tool and operation id, and the upstream is not called', async () => {
    const boom = plugin('boom', async () => {
      throw new Error('db password is hunter2');
    });
    const { client, stub, errors } = await rig({ plugins: [boom] });
    const result = (await client.callTool({ name: 'read_file', arguments: { path: '/secret' } })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('The tool call failed.');
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.ctx).toEqual({ tool: 'read_file', operationId: 'files.read_file' });
    expect((errors[0]!.error as Error).message).toBe('db password is hunter2');
    expect(stub.calls).toHaveLength(0);
  });

  it('@G7 a refusal is NOT an error: onError is not called for permission_denied', async () => {
    const { client, errors } = await rig({ plugins: [denying(['files.write_file'])] });
    await client.callTool({ name: 'write_file', arguments: {} });
    expect(errors).toEqual([]);
  });

  it('@G7 an ApiError that is not a denial is still generic', async () => {
    const { client, errors } = await rig({
      plugins: [plugin('nf', async () => { throw new ApiError('not_found', 'record 7 is missing'); })],
    });
    const result = (await client.callTool({ name: 'ping' })) as CallToolResult;
    expect(textOf(result)).toBe('The tool call failed.');
    expect(errors).toHaveLength(1);
  });

  it('@G7 an error the UPSTREAM returned (JSON-RPC) reaches the host with its code and its message once', async () => {
    const { client, errors } = await rig({
      stub: { tools: [{ name: 'hard', inputSchema: FILE_SCHEMA, rpcError: { code: -32602, message: 'path must be absolute' } }] },
    });
    const err = await client.callTool({ name: 'hard', arguments: { path: 'rel' } }).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(-32602);
    expect(err.message.endsWith('path must be absolute')).toBe(true);
    expect(err.message.split('path must be absolute')).toHaveLength(2); // the message once
    // the SDK client and server each add one "MCP error <code>:" prefix; the gateway's own
    // re-raise strips the one it received from the upstream, so it never triples
    expect(err.message.match(/MCP error -32602:/g)?.length).toBeLessThanOrEqual(2);
    expect(errors).toHaveLength(1);
  });

  it('@G7 a throwing onError cannot change what the host sees', async () => {
    const stub = createStubMcpUpstream({ tools: TOOLS });
    const source = await resolveSource({ kind: 'bin', command: 'node' }, 'serve', { launcher: stub.launcher, cwd: '/w' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const abort = new AbortController();
    const server = await serveMcpPassthrough({
      source,
      usePlugins: [plugin('boom', async () => { throw new Error('x'); })],
      serverInfo: { name: 's', version: '1' },
      transport: serverTransport,
      signal: abort.signal,
      onError: () => {
        throw new Error('reporter exploded');
      },
    });
    const client = new Client({ name: 'h', version: '1' }, { capabilities: {} });
    await client.connect(clientTransport);
    const result = (await client.callTool({ name: 'ping' })) as CallToolResult;
    expect(textOf(result)).toBe('The tool call failed.');
    abort.abort();
    await server.closed;
  });

  it('@G7 the default reporter writes ONE stderr line with the tool and error class, never argument values', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stub = createStubMcpUpstream({ tools: TOOLS });
    const source = await resolveSource({ kind: 'bin', command: 'node' }, 'serve', { launcher: stub.launcher, cwd: '/w' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const abort = new AbortController();
    const server = await serveMcpPassthrough({
      source,
      usePlugins: [plugin('boom', async () => { throw new ApiError('internal', 'x'); })],
      serverInfo: { name: 's', version: '1' },
      transport: serverTransport,
      signal: abort.signal,
    });
    const client = new Client({ name: 'h', version: '1' }, { capabilities: {} });
    await client.connect(clientTransport);
    await client.callTool({ name: 'read_file', arguments: { path: '/very-secret-value' } });
    const lines = write.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('apigen-gateway: tool call failed'));
    expect(lines).toEqual(['apigen-gateway: tool call failed: tool=read_file error=ApiError code=internal\n']);
    expect(lines.join('')).not.toContain('very-secret-value');
    abort.abort();
    await server.closed;
  });
});

describe('Feature: cancellation reaches the Layer and the upstream (G8)', () => {
  it('@G8 the host cancelling a request aborts Call.signal', async () => {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const outcomes: boolean[] = [];
    const waiting = plugin('wait', async (call) => {
      enter();
      await new Promise<void>((resolve) => call.signal?.addEventListener('abort', () => resolve(), { once: true }));
      outcomes.push(call.signal?.aborted === true);
      throw new Error('cancelled');
    });
    const { client, stub } = await rig({ plugins: [waiting] });
    const ac = new AbortController();
    const pending = client.callTool({ name: 'ping' }, undefined, { signal: ac.signal }).catch((e) => e);
    await entered;
    ac.abort(new Error('user pressed stop'));
    await pending;
    await settle();
    expect(outcomes).toEqual([true]);
    expect(stub.calls).toHaveLength(0);
  });

  it('@G8 the server shutting down aborts Call.signal of a call in flight', async () => {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const aborted: boolean[] = [];
    const waiting = plugin('wait', async (call) => {
      enter();
      await new Promise<void>((resolve) => call.signal?.addEventListener('abort', () => resolve(), { once: true }));
      aborted.push(call.signal?.aborted === true);
      throw new Error('shutting down');
    });
    const r = await rig({ plugins: [waiting] });
    const pending = r.client.callTool({ name: 'ping' }).catch((e) => e);
    await entered;
    r.abort.abort();
    await r.server.closed;
    await pending;
    expect(aborted).toEqual([true]);
  });

  it('@G8 a call already forwarded to the upstream is cancelled upstream when the host cancels', async () => {
    const r = await rig({ stub: { tools: [{ name: 'slow', inputSchema: FILE_SCHEMA, silent: true }] } });
    const ac = new AbortController();
    const pending = r.client.callTool({ name: 'slow', arguments: {} }, undefined, { signal: ac.signal }).catch((e) => e);
    await settle();
    expect(r.stub.calls).toHaveLength(1);
    ac.abort(new Error('stop'));
    await pending;
    await settle();
    // the upstream request was abandoned: a later call on the same connection still works
    expect((await r.client.listTools()).tools).toHaveLength(1);
  });
});

describe('Feature: lifecycle — the server and the upstream live and die together (G8)', () => {
  it('@G8 the host disconnecting shuts the server down and disposes the upstream process', async () => {
    const r = await rig();
    await r.client.close();
    await r.server.closed;
    expect(r.stub.proc().stdinEnded).toBe(true);
    expect(r.stub.proc().kills).toEqual(['SIGTERM']);
    expect(r.stub.proc().hasExited).toBe(true);
  });

  it('@G8 the upstream exiting on its own closes the server: the host sees a disconnect and `closed` settles', async () => {
    const r = await rig();
    r.stub.proc().exit(3);
    await r.server.closed;
    await settle();
    expect(r.hostClosed()).toBe(1);
    expect(r.stub.proc().kills).toEqual([]);
  });

  it('@G8 aborting the signal closes the server, disposes the source, and closes the host connection', async () => {
    const r = await rig();
    r.abort.abort();
    await r.server.closed;
    await settle();
    expect(r.stub.proc().kills[0]).toBe('SIGTERM');
    expect(r.hostClosed()).toBe(1);
  });

  it('@G8 an already-aborted signal disposes the source and never connects', async () => {
    const stub = createStubMcpUpstream({ tools: TOOLS });
    const source = await resolveSource({ kind: 'bin', command: 'node' }, 'serve', { launcher: stub.launcher, cwd: '/w' });
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const startSpy = vi.spyOn(serverTransport, 'start');
    const abort = new AbortController();
    abort.abort();
    const server = await serveMcpPassthrough({
      source,
      usePlugins: [],
      serverInfo: { name: 's', version: '1' },
      transport: serverTransport,
      signal: abort.signal,
    });
    await server.closed;
    expect(startSpy).not.toHaveBeenCalled();
    expect(stub.proc().kills[0]).toBe('SIGTERM');
  });

  it('@G8 a transport that fails to connect rejects and still disposes the source', async () => {
    const stub = createStubMcpUpstream({ tools: TOOLS });
    const source = await resolveSource({ kind: 'bin', command: 'node' }, 'serve', { launcher: stub.launcher, cwd: '/w' });
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    vi.spyOn(serverTransport, 'start').mockRejectedValue(new Error('stdio unavailable'));
    await expect(
      serveMcpPassthrough({
        source,
        usePlugins: [],
        serverInfo: { name: 's', version: '1' },
        transport: serverTransport,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('stdio unavailable');
    expect(stub.proc().kills[0]).toBe('SIGTERM');
  });

  it('@G8 a source that is not an MCP source is a TypeError and is disposed (fail closed)', async () => {
    const launcher = createFakeLauncher();
    const argvSource = await resolveSource({ kind: 'bin', command: 'touch' }, 'run', { launcher, cwd: '/w' });
    const dispose = vi.spyOn(argvSource, 'dispose');
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    await expect(
      serveMcpPassthrough({
        source: argvSource,
        usePlugins: [],
        serverInfo: { name: 's', version: '1' },
        transport: serverTransport,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(TypeError);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('@S7.fail a handshake failure means there is no source to serve: serve refuses before any server exists', async () => {
    const stub = createStubMcpUpstream({ initialize: 'error', tools: TOOLS });
    await expect(
      resolveSource({ kind: 'bin', command: 'node' }, 'serve', { launcher: stub.launcher, cwd: '/w' })
    ).rejects.toMatchObject({ code: 'handshake-failed' });
    expect(stub.proc().hasExited).toBe(true);
  });
});

describe('Feature: serve over real stdio framing — stdin closing tears the upstream down (G8)', () => {
  /** Speaks newline-delimited JSON-RPC to the gateway's stdio host transport through two pipes. */
  async function stdioRig(plugins: readonly UsePlugin[] = []) {
    const stub = createStubMcpUpstream({ tools: TOOLS });
    const source = await resolveSource({ kind: 'bin', command: 'node' }, 'serve', {
      launcher: stub.launcher,
      cwd: '/w',
      name: 'files',
    });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const lines: Array<Record<string, unknown>> = [];
    let buffered = '';
    stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
        lines.push(JSON.parse(buffered.slice(0, nl)) as Record<string, unknown>);
        buffered = buffered.slice(nl + 1);
      }
    });
    const server = await serveMcpPassthrough({
      source,
      usePlugins: plugins,
      serverInfo: { name: 'adhd-policy', version: '1' },
      transport: createStdioHostTransport(stdin, stdout),
      signal: new AbortController().signal,
    });
    const send = async (message: Record<string, unknown>): Promise<void> => {
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
      await settle();
    };
    return { stub, stdin, lines, server, send };
  }

  it('@G8 initialize, list and a refused call work over the pipes, then stdin end-of-file disposes the upstream and `closed` settles', async () => {
    const { stub, stdin, lines, server, send } = await stdioRig([denying(['files.write_file'])]);
    await send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'h', version: '1' } } });
    await send({ method: 'notifications/initialized' });
    await send({ id: 2, method: 'tools/list' });
    await send({ id: 3, method: 'tools/call', params: { name: 'write_file', arguments: { path: '/a' } } });

    expect(lines.find((l) => l['id'] === 1)).toMatchObject({ result: { serverInfo: { name: 'adhd-policy' } } });
    const listed = lines.find((l) => l['id'] === 2) as { result: { tools: Array<{ name: string }> } };
    expect(listed.result.tools.map((t) => t.name)).toEqual(['read_file', 'write_file', 'ping']);
    expect(lines.find((l) => l['id'] === 3)).toMatchObject({ result: { isError: true } });
    expect(stub.calls).toHaveLength(0);

    stdin.end();
    await server.closed;
    expect(stub.proc().stdinEnded).toBe(true);
    expect(stub.proc().kills[0]).toBe('SIGTERM');
    expect(stub.proc().hasExited).toBe(true);
  });

  it('@G8 stdin end-of-file before any request also tears the upstream down', async () => {
    const { stub, stdin, server } = await stdioRig();
    stdin.end();
    await server.closed;
    await flush();
    expect(stub.proc().hasExited).toBe(true);
  });
});
