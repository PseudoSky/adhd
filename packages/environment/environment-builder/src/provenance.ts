/**
 * `provenance.ts` — provenance extraction, decoupled from resolution.
 *
 * `config-resolver.ts`'s `resolveConfig()` produces, per field, a
 * `ResolvedFieldValue` (`{ value, source, scope, env? }`) — resolution and
 * provenance metadata bundled together, because computing one requires the
 * other. `trackProvenance()` is the pure, independently-testable projection
 * from that bundle down to the `SnapshotData.provenance` shape
 * (`Record<string, ProvenanceEntry>`): it drops `value` (which belongs in
 * `SnapshotData.raw`, not `SnapshotData.provenance`) and defensively strips
 * `env` for any source that isn't itself env-derived, so a caller can never
 * accidentally read a stale/irrelevant env var name off a `.default`/`.set`
 * provenance entry.
 *
 * Pure — no I/O, no shared mutable state.
 */

import type { ConfigScope, ProvenanceEntry, ProvenanceSource } from '@adhd/environment-base-spec';

/** The subset of `config-resolver.ts`'s `ResolvedFieldValue` that provenance is derived from. */
export interface ResolvedProvenanceInput {
  source: ProvenanceSource;
  scope: ConfigScope;
  env?: string;
}

/** Sources for which recording an `env` var name is meaningful. */
const ENV_DERIVED_SOURCES: ReadonlySet<ProvenanceSource> = new Set([
  'project.env',
  'project.override',
  'global.env',
]);

/**
 * Projects a flat map of per-field resolution metadata down to
 * `SnapshotData.provenance`'s shape: `Record<string, ProvenanceEntry>`.
 */
export function trackProvenance(
  resolved: Record<string, ResolvedProvenanceInput>,
): Record<string, ProvenanceEntry> {
  const provenance: Record<string, ProvenanceEntry> = {};

  for (const key of Object.keys(resolved)) {
    const entry = resolved[key];
    const provenanceEntry: ProvenanceEntry = {
      source: entry.source,
      scope: entry.scope,
    };
    if (entry.env !== undefined && ENV_DERIVED_SOURCES.has(entry.source)) {
      provenanceEntry.env = entry.env;
    }
    provenance[key] = provenanceEntry;
  }

  return provenance;
}
