// Unit tests for @adhd/apigen-plugin-batch's `MountCapability.operations()`
// (3-arg hostBridge call) and its handler's real fan-out logic.
//
// Per CLAUDE.md §7: mocks are used ONLY for the external boundary — here,
// the "host's own composed invoker" (`hostBridge.invoke`) stands in for a
// real host's `createPackageInvoker`. Everything downstream of that
// boundary — `invokeBatch`'s real concurrency/error-handling/timeout logic,
// `buildBatchMountedOperations`'s real schema/mount derivation, the plugin's
// own request parsing — is the REAL implementation, never mocked.

import { describe, expect, it, vi } from 'vitest';
import type {
  Call,
  Descriptor,
  MountHostBridge,
  MountHostBridgeInvokeOptions,
  Operation,
} from '@adhd/apigen-core-client';
import { ApiError } from '@adhd/apigen-base-errors';
import batchPlugin from '../lib/plugin';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeOp(id: string, kind: Operation['kind'] = 'action'): Operation {
  const [namespace, ...path] = id.split('/');
  return {
    id,
    host: 'ts',
    namespace: { raw: namespace, words: [namespace] },
    path: path.map((p) => ({ raw: p, words: [p] })),
    kind,
    async: false,
    streaming: false,
    safe: kind === 'query',
    input: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
    output: { type: 'string' },
    envelope: {},
    typeText: null,
  };
}

/**
 * BUG-APIGEN-CLI-002: `_batch/<kind>`'s wire shape nests every control-plane
 * field under one top-level `input` object (`batch.ts`'s `branchInputSchema`)
 * — matching every other apigen-mounted operation's single-JSON-blob
 * convention. `fakeCall` takes the bare `{operation, items, ...}` fields (as
 * every test below already does) and wraps them into the real `{data:
 * {input: {...}}}` shape the handler actually receives, so call sites read
 * exactly like the batch request they're modeling.
 */
function fakeCall(input: Record<string, unknown>): Call {
  return {
    operation: makeOp('_batch/action'),
    data: { input },
    envelope: {},
    ctx: { get: () => undefined, set: () => undefined },
    transport: 'http',
    signal: new AbortController().signal,
  };
}

/** Builds a `Call` whose `data` is passed through UNWRAPPED — for asserting the `input` wrapper is actually required. */
function fakeCallUnwrapped(data: Record<string, unknown>): Call {
  return {
    operation: makeOp('_batch/action'),
    data,
    envelope: {},
    ctx: { get: () => undefined, set: () => undefined },
    transport: 'http',
    signal: new AbortController().signal,
  };
}

/**
 * A minimal, REAL (not mocked) `MountHostBridge` whose `invoke` looks up a
 * plain in-memory function table by op id — this stands in for a host's real
 * `createPackageInvoker`-composed invoker (the one legitimate mock boundary:
 * "the host's own runtime", not the thing under test).
 */
function makeHostBridge(
  fns: Record<string, (domainArgs: Record<string, unknown>) => unknown>
): MountHostBridge {
  const invokeOptions: MountHostBridgeInvokeOptions = {
    fns: fns as Record<string, (...args: unknown[]) => unknown>,
    schemas: {},
  };
  return {
    invoke: vi.fn(async (fnName, call) => {
      const fn = fns[fnName];
      if (!fn) throw new Error(`no such fn: ${fnName}`);
      return fn(call.domainArgs);
    }),
    invokeOptions,
  };
}

const requireMount = (): NonNullable<typeof batchPlugin.capabilities.mount> => {
  const mount = batchPlugin.capabilities.mount;
  if (!mount) throw new Error('batchPlugin unexpectedly has no mount capability');
  return mount;
};

// ---------------------------------------------------------------------------
// Mount derivation (3-arg operations() call)
// ---------------------------------------------------------------------------

describe('batchPlugin mount: operations(descriptor, opts, hostBridge)', () => {
  it('returns [] for a descriptor with zero batchable operations (§1.1 edge case)', () => {
    const descriptor: Descriptor = { host: 'ts', operations: [] };
    const ops = requireMount().operations(descriptor, undefined, undefined);
    expect(ops).toEqual([]);
  });

  it('mounts one _batch/<kind> operation per distinct kind, with a real handler attached', () => {
    const descriptor: Descriptor = {
      host: 'ts',
      operations: [makeOp('ns/opA', 'action'), makeOp('ns/opB', 'action'), makeOp('ns/opC', 'query')],
    };
    const ops = requireMount().operations(descriptor, undefined, undefined);
    const ids = ops.map((o) => o.id).sort();
    expect(ids).toEqual(['_batch/action', '_batch/query']);
    for (const op of ops) {
      expect(typeof op.handler).toBe('function');
    }
  });

  it('respects opts.exclude (§2.1)', () => {
    const descriptor: Descriptor = {
      host: 'ts',
      operations: [makeOp('ns/opA'), makeOp('ns/opB')],
    };
    const ops = requireMount().operations(descriptor, { exclude: ['ns/opA', 'ns/opB'] }, undefined);
    expect(ops).toEqual([]);
  });

  it('a 3-arg call accepts a hostBridge without throwing at mount time (only the handler needs it)', () => {
    const descriptor: Descriptor = { host: 'ts', operations: [makeOp('ns/opA')] };
    const bridge = makeHostBridge({ 'ns/opA': (a) => a });
    expect(() => requireMount().operations(descriptor, undefined, bridge)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Handler — missing hostBridge (clear, actionable error, never a silent no-op)
// ---------------------------------------------------------------------------

describe('batchPlugin handler: missing hostBridge', () => {
  it('throws a clear ApiError (code: internal) instead of silently no-opping', async () => {
    const descriptor: Descriptor = { host: 'ts', operations: [makeOp('ns/opA')] };
    const [op] = requireMount().operations(descriptor, undefined, undefined);
    await expect(
      op.handler(fakeCall({ operation: 'ns/opA', items: [{ value: 'x' }] }))
    ).rejects.toMatchObject({
      code: 'internal',
      message: expect.stringContaining('MountHostBridge'),
    });
  });
});

// ---------------------------------------------------------------------------
// Handler — request validation (defense-in-depth, §1.1)
// ---------------------------------------------------------------------------

describe('batchPlugin handler: request validation', () => {
  function mountedOp() {
    const descriptor: Descriptor = {
      host: 'ts',
      operations: [makeOp('ns/opA'), makeOp('ns/opB')],
    };
    const bridge = makeHostBridge({
      'ns/opA': (a) => `A:${a['value']}`,
      'ns/opB': (a) => `B:${a['value']}`,
    });
    const [op] = requireMount().operations(descriptor, undefined, bridge);
    return { op, bridge };
  }

  it('rejects a missing/non-string "operation"', async () => {
    const { op } = mountedOp();
    await expect(
      op.handler(fakeCall({ items: [] }))
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('rejects an "operation" not in this mount\'s batchable set', async () => {
    const { op } = mountedOp();
    await expect(
      op.handler(fakeCall({ operation: 'ns/not-a-real-op', items: [] }))
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('rejects a non-array "items"', async () => {
    const { op } = mountedOp();
    await expect(
      op.handler(fakeCall({ operation: 'ns/opA', items: 'not-an-array' }))
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('rejects a malformed "mode"', async () => {
    const { op } = mountedOp();
    await expect(
      op.handler(fakeCall({ operation: 'ns/opA', items: [], mode: 'sideways' }))
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  // BUG-APIGEN-CLI-002: the control-plane fields MUST be nested under a
  // top-level `input` object — a request that sends them unwrapped (the
  // pre-fix flat shape) must be rejected, not silently accepted.
  it('rejects the pre-fix flat shape — {operation, items} directly on data, not nested under "input"', async () => {
    const { op } = mountedOp();
    await expect(
      op.handler(fakeCallUnwrapped({ operation: 'ns/opA', items: [{ value: 'x' }] }))
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });
});

// ---------------------------------------------------------------------------
// Handler — real fan-out via the real invokeBatch (only hostBridge.invoke is faked)
// ---------------------------------------------------------------------------

describe('batchPlugin handler: real fan-out (invokeBatch)', () => {
  it('fans out N items to the named target operation and returns fulfilled results in order', async () => {
    const descriptor: Descriptor = { host: 'ts', operations: [makeOp('ns/opA')] };
    const bridge = makeHostBridge({
      'ns/opA': (a) => `echo:${a['value']}`,
    });
    const [op] = requireMount().operations(descriptor, undefined, bridge);

    const result = await op.handler(
      fakeCall({
        operation: 'ns/opA',
        items: [{ value: 'one' }, { value: 'two' }, { value: 'three' }],
      })
    );

    expect(result).toEqual([
      { index: 0, status: 'fulfilled', value: 'echo:one' },
      { index: 1, status: 'fulfilled', value: 'echo:two' },
      { index: 2, status: 'fulfilled', value: 'echo:three' },
    ]);
    // Proves the handler routed through hostBridge.invoke (the host's real
    // composed invoker stand-in) once per item, not a bypass.
    expect(bridge.invoke).toHaveBeenCalledTimes(3);
  });

  it('onItemError: "continue" (default) — one failing item does not stop the others', async () => {
    const descriptor: Descriptor = { host: 'ts', operations: [makeOp('ns/opA')] };
    const bridge = makeHostBridge({
      'ns/opA': (a) => {
        if (a['value'] === 'bad') throw new Error('boom');
        return `ok:${a['value']}`;
      },
    });
    const [op] = requireMount().operations(descriptor, undefined, bridge);

    const result = await op.handler(
      fakeCall({
        operation: 'ns/opA',
        items: [{ value: 'good1' }, { value: 'bad' }, { value: 'good2' }],
      })
    );

    expect(result[0]).toMatchObject({ status: 'fulfilled', value: 'ok:good1' });
    expect(result[1]).toMatchObject({ status: 'rejected' });
    expect(result[2]).toMatchObject({ status: 'fulfilled', value: 'ok:good2' });
  });

  it('onItemError: "abort" — a failing item stops not-yet-started items (serial mode makes this deterministic)', async () => {
    const descriptor: Descriptor = { host: 'ts', operations: [makeOp('ns/opA')] };
    const seen: string[] = [];
    const bridge = makeHostBridge({
      'ns/opA': (a) => {
        seen.push(a['value'] as string);
        if (a['value'] === 'bad') throw new Error('boom');
        return `ok:${a['value']}`;
      },
    });
    const [op] = requireMount().operations(descriptor, undefined, bridge);

    const result = await op.handler(
      fakeCall({
        operation: 'ns/opA',
        items: [{ value: 'first' }, { value: 'bad' }, { value: 'never' }],
        mode: 'serial',
        onItemError: 'abort',
      })
    );

    expect(result[0]).toMatchObject({ status: 'fulfilled', value: 'ok:first' });
    expect(result[1]).toMatchObject({ status: 'rejected' });
    expect(result[2]).toMatchObject({ status: 'rejected' });
    // The 3rd item's fn was never actually invoked — proves abort really
    // stops fan-out rather than merely reporting a rejection after the fact.
    expect(seen).toEqual(['first', 'bad']);
  });

  it('respects a caller-requested concurrency (clamped, never exceeding BATCH_MAX_CONCURRENCY)', async () => {
    const descriptor: Descriptor = { host: 'ts', operations: [makeOp('ns/opA')] };
    let inFlight = 0;
    let maxInFlight = 0;
    const bridge = makeHostBridge({
      'ns/opA': async (a) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return a['value'];
      },
    });
    const [op] = requireMount().operations(descriptor, undefined, bridge);

    await op.handler(
      fakeCall({
        operation: 'ns/opA',
        items: Array.from({ length: 6 }, (_, i) => ({ value: `v${i}` })),
        concurrency: 2,
      })
    );

    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Regression: BUG-APIGEN-BATCH-NULL-ITEM (087ec253) — non-object batch items
// ---------------------------------------------------------------------------
//
// Test header
//   guards: the per-item guard in plugin.ts parseBatchRequest rejects a
//     null, undefined, sparse-hole, primitive (number, string, boolean) or
//     array item with invalid_argument naming input.items[<0-based index>]
//     before any item is dispatched, so the target operation is never
//     invoked; a valid object item reaches the target invoke as the same
//     object (no {} substitution).
//   tier: S (unit). The only fake is hostBridge.invoke, the host boundary
//     named in this file's header; invokeBatch and the request parser are real.
//   cites: 087ec253 AC1, AC2, AC3.
//   tags: regression:087ec253.
//   teeth: AC1 fails on 36ada51f^ (ebc5ac0c), where the null/undefined item is
//     coerced to {} and the handler resolves instead of rejecting; the
//     primitive and array cases additionally fail on 36ada51f itself, whose
//     guard only rejects null/undefined, and pass on the bucket head.
//   red: pending (user hold; not run; must fail on 36ada51f^ for the
//     null/undefined/hole cases, on 36ada51f for the primitive/array cases,
//     and pass on the bucket head). AC2 and AC3 are characterization guards: they pass on
//     both sides and pin the valid-item path the fix must keep.

/**
 * Resolves to the rejection reason of `promise`. Throws when the promise
 * resolves, so a handler that silently accepts a bad item fails here with a
 * clear message rather than passing an assertion on the wrong value.
 */
async function captureRejection(promise: unknown): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the batch handler to reject, but it resolved');
}

describe('regression:087ec253 batchPlugin handler: null/undefined item guard', () => {
  function mountWithBridge(
    fns: Record<string, (domainArgs: Record<string, unknown>) => unknown> = {
      'ns/opA': (a) => `echo:${a['value']}`,
    }
  ) {
    const descriptor: Descriptor = { host: 'ts', operations: [makeOp('ns/opA')] };
    const bridge = makeHostBridge(fns);
    const [op] = requireMount().operations(descriptor, undefined, bridge);
    return { op, bridge };
  }

  it('087ec253 AC1: a null item rejects with invalid_argument naming input.items[1] and never invokes the target', async () => {
    const { op, bridge } = mountWithBridge();
    const err = await captureRejection(
      op.handler(fakeCall({ operation: 'ns/opA', items: [{ value: 'a' }, null] }))
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('input.items[1]'),
    });
    expect(bridge.invoke).not.toHaveBeenCalled();
  });

  it('087ec253 AC1: an explicit undefined item rejects with invalid_argument naming input.items[1] and never invokes the target', async () => {
    const { op, bridge } = mountWithBridge();
    const err = await captureRejection(
      op.handler(fakeCall({ operation: 'ns/opA', items: [{ value: 'a' }, undefined] }))
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('input.items[1]'),
    });
    expect(bridge.invoke).not.toHaveBeenCalled();
  });

  it('087ec253 AC1: a sparse hole in items rejects with invalid_argument naming input.items[1] and never invokes the target', async () => {
    const { op, bridge } = mountWithBridge();
    const holey: unknown[] = [{ value: 'a' }];
    holey.length = 2; // index 1 is a hole: reads as undefined, Array.isArray still true
    const err = await captureRejection(
      op.handler(fakeCall({ operation: 'ns/opA', items: holey }))
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('input.items[1]'),
    });
    expect(bridge.invoke).not.toHaveBeenCalled();
  });

  it.each([
    ['number 1', 1],
    ['string "x"', 'x'],
    ['boolean true', true],
    ['an array', ['nested']],
  ])('087ec253 AC1: a %s item rejects with the same invalid_argument shape naming input.items[1] and never invokes the target', async (_label, bad) => {
    const { op, bridge } = mountWithBridge();
    const err = await captureRejection(
      op.handler(fakeCall({ operation: 'ns/opA', items: [{ value: 'a' }, bad] }))
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('input.items[1]'),
    });
    expect(bridge.invoke).not.toHaveBeenCalled();
  });

  it('087ec253 AC1: a primitive at index 0 is named input.items[0] (0-based) and rejects the whole batch', async () => {
    const { op, bridge } = mountWithBridge();
    const err = await captureRejection(
      op.handler(fakeCall({ operation: 'ns/opA', items: [7, { value: 'b' }] }))
    );
    expect(err).toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('input.items[0]'),
    });
    expect(bridge.invoke).not.toHaveBeenCalled();
  });

  it('087ec253 AC2: a valid object item reaches the target invoke as the exact same object (identity, no {} substitution)', async () => {
    const seen: unknown[] = [];
    const { op } = mountWithBridge({
      'ns/opA': (a) => {
        seen.push(a);
        return 'ok';
      },
    });
    const item = { value: 'kept' };
    const result = await op.handler(fakeCall({ operation: 'ns/opA', items: [item] }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(item);
    expect(result).toEqual([{ index: 0, status: 'fulfilled', value: 'ok' }]);
  });

  it('087ec253 AC3 (characterization): a two-item object batch makes two invoke calls with the same domainArgs and the BatchItemResult[] shape', async () => {
    const { op, bridge } = mountWithBridge();
    const items = [{ value: 'one' }, { value: 'two' }];
    const result = await op.handler(fakeCall({ operation: 'ns/opA', items }));
    const invokeMock = bridge.invoke as unknown as ReturnType<typeof vi.fn>;
    expect(invokeMock).toHaveBeenCalledTimes(2);
    const domainArgs = invokeMock.mock.calls.map(
      (c: unknown[]) => (c[1] as { domainArgs: unknown }).domainArgs
    );
    expect(domainArgs).toHaveLength(2);
    expect(domainArgs[0]).toBe(items[0]);
    expect(domainArgs[1]).toBe(items[1]);
    expect(result).toEqual([
      { index: 0, status: 'fulfilled', value: 'echo:one' },
      { index: 1, status: 'fulfilled', value: 'echo:two' },
    ]);
  });
});
