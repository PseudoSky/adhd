import type { ICompileOptions, ICompileResult, ILayerInput } from '../../spec';
import { compile } from '../compile/compile';
import { memoKey } from './key';

/** In-memory compile memo (CC-01..CC-05). */
export interface IPolicyMemo {
  /** Hit: same input hash returns the stored result object (identity-equal) with no parse or compile. Miss: compile, store, return. */
  load(layers: readonly ILayerInput[]): ICompileResult;
  /** Number of stored results. */
  readonly size: number;
  /** Drops every entry. */
  clear(): void;
}

/**
 * Creates a memo keyed by the input hash and compiler version. Both `ok: true`
 * and `ok: false` results are cached. In-memory only, no eviction beyond
 * `clear()`; entries are immutable so concurrent loads in one process are safe.
 */
export function createPolicyMemo(options?: ICompileOptions): IPolicyMemo {
  const entries = new Map<string, ICompileResult>();
  return {
    load(layers: readonly ILayerInput[]): ICompileResult {
      let key: string;
      try {
        key = memoKey(layers, options);
      } catch {
        // Layers that cannot be canonicalised are never cached; compile reports them.
        return compile(layers, options);
      }
      const hit = entries.get(key);
      if (hit !== undefined) return hit;
      const result = compile(layers, options);
      entries.set(key, result);
      return result;
    },
    get size(): number {
      return entries.size;
    },
    clear(): void {
      entries.clear();
    },
  };
}
