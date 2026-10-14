import { evaluate } from './api';
import type { IPolicyCtx } from './ctx';

/** One call to decide on, as a host presents it. */
export interface IDeciderRequest {
  tool: string;
  args: Readonly<Record<string, unknown>>;
  envelope: Readonly<Record<string, unknown>>;
  transport: 'http' | 'grpc' | 'mcp' | 'cli';
  attributes?: Readonly<Record<string, string | number | readonly string[]>>;
}

/** What a host does with the call. */
export type IDeciderResult =
  | { decision: 'allow'; set?: Readonly<Record<string, unknown>> }
  | { decision: 'ask'; reason?: string }
  | { decision: 'deny'; reason?: string };

/** The yes/no port a host embeds; structurally identical to the Layer package's `IPolicyDecider` (LP-03). */
export interface IDecider {
  decide(request: IDeciderRequest, signal?: AbortSignal): Promise<IDeciderResult>;
}

/**
 * Maps `evaluate` onto the decider port: allow (with forced `set`), ask (with a
 * reason), deny (reason = the denial reason). Any thrown error, including a
 * policy that cannot load, becomes a deny. `options.scope` is forwarded to the
 * ctx runtime provider.
 */
export function createDecider(ctx: IPolicyCtx, options?: { readonly scope?: string }): IDecider {
  const provider = ctx.runtime;
  const scope = options?.scope;
  const scoped: IPolicyCtx =
    scope !== undefined && provider !== undefined
      ? { ...ctx, runtime: { observe: (input) => provider.observe({ ...input, scope }) } }
      : ctx;
  return {
    async decide(request, signal): Promise<IDeciderResult> {
      try {
        if (signal?.aborted) return { decision: 'deny', reason: 'the request was aborted' };
        const decision = await evaluate(scoped, {
          tool: request.tool,
          args: { ...request.args },
          ...(request.attributes !== undefined ? { attributes: request.attributes } : {}),
        });
        if (decision.effect === 'allow') {
          return Object.keys(decision.set).length > 0 ? { decision: 'allow', set: decision.set } : { decision: 'allow' };
        }
        if (decision.effect === 'ask') {
          return { decision: 'ask', reason: `requires approval (matched ${decision.matched.join(', ')})` };
        }
        return { decision: 'deny', reason: decision.denial?.reason ?? 'denied' };
      } catch (error) {
        return { decision: 'deny', reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
