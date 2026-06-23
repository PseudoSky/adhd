/**
 * Layer harness — SPEC §8.1 (normative TS Layer model).
 *
 * Implements `createInvoker(layers) → invoke(op, call)` which composes a
 * typed Layer stack around the core `dispatch` Service.  Transports become
 * thin adapters: marshal envelope/data in → `invoke` → marshal result/error
 * out.
 *
 * Six §8.1 rules honored:
 *   1. Short-circuit — a Layer returns without calling `next`, skipping all
 *      downstream Layers and dispatch.
 *   2. Error propagation — errors unwind outward through each enclosing Layer.
 *   3. Typed-extension `ctx` — typed, type-keyed extensions readable by any Layer.
 *   4. `poll_ready` — host-optional no-op (TS omits it; Rust/Tower exposes it).
 *   5. Streaming-aware `next()` — return type accommodates both a value and an
 *      AsyncIterable (streaming projection lands later, but the harness type
 *      carries it now per §11).
 *   6. Codegen-weave compatible — composition is pure function; static hosts
 *      weave at codegen with the same semantics.
 */

import type { Operation } from '@adhd/apigen-core'
import { dispatch } from './dispatch'
import type { ComposedSchemas } from './types'

// ---------------------------------------------------------------------------
// ctx — typed-extension map (§8.1 rule 3)
// ---------------------------------------------------------------------------

/**
 * A symbol-keyed or constructor-keyed typed extension map.  Each value is
 * stored under a unique token so Layers can share typed data without a mutable
 * property bag.  Modeled after Tower/`http::Extensions` — the only `ctx` shape
 * expressible under Rust's borrow checker, so TS matches it for dual-host
 * alignment.
 */
export class LayerContext {
  private readonly _map: Map<unknown, unknown> = new Map()

  /** Store `value` under `token` (a constructor or a unique symbol). */
  set<T>(token: abstract new (...args: never[]) => T, value: T): void
  set<T>(token: symbol, value: T): void
  set(token: unknown, value: unknown): void {
    this._map.set(token, value)
  }

  /**
   * Retrieve the value stored under `token`.  Returns `undefined` when the
   * token has not been inserted — callers are responsible for presence checks.
   */
  get<T>(token: abstract new (...args: never[]) => T): T | undefined
  get<T>(token: symbol): T | undefined
  get(token: unknown): unknown {
    return this._map.get(token)
  }

  /** Returns true when the token has a stored value. */
  has(token: unknown): boolean {
    return this._map.has(token)
  }
}

// ---------------------------------------------------------------------------
// Call — the request object threaded through every Layer (§8.1)
// ---------------------------------------------------------------------------

/** The resolved domain call, threaded through the Layer stack. */
export interface Call {
  /**
   * The canonical operation descriptor.  For v1 callers that do not have a
   * full Operation, only `id` is guaranteed; the remaining fields are optional.
   */
  operation: Pick<Operation, 'id'> & Partial<Operation>
  /** Typed extension map — insert/read per §8.1 rule 3. */
  ctx: LayerContext
  /** Middleware envelope (side-channel from transport metadata). */
  envelope: Record<string, unknown>
  /** Domain arguments (the `data` sub-object from the composed input). */
  domainArgs: Record<string, unknown>
  /** Cancellation signal (AbortSignal) — §11. */
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Layer type — §8.1 normative TS signature
// ---------------------------------------------------------------------------

/**
 * The primitive result a Layer or dispatch can return.
 *
 * §11: a streaming operation returns `AsyncIterable<unknown>`; a normal
 * operation returns `unknown`.  Both are covered by this union.
 */
export type LayerResult = unknown | AsyncIterable<unknown>

/**
 * `next` continuation — the inner Layer or dispatch Service.
 *
 * Returns a promise of either a scalar result or an AsyncIterable stream
 * (§11).  A Layer that short-circuits (§8.1 rule 1) never calls this.
 */
export type Next = () => Promise<LayerResult>

/**
 * A Layer in the TS harness (§8.1 normative closure signature).
 *
 * ```ts
 * const logger: Layer = async (call, next) => {
 *   const t = Date.now()
 *   try   { const r = await next(); return r }
 *   catch (e) { throw e }  // error unwinds outward — §8.1 rule 2
 * }
 * ```
 *
 * Rule 1 (short-circuit): return a value WITHOUT calling `next`.
 * Rule 2 (error propagation): `throw` propagates to the enclosing Layer.
 * Rule 4 (poll_ready): not present — TS host omits it entirely (host-optional).
 * Rule 5 (streaming): `next()` return type includes `AsyncIterable<unknown>`.
 * Rule 6 (codegen-weave): composition is a pure function; same semantics.
 */
export type Layer = (call: Call, next: Next) => Promise<LayerResult>

// ---------------------------------------------------------------------------
// InvokeOptions — runtime dispatch target
// ---------------------------------------------------------------------------

/**
 * Runtime context needed by `invoke` to reach the core dispatch Service.
 *
 * v1 callers supply `fns` + `createClient` + `schemas` directly; future
 * callers may pre-build an invoker from an Operation descriptor.
 */
export interface InvokeOptions {
  /** The live function table (fn-name → implementation). */
  fns: Record<string, (...args: unknown[]) => unknown>
  /** Optional client factory (for session-ctx middleware). */
  createClient?: (envelope: Record<string, unknown>) => Promise<unknown>
  /** Composed schemas for the target namespace. */
  schemas: ComposedSchemas
}

// ---------------------------------------------------------------------------
// Invoker factory — createInvoker(layers) → invoke
// ---------------------------------------------------------------------------

/**
 * The composed invoke function returned by {@link createInvoker}.
 *
 * Accepts an operation name, a {@link Call}, and runtime dispatch options.
 * Returns the Service result, streaming or scalar.
 */
export type InvokeFn = (
  fnName: string,
  call: Call,
  opts: InvokeOptions,
) => Promise<LayerResult>

/**
 * Compose a Layer stack and return a typed `invoke` function.
 *
 * Layers are applied **outermost-first**: `layers[0]` wraps `layers[1]`
 * which wraps … which wraps `dispatch`.  Equivalent to Tower's
 * `ServiceBuilder::layer` / `layer_fn` composition order.
 *
 * ```ts
 * const invoke = createInvoker([authLayer, loggerLayer])
 * const result = await invoke('getUser', call, opts)
 * ```
 *
 * When `layers` is empty, `invoke` calls `dispatch` directly.
 *
 * §8.1 rule 6 (codegen-weave): static hosts receive the composed list at
 * codegen time; `createInvoker` is called once per plugin instantiation, not
 * once per request.
 */
export function createInvoker(layers: readonly Layer[] = []): InvokeFn {
  return async function invoke(
    fnName: string,
    call: Call,
    opts: InvokeOptions,
  ): Promise<LayerResult> {
    const schema = opts.schemas[fnName]
    if (!schema) {
      throw new Error(`apigen/invoke: no schema found for operation "${fnName}"`)
    }

    // The innermost Service — wraps the canonical dispatch function.
    const coreService: Next = () =>
      dispatch(opts.fns, opts.createClient, schema, fnName, call.envelope, call.domainArgs)

    // Compose layers right-to-left so layers[0] is outermost.
    // Each Layer receives a `next` that calls the next Layer inward.
    const composed: Next = layers.reduceRight<Next>(
      (innerNext, layer) => () => layer(call, innerNext),
      coreService,
    )

    return composed()
  }
}
