/**
 * `provenance.ts` — provenance-entry construction, decoupled from
 * resolution (salvaged from the pre-redesign builder; see
 * `ARCHITECTURE.md` §4). `config-resolver.ts#resolveConfig` computes,
 * per field, the value + the layer it came from — this module is the pure,
 * independently-testable projection of that pair down to the
 * `SnapshotData.provenance` shape (`ProvenanceEntry`).
 *
 * Pure — no I/O, no shared mutable state.
 */

import type { ProvenanceEntry, ProvenanceSource, Scope } from '@adhd/environment-base-spec';

export interface ProvenanceInput {
  source: ProvenanceSource;
  scope: Scope;
  /** The env var name consulted, when `source === 'env'`. */
  env?: string;
}

/**
 * Builds a single `ProvenanceEntry`, defensively stripping `env` for any
 * source that isn't `'env'` — a caller can never accidentally read a
 * stale/irrelevant env var name off a `'default'`/file-layer provenance
 * entry.
 */
export function buildProvenanceEntry(input: ProvenanceInput): ProvenanceEntry {
  const entry: ProvenanceEntry = { source: input.source, scope: input.scope };
  if (input.source === 'env' && input.env !== undefined) {
    entry.env = input.env;
  }
  return entry;
}

/** Projects a flat map of per-field resolution metadata down to
 *  `SnapshotData.provenance`'s shape: `Record<string, ProvenanceEntry>`. */
export function trackProvenance(resolved: Record<string, ProvenanceInput>): Record<string, ProvenanceEntry> {
  const provenance: Record<string, ProvenanceEntry> = {};
  for (const key of Object.keys(resolved)) {
    provenance[key] = buildProvenanceEntry(resolved[key]);
  }
  return provenance;
}
