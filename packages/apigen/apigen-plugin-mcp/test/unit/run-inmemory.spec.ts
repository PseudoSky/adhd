// guards: The apigen MCP adapter regresses on what a host sees: a string result is JSON-quoted, an ApiError rejects the call instead of resolving as a readable isError result, host cancellation never reaches a Layer, --use Layers do not run before a dispatch terminal (or a refusal still reaches the terminal), or the in-process seams (hostTransport, serverInfo, stdio streams, terminal) mis-wire.
// tier: S
// cites: docs/plan/policy-core/REMEDIATION-PLAN.md T-R4 (BA-2 raw text, BA-3/BA-4 isError for every ApiError, protocol errors stay protocol errors, tools/list title+annotations, host cancellation), D1 terminal route, ADR-0018 D1-D4, ADR-0019 D4
// tags: contract, regression:BA-2, regression:BA-4
// teeth: red: npx nx run apigen-plugin-mcp:test -> exit 1; each case was turned red by reverting its branch of McpTransportAdapter.writeResult/writeError, createMcpServer's `signal: extra.signal`, the terminal-route branch of buildToolTable, or resolveMcpServerIdentity (controls recorded in the Phase C report)
//
// Lane: unit. Every host runs through the REAL `mcpPlugin.run` over the SDK's
// in-memory transport (`options.hostTransport`) or injected stdio streams: no
// port, no child process, no sleep. Awaits are on latches and protocol replies.

import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ApiError } from '@adhd/apigen-base-errors';
import type { ApiErrorCode } from '@adhd/apigen-base-errors';
import type { Call, Operation, Plugin, RunInput } from '@adhd/apigen-core-client';
import { project } from '@adhd/apigen-engine-naming';
import { mcpPlugin } from '../../src/lib/plugin';
import { operationFor } from '../../src/lib/tool-naming';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PKG = { id: 'mem-pkg', importPath: '@test/mem-pkg' };
const SILENT = (() => {
  const noop = (): void => undefined;
  const logger: Record<string, unknown> = { info: noop, error: noop, warn: noop, debug: noop, trace: noop, fatal: noop };
  logger['child'] = () => logger;
  return logger;
})() as unknown as NonNullable<RunInput['logger']>;

/** One Operation per fixture function (a package's operations[] must cover every fn), with per-function overrides. */
const packageOps = (overrides: Record<string, Partial<Operation>> = {}): Operation[] =>
  Object.keys(SCHEMAS).map((fnName) => ({ ...operationFor(PKG, fnName), ...overrides[fnName] }));

const nameOf = (op: Operation): string => project(op).mcp.name;
const toolName = (fnName: string): string => nameOf(operationFor(PKG, fnName));

/** A `{ data: { ...props } }` composed schema, the shape every extracted TS operation has. */
function fnSchema(props: Record<string, unknown> = {}, required: string[] = [], output: Record<string, unknown> = {}) {
  return {
    input: {
      type: 'object',
      properties: { data: { type: 'object', properties: props, required } },
      required: ['data'],
    },
    output,
  };
}

const ERROR_CODES: readonly ApiErrorCode[] = ['unauthenticated', 'permission_denied', 'not_found', 'invalid_argument', 'internal'];

const SCHEMAS = {
  echoString: fnSchema({}, [], { type: 'string' }),
  echoObject: fnSchema({}, [], { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }),
  needsUserId: fnSchema({ userId: { type: 'string' } }, ['userId'], { type: 'string' }),
  failWith: fnSchema({ code: { type: 'string' }, message: { type: 'string' } }, ['code', 'message']),
  failUnavailable: fnSchema({ message: { type: 'string' } }, ['message']),
  failPlain: fnSchema(),
  waitForCancel: fnSchema({}, [], { type: 'string' }),
};

const FNS: Record<string, (...args: unknown[]) => unknown> = {
  echoString: () => 'ok',
  echoObject: () => ({ id: 'o1' }),
  needsUserId: (userId) => `hello ${String(userId)}`,
  failWith: (code, message) => {
    throw new ApiError(code as ApiErrorCode, String(message));
  },
  failUnavailable: (message) => {
    throw new ApiError('internal', String(message), { gatewayCode: 'unavailable' });
  },
  failPlain: () => {
    throw new Error('kaboom (plain)');
  },
  waitForCancel: () => 'unreachable-in-cancel-test',
};

function latch<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface IHost {
  readonly client: Client;
  readonly running: Promise<void>;
  stop(): Promise<void>;
}

const open: IHost[] = [];

/**
 * Starts the REAL `mcpPlugin.run` on one end of an in-memory transport pair and
 * connects an SDK `Client` to the other. `extra` options are merged over
 * `hostTransport`, so a case can add `usePlugins`, `terminal`, `serverInfo`...
 */
async function startHost(
  extra: {
    options?: Record<string, unknown>;
    operations?: Operation[];
    packages?: RunInput['packages'];
  } = {}
): Promise<IHost> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const controller = new AbortController();
  const input: RunInput = {
    packages: extra.packages ?? [{ id: PKG.id, schemas: SCHEMAS, importPath: PKG.importPath, fns: FNS }],
    outputDir: 'tmp/apigen-plugin-mcp-unused',
    options: { transport: 'stdio', hostTransport: serverSide, ...extra.options },
    logger: SILENT,
    signal: controller.signal,
    ...(extra.operations !== undefined ? { operations: extra.operations } : {}),
  };
  const running = mcpPlugin.run!(input);
  const client = new Client({ name: 'inmemory-spec-client', version: '1.0.0' }, { capabilities: {} });
  // A run() that rejects during startup must fail the case now, not time the connect out.
  await Promise.race([client.connect(clientSide), running.then(() => Promise.reject(new Error('run() settled before the host connected')))]);
  const host: IHost = {
    client,
    running,
    stop: async () => {
      controller.abort();
      await client.close().catch(() => undefined);
      await running.catch(() => undefined);
    },
  };
  open.push(host);
  return host;
}

afterEach(async () => {
  for (const host of open.splice(0)) await host.stop();
});

interface IToolResult {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
  _meta?: Record<string, unknown>;
}

async function call(host: IHost, fnName: string, data: Record<string, unknown> = {}): Promise<IToolResult> {
  return (await host.client.callTool({ name: toolName(fnName), arguments: { data } })) as IToolResult;
}

/** A `--use` plugin whose static `layer` runs `body` around every call. */
function layerPlugin(
  id: string,
  body: (call: Call, next: () => unknown) => unknown
): { id: string; capabilities: { layer: { layer: (call: Call, next: () => unknown) => unknown } } } {
  return { id, capabilities: { layer: { layer: body } } };
}

// ---------------------------------------------------------------------------
// BA-2 raw text, BA-3 / BA-4 isError
// ---------------------------------------------------------------------------

describe('Feature: tool results as a host reads them (in-memory transport, real mcpPlugin.run)', () => {
  it('@T-R4 @BA-2 a string result is raw text, not JSON-quoted, and carries no structuredContent', async () => {
    const host = await startHost();
    const result = await call(host, 'echoString');
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(result.structuredContent).toBeUndefined();
  });

  it('@T-R4 @BA-2 an object result is still JSON text with structuredContent mirroring it', async () => {
    const host = await startHost();
    const result = await call(host, 'echoObject');
    expect(JSON.parse(result.content?.[0]?.text ?? 'null')).toEqual({ id: 'o1' });
    expect(result.structuredContent).toEqual({ id: 'o1' });
  });

  it('@T-R4 @BA-3 a refusal is a readable tool result: isError, "permission_denied: blocked by rule r1", _meta code', async () => {
    const host = await startHost();
    const result = await call(host, 'failWith', { code: 'permission_denied', message: 'blocked by rule r1' });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'permission_denied: blocked by rule r1' }]);
    expect(result._meta?.['adhd/error']).toEqual({ code: 'permission_denied' });
  });

  for (const code of ERROR_CODES) {
    it(`@T-R4 @BA-4 ApiError ${code} resolves callTool as an isError result "${code}: <message>" with _meta code ${code}`, async () => {
      const host = await startHost();
      const result = await call(host, 'failWith', { code, message: `msg for ${code}` });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: `${code}: msg for ${code}` }]);
      expect(result._meta?.['adhd/error']).toEqual({ code });
      expect(result.structuredContent).toBeUndefined();
    });
  }

  it('@T-R4 @BA-4 a validate-Layer rejection (missing required argument) is an invalid_argument isError result, and the function never ran', async () => {
    const host = await startHost();
    const result = await call(host, 'needsUserId', {});
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/^invalid_argument: /);
    expect(result._meta?.['adhd/error']).toEqual({ code: 'invalid_argument' });
    // Control: a well-formed call to the same tool succeeds.
    expect((await call(host, 'needsUserId', { userId: 'u1' })).content).toEqual([{ type: 'text', text: 'hello u1' }]);
  });

  it('@T-R4 @BA-4 the gateway-unavailable error (internal + details.gatewayCode unavailable) renders "unavailable: <message>" with both codes in _meta', async () => {
    const host = await startHost();
    const result = await call(host, 'failUnavailable', { message: 'upstream notes is restarting' });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'unavailable: upstream notes is restarting' }]);
    expect(result._meta?.['adhd/error']).toEqual({ code: 'internal', gatewayCode: 'unavailable' });
  });

  it('@T-R4 @BA-4 an internal error WITHOUT gatewayCode stays "internal: <message>"', async () => {
    const host = await startHost();
    const result = await call(host, 'failWith', { code: 'internal', message: 'disk full' });
    expect(result.content?.[0]?.text).toBe('internal: disk full');
    expect(result._meta?.['adhd/error']).toEqual({ code: 'internal' });
  });

  it('@T-R4 @BA-4 a non-ApiError throw stays a protocol error: callTool rejects', async () => {
    const host = await startHost();
    await expect(call(host, 'failPlain')).rejects.toThrow(/kaboom \(plain\)/);
  });

  it('@T-R4 @BA-4 an unknown tool stays a protocol error: callTool rejects matching /Unknown tool/', async () => {
    const host = await startHost();
    await expect(host.client.callTool({ name: 'no-such-tool', arguments: {} })).rejects.toThrow(/Unknown tool/);
  });
});

// ---------------------------------------------------------------------------
// tools/list metadata
// ---------------------------------------------------------------------------

describe('Feature: tools/list carries Operation.tool metadata', () => {
  it('@T-R4 @BA-3 an operation with tool { title, annotations } lists both; an extracted operation lists neither field', async () => {
    const operations = packageOps({ echoString: { tool: { title: 'Add', annotations: { readOnlyHint: false } } } });
    const annotated = operations.find((o) => o.id.endsWith('/echoString')) as Operation;
    const plain = operations.find((o) => o.id.endsWith('/echoObject')) as Operation;
    const host = await startHost({ operations });
    const { tools } = await host.client.listTools();
    const withMeta = tools.find((t) => t.name === nameOf(annotated));
    const without = tools.find((t) => t.name === nameOf(plain));
    expect(withMeta?.title).toBe('Add');
    expect(withMeta?.annotations).toEqual({ readOnlyHint: false });
    expect(without).toBeDefined();
    expect(without).not.toHaveProperty('title');
    expect(without).not.toHaveProperty('annotations');
  });
});

// ---------------------------------------------------------------------------
// extra.signal -> Layers
// ---------------------------------------------------------------------------

describe('Feature: the host cancels a call', () => {
  it('@T-R4 @ADR-0019-D4 cancelling an in-flight tools/call aborts the signal the Layer received, which was live (not aborted) on entry', async () => {
    const entered = latch<boolean>();
    const observedAbort = latch<boolean>();
    const waiting = layerPlugin('cancel-probe', async (c, next) => {
      if (!c.operation.id.endsWith('waitForCancel')) return next();
      entered.resolve(c.signal.aborted);
      await new Promise<void>((resolve) => c.signal.addEventListener('abort', () => resolve(), { once: true }));
      observedAbort.resolve(c.signal.aborted);
      return 'cancelled';
    });
    const host = await startHost({ options: { usePlugins: [waiting] } });
    const hostSide = new AbortController();
    const outcome = host.client.callTool({ name: toolName('waitForCancel'), arguments: { data: {} } }, undefined, {
      signal: hostSide.signal,
    });
    outcome.catch(() => undefined);
    expect(await entered.promise).toBe(false);
    hostSide.abort();
    await expect(outcome).rejects.toBeDefined();
    expect(await observedAbort.promise).toBe(true);
  });

  it('@T-R4 @ADR-0019-D4 a call that is never cancelled keeps a live signal, and one request cancelled does not abort the next', async () => {
    const signals: AbortSignal[] = [];
    const probe = layerPlugin('signal-probe', (c, next) => {
      signals.push(c.signal);
      return next();
    });
    const host = await startHost({ options: { usePlugins: [probe] } });
    await call(host, 'echoString');
    await call(host, 'echoString');
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    // Settled requests: the SDK aborts the per-request controller only on cancel, never on completion.
    expect(signals.every((s) => s.aborted === false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer options (createLayer)
// ---------------------------------------------------------------------------

describe('Feature: --use Layers receive the invocation options', () => {
  it('@T-R4 @ADR-0019-D1 createLayer receives the flat options bag (with the caller\'s keys) and its Layer wraps the call', async () => {
    const bags: Array<Record<string, unknown>> = [];
    const plugin: Pick<Plugin, 'id'> & { capabilities: { layer: { createLayer: (opts: Record<string, unknown>) => (call: Call, next: () => unknown) => unknown } } } = {
      id: 'opts-probe',
      capabilities: {
        layer: {
          createLayer: (opts) => {
            bags.push(opts);
            return async (c, next) => {
              const out = await next();
              return typeof out === 'string' ? `${String(opts['marker'])}:${out}` : out;
            };
          },
        },
      },
    };
    const host = await startHost({ options: { usePlugins: [plugin], marker: 'M1' } });
    expect(bags).toHaveLength(1);
    expect(bags.every((b) => b['marker'] === 'M1')).toBe(true);
    const result = await call(host, 'echoString');
    expect(result.content).toEqual([{ type: 'text', text: 'M1:ok' }]);
  });

  it('@T-R4 @ADR-0019-D1 a Layer refusal (ApiError permission_denied) surfaces as an isError result and the function never runs', async () => {
    let ran = 0;
    const refuse = layerPlugin('refuser', () => {
      throw new ApiError('permission_denied', 'blocked by rule r1');
    });
    const host = await startHost({
      options: { usePlugins: [refuse] },
      packages: [{ id: PKG.id, schemas: SCHEMAS, importPath: PKG.importPath, fns: { ...FNS, echoString: () => (ran += 1, 'ok') } }],
    });
    const result = await call(host, 'echoString');
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toBe('permission_denied: blocked by rule r1');
    expect(ran).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// options.terminal
// ---------------------------------------------------------------------------

const GATEWAY = { id: 'gw', importPath: '@test/gw' };
const flatInput = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };

/** A terminal-routed (gateway/proxy) operation: bound to an upstream, flat input. */
function terminalOp(fnName: string, extra: Partial<Operation> = {}): Operation {
  return { ...operationFor(GATEWAY, fnName), host: 'mcp', binding: `mcp:${GATEWAY.id}`, input: flatInput, ...extra };
}

type Terminal = (fnName: string, call: { domainArgs: Record<string, unknown>; signal?: AbortSignal }, opts: unknown) => Promise<unknown>;

describe('Feature: options.terminal serves operations no package implements', () => {
  it('@T-R4 @D1 a flat-argument operation runs through the terminal: the terminal receives the arguments as ONE object plus the call signal, and its return reaches the host', async () => {
    const op = terminalOp('save');
    const seen: Array<{ fn: string; args: Record<string, unknown>; signal: AbortSignal | undefined }> = [];
    const terminal: Terminal = async (fn, c) => {
      seen.push({ fn, args: c.domainArgs, signal: c.signal });
      return 'saved';
    };
    const host = await startHost({ packages: [], operations: [op], options: { terminal } });
    const result = (await host.client.callTool({ name: nameOf(op), arguments: { text: 'hi' } })) as IToolResult;
    expect(result.content).toEqual([{ type: 'text', text: 'saved' }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.fn).toBe(op.id);
    expect(seen[0]?.args).toEqual({ text: 'hi' });
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('@T-R4 @D1 --use Layers run BEFORE the terminal, in order, and see the same flat arguments', async () => {
    const op = terminalOp('save');
    const trace: string[] = [];
    const seenByLayer: Array<Record<string, unknown>> = [];
    const outer = layerPlugin('outer', async (c, next) => {
      trace.push('outer:in');
      seenByLayer.push({ ...c.data });
      const out = await next();
      trace.push('outer:out');
      return out;
    });
    const inner = layerPlugin('inner', (_c, next) => (trace.push('inner'), next()));
    const terminal: Terminal = async () => (trace.push('terminal'), 'saved');
    const host = await startHost({ packages: [], operations: [op], options: { terminal, usePlugins: [outer, inner] } });
    const result = (await host.client.callTool({ name: nameOf(op), arguments: { text: 'hi' } })) as IToolResult;
    expect(result.content?.[0]?.text).toBe('saved');
    expect(trace).toEqual(['outer:in', 'inner', 'terminal', 'outer:out']);
    expect(seenByLayer).toEqual([{ text: 'hi' }]);
  });

  it('@T-R4 @D1 a Layer refusal skips the terminal: the host reads permission_denied and the terminal never ran', async () => {
    const op = terminalOp('save');
    let terminalCalls = 0;
    const refuse = layerPlugin('refuser', () => {
      throw new ApiError('permission_denied', 'denied by permission global:1');
    });
    const terminal: Terminal = async () => (terminalCalls += 1, 'saved');
    const host = await startHost({ packages: [], operations: [op], options: { terminal, usePlugins: [refuse] } });
    const result = (await host.client.callTool({ name: nameOf(op), arguments: { text: 'hi' } })) as IToolResult;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toBe('permission_denied: denied by permission global:1');
    expect(terminalCalls).toBe(0);
  });

  it('@T-R4 @D1 a terminal result that is already a CallToolResult reaches the host unchanged (upstream isError and content intact)', async () => {
    const op = terminalOp('save');
    const upstream = { content: [{ type: 'text', text: 'upstream says no' }], isError: true };
    const host = await startHost({ packages: [], operations: [op], options: { terminal: (async () => upstream) as Terminal } });
    const result = (await host.client.callTool({ name: nameOf(op), arguments: { text: 'hi' } })) as IToolResult;
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(upstream.content);
  });

  it('@T-R4 @D1 a terminal that throws the gateway unavailable error resolves as "unavailable: <message>"', async () => {
    const op = terminalOp('save');
    const terminal: Terminal = async () => {
      throw new ApiError('internal', 'upstream gw is restarting', { gatewayCode: 'unavailable' });
    };
    const host = await startHost({ packages: [], operations: [op], options: { terminal } });
    const result = (await host.client.callTool({ name: nameOf(op), arguments: { text: 'hi' } })) as IToolResult;
    expect(result.content?.[0]?.text).toBe('unavailable: upstream gw is restarting');
    expect(result._meta?.['adhd/error']).toEqual({ code: 'internal', gatewayCode: 'unavailable' });
  });

  it('@T-R4 @D1 tools/list uses the upstream description and outputSchema (and title/annotations) instead of the generated ones', async () => {
    const outputSchema = { type: 'object', properties: { saved: { type: 'boolean' } }, required: ['saved'] };
    const op = terminalOp('save', {
      tool: { title: 'Save a note', description: 'Persist a note upstream.', annotations: { readOnlyHint: false }, outputSchema },
    });
    const bare = terminalOp('plainRemote');
    const host = await startHost({ packages: [], operations: [op, bare], options: { terminal: (async () => 'x') as Terminal } });
    const { tools } = await host.client.listTools();
    const saved = tools.find((t) => t.name === nameOf(op));
    expect(saved?.description).toBe('Persist a note upstream.');
    expect(saved?.outputSchema).toEqual(outputSchema);
    expect(saved?.title).toBe('Save a note');
    expect(saved?.annotations).toEqual({ readOnlyHint: false });
    expect(saved?.inputSchema).toMatchObject({ type: 'object', properties: { text: { type: 'string' } } });
    const generated = tools.find((t) => t.name === nameOf(bare));
    expect(generated?.description).not.toBe('Persist a note upstream.');
    expect(generated?.description?.length).toBeGreaterThan(0);
  });

  it('@T-R4 @D1 a terminal operation whose tool name clashes with another operation is rejected at startup with invalid_argument naming the name', async () => {
    const a = terminalOp('save');
    const b: Operation = { ...a, id: 'other/save-id' };
    expect(nameOf(a)).toBe(nameOf(b));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    void clientSide;
    const failure = await mcpPlugin
      .run!({
        packages: [],
        operations: [a, b],
        outputDir: 'tmp/apigen-plugin-mcp-unused',
        options: { transport: 'stdio', hostTransport: serverSide, terminal: (async () => 'x') as Terminal },
        logger: SILENT,
      })
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect((failure as ApiError | undefined)?.code).toBe('invalid_argument');
    expect((failure as Error).message).toContain(nameOf(a));
  });

  it('@T-R4 @D1 an operation a package already implements is served by the package, not the terminal', async () => {
    let terminalCalls = 0;
    const terminal: Terminal = async () => (terminalCalls += 1, 'from-terminal');
    const host = await startHost({ operations: packageOps(), options: { terminal } });
    expect((await call(host, 'echoString')).content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(terminalCalls).toBe(0);
  });

  it('@T-R4 @D1 a non-function options.terminal fails startup with invalid_argument', async () => {
    const [, serverSide] = InMemoryTransport.createLinkedPair();
    const failure = await mcpPlugin
      .run!({
        packages: [{ id: PKG.id, schemas: SCHEMAS, importPath: PKG.importPath, fns: FNS }],
        outputDir: 'tmp/apigen-plugin-mcp-unused',
        options: { transport: 'stdio', hostTransport: serverSide, terminal: 'not-a-function' },
        logger: SILENT,
      })
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect((failure as ApiError | undefined)?.code).toBe('invalid_argument');
    expect((failure as Error).message).toContain('"terminal" must be a function');
  });
});

// ---------------------------------------------------------------------------
// hostTransport / serverInfo / stdio
// ---------------------------------------------------------------------------

describe('Feature: in-process seams of mcpPlugin.run', () => {
  it('@T-R4 @seam options.hostTransport serves the host in-process, run() settles when the host closes the transport, with no signal', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const running = mcpPlugin.run!({
      packages: [{ id: PKG.id, schemas: SCHEMAS, importPath: PKG.importPath, fns: FNS }],
      outputDir: 'tmp/apigen-plugin-mcp-unused',
      options: { transport: 'stdio', hostTransport: serverSide },
      logger: SILENT,
    });
    const client = new Client({ name: 'close-probe', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientSide);
    expect((await client.callTool({ name: toolName('echoString'), arguments: { data: {} } })) as IToolResult).toMatchObject({
      content: [{ type: 'text', text: 'ok' }],
    });
    await client.close();
    await expect(running).resolves.toBeUndefined();
  });

  it('@T-R4 @seam a hostTransport that is not an SDK Transport is rejected with invalid_argument', async () => {
    const failure = await mcpPlugin
      .run!({
        packages: [{ id: PKG.id, schemas: SCHEMAS, importPath: PKG.importPath, fns: FNS }],
        outputDir: 'tmp/apigen-plugin-mcp-unused',
        options: { transport: 'stdio', hostTransport: { start: () => undefined } },
        logger: SILENT,
      })
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect((failure as ApiError | undefined)?.code).toBe('invalid_argument');
    expect((failure as Error).message).toContain('hostTransport');
  });

  it('@T-R4 @seam options.serverInfo overrides the handshake identity; without it the first package id and version are reported', async () => {
    const overridden = await startHost({ options: { serverInfo: { name: 'adhd-policy', version: '9.9.9' } } });
    expect(overridden.client.getServerVersion()).toMatchObject({ name: 'adhd-policy', version: '9.9.9' });

    const defaulted = await startHost({
      packages: [{ id: PKG.id, schemas: SCHEMAS, importPath: PKG.importPath, fns: FNS, version: '2.3.4' }],
    });
    expect(defaulted.client.getServerVersion()).toMatchObject({ name: PKG.id, version: '2.3.4' });
  });

  it('@T-R4 @seam a serverInfo missing a string name or version is ignored, falling back to the package identity', async () => {
    const host = await startHost({ options: { serverInfo: { name: 'only-name' } } });
    expect(host.client.getServerVersion()).toMatchObject({ name: PKG.id, version: '1.0.0' });
  });

  it('@T-R4 @seam options.stdio injects the stdin/stdout streams: a JSON-RPC session runs over them and stdin EOF settles run() with no signal', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const replies = new Map<number, Record<string, unknown>>();
    const waiters = new Map<number, (m: Record<string, unknown>) => void>();
    let buffer = '';
    stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line.length === 0) continue;
        const message = JSON.parse(line) as Record<string, unknown> & { id?: number };
        if (typeof message.id === 'number') {
          replies.set(message.id, message);
          waiters.get(message.id)?.(message);
        }
      }
    });
    const reply = (id: number): Promise<Record<string, unknown>> =>
      replies.has(id) ? Promise.resolve(replies.get(id) as Record<string, unknown>) : new Promise((resolve) => waiters.set(id, resolve));
    const send = (message: Record<string, unknown>): void => void stdin.write(`${JSON.stringify(message)}\n`);

    const running = mcpPlugin.run!({
      packages: [{ id: PKG.id, schemas: SCHEMAS, importPath: PKG.importPath, fns: FNS }],
      outputDir: 'tmp/apigen-plugin-mcp-unused',
      options: { transport: 'stdio', stdio: { stdin, stdout } },
      logger: SILENT,
    });

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } });
    const init = (await reply(1)) as { result?: { serverInfo?: { name?: string } } };
    expect(init.result?.serverInfo?.name).toBe(PKG.id);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName('echoString'), arguments: { data: {} } } });
    const called = (await reply(2)) as { result?: { content?: Array<{ text?: string }> } };
    expect(called.result?.content?.[0]?.text).toBe('ok');

    stdin.end();
    await expect(running).resolves.toBeUndefined();
  });

  it('@T-R4 @seam an options.stdio that is not a { stdin, stdout } object, or has a non-stream member, is rejected with invalid_argument', async () => {
    for (const stdio of ['nope', { stdin: 5 }, { stdout: {} }]) {
      const failure = await mcpPlugin
        .run!({
          packages: [{ id: PKG.id, schemas: SCHEMAS, importPath: PKG.importPath, fns: FNS }],
          outputDir: 'tmp/apigen-plugin-mcp-unused',
          options: { transport: 'stdio', stdio },
          logger: SILENT,
        })
        .then(
          () => undefined,
          (error: unknown) => error
        );
      expect((failure as ApiError | undefined)?.code, JSON.stringify(stdio)).toBe('invalid_argument');
    }
  });
});
