/**
 * createPackageInvoker — serve-core primitive ([iface:create-package-invoker]).
 *
 * [fix:invoker-promotion] (architect topology gap): PROMOTES the
 * byte-identical `UsePlugin`/`readUsePlugins`/`readUseOptions`/
 * `adaptCoreLayer`/`buildInvokerForPackage` block (~120 lines, proposal §4)
 * that `apigen-plugin-api-fastify/src/lib/run.ts:91-166` and
 * `apigen-plugin-api-express/src/lib/run.ts:84-159` each duplicate today into
 * this single authority. Those symbols are DELETED from the plugin files in
 * the adapter states that consume this primitive (fastify collapses onto
 * `createPackageInvoker` first; express then collapses onto the SAME
 * function instead of keeping its own copy) — NOT in this state, which only
 * builds and unit-tests the primitive.
 *
 * Composes the request-path invoker for one package: the `--use` layer
 * plugins (outermost-first, in declaration order) wrapping the central
 * validate-Layer (innermost, immediately before dispatch — BUG-APIGEN-009),
 * built ONCE per package via `createInvoker` (`./invoke.ts`).
 */

import { ApiError } from '@adhd/apigen-base-errors';
import type { Layer, Terminal } from './invoke';
import { createInvoker } from './invoke';
import { makeValidateLayer } from './validate-layer';
import type { Call as RuntimeCall, InvokeFn } from './invoke';
import type { ComposedSchemas } from './types';

// ---------------------------------------------------------------------------
// §7.1 / §8 — `--use` Layer + Mount composition (BUG-APIGEN-009 / -010)
// ---------------------------------------------------------------------------

/**
 * A loaded `--use` plugin object (SPEC §7.1): the layer and mount
 * capabilities this runtime consumes.
 *
 * Still a structural copy of core-client's `Plugin['capabilities']`, not a
 * derivation (backlog cfd37408): deriving `layer` from core-client's
 * `LayerCapability` types the layer's `call` as the core-client `Call`, and
 * readers outside this package that cast it to the runtime `Call`
 * (`entrypoint/policy/src/wrapper/attributes-layer.ts`) stop compiling. The
 * derivation lands with those readers' segments (R6, R9).
 */
export interface UsePlugin {
  id: string;
  capabilities?: {
    layer?: {
      /**
       * The static layer function. Optional because a plugin may supply only
       * {@link createLayer} (adhd ADR-0019 D1).
       */
      layer?: (
        call: unknown,
        next: () => Promise<unknown>
      ) => Promise<unknown> | AsyncIterable<unknown>;
      /**
       * Opts-aware layer factory (adhd ADR-0019 D1, SPEC §7.1): called ONCE per
       * plugin at composition time with the invocation's flat options bag;
       * the returned function is the layer. Wins over {@link layer} when both
       * are present.
       */
      createLayer?: (
        opts: Record<string, unknown>
      ) => (
        call: unknown,
        next: () => Promise<unknown>
      ) => Promise<unknown> | AsyncIterable<unknown>;
    };
    mount?: {
      operations: (
        descriptor: { host: string; operations: unknown[] },
        opts?: Record<string, unknown>,
        // (batch-rollout, BATCH_0.0.1.md §2/§F1) Optional, additive third
        // param — structurally equivalent to `apigen-core-client`'s
        // `MountHostBridge`. (This package already depends on core-client;
        // the structural copy is the debt tracked by backlog cfd37408.)
        hostBridge?: {
          invoke(
            fnName: string,
            call: {
              domainArgs: Record<string, unknown>;
              envelope: Record<string, unknown>;
              signal?: AbortSignal;
            },
            opts: {
              fns: Record<string, unknown>;
              schemas: Record<string, unknown>;
              createClient?: (envelope: Record<string, unknown>) => Promise<unknown>;
            }
          ): Promise<unknown>;
          invokeOptions: {
            fns: Record<string, unknown>;
            schemas: Record<string, unknown>;
            createClient?: (envelope: Record<string, unknown>) => Promise<unknown>;
          };
        }
      ) => Array<{
        id: string;
        transports?: string[];
        handler: (call: unknown) => unknown;
      }>;
    };
  };
}

/** Per-`--use` plugin option bag, keyed by plugin id (carried on `options.useOptions`). */
export type UseOptions = Record<string, Record<string, unknown>>;

/**
 * Read the loaded `--use` plugins off `input.options`. The CLI loads the
 * specifiers into real plugin objects and threads them here (`RunInput`
 * carries no dedicated field, so they ride on `options.usePlugins`).
 */
export function readUsePlugins(options: Record<string, unknown>): UsePlugin[] {
  const raw = options['usePlugins'];
  return Array.isArray(raw) ? (raw as UsePlugin[]) : [];
}

/**
 * Optional `options.exitCode` hook: maps a SUCCESSFULLY-RETURNED result to a
 * process exit code.
 *
 * A host whose operations return a result-shaped outcome (`{ok:false, error}`)
 * rather than throwing looks like unqualified success to a transport, so the
 * CLI exits 0 on a reported failure — a caller's `&&` chain then proceeds and
 * `set -e` never trips. This hook is the seam that lets such a host state its
 * own mapping without apigen having to know the envelope shape.
 *
 * Opt-in and absent by default: a host that does not pass it keeps the
 * existing "returned normally ⇒ exit 0" behaviour exactly.
 *
 * Thrown `ApiError`s are unaffected — those already map through
 * `CLI_EXIT_CODE`.
 */
export function readExitCodeHook(
  options: Record<string, unknown>
): ((result: unknown) => number | undefined) | undefined {
  const raw = options['exitCode'];
  return typeof raw === 'function'
    ? (raw as (result: unknown) => number | undefined)
    : undefined;
}

export function readUseOptions(options: Record<string, unknown>): UseOptions {
  const raw = options['useOptions'];
  return raw && typeof raw === 'object' ? (raw as UseOptions) : {};
}

/** Options for {@link createPackageInvoker}. */
export interface PackageInvokerOptions {
  /**
   * The invocation's flat options bag (adhd ADR-0019 D1): handed to every
   * `--use` plugin's `createLayer` once, at composition time. Not namespaced
   * per plugin — a plugin reads only its own keys. Defaults to `{}`.
   */
  layerOptions?: Record<string, unknown>;
  /**
   * Binding-aware dispatch terminal (adhd ADR-0017 D7): passed through to
   * {@link createInvoker}, where it replaces the core `dispatch` as the
   * innermost Service, inside the validate-Layer. Absent, the invoker
   * dispatches through `dispatch` unchanged. See {@link Terminal}.
   */
  terminal?: Terminal;
}

/** The layer capability of a `--use` plugin, as {@link UsePlugin} declares it. */
type UseLayerCapability = NonNullable<NonNullable<UsePlugin['capabilities']>['layer']>;

/**
 * Adapt a core `LayerCapability` (whose layer receives the SPEC §7.1 `Call`
 * shape with `.data`) into a runtime {@link Layer} (which threads the §8.1
 * `Call` with `.domainArgs`). The runtime Call already carries `operation`,
 * `envelope`, `ctx`, and `signal`; we additionally surface `.data` (an alias of
 * `domainArgs`) so layers written against either shape see their fields.
 *
 * Accepts either form of the capability (adhd ADR-0019 D1):
 *   - `createLayer` present → called ONCE, here, with `layerOptions`; its
 *     result is the layer. It wins over a static `layer`. A `createLayer` that
 *     throws propagates unchanged (it fails composition, before any request).
 *   - otherwise `layer` is the layer.
 *
 * Call this once per plugin at composition time, never per request.
 *
 * @param cap          The plugin's layer capability.
 * @param layerOptions The invocation's flat options bag for `createLayer`; defaults to `{}`.
 * @param pluginId     The plugin's id, named in the composition error; optional.
 * @returns The runtime Layer.
 * @throws ApiError('internal') when the capability has neither a `layer` nor a
 *   `createLayer` function (possible only from untyped JS), or when
 *   `createLayer` returns something other than a function.
 */
export function adaptCoreLayer(
  cap: UseLayerCapability,
  layerOptions: Record<string, unknown> = {},
  pluginId?: string
): Layer {
  const label = pluginId === undefined ? 'a --use plugin' : `--use plugin "${pluginId}"`;
  let layerFn: (
    call: unknown,
    next: () => Promise<unknown>
  ) => Promise<unknown> | AsyncIterable<unknown>;
  if (typeof cap.createLayer === 'function') {
    const built: unknown = cap.createLayer(layerOptions);
    if (typeof built !== 'function') {
      throw new ApiError(
        'internal',
        `apigen-engine-runtime: ${label}: layer capability createLayer() returned ${built === null ? 'null' : typeof built}, not a layer function`
      );
    }
    layerFn = built as typeof layerFn;
  } else if (typeof cap.layer === 'function') {
    const staticLayer = cap.layer;
    layerFn = (call, next) => staticLayer.call(cap, call, next);
  } else {
    throw new ApiError(
      'internal',
      `apigen-engine-runtime: ${label}: layer capability has neither a layer nor a createLayer function`
    );
  }
  return async function useLayer(call: RuntimeCall, next): Promise<unknown> {
    const view = Object.assign(call, { data: call.domainArgs });
    const result = await layerFn(view, next as () => Promise<unknown>);
    return result;
  };
}

/**
 * Compose the request-path invoker for one package: the `--use` layer
 * plugins (outermost-first, in declaration order) wrapping the central
 * validate-Layer (innermost, immediately before dispatch — BUG-APIGEN-009).
 * Built ONCE per package, not per request.
 *
 * Every plugin's layer is materialised here, at composition (adhd ADR-0019
 * D1): a `createLayer` runs once with `options.layerOptions`, and a capability
 * with neither `layer` nor `createLayer` fails here — once, with
 * `ApiError('internal')` — rather than on every request.
 *
 * @param schemas    The package's composed schemas (bound to the validate-Layer).
 * @param usePlugins The loaded `--use` plugins, outermost first.
 * @param options    Composition options; see {@link PackageInvokerOptions}.
 * @returns The composed invoke function.
 */
export function createPackageInvoker(
  schemas: ComposedSchemas,
  usePlugins: UsePlugin[],
  options: PackageInvokerOptions = {}
): InvokeFn {
  const layerOptions = options.layerOptions ?? {};
  const layers: Layer[] = [];
  for (const plugin of usePlugins) {
    const cap = plugin.capabilities?.layer;
    if (cap) layers.push(adaptCoreLayer(cap, layerOptions, plugin.id));
  }
  // validate-Layer is ALWAYS innermost so malformed input is rejected before
  // dispatch is ever reached (SPEC §6 / §8.1 rule 1).
  layers.push(makeValidateLayer(schemas));
  return options.terminal === undefined
    ? createInvoker(layers)
    : createInvoker(layers, { terminal: options.terminal });
}
