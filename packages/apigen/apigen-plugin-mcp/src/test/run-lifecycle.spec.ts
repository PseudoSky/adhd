/**
 * Transport lifecycle — the `run()` shutdown contract and the memoized
 * `tools/list` projection.
 *
 * Closes:
 *  - BUG a4b5bad6 — `run()`'s stdio/sse/streaming-http promise never settled
 *    without an AbortSignal (each transport built a `new Promise` whose sole
 *    `resolve()` sat inside an `if (input.signal)` guard).
 *  - BUG d6fd726f — `sse`/`streaming-http` attached no `'error'` listener
 *    before `httpServer.listen()`, so a bind failure (EADDRINUSE) surfaced as
 *    an unhandled `'error'` event and never reached the `run()` caller.
 *  - DEBT 730f525f — `listTools()` rebuilt its array (and a fresh default
 *    input schema per schema-less tool) on every call.
 *
 * NO-GO remediation (this file):
 *  - HIGH-1: the "no signal" negative control keyed on `/signal|shutdown/i`,
 *    whose own `settleWithin` deadline message contains the word "signal", so
 *    it could never go red. It now asserts the typed identity
 *    (`code:'invalid_argument'`) AND the specific message.
 *  - HIGH-2: the stdio branch is driven end-to-end through
 *    `run({transport:'stdio'})` over a REAL stdin pipe (not just the extracted
 *    helper), proving the promise settles on stdin EOF with NO signal. The SDK
 *    transport does not raise `onclose` for EOF, so the helper watches stdin
 *    directly — and this test would fail if that wiring were reverted.
 *  - HIGH-3: `awaitStdioClose` must CHAIN, never replace, the SDK's
 *    `Protocol.connect()`-installed `onclose`; the test asserts
 *    `Protocol._onclose()` still ran (`server.transport` cleared).
 *  - HIGH-4: aborting `sse` while a client holds a stream open must still
 *    settle `run()` (bounded deadline) — `httpServer.close()` alone does not.
 *
 * RESOURCE LANE — DEFAULT-RUNNING BY DESIGN. These are `*.spec.ts`, so the
 * project's default `test` target runs them. The lifecycle cases bind real
 * loopback sockets (the bind-failure and abort-with-open-stream cases) and
 * close them in `finally`; per AGENTS.md §7 a local port is NOT a paid/external
 * third-party service, so env-gating this would be an undocumented gate — it
 * runs by default, and it must FAIL (never silently skip) if the loopback bind
 * prerequisite is unavailable.
 *
 * Assertions are keyed on the returned promise's settle/reject, on object
 * identity, and on the real SDK's own disconnect bookkeeping — never on
 * wall-clock sleeps. Bounded deadlines exist only so a REGRESSION (a promise
 * that never settles) turns the suite red promptly instead of hanging on
 * vitest's global timeout.
 */
import { describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { PassThrough } from 'node:stream';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ComposedSchemas, RunInput } from '@adhd/apigen-core-client';
import type { LayerResult } from '@adhd/apigen-engine-runtime';
import { buildOpPlan, createLogger } from '@adhd/apigen-engine-runtime';
import { awaitStdioClose, McpTransportAdapter, run } from '../lib/run';
import { operationFor } from '../lib/tool-naming';

/** Reject — rather than hang — if `promise` has not settled within `ms`. */
async function settleWithin<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}: did not settle within ${ms}ms`)),
      ms
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Bind a TCP server to an ephemeral loopback port and hold it, so a second
 * `listen()` on that port fails with EADDRINUSE. `release()` always closes it. */
async function occupyLoopbackPort(): Promise<{
  port: number;
  release: () => Promise<void>;
}> {
  const srv = net.createServer();
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve());
  });
  const address = srv.address() as net.AddressInfo;
  return {
    port: address.port,
    release: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

/** Reserve a currently-free loopback port (bind, read the port, release it) so
 * `run()` can be given a concrete port the test can then connect to. */
async function reserveLoopbackPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = srv.address() as net.AddressInfo;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

/** Open a `/sse` stream against `port` and keep it open. A readiness retry
 * (bounded) covers the gap between `run()` being called and its server binding
 * — this is a liveness poll, not a correctness race. */
async function openSseStream(
  port: number,
  readinessBudgetMs = 3000
): Promise<http.IncomingMessage> {
  const deadline = Date.now() + readinessBudgetMs;
  for (;;) {
    try {
      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/sse' }, resolve);
        req.once('error', reject);
      });
      // The server force-closes this socket on abort; don't let that surface as
      // an unhandled 'error' event.
      res.on('error', () => undefined);
      return res;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

/** Minimal valid `RunInput` — no packages needed to exercise the transport
 * lifecycle: `buildToolTable()` with zero packages is a no-op, so `run()`
 * reaches the transport branch with an empty tool table. */
function lifecycleInput(
  transport: string,
  overrides: Partial<RunInput> = {}
): RunInput {
  return {
    packages: [],
    outputDir: '/tmp/apigen-plugin-mcp-test',
    options: { transport, host: '127.0.0.1', port: 0 },
    ...overrides,
  };
}

/** A real stdio transport over in-memory streams (no process I/O). */
function stdioTransport(): {
  transport: StdioServerTransport;
  stdin: PassThrough;
} {
  const stdin = new PassThrough();
  return { transport: new StdioServerTransport(stdin, new PassThrough()), stdin };
}

describe('run() lifecycle — an HTTP transport with no AbortSignal rejects (a4b5bad6)', () => {
  it.each(['sse', 'streaming-http'] as const)(
    '%s: run() rejects with a typed invalid_argument naming the missing signal',
    async (transport) => {
      // No `signal`. Pre-fix this bound a server and the promise never settled.
      const settled = run(lifecycleInput(transport));
      // HIGH-1: key on the TYPED identity (and the specific message), never on
      // a bare /signal/i token — `settleWithin`'s own timeout message contains
      // "signal", so a token match would pass even when `run()` hangs.
      await expect(
        settleWithin(settled, 2000, `${transport} run() without a signal`)
      ).rejects.toMatchObject({ code: 'invalid_argument' });
      await expect(
        settleWithin(run(lifecycleInput(transport)), 2000, transport)
      ).rejects.toThrow(/requires RunInput\.signal/);
    }
  );

  it('stdio is NOT required to have a signal — no path resolves solely inside an `if (input.signal)` guard', () => {
    // Guard against regressing the invariant structurally, independent of the
    // behavioural stdio test below: a signal-less awaitStdioClose must still
    // resolve when `onclose` fires.
    const { transport, stdin } = stdioTransport();
    const settled = awaitStdioClose(transport, createLogger(), undefined, stdin);
    transport.onclose?.();
    return expect(settled).resolves.toBeUndefined();
  });
});

describe('run() over stdio — the stdio branch settles on stdin EOF without a signal (a4b5bad6 HIGH-2)', () => {
  it('run({transport:"stdio"}) resolves when the client closes stdin', async () => {
    // A real stdin pipe stood in for the process's own stdin, so the whole
    // path is exercised: run() builds a real StdioServerTransport over it,
    // `server.connect()` binds it, and `awaitStdioClose()` watches for EOF.
    const fakeStdin = new PassThrough();
    const stdinSpy = vi
      .spyOn(process, 'stdin', 'get')
      .mockReturnValue(fakeStdin as unknown as NodeJS.ReadStream);
    try {
      const settled = run(lifecycleInput('stdio'));
      // Drain microtasks so `server.connect()`/`awaitStdioClose()` finish
      // wiring before EOF is signalled.
      await new Promise<void>((resolve) => setImmediate(resolve));
      // The MCP client closing its end of the pipe.
      fakeStdin.end();
      await expect(
        settleWithin(settled, 1000, 'stdio run() on stdin EOF')
      ).resolves.toBeUndefined();
    } finally {
      stdinSpy.mockRestore();
      fakeStdin.destroy();
    }
  });
});

describe('run() lifecycle — a bind failure reaches the caller, not an unhandled event (d6fd726f)', () => {
  it.each(['sse', 'streaming-http'] as const)(
    '%s: run() rejects naming the occupied host:port within 5s',
    async (transport) => {
      const occupied = await occupyLoopbackPort();
      const controller = new AbortController();
      try {
        const settled = run(
          lifecycleInput(transport, {
            options: { transport, host: '127.0.0.1', port: occupied.port },
            signal: controller.signal,
          })
        );
        await expect(
          settleWithin(settled, 5000, `${transport} run() bind failure`)
        ).rejects.toThrow(new RegExp(String(occupied.port)));
      } finally {
        controller.abort();
        await occupied.release();
      }
    }
  );
});

describe('run() lifecycle — abort settles while a client holds a stream open (a4b5bad6 HIGH-4)', () => {
  it('sse: aborting with an open SSE response resolves run() within a bounded deadline', async () => {
    const port = await reserveLoopbackPort();
    const controller = new AbortController();
    const settled = run(
      lifecycleInput('sse', {
        options: { transport: 'sse', host: '127.0.0.1', port },
        signal: controller.signal,
      })
    );
    // Hold the SSE response open — this connection is exactly what makes a bare
    // `httpServer.close()` wait forever.
    const stream = await openSseStream(port);
    try {
      controller.abort();
      await expect(
        settleWithin(settled, 2000, 'sse run() abort with an open stream')
      ).resolves.toBeUndefined();
    } finally {
      stream.destroy();
      controller.abort();
    }
  });
});

describe('awaitStdioClose() — stdio shutdown needs no signal', () => {
  it('resolves on onclose when no signal is supplied', async () => {
    const { transport, stdin } = stdioTransport();
    const settled = awaitStdioClose(transport, createLogger(), undefined, stdin);
    expect(typeof transport.onclose).toBe('function');
    transport.onclose?.();
    await expect(
      settleWithin(settled, 1000, 'awaitStdioClose onclose')
    ).resolves.toBeUndefined();
  });

  it('resolves on stdin EOF — the SDK transport does NOT raise onclose for EOF', async () => {
    const { transport, stdin } = stdioTransport();
    const settled = awaitStdioClose(transport, createLogger(), undefined, stdin);
    // A stream only emits 'end' while flowing — the real transport's 'data'
    // listener puts process.stdin into flowing mode, so match that here.
    stdin.resume();
    stdin.end();
    await expect(
      settleWithin(settled, 1000, 'awaitStdioClose stdin EOF')
    ).resolves.toBeUndefined();
  });

  it('also resolves on abort when a signal IS supplied (additive, not required)', async () => {
    const { transport, stdin } = stdioTransport();
    const controller = new AbortController();
    const settled = awaitStdioClose(
      transport,
      createLogger(),
      controller.signal,
      stdin
    );
    controller.abort();
    await expect(
      settleWithin(settled, 1000, 'awaitStdioClose abort')
    ).resolves.toBeUndefined();
  });

  it('chains — never clobbers — the SDK Protocol.connect() onclose (HIGH-3)', async () => {
    const { transport, stdin } = stdioTransport();
    const server = new Server(
      { name: 'chain-probe', version: '0.0.0' },
      { capabilities: { tools: {} } }
    );
    await server.connect(transport);
    // sanity: the SDK installed its chained handler on connect()
    expect(server.transport).toBe(transport);

    const settled = awaitStdioClose(transport, createLogger(), undefined, stdin);
    transport.onclose?.();
    await expect(settled).resolves.toBeUndefined();

    // `Protocol._onclose()` clears `_transport`; it is reachable ONLY through
    // the chained handler. A clobbering replacement leaves it set — RED.
    expect(server.transport).toBeUndefined();
  });
});

describe('McpTransportAdapter.listTools() — memoized projection (730f525f)', () => {
  const schema = {
    input: { type: 'object', properties: {} },
  } as unknown as ComposedSchemas[string];

  function planFor(fnName: string) {
    const op = operationFor(
      { id: 'test-pkg', importPath: '@test/test-pkg' },
      fnName
    );
    return buildOpPlan({ op, schema, transport: 'mcp', projection: {} });
  }

  const dispatch = async (): Promise<LayerResult> => ({} as LayerResult);

  it('returns the same array reference across calls, a fresh one after registerRoute, and shares one default input schema', () => {
    const adapter = new McpTransportAdapter();

    // No routes: both calls hand back the SAME (empty) array instance.
    const empty1 = adapter.listTools();
    const empty2 = adapter.listTools();
    expect(empty1).toBe(empty2);
    expect(empty1).toEqual([]);

    // registerRoute() is the mutation point — it must invalidate the cache.
    const planA = planFor('getUser');
    adapter.registerRoute(planA, dispatch);
    const afterA = adapter.listTools();
    expect(afterA).not.toBe(empty1);
    expect(afterA.map((t) => t.name)).toContain(planA.mcp.name);

    // …and memoize again, so the next call is stable.
    expect(adapter.listTools()).toBe(afterA);

    const planB = planFor('listUsers');
    adapter.registerRoute(planB, dispatch);
    const afterB = adapter.listTools();
    expect(afterB).not.toBe(afterA);

    const entryA = afterB.find((t) => t.name === planA.mcp.name);
    const entryB = afterB.find((t) => t.name === planB.mcp.name);
    expect(entryA).toBeDefined();
    expect(entryB).toBeDefined();
    // Neither tool had metadata bound, so both must point at the ONE shared
    // module-level DEFAULT_INPUT_SCHEMA — not two fresh object literals.
    expect(entryA?.inputSchema).toBe(entryB?.inputSchema);
    expect(entryA?.inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('invalidates the memoized projection when bindToolMeta() runs (LOW-a)', () => {
    const adapter = new McpTransportAdapter();
    const plan = planFor('getUser');
    adapter.registerRoute(plan, dispatch);
    const before = adapter.listTools();

    // bindToolMeta() is the metadata half of the projection and must ALSO
    // invalidate — a stale description here would be served forever.
    const inputSchema = { type: 'object', properties: { id: { type: 'string' } } };
    adapter.bindToolMeta(plan.mcp.name, {
      description: 'bound-after-register',
      inputSchema,
    });
    const after = adapter.listTools();

    expect(after).not.toBe(before);
    const entry = after.find((t) => t.name === plan.mcp.name);
    expect(entry?.description).toBe('bound-after-register');
    expect(entry?.inputSchema).toBe(inputSchema);
    // …and re-memoized.
    expect(adapter.listTools()).toBe(after);
  });

  it('hands out a frozen projection — the memoized cache cannot be corrupted in place (LOW-b)', () => {
    const adapter = new McpTransportAdapter();
    const plan = planFor('getUser');
    adapter.registerRoute(plan, dispatch);

    const list = adapter.listTools();
    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(list[0])).toBe(true);
    // Schema-less tool → the shared DEFAULT_INPUT_SCHEMA, which is frozen too.
    expect(Object.isFrozen(list[0]?.inputSchema)).toBe(true);

    expect(() => {
      (list as unknown[]).push({ name: 'injected' });
    }).toThrow(TypeError);
    // The cache is untouched.
    expect(adapter.listTools()).toBe(list);
  });
});
