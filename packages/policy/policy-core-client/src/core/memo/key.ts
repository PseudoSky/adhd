import type { ICompileOptions, ILayerInput } from '../../spec';
import { COMPILER_VERSION } from '../compile/compile';
import { computeInputHash } from '../compile/hash';
import { LAYER_ORDER } from '../compile/layers';

/**
 * Same hash input as compile's `inputHash`, computed without compiling:
 * layers are ordered global, project, local (stable within a name).
 */
export function memoKey(layers: readonly ILayerInput[], options?: ICompileOptions): string {
  const rank = (name: string): number => {
    const r = (LAYER_ORDER as readonly string[]).indexOf(name);
    return r < 0 ? LAYER_ORDER.length : r;
  };
  const ordered = layers
    .map((layer, index) => ({ layer, index }))
    .sort((a, b) => rank(a.layer.name) - rank(b.layer.name) || a.index - b.index)
    .map((entry) => entry.layer);
  return computeInputHash(ordered, options?.compilerVersion ?? COMPILER_VERSION);
}
