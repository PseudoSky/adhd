import type { ILayerInput } from '../../spec';
import { canonicalize } from '../canonical/canonical';
import { sha256Hex } from '../canonical/sha256';

/**
 * `inputHash`: sha256 over canonical JSON of the ordered layer inputs (name +
 * document only; `source` is NOT hashed, so a moved file compiles to the same
 * hash) and the compiler version (CC-01).
 */
export function computeInputHash(
  ordered: readonly ILayerInput[],
  compilerVersion: string
): string {
  return sha256Hex(
    canonicalize({
      layers: ordered.map((layer) => ({ name: layer.name, document: layer.document })),
      compilerVersion,
    })
  );
}
