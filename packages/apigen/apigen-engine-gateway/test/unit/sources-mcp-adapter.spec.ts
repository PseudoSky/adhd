// guards: an MCP upstream behind a gateway is routed by the shared host tag instead of its binding (two upstreams collide), is restarted without bound, answers while down, loses or rewrites an upstream result or error, or leaks the process on stop
// tier: S
// cites: policy-core REMEDIATION-PLAN T-R7 AC1 (R7b, G-1, K4), TAXONOMY item 2 (adapter spec) and item 8, D-08
// teeth: red: npx vitest run src/test/sources-mcp-adapter.spec.ts -> exit 1; gateway.ts routing line binding ?? host -> host fails 8 tests ("upstreams a and b both expose add ..."); gateway.ts maxRestarts bound attempt > maxRestarts+5 fails "exactly two restarts are attempted, then no further spawn"
// skip-expiry: 26b774a6 until 2027-03-31 the it.fails "a caller cancellation is not reported as deadline_exceeded" pins a known adapter defect (BUG 26b774a6); flip it to it() when fixed

/* eslint-disable @typescript-eslint/no-non-null-assertion -- specs index arrays/maps the test has just arranged; a miss would fail the very next assertion */
// createMcpUpstreamAdapter behind the real createGateway. The upstream is the in-process stub behind
// a fake IProcessLauncher; "the upstream crashes" is the stub process exiting; restart timing is a
// manual timer queue (never a sleep or wall clock). Only the process boundary is faked.

import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@adhd/apigen-base-errors';
import type { Operation } from '@adhd/apigen-core-client';
import {
  createGateway,
  createMcpUpstreamAdapter,
  isGatewayError,
  operationsFromMcpTools,
  type HostAdapter,
  type IProcessLauncher,
} from '../../src/index';
import { flush } from '../helpers/flush';
import { createStubMcpUpstream } from '../helpers/stub-mcp-upstream';
import type { IStubOptions } from '../helpers/stub-mcp-upstream';
import { IMMEDIATE_BACKOFF, openUpstreamRig } from '../helpers/upstream-rig';
import { caught } from '../helpers/caught';

const OBJECT_SCHEMA = { type: 'object', properties: { path: { type: 'string' } } };
const BACKOFF_MS = 10;

/** A timer queue the test fires by hand: the supervision backoff is the only 10 ms timer. */
function manualTimers() {
  interface IEntry {
    fn: () => void;
    ms: number;
    done: boolean;
  }
  const entries: IEntry[] = [];
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number): unknown => {
        const entry = { fn, ms, done: false };
        entries.push(entry);
        return entry;
      },
      clearTimeout: (handle: unknown): void => {
        (handle as IEntry).done = true;
      },
    },
    /** How many backoff sleeps are waiting. */
    pendingBackoffs: (): number => entries.filter((e) => e.ms === BACKOFF_MS && !e.done).length,
    /** Ends every waiting backoff sleep. */
    fireBackoffs(): void {
      for (const e of entries.filter((x) => x.ms === BACKOFF_MS && !x.done)) {
        e.done = true;
        e.fn();
      }
    },
  };
}

/** Wraps a launcher so only the first `allowed` starts reach it; later ones reject like a missing binary. */
function failingAfter(allowed: number, attempts: string[]): (inner: IProcessLauncher) => IProcessLauncher {
  return (inner) => ({
    async start(spec) {
      attempts.push(spec.command);
      if (attempts.length > allowed) throw new Error('spawn node ENOENT');
      return inner.start(spec);
    },
  });
}

const rigs: Array<{ stop(): Promise<void> }> = [];
async function rig(stubOptions: IStubOptions, options: Parameters<typeof openUpstreamRig>[1] = {}) {
  const r = await openUpstreamRig(stubOptions, options);
  rigs.push(r);
  return r;
}

afterEach(async () => {
  for (const r of rigs.splice(0)) await r.stop();
  vi.useRealTimers();
});

const operationOf = (r: { adapter: { operations(): readonly Operation[] } }, index = 0): Operation => r.adapter.operations()[index]!;

function requestFor(operation: Operation, data: Record<string, unknown> = {}) {
  return { operation, data, envelope: {}, transport: 'mcp' as const };
}

describe('Feature: the adapter is the HostAdapter of one MCP upstream', () => {
  it('@T-R7 host is mcp:<name>, hopCost is 1, the name is normalised; nothing is known before start', () => {
    const stub = createStubMcpUpstream({ tools: [{ name: 'add', inputSchema: OBJECT_SCHEMA }] });
    const adapter = createMcpUpstreamAdapter(
      { name: 'My Files', transport: { kind: 'stdio', command: 'node', args: [], cwd: '/w' } },
      { launcher: stub.launcher }
    );
    expect(adapter.host).toBe('mcp:my-files');
    expect(adapter.sourceName).toBe('my-files');
    expect(adapter.hopCost).toBe(1);
    expect(adapter.tools()).toEqual([]);
    expect(adapter.operations()).toEqual([]);
    expect(adapter.skipped()).toEqual([]);
    expect(stub.started).toHaveLength(0);
  });

  it('@T-R7 an alias with no usable characters falls back to the command basename, then to "server"', () => {
    const named = (name: string, command: string) =>
      createMcpUpstreamAdapter({ name, transport: { kind: 'stdio', command, args: [], cwd: '/w' } }).host;
    expect(named('!!!', '/opt/bin/notes-server.js')).toBe('mcp:notes-server');
    expect(named('', '...')).toBe('mcp:server');
  });

  it('@T-R7 a transport other than stdio is ApiError invalid_argument at construction', () => {
    const make = () => createMcpUpstreamAdapter({ name: 'r', transport: { kind: 'http', url: 'https://example.test/mcp' } });
    expect(make).toThrow(ApiError);
    try {
      make();
    } catch (e) {
      expect(e).toMatchObject({ code: 'invalid_argument' });
      expect((e as Error).message).toContain('http transport is not supported yet');
    }
  });

  it('@T-R7 start translates tools/list to IR once: ids, host mcp, binding mcp:<name>, tool metadata from the upstream tool', async () => {
    const r = await rig(
      {
        tools: [
          {
            name: 'read_file',
            title: 'Read a file',
            description: 'Reads a file from disk',
            inputSchema: OBJECT_SCHEMA,
            outputSchema: { type: 'object', properties: { text: { type: 'string' } } },
            annotations: { readOnlyHint: true },
          },
          { name: 'bad', inputSchema: { type: 'string' } },
        ],
      },
      { name: 'notes' }
    );
    expect(r.adapter.operations().map((o) => o.id)).toEqual(['notes/read-file']);
    expect(operationOf(r)).toMatchObject({
      host: 'mcp',
      binding: 'mcp:notes',
      safe: false,
      tool: {
        title: 'Read a file',
        description: 'Reads a file from disk',
        outputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        annotations: { readOnlyHint: true },
      },
    });
    expect(r.adapter.tools().map((t) => t.name)).toEqual(['read_file']);
    expect(r.adapter.skipped()).toEqual([{ tool: 'bad', reason: 'non-object inputSchema' }]);
    expect(r.stub.started).toEqual([{ command: 'node', args: ['stub.js'], cwd: '/w' }]);
  });

  it('@T-R7 the skipped-tool warning goes to onWarn', async () => {
    const warnings: string[] = [];
    await rig({ tools: [{ name: 'bad', inputSchema: { type: 'string' } }] }, { name: 's', onWarn: (l) => warnings.push(l) });
    expect(warnings).toEqual(['apigen-gateway: skipping upstream tool "bad" of s: non-object inputSchema']);
  });

  it('@T-R7 start is idempotent while connected, and concurrent starts share one spawn', async () => {
    const stub = createStubMcpUpstream({ tools: [{ name: 'add', inputSchema: OBJECT_SCHEMA }] });
    const adapter = createMcpUpstreamAdapter(
      { name: 'a', transport: { kind: 'stdio', command: 'node', args: [], cwd: '/w' } },
      { launcher: stub.launcher }
    );
    await Promise.all([adapter.start(), adapter.start(), adapter.start()]);
    await adapter.start();
    expect(stub.started).toHaveLength(1);
    expect(await adapter.ready()).toBe(true);
    await adapter.stop();
  });

  it('@T-R7 ready is false before start, true while connected and pinging, false once the upstream is gone', async () => {
    const stub = createStubMcpUpstream({ tools: [] });
    const adapter = createMcpUpstreamAdapter(
      { name: 'a', transport: { kind: 'stdio', command: 'node', args: [], cwd: '/w' } },
      { launcher: stub.launcher }
    );
    expect(await adapter.ready()).toBe(false);
    await adapter.start();
    expect(await adapter.ready()).toBe(true);
    stub.proc().exit(0);
    await flush();
    expect(await adapter.ready()).toBe(false);
    await adapter.stop();
  });
});

describe('Feature: a failed start is typed and fires no exit listener (startup-failure contract)', () => {
  it('@T-R7 a handshake failure rejects with unavailable for mcp:<name> at (start); the process is killed', async () => {
    const stub = createStubMcpUpstream({ initialize: 'error', tools: [] });
    const adapter = createMcpUpstreamAdapter(
      { name: 'files', transport: { kind: 'stdio', command: 'node', args: [], cwd: '/w' } },
      { launcher: stub.launcher }
    );
    const onExit = vi.fn();
    adapter.onExit(onExit);
    const err = await caught(adapter.start());
    expect(isGatewayError(err)).toBe(true);
    expect(err.details).toMatchObject({ gatewayCode: 'unavailable', host: 'mcp:files', operationId: '(start)' });
    expect(stub.proc().kills).toContain('SIGTERM');
    await flush();
    expect(onExit).not.toHaveBeenCalled();
    expect(await adapter.ready()).toBe(false);
  });

  it('@T-R7 a command that cannot start rejects with unavailable naming the reason', async () => {
    const stub = createStubMcpUpstream({ failStart: true, tools: [] });
    const adapter = createMcpUpstreamAdapter(
      { name: 'files', transport: { kind: 'stdio', command: 'nope', args: [], cwd: '/w' } },
      { launcher: stub.launcher }
    );
    const err = await caught(adapter.start());
    expect(err.details).toMatchObject({ gatewayCode: 'unavailable', host: 'mcp:files' });
    expect(err.message).toContain('ENOENT');
  });

  it('@T-R7 a gateway whose upstream fails its handshake refuses to start: fail closed, nothing falls back', async () => {
    const stub = createStubMcpUpstream({ initialize: 'error', tools: [] });
    const gateway = createGateway({
      adapters: [
        createMcpUpstreamAdapter(
          { name: 'files', transport: { kind: 'stdio', command: 'node', args: [], cwd: '/w' } },
          { launcher: stub.launcher }
        ),
      ],
    });
    await expect(gateway.start()).rejects.toMatchObject({ details: { gatewayCode: 'unavailable' } });
    expect(stub.started).toHaveLength(1);
  });

  it('@T-R7 stop before start settles, and a later start is refused', async () => {
    const stub = createStubMcpUpstream({ tools: [] });
    const adapter = createMcpUpstreamAdapter(
      { name: 'a', transport: { kind: 'stdio', command: 'node', args: [], cwd: '/w' } },
      { launcher: stub.launcher }
    );
    await adapter.stop();
    const err = await caught(adapter.start());
    expect(err.details).toMatchObject({ gatewayCode: 'unavailable', host: 'mcp:a' });
    expect(err.message).toContain('adapter stopped');
    expect(stub.started).toHaveLength(0);
  });
});

describe('Feature: the upstream is called verbatim through the gateway', () => {
  it('@T-R7 the arguments reach the upstream exactly as given (undeclared keys survive) and the result comes back verbatim', async () => {
    const r = await rig(
      {
        tools: [
          {
            name: 'echo',
            inputSchema: OBJECT_SCHEMA,
            result: (args) => ({ content: [{ type: 'text', text: 'echoed' }], structuredContent: { seen: args } }),
          },
        ],
      },
      { name: 'e' }
    );
    const data = { path: '/a', undeclared: { deep: [1, { two: 2 }] } };
    const result = await r.gateway.route(requestFor(operationOf(r), data));
    expect(r.stub.calls).toEqual([{ tool: 'echo', args: data }]);
    expect(result).toEqual({ content: [{ type: 'text', text: 'echoed' }], structuredContent: { seen: data } });
  });

  it('@T-R7 the upstream tool name is the raw path tail, not the rendered id segment', async () => {
    const r = await rig({ tools: [{ name: 'read_file', inputSchema: OBJECT_SCHEMA }] }, { name: 'f' });
    expect(operationOf(r).id).toBe('f/read-file');
    await r.gateway.route(requestFor(operationOf(r)));
    expect(r.stub.calls.map((c) => c.tool)).toEqual(['read_file']);
  });

  it('@T-R7 an isError result is data, not a rejection', async () => {
    const r = await rig(
      { tools: [{ name: 'soft', inputSchema: OBJECT_SCHEMA, result: () => ({ content: [{ type: 'text', text: 'denied' }], isError: true }) }] },
      { name: 'u' }
    );
    await expect(r.gateway.route(requestFor(operationOf(r)))).resolves.toMatchObject({ isError: true });
  });

  it('@T-R7 an error the upstream returned rejects as the SDK McpError, unchanged (code and message)', async () => {
    const r = await rig(
      { tools: [{ name: 'hard', inputSchema: OBJECT_SCHEMA, rpcError: { code: -32602, message: 'bad things' } }] },
      { name: 'u' }
    );
    const err = await caught(r.gateway.route(requestFor(operationOf(r))));
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(-32602);
    expect(err.message).toContain('bad things');
    expect(isGatewayError(err)).toBe(false);
  });

  it('@T-R7 a call outliving callTimeoutMs is deadline_exceeded for the binding, not a raw SDK timeout', async () => {
    vi.useFakeTimers();
    const r = await rig(
      { tools: [{ name: 'slow', inputSchema: OBJECT_SCHEMA, silent: true }] },
      { name: 'u', callTimeoutMs: 500 }
    );
    const pending = caught(r.gateway.route(requestFor(operationOf(r))));
    await vi.advanceTimersByTimeAsync(500);
    const err = await pending;
    expect(isGatewayError(err)).toBe(true);
    expect(err.details).toMatchObject({ gatewayCode: 'deadline_exceeded', host: 'mcp:u' });
    expect(err.message).toContain('500ms');
  });

  it('@T-R7 the caller signal cancels the in-flight upstream request; the connection stays usable', async () => {
    const r = await rig(
      {
        tools: [
          { name: 'slow', inputSchema: OBJECT_SCHEMA, silent: true },
          { name: 'fast', inputSchema: OBJECT_SCHEMA },
        ],
      },
      { name: 'u' }
    );
    const ac = new AbortController();
    const pending = caught(r.gateway.route(requestFor(operationOf(r, 0)), ac.signal));
    await flush();
    expect(r.stub.calls).toHaveLength(1);
    ac.abort(new Error('host cancelled'));
    const err = await pending;
    expect(err).toBeInstanceOf(Error); // the call settles instead of hanging
    await expect(r.gateway.route(requestFor(operationOf(r, 1)))).resolves.toMatchObject({ content: [{ text: 'ok:fast' }] });
  });

  // DEFECT (reported, not fixed here): the SDK wraps an abort reason as McpError(RequestTimeout), the
  // same code as a real timeout, so the adapter's RequestTimeout mapping reports a caller cancellation
  // as `deadline_exceeded` after callTimeoutMs. The assertion below is the correct behaviour; it is
  // expected to fail until the adapter checks `signal.aborted` first. See the skip-expiry header line.
  it('@T-R7 a caller cancellation is not reported as deadline_exceeded (it never outlived any deadline)', async () => {
    const r = await rig({ tools: [{ name: 'slow', inputSchema: OBJECT_SCHEMA, silent: true }] }, { name: 'u' });
    const ac = new AbortController();
    const pending = caught(r.gateway.route(requestFor(operationOf(r)), ac.signal));
    await flush();
    ac.abort(new Error('host cancelled'));
    const err = await pending;
    const deadline = isGatewayError(err) && err.details.gatewayCode === 'deadline_exceeded';
    expect(deadline).toBe(false);
  });

  it('@T-R7 invoking an adapter that is not connected is unavailable for the operation', async () => {
    const stub = createStubMcpUpstream({ tools: [{ name: 'add', inputSchema: OBJECT_SCHEMA }] });
    const adapter = createMcpUpstreamAdapter(
      { name: 'a', transport: { kind: 'stdio', command: 'node', args: [], cwd: '/w' } },
      { launcher: stub.launcher }
    );
    const op = operationsFromMcpTools([{ name: 'add', inputSchema: OBJECT_SCHEMA }], 'a', () => undefined).operations[0]!;
    const err = await caught(adapter.invoke(requestFor(op), new AbortController().signal));
    expect(isGatewayError(err)).toBe(true);
    expect(err.details).toMatchObject({ gatewayCode: 'unavailable', host: 'mcp:a', operationId: 'a/add' });
    expect(stub.calls).toEqual([]);
  });

  it('@T-R7 an operation with no path tail has no tool name: ApiError invalid_argument, nothing is called', async () => {
    const r = await rig({ tools: [{ name: 'add', inputSchema: OBJECT_SCHEMA }] }, { name: 'a' });
    const headless: Operation = { ...operationOf(r), path: [] };
    const err = await caught(r.adapter.invoke(requestFor(headless), new AbortController().signal));
    expect(err).toMatchObject({ code: 'invalid_argument' });
    expect(r.stub.calls).toEqual([]);
  });
});

describe('Feature: two upstreams aggregate through one gateway (K4)', () => {
  it('@T-R7 upstreams a and b both expose add: each call reaches its own upstream, though both operations are host mcp', async () => {
    const a = createStubMcpUpstream({
      tools: [{ name: 'add', inputSchema: OBJECT_SCHEMA, result: () => ({ content: [{ type: 'text', text: 'from-a' }] }) }],
    });
    const b = createStubMcpUpstream({
      tools: [{ name: 'add', inputSchema: OBJECT_SCHEMA, result: () => ({ content: [{ type: 'text', text: 'from-b' }] }) }],
    });
    const adapterA = createMcpUpstreamAdapter(
      { name: 'a', transport: { kind: 'stdio', command: 'node', args: ['a.js'], cwd: '/w' } },
      { launcher: a.launcher }
    );
    const adapterB = createMcpUpstreamAdapter(
      { name: 'b', transport: { kind: 'stdio', command: 'node', args: ['b.js'], cwd: '/w' } },
      { launcher: b.launcher }
    );
    const gateway = createGateway({ adapters: [adapterA, adapterB], backoff: IMMEDIATE_BACKOFF });
    rigs.push({ stop: () => gateway.stop() });
    await gateway.start();

    const opA = adapterA.operations()[0]!;
    const opB = adapterB.operations()[0]!;
    expect([opA.id, opB.id]).toEqual(['a/add', 'b/add']);
    expect(opA.host).toBe('mcp');
    expect(opB.host).toBe('mcp'); // the producer tag is shared: only the binding tells them apart

    await expect(gateway.route(requestFor(opA, { x: 1 }))).resolves.toMatchObject({ content: [{ text: 'from-a' }] });
    await expect(gateway.route(requestFor(opB, { x: 2 }))).resolves.toMatchObject({ content: [{ text: 'from-b' }] });
    expect(a.calls).toEqual([{ tool: 'add', args: { x: 1 } }]);
    expect(b.calls).toEqual([{ tool: 'add', args: { x: 2 } }]);
    const health = await gateway.health();
    expect(Object.keys(health.hosts).sort()).toEqual(['mcp:a', 'mcp:b']);
    expect(health.serving).toBe(true);
  });

  it('@T-R7 a crashed upstream fails only its own operations; the other upstream keeps serving', async () => {
    const a = createStubMcpUpstream({ tools: [{ name: 'add', inputSchema: OBJECT_SCHEMA }] });
    const b = createStubMcpUpstream({ tools: [{ name: 'add', inputSchema: OBJECT_SCHEMA }] });
    const manual = manualTimers();
    const adapterA = createMcpUpstreamAdapter(
      { name: 'a', transport: { kind: 'stdio', command: 'node', args: [], cwd: '/w' } },
      { launcher: a.launcher }
    );
    const adapterB = createMcpUpstreamAdapter(
      { name: 'b', transport: { kind: 'stdio', command: 'node', args: [], cwd: '/w' } },
      { launcher: b.launcher }
    );
    const gateway = createGateway({
      adapters: [adapterA, adapterB],
      backoff: { delayMs: () => BACKOFF_MS, maxRestarts: 0 },
      timers: manual.timers,
    });
    rigs.push({ stop: () => gateway.stop() });
    await gateway.start();
    a.proc().exit(1);
    await flush();
    const down = await caught(gateway.route(requestFor(adapterA.operations()[0]!)));
    expect(down.details).toMatchObject({ gatewayCode: 'unavailable', host: 'mcp:a' });
    await expect(gateway.route(requestFor(adapterB.operations()[0]!))).resolves.toMatchObject({ content: [{ text: 'ok:add' }] });
  });
});

describe('Feature: routing reads binding ?? host (G-1)', () => {
  function recorder(host: string) {
    const routed: string[] = [];
    const adapter: HostAdapter = {
      host,
      hopCost: 0,
      start: async () => undefined,
      ready: async () => true,
      invoke: async (req) => {
        routed.push(req.operation.id);
        return host;
      },
      onExit: () => () => undefined,
      stop: async () => undefined,
    };
    return { adapter, routed };
  }
  const mcpOp = (): Operation =>
    operationsFromMcpTools([{ name: 'add', inputSchema: OBJECT_SCHEMA }], 'a', () => undefined).operations[0]!;

  it('@G-1 an operation with a binding goes to the adapter registered under the BINDING, not under its host tag', async () => {
    const byHost = recorder('mcp');
    const byBinding = recorder('mcp:a');
    const gateway = createGateway({ adapters: [byHost.adapter, byBinding.adapter] });
    await gateway.start();
    await expect(gateway.route(requestFor(mcpOp()))).resolves.toBe('mcp:a');
    expect(byBinding.routed).toEqual(['a/add']);
    expect(byHost.routed).toEqual([]);
    await gateway.stop();
  });

  it('@G-1 an operation with no binding falls back to its host tag (the TypeScript and in-process path is unchanged)', async () => {
    const byHost = recorder('mcp');
    const gateway = createGateway({ adapters: [byHost.adapter] });
    await gateway.start();
    const { binding: _binding, ...unbound } = mcpOp();
    await expect(gateway.route(requestFor(unbound as Operation))).resolves.toBe('mcp');
    expect(byHost.routed).toEqual(['a/add']);
    await gateway.stop();
  });

  it('@G-1 a binding with no adapter is unavailable even though the host tag has one (the binding wins, no silent fallback)', async () => {
    const byHost = recorder('mcp');
    const gateway = createGateway({ adapters: [byHost.adapter] });
    await gateway.start();
    const err = await caught(gateway.route(requestFor(mcpOp())));
    expect(isGatewayError(err)).toBe(true);
    expect(err.details).toMatchObject({ gatewayCode: 'unavailable', host: 'mcp:a' });
    expect(byHost.routed).toEqual([]);
    await gateway.stop();
  });
});

describe('Feature: supervision is finite and the upstream is unavailable in between (BA-6)', () => {
  it('@T-R7 a crashed upstream restarts and serves again; the IR is the first start\'s, not re-translated', async () => {
    const r = await rig({ tools: [{ name: 'add', inputSchema: OBJECT_SCHEMA }] }, { name: 'u' });
    const operations = r.adapter.operations();
    r.stub.proc().exit(1);
    await flush();
    expect(r.stub.started).toHaveLength(2);
    await expect(r.gateway.route(requestFor(operationOf(r)))).resolves.toMatchObject({ content: [{ text: 'ok:add' }] });
    expect(r.adapter.operations()).toBe(operations);
    expect((await r.gateway.health()).hosts['mcp:u']).toMatchObject({ status: 'ready' });
  });

  it('@T-R7 a call made before the restart completes fails unavailable (gatewayCode unavailable, code internal)', async () => {
    const manual = manualTimers();
    const r = await rig(
      { tools: [{ name: 'add', inputSchema: OBJECT_SCHEMA }] },
      { name: 'u', backoff: { delayMs: () => BACKOFF_MS, maxRestarts: 2 }, timers: manual.timers }
    );
    r.stub.proc().exit(1);
    await flush();
    expect(manual.pendingBackoffs()).toBe(1);
    expect(r.stub.started).toHaveLength(1); // not respawned yet

    const err = await caught(r.gateway.route(requestFor(operationOf(r))));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('internal');
    expect(err.details).toMatchObject({ gatewayCode: 'unavailable', host: 'mcp:u' });
    expect(r.stub.calls).toEqual([]);

    manual.fireBackoffs();
    await flush();
    expect(r.stub.started).toHaveLength(2);
    await expect(r.gateway.route(requestFor(operationOf(r)))).resolves.toMatchObject({ content: [{ text: 'ok:add' }] });
  });

  it('@T-R7 with maxRestarts 2 and an upstream that will not come back, exactly two restarts are attempted, then no further spawn', async () => {
    const manual = manualTimers();
    const attempts: string[] = [];
    const r = await rig(
      { tools: [{ name: 'add', inputSchema: OBJECT_SCHEMA }] },
      {
        name: 'u',
        backoff: { delayMs: () => BACKOFF_MS, maxRestarts: 2 },
        timers: manual.timers,
        wrapLauncher: failingAfter(1, attempts),
      }
    );
    expect(attempts).toHaveLength(1); // the initial start

    r.stub.proc().exit(1); // crash
    await flush();
    expect(manual.pendingBackoffs()).toBe(1);
    manual.fireBackoffs(); // restart 1 fails
    await flush();
    expect(attempts).toHaveLength(2);
    expect(manual.pendingBackoffs()).toBe(1);
    manual.fireBackoffs(); // restart 2 fails
    await flush();
    expect(attempts).toHaveLength(3);

    // parked: no third restart is scheduled, however long we wait for one
    expect(manual.pendingBackoffs()).toBe(0);
    manual.fireBackoffs();
    await flush();
    expect(attempts).toHaveLength(3);
    expect((await r.gateway.health()).hosts['mcp:u']).toMatchObject({ status: 'down' });
    const err = await caught(r.gateway.route(requestFor(operationOf(r))));
    expect(err.details).toMatchObject({ gatewayCode: 'unavailable', host: 'mcp:u' });
  });

  it('@T-R7 the bound counts CONSECUTIVE failed restarts: restarts that succeed reset it', async () => {
    const r = await rig(
      { tools: [{ name: 'add', inputSchema: OBJECT_SCHEMA }] },
      { name: 'u', backoff: { delayMs: () => 0, maxRestarts: 1 } }
    );
    for (let crash = 1; crash <= 3; crash += 1) {
      r.stub.proc().exit(1);
      await flush();
      expect(r.stub.started).toHaveLength(crash + 1);
    }
    expect((await r.gateway.health()).hosts['mcp:u']).toMatchObject({ status: 'ready' });
    await expect(r.gateway.route(requestFor(operationOf(r)))).resolves.toMatchObject({ content: [{ text: 'ok:add' }] });
  });

  it('@T-R7 stopping the gateway disposes the upstream, fires no exit listener and ends supervision', async () => {
    const r = await rig({ tools: [{ name: 'add', inputSchema: OBJECT_SCHEMA }] }, { name: 'u' });
    const proc = r.stub.proc();
    await r.gateway.stop();
    expect(proc.stdinEnded).toBe(true);
    expect(proc.kills).toEqual(['SIGTERM']);
    expect(proc.hasExited).toBe(true);
    await flush();
    expect(r.stub.started).toHaveLength(1); // the exit caused by stop() is not a crash to restart
    const err = await caught(r.gateway.route(requestFor(operationOf(r))));
    expect(isGatewayError(err)).toBe(true);
  });
});
