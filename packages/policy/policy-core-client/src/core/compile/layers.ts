import type { ILayerInput, IPolicyDocument, IPolicyIssue, LayerName } from '../../spec';
import { POLICY_SCHEMA } from '../../spec';
import { validateSchema } from '../schema/validate';

/** Layer evaluation order. */
export const LAYER_ORDER: readonly ['global', 'project', 'local'] = ['global', 'project', 'local'];

/**
 * Sorts layers into {@link LAYER_ORDER} (stable within a layer name) and
 * validates each document against `POLICY_SCHEMA` with a small structural
 * validator (no ajv dependency). Returns issues with code `schema` and JSON
 * paths prefixed by `/<layer>`. Layers whose document fails the schema, whose
 * name is unknown, or that repeat an earlier layer's name are reported and
 * left out of `ordered`/`documents` (`ordered[i]` pairs with `documents[i]`),
 * so later phases only ever see well-formed documents.
 */
export function orderAndValidate(layers: readonly ILayerInput[]): {
  ordered: readonly ILayerInput[];
  documents: readonly IPolicyDocument[];
  issues: readonly IPolicyIssue[];
} {
  const issues: IPolicyIssue[] = [];
  const rank = (name: unknown): number => LAYER_ORDER.indexOf(name as LayerName);

  const known: ILayerInput[] = [];
  for (const layer of layers) {
    if (layer === null || typeof layer !== 'object' || rank(layer.name) < 0) {
      issues.push({
        code: 'schema',
        path: `/${String((layer as { name?: unknown } | null)?.name ?? '')}`,
        message: `unknown layer name; expected one of ${LAYER_ORDER.join(', ')}`,
      });
      continue;
    }
    known.push(layer);
  }
  const sorted = known
    .map((layer, index) => ({ layer, index }))
    .sort((a, b) => rank(a.layer.name) - rank(b.layer.name) || a.index - b.index)
    .map((entry) => entry.layer);

  const ordered: ILayerInput[] = [];
  const documents: IPolicyDocument[] = [];
  const seen = new Set<string>();
  for (const layer of sorted) {
    if (seen.has(layer.name)) {
      issues.push({
        code: 'duplicate-id',
        path: `/${layer.name}`,
        layer: layer.name,
        message: `layer "${layer.name}" is supplied more than once (${layer.source}); permission ids would collide`,
      });
      continue;
    }
    seen.add(layer.name);
    const found = validateSchema(POLICY_SCHEMA, layer.document, `/${layer.name}`);
    if (found.length > 0) {
      for (const issue of found) {
        issues.push({
          code: 'schema',
          path: issue.path,
          layer: layer.name,
          message: `${layer.source}: ${issue.message}`,
        });
      }
      continue;
    }
    ordered.push(layer);
    documents.push(layer.document as IPolicyDocument);
  }
  return { ordered, documents, issues };
}
