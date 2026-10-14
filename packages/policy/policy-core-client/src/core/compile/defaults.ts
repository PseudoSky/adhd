import type { ICompiledDefaultsRule, ILayerInput, IPolicyDocument } from '../../spec';
import { deepClone } from '../canonical/clone';

/**
 * Flattens the `defaults` rules of every layer, in layer order then file
 * order, assigning ids `<layer>:<n>` (n = 0-based index within that layer's
 * `defaults`). Expressions and values are cloned so the result shares nothing
 * with the caller's documents.
 */
export function compileDefaults(
  ordered: readonly ILayerInput[],
  documents: readonly IPolicyDocument[]
): readonly ICompiledDefaultsRule[] {
  const rules: ICompiledDefaultsRule[] = [];
  ordered.forEach((layer, li) => {
    (documents[li].defaults ?? []).forEach((rule, n) => {
      rules.push({
        id: `${layer.name}:${n}`,
        layer: layer.name,
        source: layer.source,
        where: rule.where === undefined ? undefined : deepClone(rule.where),
        set: deepClone(rule.set),
      });
    });
  });
  return rules;
}
