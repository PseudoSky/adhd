// guards: the MCP passthrough forwards a tools/call that the policy Layer refused, drops or rewrites an upstream result or error, advertises anything but the BA-1 projection of the IR operations, owns a gateway it was handed, or outlives the host's stdin EOF
// tier: S
// cites: policy-core REMEDIATION-PLAN T-R7 AC1 (R7b, O-8, BA-1, BA-4), T08b and T17 @S7.2 (gateway side), D-21, REVIEW-FIXES G2 G3 G4 G5 G7 G8
// teeth: red: npx vitest run src/test/sources-passthrough.spec.ts -> exit 1; mcp-passthrough-server.ts argv isError spread removed fails "a non-zero exit is an isError result"; gateway.ts routing line mutation fails the two-upstream and verbatim-call tests
// skip-expiry: 44367d92 until 2027-03-31 the it.fails "the host also sees the upstream-authored description and outputSchema" pins a known defect (BUG 44367d92); flip it to it() when fixed

/* eslint-disable @typescript-eslint/no-non-null-assertion -- specs index arrays/maps the test has just arranged; a miss would fail the very next assertion */
// serveMcpPassthrough (D-21, O-8, T08b, T17 @S7.2 gateway side, REVIEW-FIXES G2 G3 G4 G5 G7 G8).
//
// A real SDK `Client` talks to the real passthrough `Server` over the SDK's InMemoryTransport
// pair. The server is handed IR operations and a started gateway; the upstream is the in-process
// stub behind createMcpUpstreamAdapter and a fake IProcessLauncher (it declares serverInfo.name =
// 'liar-name' and logs every tools/call it receives). Only the process boundary is faked. The
// Layer is a hand-written `--use` plugin standing in for the policy Layer (its own tests live
// with it). The caller owns the gateway: the rig stops it, the server never does.

import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@adhd/apigen-base-errors';
import type { Operation } from '@adhd/apigen-core-client';
import { LayerContext } from '@adhd/apigen-engine-runtime';
import type { Call, UsePlugin } from '@adhd/apigen-engine-runtime';
import {
  buildArgvOperation,
  createArgvAdapter,
  createGateway,
  createMcpUpstreamAdapter,
  createStdioHostTransport,
  operationsFromMcpTools,
  serveMcpPassthrough,
  type Gateway,
  type HostAdapter,
  type IPassthroughErrorContext,
  type IPassthroughServer,
} from '../index';
import { createFakeLauncher } from './helpers/fake-launcher';
import { flush, settle } from './helpers/flush';
import { createStubMcpUpstream } from './helpers/stub-mcp-upstream';
import type { IStubOptions, IStubMcpUpstream } from './helpers/stub-mcp-upstream';
import { IMMEDIATE_BACKOFF, openUpstreamRig } from './helpers/upstream-rig';
import type { IUpstreamRig } from './helpers/upstream-rig';

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

/** The BA-1 projection of `files/<tool>`. */
const READ = 'files_read_file';
const WRITE = 'files_write_file';
const PING = 'files_ping';

type LayerFn = (call: Call, next: () => Promise<unknown>) => Promise<unknown>;

function plugin(id: string, layer: LayerFn): UsePlugin {
  return {
    id,
    capabilities: {
      layer: { layer: (call, next) => layer(call as unknown as Call, next as () => Promise<unknown>) },
    },
  };
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
  upstream: IUpstreamRig;
  client: Client;
  server: IPassthroughServer;
  abort: AbortController;
  errors: Array<{ error: unknown; ctx: IPassthroughErrorContext }>;
  hostClosed: () => number;
}

const rigs: IRig[] = [];
const extraStops: Array<() => Promise<void>> = [];

async function rig(
  options: { stub?: Partial<IStubOptions>; plugins?: readonly UsePlugin[]; name?: string } = {}
): Promise<IRig> {
  const upstream = await openUpstreamRig({ tools: TOOLS, ...options.stub }, { name: options.name ?? 'files' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const abort = new AbortController();
  const errors: IRig['errors'] = [];
  const server = await serveMcpPassthrough({
    operations: upstream.adapter.operations(),
    gateway: upstream.gateway,
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
  const r: IRig = { stub: upstream.stub, upstream, client, server, abort, errors, hostClosed: () => closed };
  rigs.push(r);
  return r;
}

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    r.abort.abort();
    await r.server.closed;
    await r.upstream.stop();
  }
  for (const stop of extraStops.splice(0)) await stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const textOf = (r: CallToolResult): string => (r.content[0] as { text: string }).text;

describe('Feature: tools/list advertises the BA-1 projection of the IR operations (D-08, G4)', () => {
  it('@S7.2 one tool per operation, named by the standard projection, with the upstream inputSchema, title and annotations', async () => {
    const { client } = await rig({ plugins: [denying([`files/write-file`])] });
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual([READ, WRITE, PING]);
    const read = listed.tools[0]!;
    expect(read).toMatchObject({ title: 'Read a file', inputSchema: FILE_SCHEMA, annotations: { readOnlyHint: true } });
  });

  // DEFECT (reported, not fixed here): tools/list builds each tool from name, inputSchema, title and
  // annotations only, so the upstream-authored description and outputSchema that the IR carries
  // (Operation.tool, E3) never reach the host. Correct behaviour asserted; fails until it is fixed.
  it('@G4 the host also sees the upstream-authored description and outputSchema of a tool', async () => {
    const { client } = await rig();
    const read = (await client.listTools()).tools[0]!;
    expect(read.description).toBe('Reads a file');
    expect(read.outputSchema).toEqual({ type: 'object', properties: { text: { type: 'string' } } });
  });

  it('@S7.2 a tool the policy would deny is still listed (the call is refused, the tool is not hidden)', async () => {
    const { client } = await rig({ plugins: [denying(['files/write-file'])] });
    expect((await client.listTools()).tools.map((t) => t.name)).toContain(WRITE);
  });

  it('@G2 names derive from the source name the USER chose, never from serverInfo.name', async () => {
    const { client } = await rig({ name: 'evil' });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(['evil_read_file', 'evil_write_file', 'evil_ping']);
    expect(JSON.stringify(names)).not.toContain('liar');
  });

  it('@G6 a bad upstream tool is skipped by the translator, never advertised, and the rest are served', async () => {
    const { client, stub } = await rig({
      stub: {
        tools: [
          { name: '__proto__', inputSchema: FILE_SCHEMA },
          { name: 'bad', inputSchema: { type: 'string' } },
          { name: 'good', inputSchema: FILE_SCHEMA },
        ],
      },
    });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['files_good']);
    await expect(client.callTool({ name: 'bad', arguments: {} })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(client.callTool({ name: 'files_bad', arguments: {} })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(stub.calls).toEqual([]);
  });

  it('@S7.2 the host\'s initialize shows the gateway\'s own serverInfo, not the upstream\'s', async () => {
    const { client } = await rig();
    expect(client.getServerVersion()).toMatchObject({ name: 'adhd-policy', version: '0.0.0-test' });
  });

  it('@BA-1 the raw upstream tool name is not a tool of the served surface (the projection is the only name)', async () => {
    const { client, stub } = await rig();
    await expect(client.callTool({ name: 'read_file', arguments: { path: '/a' } })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
    expect(stub.calls).toEqual([]);
  });
});

describe('Feature: the allowed call reaches the upstream untouched (G5)', () => {
  it('@S7.2 the Layer sees <source>/<tool> and the FLAT arguments; the upstream gets them verbatim under its raw tool name and its result comes back verbatim', async () => {
    const seen: Call[] = [];
    const snapshots: Array<{ id: string; args: unknown; transport: unknown; envelope: unknown; safe: unknown; binding: unknown }> = [];
    const watcher = plugin('watch', async (call, next) => {
      seen.push(call);
      snapshots.push({
        id: call.operation.id,
        args: structuredClone(call.domainArgs),
        transport: call.transport,
        envelope: structuredClone(call.envelope),
        safe: call.operation.safe,
        binding: call.operation.binding,
      });
      return next();
    });
    const { client, stub } = await rig({ plugins: [watcher] });
    const args = { path: '/etc/hosts', head: 2, undeclared: { deep: [1, { two: 2 }] } };

    const result = (await client.callTool({ name: READ, arguments: args })) as CallToolResult;

    expect(snapshots).toEqual([
      { id: 'files/read-file', args, transport: 'mcp', envelope: {}, safe: false, binding: 'mcp:files' },
    ]);
    expect(seen[0]!.ctx).toBeInstanceOf(LayerContext);
    expect(stub.calls).toEqual([{ tool: 'read_file', args }]);
    expect(result.content).toEqual([{ type: 'text', text: 'read /etc/hosts' }]);
    expect(result.structuredContent).toEqual({ text: 'contents' });
  });

  it('@G5 no positional dispatch and no validate layer: arguments that violate the upstream schema are forwarded as given', async () => {
    const { client, stub } = await rig();
    const args = { path: 42, extra: true };
    await client.callTool({ name: WRITE, arguments: args });
    expect(stub.calls).toEqual([{ tool: 'write_file', args }]);
  });

  it('@G5 a call without arguments reaches the upstream with an empty arguments object (the Layer always sees a flat object)', async () => {
    const { client, stub } = await rig();
    await client.callTool({ name: PING });
    expect(stub.calls).toEqual([{ tool: 'ping', args: {} }]);
  });

  it('@S7.2 a Layer that forces a value (policy "set") changes what the upstream receives', async () => {
    const forcer = plugin('force', async (call, next) => {
      call.domainArgs['tag'] = 'policy';
      return next();
    });
    const { client, stub } = await rig({ plugins: [forcer] });
    await client.callTool({ name: WRITE, arguments: { path: '/a', tag: 'mine' } });
    expect(stub.calls).toEqual([{ tool: 'write_file', args: { path: '/a', tag: 'policy' } }]);
  });

  it('@S7.2 a forced value reaches the upstream even when the host sent NO arguments', async () => {
    const forcer = plugin('force', async (call, next) => {
      call.domainArgs['tag'] = 'policy';
      return next();
    });
    const { client, stub } = await rig({ plugins: [forcer] });
    await client.callTool({ name: PING });
    expect(stub.calls).toEqual([{ tool: 'ping', args: { tag: 'policy' } }]);
  });

  it('@G5 an upstream isError result is returned as the upstream returned it', async () => {
    const { client } = await rig({
      stub: {
        tools: [{ name: 'soft', inputSchema: FILE_SCHEMA, result: () => ({ content: [{ type: 'text', text: 'no such file' }], isError: true }) }],
      },
    });
    const result = (await client.callTool({ name: 'files_soft', arguments: {} })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('no such file');
  });
});

describe('Feature: Layers run on every tools/call and a denial never reaches the upstream', () => {
  it('@S7.2 a denied call is an isError result carrying the reason; the upstream call count is 0', async () => {
    const { client, stub } = await rig({ plugins: [denying(['files/write-file'])] });
    const result = (await client.callTool({ name: WRITE, arguments: { path: '/a' } })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('permission_denied: files/write-file is not allowed');
    expect(stub.calls).toHaveLength(0);
  });

  it('@S7.2 the Layer runs per call: allowed, denied and allowed again leave exactly the allowed calls upstream', async () => {
    const seen: Call[] = [];
    const { client, stub } = await rig({ plugins: [denying(['files/write-file'], seen)] });
    await client.callTool({ name: READ, arguments: { path: '/1' } });
    await client.callTool({ name: WRITE, arguments: { path: '/2' } });
    await client.callTool({ name: READ, arguments: { path: '/3' } });
    expect(seen.map((c) => c.operation.id)).toEqual(['files/read-file', 'files/write-file', 'files/read-file']);
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
      if (call.operation.id === 'files/write-file') throw new ApiError('permission_denied', 'inner says no');
      return next();
    });
    const { client, stub } = await rig({ plugins: [outer, inner] });
    const result = (await client.callTool({ name: WRITE, arguments: {} })) as CallToolResult;
    expect(textOf(result)).toBe('inner says no');
    expect(trace).toEqual(['outer-in', 'inner-in', 'outer-out']);
    expect(stub.calls).toHaveLength(0);
  });

  it('@S7.2 a plugin without a layer capability contributes nothing', async () => {
    const { client, stub } = await rig({ plugins: [{ id: 'mount-only', capabilities: {} }, { id: 'bare' }] });
    await client.callTool({ name: PING });
    expect(stub.calls).toHaveLength(1);
  });

  it('@S7.2 with NO Layer at all the call goes straight through (the negative control for every refusal above)', async () => {
    const { client, stub } = await rig();
    const result = (await client.callTool({ name: WRITE, arguments: { path: '/a' } })) as CallToolResult;
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
  it('@G7 a Layer crash is a generic isError result, reaches onError with the projected tool and operation id, and the upstream is not called', async () => {
    const boom = plugin('boom', async () => {
      throw new Error('db password is hunter2');
    });
    const { client, stub, errors } = await rig({ plugins: [boom] });
    const result = (await client.callTool({ name: READ, arguments: { path: '/secret' } })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('The tool call failed.');
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.ctx).toEqual({ tool: READ, operationId: 'files/read-file' });
    expect((errors[0]!.error as Error).message).toBe('db password is hunter2');
    expect(stub.calls).toHaveLength(0);
  });

  it('@G7 a refusal is NOT an error: onError is not called for permission_denied', async () => {
    const { client, errors } = await rig({ plugins: [denying(['files/write-file'])] });
    await client.callTool({ name: WRITE, arguments: {} });
    expect(errors).toEqual([]);
  });

  it('@G7 an ApiError that is not a denial is still generic', async () => {
    const { client, errors } = await rig({
      plugins: [plugin('nf', async () => { throw new ApiError('not_found', 'record 7 is missing'); })],
    });
    const result = (await client.callTool({ name: PING })) as CallToolResult;
    expect(textOf(result)).toBe('The tool call failed.');
    expect(errors).toHaveLength(1);
  });

  it('@G7 an error the UPSTREAM returned (JSON-RPC) reaches the host with its code and its message once', async () => {
    const { client, errors } = await rig({
      stub: { tools: [{ name: 'hard', inputSchema: FILE_SCHEMA, rpcError: { code: -32602, message: 'path must be absolute' } }] },
    });
    const err = await client.callTool({ name: 'files_hard', arguments: { path: 'rel' } }).catch((e) => e);
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
    const upstream = await openUpstreamRig({ tools: TOOLS }, { name: 'files' });
    extraStops.push(upstream.stop);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const abort = new AbortController();
    const server = await serveMcpPassthrough({
      operations: upstream.adapter.operations(),
      gateway: upstream.gateway,
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
    const result = (await client.callTool({ name: PING })) as CallToolResult;
    expect(textOf(result)).toBe('The tool call failed.');
    abort.abort();
    await server.closed;
  });

  it('@G7 the default reporter writes ONE stderr line with the projected tool and error class, never argument values', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const upstream = await openUpstreamRig({ tools: TOOLS }, { name: 'files' });
    extraStops.push(upstream.stop);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const abort = new AbortController();
    const server = await serveMcpPassthrough({
      operations: upstream.adapter.operations(),
      gateway: upstream.gateway,
      usePlugins: [plugin('boom', async () => { throw new ApiError('internal', 'x'); })],
      serverInfo: { name: 's', version: '1' },
      transport: serverTransport,
      signal: abort.signal,
    });
    const client = new Client({ name: 'h', version: '1' }, { capabilities: {} });
    await client.connect(clientTransport);
    await client.callTool({ name: READ, arguments: { path: '/very-secret-value' } });
    const lines = write.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('apigen-gateway: tool call failed'));
    expect(lines).toEqual([`apigen-gateway: tool call failed: tool=${READ} error=ApiError code=internal\n`]);
    expect(lines.join('')).not.toContain('very-secret-value');
    abort.abort();
    await server.closed;
  });
});

describe('Feature: a down upstream is unavailable to the host, not a hang (BA-6)', () => {
  it('@T-R7 the upstream crashing mid-session: after the restart it serves again without the host reconnecting', async () => {
    const r = await rig();
    r.stub.proc().exit(1);
    await flush();
    // IMMEDIATE_BACKOFF restarted it already
    const again = (await r.client.callTool({ name: READ, arguments: { path: '/x' } })) as CallToolResult;
    expect(textOf(again)).toBe('read /x');
    expect(r.stub.started).toHaveLength(2);
  });

  it('@T-R7 while the restart is pending the call is a generic isError result and onError carries the unavailable gateway error', async () => {
    const pendingTimers: Array<() => void> = [];
    const upstream = await openUpstreamRig(
      { tools: TOOLS },
      {
        name: 'files',
        backoff: { delayMs: () => 10, maxRestarts: 2 },
        timers: {
          setTimeout: (fn, ms) => {
            if (ms === 10) pendingTimers.push(fn);
            return fn;
          },
          clearTimeout: () => undefined,
        },
      }
    );
    extraStops.push(upstream.stop);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const abort = new AbortController();
    const errors: unknown[] = [];
    const server = await serveMcpPassthrough({
      operations: upstream.adapter.operations(),
      gateway: upstream.gateway,
      usePlugins: [],
      serverInfo: { name: 's', version: '1' },
      transport: serverTransport,
      signal: abort.signal,
      onError: (error) => errors.push(error),
    });
    const client = new Client({ name: 'h', version: '1' }, { capabilities: {} });
    await client.connect(clientTransport);

    upstream.stub.proc().exit(1);
    await flush();
    expect(pendingTimers).toHaveLength(1);
    const during = (await client.callTool({ name: READ, arguments: { path: '/x' } })) as CallToolResult;
    expect(during.isError).toBe(true);
    expect(textOf(during)).toBe('The tool call failed.');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ details: { gatewayCode: 'unavailable', host: 'mcp:files' } });
    expect(upstream.stub.calls).toEqual([]);

    pendingTimers.shift()!();
    await flush();
    const after = (await client.callTool({ name: READ, arguments: { path: '/x' } })) as CallToolResult;
    expect(textOf(after)).toBe('read /x');
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
    const pending = client.callTool({ name: PING }, undefined, { signal: ac.signal }).catch((e) => e);
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
    const pending = r.client.callTool({ name: PING }).catch((e) => e);
    await entered;
    r.abort.abort();
    await r.server.closed;
    await pending;
    expect(aborted).toEqual([true]);
  });

  it('@G8 a call already forwarded to the upstream is cancelled upstream when the host cancels', async () => {
    const r = await rig({ stub: { tools: [{ name: 'slow', inputSchema: FILE_SCHEMA, silent: true }] } });
    const ac = new AbortController();
    const pending = r.client.callTool({ name: 'files_slow', arguments: {} }, undefined, { signal: ac.signal }).catch((e) => e);
    await settle();
    expect(r.stub.calls).toHaveLength(1);
    ac.abort(new Error('stop'));
    await pending;
    await settle();
    // the upstream request was abandoned: a later request on the same connection still works
    expect((await r.client.listTools()).tools).toHaveLength(1);
  });
});

describe('Feature: lifecycle — the server owns nothing it was handed (O-8)', () => {
  it('@G8 the host disconnecting closes the server and leaves the gateway and its upstream running', async () => {
    const r = await rig();
    await r.client.close();
    await r.server.closed;
    expect(r.stub.proc().kills).toEqual([]);
    expect(r.stub.proc().hasExited).toBe(false);
    expect((await r.upstream.gateway.health()).serving).toBe(true);
    await r.upstream.stop(); // the caller stops the gateway, which stops the upstream
    expect(r.stub.proc().stdinEnded).toBe(true);
    expect(r.stub.proc().kills).toEqual(['SIGTERM']);
    expect(r.stub.proc().hasExited).toBe(true);
  });

  it('@G8 the upstream exiting on its own does NOT close the server: supervision restarts it and the host stays connected', async () => {
    const r = await rig();
    r.stub.proc().exit(3);
    await flush();
    await settle();
    expect(r.hostClosed()).toBe(0);
    expect(r.stub.started).toHaveLength(2);
    expect((await r.client.listTools()).tools).toHaveLength(3);
  });

  it('@G8 aborting the signal closes the server and the host connection, and leaves the gateway to its owner', async () => {
    const r = await rig();
    r.abort.abort();
    await r.server.closed;
    await settle();
    expect(r.hostClosed()).toBe(1);
    expect(r.stub.proc().kills).toEqual([]);
    expect((await r.upstream.gateway.health()).serving).toBe(true);
  });

  it('@G8 an already-aborted signal never connects and never touches the gateway', async () => {
    const upstream = await openUpstreamRig({ tools: TOOLS }, { name: 'files' });
    extraStops.push(upstream.stop);
    const route = vi.spyOn(upstream.gateway, 'route');
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const startSpy = vi.spyOn(serverTransport, 'start');
    const abort = new AbortController();
    abort.abort();
    const server = await serveMcpPassthrough({
      operations: upstream.adapter.operations(),
      gateway: upstream.gateway,
      usePlugins: [],
      serverInfo: { name: 's', version: '1' },
      transport: serverTransport,
      signal: abort.signal,
    });
    await server.closed;
    expect(startSpy).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(upstream.stub.proc().kills).toEqual([]);
  });

  it('@G8 a transport that fails to connect rejects, and the gateway is left running for its owner to stop', async () => {
    const upstream = await openUpstreamRig({ tools: TOOLS }, { name: 'files' });
    extraStops.push(upstream.stop);
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    vi.spyOn(serverTransport, 'start').mockRejectedValue(new Error('stdio unavailable'));
    await expect(
      serveMcpPassthrough({
        operations: upstream.adapter.operations(),
        gateway: upstream.gateway,
        usePlugins: [],
        serverInfo: { name: 's', version: '1' },
        transport: serverTransport,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('stdio unavailable');
    expect(upstream.stub.proc().kills).toEqual([]);
  });

  it('@BA-1 two operations projecting to the same tool name are ApiError invalid_argument naming both, before anything connects', async () => {
    const first = operationsFromMcpTools([{ name: 'c', inputSchema: FILE_SCHEMA }], 'a_b', () => undefined).operations[0]!;
    const second = operationsFromMcpTools([{ name: 'b_c', inputSchema: FILE_SCHEMA }], 'a', () => undefined).operations[0]!;
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const startSpy = vi.spyOn(serverTransport, 'start');
    const gateway = createGateway({ adapters: [] });
    const err = await serveMcpPassthrough({
      operations: [first, second],
      gateway,
      usePlugins: [],
      serverInfo: { name: 's', version: '1' },
      transport: serverTransport,
      signal: new AbortController().signal,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('invalid_argument');
    expect(err.message).toContain(JSON.stringify(first.id));
    expect(err.message).toContain(JSON.stringify(second.id));
    expect(startSpy).not.toHaveBeenCalled();
  });
});

describe('Feature: two upstreams aggregate behind one server', () => {
  it('@T-R7 tools of both upstreams are advertised under their own projections and each call reaches its own upstream', async () => {
    const a = createStubMcpUpstream({
      tools: [{ name: 'add', inputSchema: FILE_SCHEMA, result: () => ({ content: [{ type: 'text', text: 'from-a' }] }) }],
    });
    const b = createStubMcpUpstream({
      tools: [{ name: 'add', inputSchema: FILE_SCHEMA, result: () => ({ content: [{ type: 'text', text: 'from-b' }] }) }],
    });
    const spec = (name: string) => ({ name, transport: { kind: 'stdio' as const, command: 'node', args: [], cwd: '/w' } });
    const adapterA = createMcpUpstreamAdapter(spec('a'), { launcher: a.launcher });
    const adapterB = createMcpUpstreamAdapter(spec('b'), { launcher: b.launcher });
    const gateway = createGateway({ adapters: [adapterA, adapterB], backoff: IMMEDIATE_BACKOFF });
    extraStops.push(() => gateway.stop());
    await gateway.start();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const abort = new AbortController();
    const server = await serveMcpPassthrough({
      operations: [...adapterA.operations(), ...adapterB.operations()],
      gateway,
      usePlugins: [],
      serverInfo: { name: 's', version: '1' },
      transport: serverTransport,
      signal: abort.signal,
    });
    const client = new Client({ name: 'h', version: '1' }, { capabilities: {} });
    await client.connect(clientTransport);

    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['a_add', 'b_add']);
    expect(textOf((await client.callTool({ name: 'a_add', arguments: { path: '1' } })) as CallToolResult)).toBe('from-a');
    expect(textOf((await client.callTool({ name: 'b_add', arguments: { path: '2' } })) as CallToolResult)).toBe('from-b');
    expect(a.calls).toEqual([{ tool: 'add', args: { path: '1' } }]);
    expect(b.calls).toEqual([{ tool: 'add', args: { path: '2' } }]);
    abort.abort();
    await server.closed;
  });
});

describe('Feature: serve bin:<executable> — the argv operation behind the same server (R7b)', () => {
  async function argvRig(plugins: readonly UsePlugin[], script: Parameters<typeof createFakeLauncher>[0]) {
    const launcher = createFakeLauncher(script);
    const gateway = createGateway({ adapters: [createArgvAdapter({ command: 'touch', cwd: '/w' }, { launcher })] });
    extraStops.push(() => gateway.stop());
    await gateway.start();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const abort = new AbortController();
    const server = await serveMcpPassthrough({
      operations: [buildArgvOperation('touch').operation],
      gateway,
      usePlugins: plugins,
      serverInfo: { name: 's', version: '1' },
      transport: serverTransport,
      signal: abort.signal,
    });
    const client = new Client({ name: 'h', version: '1' }, { capabilities: {} });
    await client.connect(clientTransport);
    return {
      launcher,
      client,
      stop: async () => {
        abort.abort();
        await server.closed;
      },
    };
  }

  it('@T-R7 the executable is one tool bin_touch with the {argv, cwd} schema; stdout comes back as text, exit 0 is success', async () => {
    const { launcher, client, stop } = await argvRig([], () => ({ exit: 0, stdout: 'made\n' }));
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(['bin_touch']);
    expect(listed.tools[0]!.inputSchema).toMatchObject({ required: ['argv', 'cwd'] });
    const result = (await client.callTool({ name: 'bin_touch', arguments: { argv: ['x.txt'], cwd: '/w' } })) as CallToolResult;
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: 'made\n' }]);
    expect(launcher.started).toEqual([{ command: 'touch', args: ['x.txt'], cwd: '/w' }]);
    await stop();
  });

  it('@T-R7 a non-zero exit is an isError result: stdout, stderr and the exit code are the text blocks', async () => {
    const { client, stop } = await argvRig([], () => ({ exit: 7, stdout: 'partial', stderr: 'boom' }));
    const result = (await client.callTool({ name: 'bin_touch', arguments: { argv: [], cwd: '/w' } })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(result.content.map((c) => (c as { text: string }).text)).toEqual(['partial', 'boom', 'exit code 7']);
    await stop();
  });

  it('@T-R7 the Layer sees the argv operation (bin/touch, flat {argv, cwd}) and a refusal never starts the command', async () => {
    const seen: Call[] = [];
    const { launcher, client, stop } = await argvRig([denying(['bin/touch'], seen)], () => ({ exit: 0 }));
    const result = (await client.callTool({ name: 'bin_touch', arguments: { argv: ['x'], cwd: '/w' } })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('permission_denied: bin/touch is not allowed');
    expect(seen[0]!.domainArgs).toEqual({ argv: ['x'], cwd: '/w' });
    expect(seen[0]!.operation).toMatchObject({ id: 'bin/touch', host: 'argv', binding: 'bin:touch', safe: false });
    expect(launcher.started).toHaveLength(0);
    await stop();
  });
});

describe('Feature: any other adapter result is shaped as JSON text', () => {
  async function oddRig(value: unknown) {
    const adapter: HostAdapter = {
      host: 'mcp:odd',
      hopCost: 0,
      start: async () => undefined,
      ready: async () => true,
      invoke: async () => value,
      onExit: () => () => undefined,
      stop: async () => undefined,
    };
    const gateway: Gateway = createGateway({ adapters: [adapter] });
    extraStops.push(() => gateway.stop());
    await gateway.start();
    const operation: Operation = operationsFromMcpTools([{ name: 't', inputSchema: FILE_SCHEMA }], 'odd', () => undefined).operations[0]!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const abort = new AbortController();
    const server = await serveMcpPassthrough({
      operations: [operation],
      gateway,
      usePlugins: [],
      serverInfo: { name: 's', version: '1' },
      transport: serverTransport,
      signal: abort.signal,
    });
    const client = new Client({ name: 'h', version: '1' }, { capabilities: {} });
    await client.connect(clientTransport);
    return {
      client,
      stop: async () => {
        abort.abort();
        await server.closed;
      },
    };
  }

  it('@T-R7 an object result is JSON text; a null result is the text null', async () => {
    const object = await oddRig({ a: 1 });
    expect(textOf((await object.client.callTool({ name: 'odd_t', arguments: {} })) as CallToolResult)).toBe('{"a":1}');
    await object.stop();
    const nothing = await oddRig(undefined);
    expect(textOf((await nothing.client.callTool({ name: 'odd_t', arguments: {} })) as CallToolResult)).toBe('null');
    await nothing.stop();
  });
});

describe('Feature: serve over real stdio framing — stdin closing closes the server (G8)', () => {
  /** Speaks newline-delimited JSON-RPC to the gateway's stdio host transport through two pipes. */
  async function stdioRig(plugins: readonly UsePlugin[] = []) {
    const upstream = await openUpstreamRig({ tools: TOOLS }, { name: 'files' });
    extraStops.push(upstream.stop);
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
      operations: upstream.adapter.operations(),
      gateway: upstream.gateway,
      usePlugins: plugins,
      serverInfo: { name: 'adhd-policy', version: '1' },
      transport: createStdioHostTransport(stdin, stdout),
      signal: new AbortController().signal,
    });
    const send = async (message: Record<string, unknown>): Promise<void> => {
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
      await settle();
    };
    return { upstream, stdin, lines, server, send };
  }

  it('@G8 initialize, list and a refused call work over the pipes, then stdin end-of-file closes the server and the caller\'s gateway stop disposes the upstream', async () => {
    const { upstream, stdin, lines, server, send } = await stdioRig([denying(['files/write-file'])]);
    await send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'h', version: '1' } } });
    await send({ method: 'notifications/initialized' });
    await send({ id: 2, method: 'tools/list' });
    await send({ id: 3, method: 'tools/call', params: { name: WRITE, arguments: { path: '/a' } } });

    expect(lines.find((l) => l['id'] === 1)).toMatchObject({ result: { serverInfo: { name: 'adhd-policy' } } });
    const listed = lines.find((l) => l['id'] === 2) as { result: { tools: Array<{ name: string }> } };
    expect(listed.result.tools.map((t) => t.name)).toEqual([READ, WRITE, PING]);
    expect(lines.find((l) => l['id'] === 3)).toMatchObject({ result: { isError: true } });
    expect(upstream.stub.calls).toHaveLength(0);

    stdin.end();
    await server.closed;
    expect(upstream.stub.proc().hasExited).toBe(false); // the server does not own the upstream
    await upstream.stop();
    expect(upstream.stub.proc().stdinEnded).toBe(true);
    expect(upstream.stub.proc().kills[0]).toBe('SIGTERM');
    expect(upstream.stub.proc().hasExited).toBe(true);
  });

  it('@G8 stdin end-of-file before any request also closes the server', async () => {
    const { stdin, server } = await stdioRig();
    stdin.end();
    await server.closed;
    await flush();
  });
});
