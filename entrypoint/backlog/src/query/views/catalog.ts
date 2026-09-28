/**
 * views/catalog.ts — the readable, **generated** catalog view (C8).
 *
 * ## What this is
 *
 * The tool describing itself: one read view over EVERY vocabulary a consumer
 * must know — the two the store mints (`kind`/`status`/`priority`), the edge
 * relations (§3's fixed table), the issue-field union, the envelope error-code
 * union, the location-type union, and the mounted verb surface.
 *
 * ## Generated, never hand-maintained (AC2/AC7)
 *
 * Every non-`store` term is derived from its **validating source at call
 * time** — `EDGE_KIND_TABLE` for `relation`, `ISSUE_PLAIN_FIELDS` +
 * `ISSUE_PSEUDO_FIELDS` for `field`, `BACKLOG_ERROR_CODES` for `error_code`,
 * `VALID_LOCATION_TYPES` for `location_type`, and `BACKLOG_VERBS` for `verb`.
 * A new live catalog row, a new reserved terminal status, a newly pinned verb,
 * or a widened field union appears here with **no separate edit** — the
 * property AC2's negative control (a hand-maintained list) fails.
 *
 * The `kind`/`status`/`priority` terms read the LIVE store rows and report
 * each row's `usageCount` (incoming catalog edges), `uid`, `lifecycle`, and
 * `replacedBy` — so a consumer sees the effective vocabulary, not the
 * configured one.
 *
 * ## ADR-0004 — flat union return, no envelope
 *
 * `query {view:'kinds'|'catalogs'}` returns this shape directly on the broad
 * `IIssueQueryResult` union; the transport envelope (if any) is the caller's,
 * never a nested `{result}` wrapper here.
 */

import type { GraphBackend, NodeRecord } from '@adhd/sox-graph-store';
import {
  DEPRECATED_KIND_NAMES,
  DEPRECATED_KIND_REPLACEMENTS,
  EDGE_KIND_TABLE,
  RESERVED_TERMINAL_STATUS_NAMES,
  VALID_LOCATION_TYPES,
} from '../../write/catalog.js';
import { catalogNameFold } from '../../write/catalog-repair.js';
import { BACKLOG_ERROR_CODES } from '../../envelope.js';
import { BACKLOG_VERBS } from '../../vocabulary.js';
import {
  ISSUE_PLAIN_FIELDS,
  ISSUE_PSEUDO_FIELDS,
  type ILocationType,
} from '../types.js';

/**
 * The catalogs this view exposes. `kind`/`status`/`priority` are store-backed
 * (open vocabularies minted by the write layer); the rest are fixed in-code
 * vocabularies projected from their validating source.
 */
export type CatalogKindName =
  | 'kind'
  | 'status'
  | 'priority'
  | 'relation'
  | 'field'
  | 'error_code'
  | 'location_type'
  | 'verb';

/** The in-code source a term was generated from. Named so the catalog is provably generated, not hand-maintained. */
export type CatalogSource =
  | 'store'
  | 'edge_kind_table'
  | 'reserved_terminal_status_names'
  | 'issue_field_union'
  | 'error_code_union'
  | 'valid_location_types'
  | 'mounted_verb_surface';

export type CatalogLifecycle = 'active' | 'deprecated';

export interface ICatalogTerm {
  /** The term's canonical name. */
  name: string;
  /** Live row uid when a store row backs it; absent for in-code source terms. */
  uid?: string;
  /** Which vocabulary this term belongs to. */
  catalog: CatalogKindName;
  /** The validating source this term was generated from at call time. */
  source: CatalogSource;
  lifecycle: CatalogLifecycle;
  /** Present when deprecated: the term to use instead. */
  replacedBy?: string;
  /** For `kind`/`status`/`priority`: the live callers count, read at call time. */
  usageCount?: number;
}

export interface ICatalogView {
  catalogs: CatalogKindName[];
  terms: ICatalogTerm[];
  /** True when any term is a case-fold collision of another within its catalog (the invariant the read layer depends on). */
  hasCaseCollisions: boolean;
}

/**
 * ## Adding a term is gated, not free (the five-part promotion gate)
 *
 * This view is the DISCOVERY half of C8's promotion gate: a word becomes a
 * primitive only when ALL FIVE hold — (1) not expressible by an existing
 * primitive, (2) demanded by ≥2 independent in-repo consumers (a distinct
 * actor that must act on the item, never prior art), (3) carries a
 * rename-proof id, (4) validatable by the closed grammar, and (5)
 * discoverable here. A weaker extension is governed separately (owner,
 * register verb, lifecycle) rather than promoted. Full statement and the
 * governed-extension namespace rule: `write/CONTRACT.md` ("The five-part
 * promotion gate"). `DESIGN.md` §2 Invariant 6, §5 AC8, §6 Vocabulary.
 */

/** The catalog order the view reports — store-backed first, then the in-code vocabularies. */
const CATALOG_ORDER: readonly CatalogKindName[] = [
  'kind',
  'status',
  'priority',
  'relation',
  'field',
  'error_code',
  'location_type',
  'verb',
];

/** The three store-backed catalogs, with the edge rel a caller uses to point an issue at one. */
const STORE_CATALOGS: ReadonlyArray<{
  catalog: 'kind' | 'status' | 'priority';
  rel: string;
}> = [
  { catalog: 'kind', rel: 'has_kind' },
  { catalog: 'status', rel: 'has_status' },
  { catalog: 'priority', rel: 'has_priority' },
];

/** Folded lookup index over {@link DEPRECATED_KIND_NAMES} (the exported set keeps its canonical spellings). */
const FOLDED_DEPRECATED_KIND_NAMES: ReadonlySet<string> = new Set(
  [...DEPRECATED_KIND_NAMES].map((name) => catalogNameFold(name))
);

/** Folded lookup over {@link DEPRECATED_KIND_REPLACEMENTS}, so both `EPIC` and `epic` resolve their replacement. */
const FOLDED_DEPRECATED_KIND_REPLACEMENTS: ReadonlyMap<string, string> = new Map(
  [...DEPRECATED_KIND_REPLACEMENTS].map(([from, to]) => [
    catalogNameFold(from),
    to,
  ])
);

/** The in-code deprecation verdict for a `kind` NAME (fold-insensitive), used when no row meta records one. */
function inCodeKindLifecycle(name: string): {
  lifecycle: CatalogLifecycle;
  replacedBy?: string;
} {
  const fold = catalogNameFold(name);
  if (!FOLDED_DEPRECATED_KIND_NAMES.has(fold)) return { lifecycle: 'active' };
  const replacedBy = FOLDED_DEPRECATED_KIND_REPLACEMENTS.get(fold);
  return { lifecycle: 'deprecated', ...(replacedBy ? { replacedBy } : {}) };
}

/** The lifecycle a store row records in its `meta`, falling back to the in-code `kind` deprecation set. */
function storeRowLifecycle(
  catalog: 'kind' | 'status' | 'priority',
  row: NodeRecord
): { lifecycle: CatalogLifecycle; replacedBy?: string } {
  const meta = row.metadata ?? {};
  const lifecycle: CatalogLifecycle =
    meta['lifecycle'] === 'deprecated' ? 'deprecated' : 'active';
  const replacedBy =
    typeof meta['replacedBy'] === 'string' ? meta['replacedBy'] : undefined;
  if (lifecycle === 'deprecated') {
    return { lifecycle, ...(replacedBy ? { replacedBy } : {}) };
  }
  // No meta deprecation. For `kind`, the in-code set is the authoritative
  // fallback so a retired borrowed term is reported deprecated even before a
  // one-shot metadata change has run.
  if (catalog === 'kind') return inCodeKindLifecycle(row.name ?? '');
  return { lifecycle: 'active' };
}

/** Live incoming catalog-edge counts for `rel`, keyed by target rowid — ONE read for the whole catalog. */
async function usageByTargetRowid(
  graph: GraphBackend,
  rel: string
): Promise<Map<number, number>> {
  const edges = await graph.getEdges({ rel });
  const counts = new Map<number, number>();
  for (const edge of edges) {
    counts.set(edge.dst, (counts.get(edge.dst) ?? 0) + 1);
  }
  return counts;
}

/** Build the store-backed terms for one catalog, reading live rows + their caller counts. */
async function storeCatalogTerms(
  graph: GraphBackend,
  catalog: 'kind' | 'status' | 'priority',
  rel: string
): Promise<ICatalogTerm[]> {
  const rows = await graph.queryNodes({ kind: catalog, liveOnly: true });
  const usage = await usageByTargetRowid(graph, rel);
  return rows.map((row) => {
    const { lifecycle, replacedBy } = storeRowLifecycle(catalog, row);
    return {
      name: row.name ?? '',
      uid: row.uid,
      catalog,
      source: 'store' as const,
      lifecycle,
      ...(replacedBy ? { replacedBy } : {}),
      usageCount: usage.get(row.id) ?? 0,
    };
  });
}

/** The reserved terminal status names with no live row — the in-code half of the `status` catalog. */
function reservedStatusTerms(liveStatusFolds: ReadonlySet<string>): ICatalogTerm[] {
  const terms: ICatalogTerm[] = [];
  for (const name of RESERVED_TERMINAL_STATUS_NAMES) {
    if (liveStatusFolds.has(catalogNameFold(name))) continue;
    terms.push({
      name,
      catalog: 'status',
      source: 'reserved_terminal_status_names',
      lifecycle: 'active',
    });
  }
  return terms;
}

/** One term per fixed in-code vocabulary entry of `catalog`, all `active`, from `source`. */
function inCodeTerms(
  catalog: CatalogKindName,
  source: CatalogSource,
  names: readonly string[]
): ICatalogTerm[] {
  return names.map((name) => ({
    name,
    catalog,
    source,
    lifecycle: 'active' as const,
  }));
}

/** True iff any two terms within one catalog share a case fold. */
function detectCaseCollisions(terms: readonly ICatalogTerm[]): boolean {
  const byCatalog = new Map<CatalogKindName, Set<string>>();
  for (const term of terms) {
    const seen = byCatalog.get(term.catalog) ?? new Set<string>();
    const fold = catalogNameFold(term.name);
    if (seen.has(fold)) return true;
    seen.add(fold);
    byCatalog.set(term.catalog, seen);
  }
  return false;
}

/**
 * ONE read view over every vocabulary (AC1). Every non-`store` term is derived
 * from its in-code source at call time — never a hand-written list — and every
 * `store` term is a live row with its caller count.
 *
 * Read-only: it never opens a transaction and never writes, so it is safe
 * against any store, including the live one.
 */
export async function catalogView(graph: GraphBackend): Promise<ICatalogView> {
  const terms: ICatalogTerm[] = [];
  const liveStatusFolds = new Set<string>();

  for (const { catalog, rel } of STORE_CATALOGS) {
    const catalogTerms = await storeCatalogTerms(graph, catalog, rel);
    if (catalog === 'status') {
      for (const term of catalogTerms) liveStatusFolds.add(catalogNameFold(term.name));
    }
    terms.push(...catalogTerms);
  }
  terms.push(...reservedStatusTerms(liveStatusFolds));
  terms.push(
    ...inCodeTerms(
      'relation',
      'edge_kind_table',
      EDGE_KIND_TABLE.map((rule) => rule.rel)
    )
  );
  terms.push(
    ...inCodeTerms(
      'field',
      'issue_field_union',
      [...ISSUE_PLAIN_FIELDS, ...ISSUE_PSEUDO_FIELDS]
    )
  );
  terms.push(
    ...inCodeTerms('error_code', 'error_code_union', BACKLOG_ERROR_CODES)
  );
  terms.push(
    ...inCodeTerms(
      'location_type',
      'valid_location_types',
      VALID_LOCATION_TYPES as readonly ILocationType[]
    )
  );
  terms.push(...inCodeTerms('verb', 'mounted_verb_surface', BACKLOG_VERBS));

  // Deterministic order: catalog order, then name, then uid (in-code terms
  // have no uid and sort first within their name).
  terms.sort((a, b) => {
    const byCatalog =
      CATALOG_ORDER.indexOf(a.catalog) - CATALOG_ORDER.indexOf(b.catalog);
    if (byCatalog !== 0) return byCatalog;
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return (a.uid ?? '').localeCompare(b.uid ?? '');
  });

  return {
    catalogs: [...CATALOG_ORDER],
    terms,
    hasCaseCollisions: detectCaseCollisions(terms),
  };
}

/**
 * The terms of ONE catalog (AC1's narrowed sibling). Derived from the SAME
 * {@link catalogView} — there is no second generation path, so `kinds` and
 * `catalogs` can never disagree about a catalog's contents.
 */
export async function catalogFor(
  graph: GraphBackend,
  catalog: CatalogKindName
): Promise<ICatalogTerm[]> {
  const view = await catalogView(graph);
  return view.terms.filter((term) => term.catalog === catalog);
}
