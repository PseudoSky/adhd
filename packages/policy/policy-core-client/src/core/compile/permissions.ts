import type { ICompiledPermission, ILayerInput, IPolicyDocument } from '../../spec';
import { deepClone } from '../canonical/clone';
import { containsWithin } from '../engine/within';
import { ATTRIBUTE_PLACEHOLDER, collectFieldPaths, collectStringLeaves } from './expr-walk';

/**
 * Flattens permissions in layer order; id `<layer>:<n>` (0-based within the
 * layer's `permissions`); `tools` is always an array; `placeholders` lists
 * every `$attributes.<name>` leaf of `args` as `attributes.<name>` (first-seen
 * order, unique); `usesWithin` / `readsRuntime` are computed by walking the
 * expressions (`runtime.`-prefixed fields in `context`).
 */
export function compilePermissions(
  ordered: readonly ILayerInput[],
  documents: readonly IPolicyDocument[]
): readonly ICompiledPermission[] {
  const out: ICompiledPermission[] = [];
  ordered.forEach((layer, li) => {
    documents[li].permissions.forEach((permission, n) => {
      const placeholders: string[] = [];
      for (const leaf of collectStringLeaves(permission.args, '')) {
        const hit = ATTRIBUTE_PLACEHOLDER.exec(leaf.value);
        if (hit && !placeholders.includes(`attributes.${hit[1]}`)) {
          placeholders.push(`attributes.${hit[1]}`);
        }
      }
      out.push({
        id: `${layer.name}:${n}`,
        layer: layer.name,
        tools: typeof permission.tool === 'string' ? [permission.tool] : [...permission.tool],
        effect: permission.effect ?? 'allow',
        context: permission.context === undefined ? undefined : deepClone(permission.context),
        args: permission.args === undefined ? undefined : deepClone(permission.args),
        placeholders,
        set: permission.set === undefined ? undefined : deepClone(permission.set),
        usesWithin: containsWithin(permission.args) || containsWithin(permission.context),
        readsRuntime: collectFieldPaths(permission.context, '').some(
          (ref) => ref.segments[0] === 'runtime'
        ),
      });
    });
  });
  return out;
}
