/**
 * guards: a --use plugin's createLayer never receives the invocation's options, runs per request instead of once at composition, loses to a static layer, or a malformed capability fails on every request instead of at composition
 * tier: S
 * cites: REMEDIATION-PLAN T-R3 (scenario "options reach a createLayer plugin"; createLayer once per plugin); ADR-0019 D1; cfd37408 AC3 (UsePlugin capabilities derive from core LayerCapability)
 * tags: contract
 * teeth: red: change `cap.createLayer(layerOptions)` to `cap.createLayer({})` in adaptCoreLayer (guarded temporary edit, restored) and run `npx vitest run src/test/package-invoker-layer.spec.ts` in packages/apigen/apigen-engine-runtime -> exit 1; "hands layerOptions to createLayer" goes red. cfd37408 AC3: the `not.toEqualTypeOf` control plus the `@ts-expect-error` rows fail `npx nx run apigen-engine-runtime:typecheck-spec` if UsePlugin['capabilities']['layer'] is redefined structurally
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { ApiError } from '@adhd/apigen-base-errors';
import type { LayerCapability } from '@adhd/apigen-core-client';
import { adaptCoreLayer, createPackageInvoker, type UsePlugin } from '../../src/lib/package-invoker';
import { LayerContext, type Call } from '../../src/lib/invoke';
import type { ComposedSchemas } from '../../src/lib/types';

const schemas: ComposedSchemas = {
  ping: {
    input: { type: 'object', properties: { data: { type: 'object', properties: {} } }, required: ['data'] },
    output: {},
  },
};

function makeCall(): Call {
  return { operation: { id: 'ping' }, ctx: new LayerContext(), envelope: {}, domainArgs: {}, transport: 'cli' };
}

const run = (invoke: ReturnType<typeof createPackageInvoker>) =>
  invoke('ping', makeCall(), { fns: { ping: () => 'pong' }, schemas });

describe('createPackageInvoker with createLayer plugins (T-R3)', () => {
  it('hands layerOptions to createLayer and runs it once across two invocations', async () => {
    const created: Array<Record<string, unknown>> = [];
    const saw: unknown[] = [];
    const plugin: UsePlugin = {
      id: 'timeouts',
      capabilities: {
        layer: {
          createLayer: (opts) => {
            created.push(opts);
            return async (_call, next) => {
              saw.push(opts['timeoutMs']);
              return next();
            };
          },
        },
      },
    };
    const invoke = createPackageInvoker(schemas, [plugin], { layerOptions: { timeoutMs: 50 } });
    expect(created).toHaveLength(1); // built at composition, before any request
    expect(await run(invoke)).toBe('pong');
    expect(await run(invoke)).toBe('pong');
    expect(created).toEqual([{ timeoutMs: 50 }]);
    expect(saw).toEqual([50, 50]);
  });

  it('defaults the options bag to {}', () => {
    const created: Array<Record<string, unknown>> = [];
    createPackageInvoker(schemas, [
      {
        id: 'p',
        capabilities: {
          layer: {
            createLayer: (opts) => {
              created.push(opts);
              return async (_call, next) => next();
            },
          },
        },
      },
    ]);
    expect(created).toEqual([{}]);
  });

  it('createLayer wins over a static layer on the same capability', async () => {
    const plugin: UsePlugin = {
      id: 'both',
      capabilities: {
        layer: {
          layer: async () => 'from-layer',
          createLayer: () => async () => 'from-createLayer',
        },
      },
    };
    expect(await run(createPackageInvoker(schemas, [plugin]))).toBe('from-createLayer');
  });

  it('a static-layer-only plugin is unchanged and layers compose outermost first', async () => {
    const order: string[] = [];
    const mk = (id: string): UsePlugin => ({
      id,
      capabilities: {
        layer: {
          layer: async (_call, next) => {
            order.push(id);
            return next();
          },
        },
      },
    });
    expect(await run(createPackageInvoker(schemas, [mk('outer'), mk('inner')]))).toBe('pong');
    expect(order).toEqual(['outer', 'inner']);
  });

  it('gives a layer the domain arguments on call.data as well as domainArgs', async () => {
    let data: unknown;
    const plugin: UsePlugin = {
      id: 'reader',
      capabilities: {
        layer: {
          layer: async (call, next) => {
            data = call.data;
            return next();
          },
        },
      },
    };
    const invoke = createPackageInvoker(schemas, [plugin]);
    await invoke('ping', { ...makeCall(), domainArgs: {} }, { fns: { ping: () => 1 }, schemas });
    expect(data).toEqual({});
  });

  it('fails at composition, naming the plugin, when createLayer returns a non-function', () => {
    const plugin = { id: 'bad-factory', capabilities: { layer: { createLayer: () => 'nope' } } } as unknown as UsePlugin;
    expect(() => createPackageInvoker(schemas, [plugin])).toThrow(
      expect.objectContaining({ code: 'internal', message: expect.stringContaining('"bad-factory"') as string }) as Error
    );
    try {
      createPackageInvoker(schemas, [plugin]);
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
    }
  });

  it('fails at composition when a capability has neither layer nor createLayer', () => {
    const plugin = { id: 'empty', capabilities: { layer: {} } } as unknown as UsePlugin;
    expect(() => createPackageInvoker(schemas, [plugin])).toThrow(/"empty".*neither a layer nor a createLayer/);
  });

  it('lets a createLayer that throws fail composition with its own error', () => {
    const plugin: UsePlugin = {
      id: 'throws',
      capabilities: {
        layer: {
          createLayer: () => {
            throw new Error('bad option');
          },
        },
      },
    };
    expect(() => createPackageInvoker(schemas, [plugin])).toThrow('bad option');
  });

  it('adaptCoreLayer works without a plugin id', () => {
    expect(() => adaptCoreLayer({} as never)).toThrow(/a --use plugin: layer capability has neither/);
  });
});

describe('UsePlugin capabilities derive from core-client LayerCapability (cfd37408 AC3)', () => {
  it('UsePlugin[capabilities][layer] is exactly LayerCapability', () => {
    type Derived = NonNullable<NonNullable<UsePlugin['capabilities']>['layer']>;
    expectTypeOf<Derived>().toEqualTypeOf<LayerCapability>();
    // Control: a structurally redefined layer type must NOT be equal.
    expectTypeOf<Derived>().not.toEqualTypeOf<{ layer(call: unknown, next: () => Promise<unknown>): Promise<unknown> }>();
    expect(true).toBe(true);
  });

  it('accepts createLayer-only and layer-only capabilities and rejects an empty one', () => {
    const createOnly: UsePlugin = { id: 'a', capabilities: { layer: { createLayer: () => async (_c, n) => n() } } };
    const layerOnly: UsePlugin = { id: 'b', capabilities: { layer: { layer: async (_c, n) => n() } } };
    // @ts-expect-error a capability with neither layer nor createLayer does not satisfy LayerCapability
    const neither: UsePlugin = { id: 'c', capabilities: { layer: {} } };
    expect([createOnly, layerOnly, neither]).toHaveLength(3);
  });
});
