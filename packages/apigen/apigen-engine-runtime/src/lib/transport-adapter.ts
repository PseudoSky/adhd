/**
 * TransportAdapter — serve-core primitive port ([iface:transport-adapter]).
 *
 * The thin, transport-specific seam every serve-core adapter (fastify,
 * express, mcp, cli, py-flask, py-grpc, …) implements against a resolved
 * `OpPlan`. Everything transport-NEUTRAL (route/verb/tool-name/flag
 * resolution, envelope binding, mount/stream detection) already lives on the
 * `OpPlan`; a `TransportAdapter` only has to:
 *
 *   - `registerRoute`  — wire the plan's projected surface (HTTP route, MCP
 *     tool, CLI command, gRPC method — whichever this transport serves) to a
 *     `dispatch` callback.
 *   - `readCall`       — marshal the transport-native inbound request (`Raw`)
 *     into the runtime `Call` shape (minus `operation`/`ctx`, which the
 *     dispatch path fills in — see `dispatchForPlan`).
 *   - `writeResult`     — marshal a resolved `LayerResult` back onto the
 *     transport-native outbound carrier (`Raw`).
 *   - `writeError`      — marshal a thrown error back onto `Raw`.
 *
 * F1 [fix:layerresult-return]: `invoke()` (`./invoke.ts:94-102,152-156`)
 * ALWAYS returns a `Promise`; only the RESOLVED value is the
 * `unknown | AsyncIterable<unknown>` union (`LayerResult`). So the `dispatch`
 * callback threaded through `registerRoute` returns `Promise<LayerResult>`,
 * and `writeResult` takes the already-RESOLVED `LayerResult` — never a bare
 * `Promise<unknown> | AsyncIterable<unknown>` union, which does not
 * type-check against `invoke`'s real signature.
 *
 * `Raw` stays a generic escape hatch (e.g. fastify's SSE path needs
 * `reply.hijack()`); `readCall`/`writeResult`/`writeError` are genuinely
 * transport-specific and may be sync or async.
 */

import type { Call, LayerResult } from './invoke';
import type { OpPlan } from './op-plan';

export interface TransportAdapter<Raw = unknown> {
  /**
   * Register `plan`'s projected route/tool/command/method with this
   * transport's underlying server/CLI/router, wiring inbound requests to
   * `dispatch`. Called ONCE per `OpPlan`, at server/CLI wiring time.
   */
  registerRoute(
    plan: OpPlan,
    dispatch: (call: Omit<Call, 'operation' | 'ctx'>) => Promise<LayerResult>
  ): void;

  /**
   * Marshal the transport-native inbound request `raw` into the runtime
   * `Call` shape (minus `operation`/`ctx`, filled in by the dispatch path).
   */
  readCall(
    raw: Raw,
    plan: OpPlan
  ): Omit<Call, 'operation' | 'ctx'> | Promise<Omit<Call, 'operation' | 'ctx'>>;

  /**
   * Marshal a resolved `LayerResult` (the value `dispatch`'s returned
   * Promise resolved to — F1) back onto the transport-native outbound
   * carrier `raw`.
   */
  writeResult(
    raw: Raw,
    result: LayerResult,
    plan: OpPlan
  ): void | Promise<void>;

  /** Marshal a thrown error back onto the transport-native outbound carrier `raw`. */
  writeError(raw: Raw, err: unknown, plan: OpPlan): void | Promise<void>;
}
