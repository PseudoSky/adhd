/**
 * Ports owned by the apigen policy Layer. The Layer depends on these shapes
 * only; any decider that satisfies them structurally can be plugged in. This
 * file imports nothing.
 */

/** One authorization question put to a decider, built per call by the Layer. */
export interface IPolicyDecideRequest {
  /** The apigen operation id of the call. */
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly envelope: Readonly<Record<string, unknown>>;
  readonly transport: 'http' | 'grpc' | 'mcp' | 'cli';
  /** Read from the call envelope, where an earlier layer (an auth layer) wrote them (LP-09). Absent means none (AT-09). */
  readonly attributes?: Readonly<Record<string, string | number | readonly string[]>>;
}

/** A decider's answer. `allow.set` is merged over the call's domain arguments. */
export type IPolicyDecision =
  | { readonly decision: 'allow'; readonly set?: Readonly<Record<string, unknown>> }
  | { readonly decision: 'ask'; readonly reason?: string }
  | { readonly decision: 'deny'; readonly reason?: string };

/** Anything that can answer an authorization question. */
export interface IPolicyDecider {
  decide(request: IPolicyDecideRequest, signal?: AbortSignal): Promise<IPolicyDecision>;
}

/** Resolves an `ask` decision; anything other than `'allow-once'` is a denial. */
export interface IPolicyAskHandler {
  ask(request: IPolicyDecideRequest, reason?: string): Promise<'allow-once' | 'deny'>;
}
