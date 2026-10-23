import { expect } from 'vitest';
import type { ApiError } from '@adhd/apigen-base-errors';
import { adaptCoreLayer, createInvoker, LayerContext } from '@adhd/apigen-engine-runtime';
import type { Call, ComposedSchemas, Layer, UsePlugin } from '@adhd/apigen-engine-runtime';
import { PolicyAttributes } from '../../src/attributes';

/** The operations the host exposes in these tests, with their `data` parameters. */
function op(params: Record<string, unknown>): ComposedSchemas[string] {
  return {
    input: { type: 'object', properties: { data: { type: 'object', properties: params } }, required: ['data'] },
    output: {},
  };
}

export const SCHEMAS: ComposedSchemas = {
  'files/read': op({ path: { type: 'string' } }),
  'files/write': op({ path: { type: 'string' }, overwrite: { type: 'boolean' } }),
  'refunds/issue': op({ amount: { type: 'number' } }),
  'stream/items': op({}),
};

/** One recorded execution of an operation; the marker the Layer must keep unset when it refuses. */
export interface IRan {
  readonly fn: string;
  readonly args: readonly unknown[];
}

export interface IHost {
  /** Every operation body that actually ran. Empty means the Layer refused (or never let the call through). */
  readonly ran: IRan[];
  invoke(
    fn: string,
    domainArgs: Record<string, unknown>,
    options?: {
      readonly envelope?: Record<string, unknown>;
      readonly signal?: AbortSignal;
      readonly transport?: string;
      /** Attributes an earlier (auth) Layer wrote to `ctx` as `PolicyAttributes`; absent writes nothing. */
      readonly attributes?: unknown;
      /** Layers declared before the policy Layer (an auth layer), outermost first. */
      readonly before?: readonly Layer[];
    }
  ): Promise<unknown>;
}

/** What the harness needs of a plugin: its id and Layer capability (a `Plugin` is not structurally a `UsePlugin` until its `mount` is, cfd37408). */
export type LayerPlugin = Pick<UsePlugin, 'id'> & {
  readonly capabilities?: Pick<NonNullable<UsePlugin['capabilities']>, 'layer'>;
};

/**
 * The Layer of a plugin, materialised exactly as the apigen host does
 * (`adaptCoreLayer` calls `createLayer(layerOptions)` once).
 */
export function layerOf(plugin: LayerPlugin, layerOptions: Record<string, unknown> = {}): Layer {
  const cap = plugin.capabilities?.layer;
  expect(cap, 'plugin has no layer capability').toBeDefined();
  return adaptCoreLayer(cap as NonNullable<typeof cap>, layerOptions, plugin.id);
}

/** The real `createInvoker` composed from `plugin`'s Layer, over operations that record their own execution. */
export function createHost(plugin: LayerPlugin, layerOptions: Record<string, unknown> = {}): IHost {
  const ran: IRan[] = [];
  const fns: Record<string, (...args: unknown[]) => unknown> = {
    'files/read': (...args) => (ran.push({ fn: 'files/read', args }), 'read-ran'),
    'files/write': (...args) => (ran.push({ fn: 'files/write', args }), 'write-ran'),
    'refunds/issue': (...args) => (ran.push({ fn: 'refunds/issue', args }), 'refund-ran'),
    'stream/items': (...args) => {
      ran.push({ fn: 'stream/items', args });
      return (async function* () {
        yield 1;
        yield 2;
      })();
    },
  };
  return {
    ran,
    invoke(fn, domainArgs, options = {}) {
      const invoke = createInvoker([...(options.before ?? []), layerOf(plugin, layerOptions)]);
      const ctx = new LayerContext();
      if (options.attributes !== undefined) {
        ctx.set(PolicyAttributes, new PolicyAttributes(options.attributes as never));
      }
      const call: Call = {
        operation: { id: fn },
        ctx,
        envelope: options.envelope ?? {},
        domainArgs,
        transport: (options.transport ?? 'cli') as Call['transport'],
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      };
      return invoke(fn, call, { fns, schemas: SCHEMAS });
    },
  };
}

/** Settles `p` and returns the ApiError it rejected with; fails if it resolved or threw something else. */
export async function refusal(p: Promise<unknown>): Promise<ApiError> {
  let value: unknown;
  try {
    value = await p;
  } catch (error) {
    // Duck-typed: a module re-imported after vi.resetModules carries its own ApiError class.
    if (error instanceof Error && error.name === 'ApiError' && typeof (error as { code?: unknown }).code === 'string') {
      return error as ApiError;
    }
    throw error;
  }
  throw new Error(`expected a refusal, the call resolved with ${JSON.stringify(value)}`);
}

/** A promise settled from outside, used as a latch so tests never wait on the clock. */
export function latch<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
