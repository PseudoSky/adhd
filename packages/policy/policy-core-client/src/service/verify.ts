import { LAYER_ORDER, compile } from '../core';
import type { ILayerInput, IPolicyIssue, IVerifyReport } from '../spec';

function rank(name: unknown): number {
  const index = (LAYER_ORDER as readonly unknown[]).indexOf(name);
  return index < 0 ? LAYER_ORDER.length : index;
}

/**
 * `compile` plus reporting: returns EVERY error and warning (D-05), never just
 * the first. The `runtime-without-provider` warning is kept only when no
 * runtime provider is configured (`hasRuntimeProvider`), because with a
 * provider the policy can be decided. `sources` lists the layer sources in
 * layer order. Never throws: input that cannot be compiled is a report.
 */
export function verifyLayers(
  layers: readonly ILayerInput[],
  options: { hasRuntimeProvider: boolean }
): IVerifyReport {
  const list = Array.isArray(layers) ? layers : [];
  const result = compile(list);
  const rawWarnings: readonly IPolicyIssue[] = result.ok ? result.warnings : (result.warnings ?? []);
  const warnings = options.hasRuntimeProvider
    ? rawWarnings.filter((issue) => issue.code !== 'runtime-without-provider')
    : rawWarnings;
  const errors: readonly IPolicyIssue[] = result.ok ? [] : result.errors;
  const sources = list
    .map((layer, index) => ({ layer, index }))
    .sort((a, b) => rank(a.layer?.name) - rank(b.layer?.name) || a.index - b.index)
    .map((entry) => String(entry.layer?.source));
  return { ok: errors.length === 0, errors, warnings, sources };
}
