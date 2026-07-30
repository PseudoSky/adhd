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

import type { Layer } from './invoke';
import { createInvoker } from './invoke';
import { makeValidateLayer } from './validate-layer';
import type { Call as RuntimeCall, InvokeFn } from './invoke';
import type { ComposedSchemas } from './types';

// ---------------------------------------------------------------------------
// §7.1 / §8 — `--use` Layer + Mount composition (BUG-APIGEN-009 / -010)
// ---------------------------------------------------------------------------

/**
 * A loaded `--use` plugin object (SPEC §7.1). We only depend on the shape we
 * actually consume here (layer / mount capabilities) so the runtime stays
 * decoupled from the full `Plugin` type surface.
 */
export interface UsePlugin {
  id: string;
  capabilities?: {
    layer?: {
      layer: (
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
        // `MountHostBridge` (duck-typed here rather than imported, since this
        // file must not depend on the core-client package for its own
        // internal `UsePlugin` shape).
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

export function readUseOptions(options: Record<string, unknown>): UseOptions {
  const raw = options['useOptions'];
  return raw && typeof raw === 'object' ? (raw as UseOptions) : {};
}

/**
 * Adapt a core `LayerCapability.layer` (which receives the SPEC §7.1 `Call`
 * shape with `.data`) into a runtime {@link Layer} (which threads the §8.1
 * `Call` with `.domainArgs`). The runtime Call already carries `operation.id`,
 * `envelope`, `ctx`, and `signal`; we additionally surface `.data` (an alias of
 * `domainArgs`) so layers written against either shape see their fields.
 */
export function adaptCoreLayer(
  cap: NonNullable<NonNullable<UsePlugin['capabilities']>['layer']>
): Layer {
  return async function useLayer(call: RuntimeCall, next): Promise<unknown> {
    const view = Object.assign(call, { data: call.domainArgs });
    const result = await cap.layer(view, next as () => Promise<unknown>);
    return result;
  };
}

/**
 * Compose the request-path invoker for one package: the `--use` layer
 * plugins (outermost-first, in declaration order) wrapping the central
 * validate-Layer (innermost, immediately before dispatch — BUG-APIGEN-009).
 * Built ONCE per package, not per request.
 */
export function createPackageInvoker(
  schemas: ComposedSchemas,
  usePlugins: UsePlugin[]
): InvokeFn {
  const layers: Layer[] = [];
  for (const plugin of usePlugins) {
    const cap = plugin.capabilities?.layer;
    if (cap) layers.push(adaptCoreLayer(cap));
  }
  // validate-Layer is ALWAYS innermost so malformed input is rejected before
  // dispatch is ever reached (SPEC §6 / §8.1 rule 1).
  layers.push(makeValidateLayer(schemas));
  return createInvoker(layers);
}
