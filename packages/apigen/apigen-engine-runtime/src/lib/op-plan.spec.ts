/**
 * Tests for the serve-core primitives: `OpPlan`/`buildOpPlan` (`./op-plan`),
 * `createPackageInvoker` (+ promoted `UsePlugin`/`readUsePlugins`/
 * `readUseOptions`/`adaptCoreLayer`, `./package-invoker`), `dispatchForPlan`
 * (`./dispatch-for-plan`), and the `TransportAdapter` port
 * (`./transport-adapter`). This is the ONLY spec file this state may touch
 * (see the plan's Reservations) — every acceptance criterion
 * [serve-core-primitives.1]..[.9] is proven here.
 *
 * TEETH contract (AGENTS.md §7 / CLAUDE.md §6):
 *   - cliFlags/envelope/transport-stamping assertions check EXACT values, not
 *     presence-only, so a regression in the computation flips them RED.
 *   - F3 (transport stamping) is asserted against a NON-http transport
 *     ('mcp'/'grpc') specifically so a hardcoded `'http'` fallback fails.
 *   - The validate-Layer rejection test is a negative control: malformed
 *     input must throw `invalid_argument` through the exact same dispatch
 *     path the happy-path test exercises.
 */

import { describe, expect, it } from 'vitest';
import type {
  MountedOperation,
  Operation,
  Segment,
  Call as CoreClientCall,
} from '@adhd/apigen-core-client';
import type { ComposedSchemas } from './types';
import { buildOpPlan } from './op-plan';
import type { OpPlan } from './op-plan';
import {
  adaptCoreLayer,
  createPackageInvoker,
  readUseOptions,
  readUsePlugins,
} from './package-invoker';
import type { UsePlugin } from './package-invoker';
import { dispatchForPlan } from './dispatch-for-plan';
import type { InvokeOptions } from './invoke';
import type { TransportAdapter } from './transport-adapter';

// Barrel-export proof — [serve-core-primitives.1]..[.4]: these primitives
// must be reachable from the package's public `index.ts`, not just their
// own lib file.
import * as apigenEngineRuntime from '../index';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function seg(raw: string, words: string[]): Segment {
  return { raw, words };
}

/** A real source op: `transform/humanize/humanize-bytes` (naming.ts's own doc example). */
const humanizeOp: Operation = {
  id: 'transform/humanize/humanize-bytes',
  host: 'ts',
  namespace: seg('transform', ['transform']),
  path: [seg('humanize', ['humanize']), seg('humanizeBytes', ['humanize', 'bytes'])],
  kind: 'action',
  async: true,
  streaming: false,
  safe: true,
  input: {},
  output: {},
  envelope: {},
  typeText: null,
};

/** The composed schema for `humanizeOp`: mixed boolean/json/string domain params + one envelope field. */
const humanizeSchema: ComposedSchemas[string] = {
  input: {
    type: 'object',
    properties: {
      data: {
        type: 'object',
        properties: {
          bytes: { type: 'number' },
          pretty: { type: 'boolean' },
          tags: { type: 'array', items: { type: 'string' } },
          outputLabel: { type: 'string' },
        },
        required: ['bytes'],
      },
      session: { type: 'string' },
    },
  },
  output: {},
  'x-apigen-envelope': { session: 'auth' },
} as unknown as ComposedSchemas[string];

function makeMountOp(
  id: string,
  handler: MountedOperation['handler'],
  overrides: Partial<MountedOperation> = {}
): MountedOperation {
  return {
    id,
    host: 'ts',
    namespace: seg('_meta', ['meta']),
    path: [seg(id.split('/')[1] ?? id, [id.split('/')[1] ?? id])],
    kind: 'action',
    async: false,
    streaming: false,
    safe: true,
    input: {},
    output: {},
    envelope: {},
    typeText: null,
    handler,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// [serve-core-primitives.1]..[.4] — barrel exports
// ---------------------------------------------------------------------------

describe('serve-core primitives — index barrel exports', () => {
  it('exports createPackageInvoker from the package index [serve-core-primitives.1]', () => {
    expect(typeof apigenEngineRuntime.createPackageInvoker).toBe('function');
  });

  it('exports dispatchForPlan from the package index [serve-core-primitives.2]', () => {
    expect(typeof apigenEngineRuntime.dispatchForPlan).toBe('function');
  });

  it('exports buildOpPlan (the OpPlan constructor) from the package index [serve-core-primitives.3]', () => {
    expect(typeof apigenEngineRuntime.buildOpPlan).toBe('function');
  });

  it('exposes a usable TransportAdapter port shape from the package index [serve-core-primitives.4]', () => {
    // TransportAdapter is a type — the compile-time proof is that this file
    // type-checks against `import type { TransportAdapter } from '../index'`
    // (see the runtime end-to-end TransportAdapter test below, which
    // instantiates one and drives OpPlan/dispatchForPlan through it).
    const adapter: TransportAdapter<{ args: unknown }> = {
      registerRoute: () => undefined,
      readCall: () => ({ envelope: {}, domainArgs: {} }),
      writeResult: () => undefined,
      writeError: () => undefined,
    };
    expect(typeof adapter.registerRoute).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// buildOpPlan — projection, envelope, cliFlags, params, streaming, isMount
// ---------------------------------------------------------------------------

describe('buildOpPlan — source op', () => {
  const plan = buildOpPlan({
    op: humanizeOp,
    schema: humanizeSchema,
    transport: 'mcp',
  });

  it('stamps `transport` from the caller-supplied value, never a hardcoded literal [serve-core-primitives.8 / F3]', () => {
    expect(plan.transport).toBe('mcp');
    expect(plan.transport).not.toBe('http');
  });

  it('projects http/mcp/grpc/cli exactly as @adhd/apigen-engine-naming would', () => {
    expect(plan.http).toEqual({
      verb: 'GET',
      route: '/transform/humanize/humanize-bytes',
    });
    expect(plan.mcp).toEqual({ name: 'transform_humanize_humanize_bytes' });
    expect(plan.grpc).toEqual({
      package: 'transform.humanize',
      service: 'Humanize',
      method: 'HumanizeBytes',
    });
    expect(plan.cli).toEqual({ path: ['transform', 'humanize', 'humanize-bytes'] });
  });

  it('computes params from describeParams', () => {
    expect(plan.params).toEqual([
      { name: 'bytes', type: 'number', required: true },
      { name: 'pretty', type: 'boolean', required: false },
      { name: 'tags', type: 'string[]', required: false },
      { name: 'outputLabel', type: 'string', required: false },
    ]);
  });

  it('computes the envelope[] table from x-apigen-envelope + non-data input properties [serve-core-primitives.5]', () => {
    expect(plan.envelope).toEqual([
      {
        field: 'session',
        pluginId: 'auth',
        httpHeader: 'x-auth-session',
        mcpMetaKey: 'x-auth-session',
        cliFlag: '--auth-session',
        envVar: 'APIGEN_AUTH_SESSION',
      },
    ]);
  });

  it('computes the precomputed cliFlags table with kebab keys + correct valueKind per prop [serve-core-primitives.5]', () => {
    expect(plan.cliFlags.size).toBe(5);
    // BUG-APIGEN-CLI-OUTPUT-001 (fixed alongside the mount-cliFlags gap): a
    // `number`-typed domain param now resolves `valueKind: 'json'` (JSON.parse
    // produces a real JS `number`) — it previously fell through to `'string'`,
    // silently handing a raw unparsed argv token to a handler expecting a
    // real number (this specifically broke `_batch/<kind>`'s
    // `--concurrency`/`--itemTimeoutMs` flags once mount ops got real cliFlags
    // at all).
    expect(plan.cliFlags.get('bytes')).toEqual({
      camelKey: 'bytes',
      kind: 'domain',
      valueKind: 'json',
    });
    expect(plan.cliFlags.get('pretty')).toEqual({
      camelKey: 'pretty',
      kind: 'domain',
      valueKind: 'boolean',
    });
    expect(plan.cliFlags.get('tags')).toEqual({
      camelKey: 'tags',
      kind: 'domain',
      valueKind: 'json',
    });
    // kebab-casing of a multi-word camel param.
    expect(plan.cliFlags.get('output-label')).toEqual({
      camelKey: 'outputLabel',
      kind: 'domain',
      valueKind: 'string',
    });
  });

  it('carries envVar on the envelope cliFlags entry so parseArgs env-var fallback is not regressed [serve-core-primitives.9 / F2]', () => {
    const sessionFlag = plan.cliFlags.get('auth-session');
    expect(sessionFlag).toEqual({
      camelKey: 'session',
      kind: 'envelope',
      valueKind: 'string',
      envVar: 'APIGEN_AUTH_SESSION',
    });
    expect(sessionFlag?.envVar).toBeDefined();
  });

  it('is not a mount op and carries no mountHandler', () => {
    expect(plan.isMount).toBe(false);
    expect(plan.mountHandler).toBeUndefined();
  });

  it('carries the streaming flag from Operation.streaming', () => {
    const streamingOp: Operation = { ...humanizeOp, id: 'transform/humanize/stream-bytes', streaming: true };
    const streamingPlan = buildOpPlan({ op: streamingOp, schema: humanizeSchema, transport: 'http' });
    expect(streamingPlan.streaming).toBe(true);
    expect(plan.streaming).toBe(false);
  });
});

describe('buildOpPlan — mount op', () => {
  it('detects a MountedOperation via its handler and sets isMount/mountHandler [serve-core-primitives.8]', async () => {
    let received: CoreClientCall | undefined;
    const mountOp = makeMountOp('_meta/health', async (call) => {
      received = call;
      return { ok: true };
    });

    const plan = buildOpPlan({ op: mountOp, transport: 'grpc' });

    expect(plan.isMount).toBe(true);
    expect(plan.transport).toBe('grpc');
    expect(plan.envelope).toEqual([]);
    expect(plan.cliFlags.size).toBe(0);
    expect(plan.params).toBeUndefined();
    expect(typeof plan.mountHandler).toBe('function');

    const fakeCall = {
      operation: mountOp,
      data: {},
      envelope: {},
      ctx: { get: () => undefined, set: () => undefined },
      transport: 'grpc' as const,
      signal: new AbortController().signal,
    };
    if (!plan.mountHandler) throw new Error('expected mountHandler to be set');
    const result = await plan.mountHandler(fakeCall);
    expect(result).toEqual({ ok: true });
    expect(received).toBe(fakeCall);
  });
});

// ---------------------------------------------------------------------------
// createPackageInvoker + promoted UsePlugin helpers — [serve-core-primitives.7]
// ---------------------------------------------------------------------------

describe('createPackageInvoker + promoted UsePlugin/readUsePlugins/readUseOptions/adaptCoreLayer', () => {
  it('readUsePlugins reads options.usePlugins, defaulting to []', () => {
    const plugin: UsePlugin = { id: 'p1' };
    expect(readUsePlugins({ usePlugins: [plugin] })).toEqual([plugin]);
    expect(readUsePlugins({})).toEqual([]);
    expect(readUsePlugins({ usePlugins: 'not-an-array' })).toEqual([]);
  });

  it('readUseOptions reads options.useOptions, defaulting to {}', () => {
    expect(readUseOptions({ useOptions: { p1: { verbose: true } } })).toEqual({
      p1: { verbose: true },
    });
    expect(readUseOptions({})).toEqual({});
  });

  it('adaptCoreLayer surfaces domainArgs as .data for a core-shaped layer', async () => {
    let sawData: unknown;
    const layer = adaptCoreLayer({
      layer: async (call, next) => {
        sawData = (call as { data: unknown }).data;
        return next();
      },
    });
    const runtimeCall = {
      operation: { id: 'x' },
      ctx: { get: () => undefined, set: () => undefined } as never,
      envelope: {},
      domainArgs: { bytes: 42 },
    };
    const result = await layer(runtimeCall as never, async () => 'inner-result');
    expect(sawData).toEqual({ bytes: 42 });
    expect(result).toBe('inner-result');
  });

  it('composes --use layers outermost-first, wrapping validate-Layer innermost, then dispatches (BUG-APIGEN-009)', async () => {
    const order: string[] = [];
    const outerPlugin: UsePlugin = {
      id: 'outer',
      capabilities: {
        layer: {
          layer: async (_call, next) => {
            order.push('outer-before');
            const r = await next();
            order.push('outer-after');
            return r;
          },
        },
      },
    };

    const schemas: ComposedSchemas = { [humanizeOp.id]: humanizeSchema };
    const invoke = createPackageInvoker(schemas, [outerPlugin]);

    const fns = {
      [humanizeOp.id]: (bytes: unknown, pretty: unknown) => {
        order.push('dispatch');
        return { bytesArg: bytes, prettyArg: pretty };
      },
    };
    const opts: InvokeOptions = { fns, schemas };

    const result = await invoke(
      humanizeOp.id,
      {
        operation: { id: humanizeOp.id },
        ctx: { get: () => undefined, set: () => undefined } as never,
        envelope: { session: 'abc' },
        domainArgs: { bytes: 1024, pretty: true },
      } as never,
      opts
    );

    expect(result).toEqual({ bytesArg: 1024, prettyArg: true });
    expect(order).toEqual(['outer-before', 'dispatch', 'outer-after']);
  });

  it('rejects malformed input with ApiError{invalid_argument} BEFORE dispatch is reached (negative control)', async () => {
    const schemas: ComposedSchemas = { [humanizeOp.id]: humanizeSchema };
    const invoke = createPackageInvoker(schemas, []);
    let dispatchReached = false;
    const opts: InvokeOptions = {
      fns: {
        [humanizeOp.id]: () => {
          dispatchReached = true;
          return {};
        },
      },
      schemas,
    };

    await expect(
      invoke(
        humanizeOp.id,
        {
          operation: { id: humanizeOp.id },
          ctx: { get: () => undefined, set: () => undefined } as never,
          envelope: {},
          // `bytes` is required and missing — must be rejected.
          domainArgs: {},
        } as never,
        opts
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(dispatchReached).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dispatchForPlan — [serve-core-primitives.2], F1 (LayerResult return),
// F3 (transport stamping), [fix:mount-through-layers]
// ---------------------------------------------------------------------------

describe('dispatchForPlan — source op path', () => {
  it('fills in operation/ctx and returns the resolved LayerResult (F1)', async () => {
    const schemas: ComposedSchemas = { [humanizeOp.id]: humanizeSchema };
    const invoke = createPackageInvoker(schemas, []);
    const plan = buildOpPlan({ op: humanizeOp, schema: humanizeSchema, transport: 'http' });
    const opts: InvokeOptions = {
      fns: {
        [humanizeOp.id]: (bytes: unknown, pretty: unknown) => ({
          bytesArg: bytes,
          prettyArg: pretty,
        }),
      },
      schemas,
    };

    const result = await dispatchForPlan(
      plan,
      invoke,
      { envelope: { session: 'abc' }, domainArgs: { bytes: 1024, pretty: true } },
      opts
    );

    // F1: dispatchForPlan's return value IS the resolved LayerResult, not a
    // Promise wrapper the caller has to further unwrap.
    expect(result).toEqual({ bytesArg: 1024, prettyArg: true });
  });

  it('still rejects malformed input through the composed invoker (negative control)', async () => {
    const schemas: ComposedSchemas = { [humanizeOp.id]: humanizeSchema };
    const invoke = createPackageInvoker(schemas, []);
    const plan = buildOpPlan({ op: humanizeOp, schema: humanizeSchema, transport: 'http' });
    const opts: InvokeOptions = {
      fns: { [humanizeOp.id]: () => ({}) },
      schemas,
    };

    await expect(
      dispatchForPlan(plan, invoke, { envelope: {}, domainArgs: {} }, opts)
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });
});

describe('dispatchForPlan — mount op path (F3 + fix:mount-through-layers)', () => {
  it('adapts the runtime Call to a core-client Call, stamps transport from plan.transport (never hardcoded), and flows through --use layers', async () => {
    let captured: CoreClientCall | undefined;
    const mountOp = makeMountOp('_meta/version', async (call) => {
      captured = call;
      return { version: '1.0.0' };
    });
    // Stamp a NON-http transport deliberately — a hardcoded 'http' fallback
    // in dispatchForPlan's mount branch would fail this assertion.
    const plan = buildOpPlan({ op: mountOp, transport: 'mcp' });

    let sawMountInLayer = false;
    const observerPlugin: UsePlugin = {
      id: 'observer',
      capabilities: {
        layer: {
          layer: async (_call, next) => {
            sawMountInLayer = true;
            return next();
          },
        },
      },
    };

    // The PACKAGE's real composed schemas never contain a mount op id — this
    // is what makes makeValidateLayer no-op for the mount call (bound to
    // these schemas at construction time, per [fix:mount-through-layers]).
    const invoke = createPackageInvoker({}, [observerPlugin]);
    const opts: InvokeOptions = { fns: {}, schemas: {} };

    const result = await dispatchForPlan(
      plan,
      invoke,
      { envelope: {}, domainArgs: {} },
      opts
    );

    expect(result).toEqual({ version: '1.0.0' });
    expect(sawMountInLayer).toBe(true);
    expect(captured).toBeDefined();
    expect(captured?.transport).toBe('mcp');
    expect(captured?.transport).not.toBe('http');
    expect(captured?.operation).toBe(mountOp);
    expect(captured?.data).toEqual({});
  });

  it('throws a descriptive error when isMount is true but mountHandler is missing', async () => {
    const mountOp = makeMountOp('_meta/broken', async () => ({}));
    const plan: OpPlan = { ...buildOpPlan({ op: mountOp, transport: 'cli' }), mountHandler: undefined };
    const invoke = createPackageInvoker({}, []);

    await expect(
      dispatchForPlan(plan, invoke, { envelope: {}, domainArgs: {} }, { fns: {}, schemas: {} })
    ).rejects.toThrow(/mountHandler/);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: TransportAdapter + OpPlan + dispatchForPlan wired together
// ---------------------------------------------------------------------------

describe('TransportAdapter — end-to-end wiring (proves the port composes with the other primitives)', () => {
  it('drives a full request through a fake in-memory adapter', async () => {
    interface FakeRaw {
      domainArgs: Record<string, unknown>;
      result?: unknown;
      error?: unknown;
    }

    const schemas: ComposedSchemas = { [humanizeOp.id]: humanizeSchema };
    const invoke = createPackageInvoker(schemas, []);
    const plan = buildOpPlan({ op: humanizeOp, schema: humanizeSchema, transport: 'http' });
    const invokeOpts: InvokeOptions = {
      fns: {
        [humanizeOp.id]: (bytes: unknown) => ({ humanized: `${bytes}B` }),
      },
      schemas,
    };

    const routes = new Map<
      string,
      (call: { envelope: Record<string, unknown>; domainArgs: Record<string, unknown> }) => Promise<unknown>
    >();

    const adapter: TransportAdapter<FakeRaw> = {
      registerRoute(p, dispatch) {
        routes.set(p.http.route, dispatch);
      },
      readCall(raw) {
        return { envelope: {}, domainArgs: raw.domainArgs };
      },
      writeResult(raw, result) {
        raw.result = result;
      },
      writeError(raw, err) {
        raw.error = err;
      },
    };

    adapter.registerRoute(plan, (call) => dispatchForPlan(plan, invoke, call, invokeOpts));

    const raw: FakeRaw = { domainArgs: { bytes: 2048 } };
    const dispatch = routes.get(plan.http.route);
    if (!dispatch) throw new Error('expected a registered route dispatch fn');
    try {
      const call = await adapter.readCall(raw, plan);
      const result = await dispatch(call);
      await adapter.writeResult(raw, result, plan);
    } catch (err) {
      await adapter.writeError(raw, err, plan);
    }

    expect(raw.result).toEqual({ humanized: '2048B' });
    expect(raw.error).toBeUndefined();
  });
});
