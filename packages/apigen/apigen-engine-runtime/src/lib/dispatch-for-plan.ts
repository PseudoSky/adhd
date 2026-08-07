/**
 * dispatchForPlan — serve-core primitive ([iface:dispatch-for-plan]).
 *
 * F1 [fix:layerresult-return]: `invoke()` ALWAYS returns a `Promise`; only
 * the RESOLVED value is the `unknown | AsyncIterable<unknown>` union
 * (`LayerResult`, `./invoke.ts:94-102,152-156`). `dispatchForPlan` therefore
 * returns `Promise<LayerResult>` — NOT the bare
 * `Promise<unknown> | AsyncIterable<unknown>` sketch, which does not
 * type-check against `invoke`'s real signature.
 *
 * Branches on `plan.isMount`:
 *   - source op → build the full runtime `Call` (fills in `operation`/`ctx`,
 *     which callers omit per the `TransportAdapter` contract) and call
 *     `invoke` directly.
 *   - mount op  → [fix:mount-through-layers]: routes the call through the
 *     SAME composed `--use` layer stack as source ops (the `--use` layer
 *     capabilities — auth/logging — now see mount calls too, a reviewed,
 *     flagged behavior change), by supplying a synthetic, empty-schema
 *     fn/schema entry keyed to the mount op's id via `InvokeOptions`. This is
 *     safe because `makeValidateLayer` is bound to the PACKAGE's real
 *     `ComposedSchemas` at `createPackageInvoker` construction time (never
 *     the per-call synthetic entry supplied here), so it looks up
 *     `schemas[mountOpId]`, finds nothing, and no-ops
 *     (`./validate-layer.ts` — `schema === undefined` short-circuits to
 *     `next()`). The synthetic entry only exists to satisfy `createInvoker`'s
 *     own "no schema found" guard (`./invoke.ts`) so the mount call reaches
 *     the composed layers at all; the synthetic fn ignores dispatch's
 *     positional args and instead invokes `plan.mountHandler` with the
 *     ADAPTED core-client `Call` (F3) captured in its closure.
 *
 * F3 [fix:transport-stamping]: the mount branch adapts the runtime `Call`
 * (`domainArgs`/`ctx: LayerContext`) into the core-client `Call`
 * (`data`/`ctx: Extensions`/`transport`/`raw`,
 * `apigen-core-client/src/lib/plugin.ts:87-117`) and stamps `Call.transport`
 * from `plan.transport` — NEVER a hardcoded `'http'`, which would mis-tag
 * every non-HTTP transport's mount provenance once mcp/cli land.
 */

import type { Call as CoreClientCall, Extensions } from '@adhd/apigen-core-client';
import type {
  Call as RuntimeCall,
  InvokeFn,
  InvokeOptions,
  LayerResult,
} from './invoke';
import { LayerContext } from './invoke';
import type { OpPlan } from './op-plan';

/** A minimal, self-contained `Extensions` implementation for an adapted mount `Call`. */
function createExtensions(): Extensions {
  const map = new Map<unknown, unknown>();
  return {
    get: <T>(key: abstract new (...args: never[]) => T): T | undefined =>
      map.get(key) as T | undefined,
    set: <T>(key: abstract new (...args: never[]) => T, value: T): void => {
      map.set(key, value);
    },
  };
}

/**
 * A schema-less, zero-domain-param composed-schema stand-in used ONLY to
 * satisfy `createInvoker`'s "no schema found" guard for a mount op's
 * synthetic dispatch-path entry. Never registered against the package's real
 * `ComposedSchemas` (that would defeat [fix:mount-through-layers]'s no-op
 * validate-Layer guarantee).
 */
const MOUNT_PASSTHROUGH_SCHEMA: {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
} = {
  input: {
    type: 'object',
    properties: { data: { type: 'object', properties: {} } },
  },
  output: {},
};

/**
 * Resolve one dispatch for `plan`, given the package's composed `invoke`
 * (`InvokeFn`, e.g. from `createPackageInvoker`) and a partial runtime `Call`
 * (minus `operation`/`ctx`, per the `TransportAdapter` contract).
 */
export async function dispatchForPlan(
  plan: OpPlan,
  invoke: InvokeFn,
  call: Omit<RuntimeCall, 'operation' | 'ctx'>,
  opts: InvokeOptions
): Promise<LayerResult> {
  const fullCall: RuntimeCall = {
    ...call,
    operation: { id: plan.op.id },
    ctx: new LayerContext(),
  };

  if (plan.isMount) {
    const mountHandler = plan.mountHandler;
    if (!mountHandler) {
      throw new Error(
        `apigen-engine-runtime/dispatchForPlan: OpPlan for mount op "${plan.op.id}" has isMount=true but no mountHandler`
      );
    }

    // F3: adapt the runtime Call -> core-client Call, stamping `transport`
    // from `plan.transport` — never a hardcoded literal.
    const coreCall: CoreClientCall = {
      operation: plan.op,
      data: call.domainArgs,
      envelope: call.envelope,
      ctx: createExtensions(),
      transport: plan.transport,
      signal: call.signal ?? new AbortController().signal,
    };

    const mountOpts: InvokeOptions = {
      ...opts,
      fns: { [plan.op.id]: () => mountHandler(coreCall) },
      schemas: { [plan.op.id]: MOUNT_PASSTHROUGH_SCHEMA },
    };

    return invoke(plan.op.id, fullCall, mountOpts);
  }

  return invoke(plan.op.id, fullCall, opts);
}
