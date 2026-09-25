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
 * RESOURCE LANE — DEFAULT-RUNNING BY DESIGN. These are `*.spec.ts`, so the
 * project's default `test` target runs them. Exactly one case binds a real
 * loopback port (the bind-failure case) and closes it in `finally`; every
 * other case fails or settles without a socket. Per AGENTS.md §7 a local
 * port is NOT a paid/external third-party service, so env-gating this would
 * be an undocumented gate — it runs by default, and it must FAIL (never
 * silently skip) if the loopback bind prerequisite is unavailable.
 *
 * Assertions are keyed on the returned promise's settle/reject and on object
 * identity — never on wall-clock sleeps. Bounded deadlines exist only so a
 * REGRESSION (a promise that never settles) turns the suite red promptly
 * instead of hanging on vitest's global timeout: pre-fix each of these
 * negative-control cases times out at the deadline below.
 */
import { describe, expect, it } from 'vitest';
import * as net from 'node:net';
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

describe('run() lifecycle — an HTTP transport with no AbortSignal rejects (a4b5bad6)', () => {
  it.each(['sse', 'streaming-http'] as const)(
    '%s: run() rejects naming the missing signal within a bounded deadline',
    async (transport) => {
      // No `signal`. Pre-fix this bound a server and the promise never settled.
      const settled = run(lifecycleInput(transport));
      await expect(
        settleWithin(settled, 2000, `${transport} run() without a signal`)
      ).rejects.toThrow(/signal|shutdown/i);
    }
  );

  it('stdio is NOT required to have a signal — no path resolves solely inside an `if (input.signal)` guard', () => {
    // Guard against regressing the invariant structurally, independent of the
    // behavioural stdio test below: a signal-less awaitStdioClose must still
    // resolve when `onclose` fires.
    const transport: { onclose?: () => void } = {};
    const settled = awaitStdioClose(transport, createLogger());
    transport.onclose?.();
    return expect(settled).resolves.toBeUndefined();
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

describe('awaitStdioClose() — stdio shutdown needs no signal', () => {
  it('resolves on onclose when no signal is supplied', async () => {
    const transport: { onclose?: () => void } = {};
    const settled = awaitStdioClose(transport, createLogger());
    expect(typeof transport.onclose).toBe('function');
    transport.onclose?.();
    await expect(
      settleWithin(settled, 1000, 'awaitStdioClose onclose')
    ).resolves.toBeUndefined();
  });

  it('also resolves on abort when a signal IS supplied (additive, not required)', async () => {
    const transport: { onclose?: () => void } = {};
    const controller = new AbortController();
    const settled = awaitStdioClose(transport, createLogger(), controller.signal);
    controller.abort();
    await expect(
      settleWithin(settled, 1000, 'awaitStdioClose abort')
    ).resolves.toBeUndefined();
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
});
