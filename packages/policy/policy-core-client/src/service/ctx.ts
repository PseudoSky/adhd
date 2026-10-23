import { ApiError } from '@adhd/apigen-base-errors';
import { createPolicyMemo } from '../core';
import { isStableLayers } from './stable-layers';
import type { IAuditSink, ICompiledPolicy, ILayerInput, ILayerSource, IPolicyIssue, IRuntimeProvider } from '../spec';

/** What every operation receives first; schema-excluded by apigen. */
export interface IPolicyCtx {
  /**
   * Memoized compile of the configured layers. Rejects with
   * `ApiError('internal', 'policy failed to compile: <first issue> (<n> errors) [<source>]')`
   * when the layers do not compile, and `ApiError('internal', ...)` naming the
   * file when they cannot be loaded (D-05, FC-06). A policy that cannot load
   * never yields a decision.
   */
  readonly policy: () => Promise<ICompiledPolicy>;
  /** The raw layers (for verify / show). Re-read on every call. */
  readonly layers: () => Promise<readonly ILayerInput[]>;
  readonly runtime?: IRuntimeProvider;
  readonly audit?: IAuditSink;
  readonly now: () => number;
  /** For doctor: resolved settings with their cascade source, and where the policy came from. */
  readonly describe: () => {
    readonly settings: Readonly<Record<string, { value: unknown; source: string }>>;
    readonly policySource: string;
  };
}

/** Names the layer file an issue belongs to, falling back to every source. */
function sourceOf(issue: IPolicyIssue, layers: readonly ILayerInput[]): string {
  const match = layers.find((layer) => layer.name === issue.layer);
  return match !== undefined ? match.source : layers.map((layer) => layer.source).join(', ');
}

/**
 * Builds a ctx over ANY `ILayerSource` with one compile memo per ctx. Lazy:
 * nothing is read until a thunk is awaited (IN-14). Layers are re-read on every
 * call, so an edited file is picked up; the memo is keyed by the input hash, so
 * unchanged layers do not recompile. When a source returns the identity-stable
 * layer array it returned last time (the filesystem source does while no file
 * changed), `policy()` returns the previous compiled policy without hashing.
 */
export function createCtx(input: {
  source: ILayerSource;
  runtime?: IRuntimeProvider;
  audit?: IAuditSink;
  now?: () => number;
  describe?: IPolicyCtx['describe'];
}): IPolicyCtx {
  const memo = createPolicyMemo();
  const layers = async (): Promise<readonly ILayerInput[]> => {
    try {
      return await input.source.load();
    } catch (error) {
      throw new ApiError(
        'internal',
        `policy failed to load: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };
  let last: { readonly layers: readonly ILayerInput[]; readonly policy: ICompiledPolicy } | undefined;
  const policy = async (): Promise<ICompiledPolicy> => {
    const loaded = await layers();
    if (last?.layers === loaded && isStableLayers(loaded)) return last.policy;
    const result = memo.load(loaded);
    if (!result.ok) {
      const first = result.errors[0];
      const n = result.errors.length;
      throw new ApiError(
        'internal',
        `policy failed to compile: ${first.message} (${n} error${n === 1 ? '' : 's'}) [${sourceOf(first, loaded)}]`,
        { errors: result.errors }
      );
    }
    if (isStableLayers(loaded)) last = { layers: loaded, policy: result.policy };
    return result.policy;
  };
  return {
    policy,
    layers,
    ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
    ...(input.audit !== undefined ? { audit: input.audit } : {}),
    now: input.now ?? (() => Date.now()),
    describe: input.describe ?? (() => ({ settings: {}, policySource: 'in-memory' })),
  };
}

/** No environment, no files: a ctx over in-memory layers. For library consumers and tests. */
export function createMemoryCtx(input: {
  layers: readonly ILayerInput[];
  runtime?: IRuntimeProvider;
  audit?: IAuditSink;
  now?: () => number;
}): IPolicyCtx {
  return createCtx({
    source: { load: async () => input.layers },
    ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
    ...(input.audit !== undefined ? { audit: input.audit } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
    describe: () => ({ settings: {}, policySource: 'in-memory' }),
  });
}
