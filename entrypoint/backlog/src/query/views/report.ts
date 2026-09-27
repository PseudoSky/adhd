/**
 * report.ts — the grouped rollup verb (C7, DESIGN §5 AC7).
 *
 * ## Why this verb exists
 *
 * Verifying umbrella coverage previously required a hand-rolled three-way
 * client join, and every caller that performed it produced its own number —
 * the exact drift DESIGN §2 Invariant 5 forbids ("a count named for what it
 * counts"). `report` performs the join server-side so no caller invents a
 * figure.
 *
 * ## Composition, never re-derivation (ADR-0002)
 *
 * `byPriority` is composed directly from `priorityMatrix` (`views/stats.ts`) —
 * the SAME status-aware, edge-scoped breakdown, not a second counting path.
 * The shared scope is resolved ONCE by `resolveScopedLiveIssueNodes`, which
 * `priorityMatrix` itself now uses, so `byKind`/`byStatus`/`avgAgeDays` are
 * guaranteed to count the SAME in-scope live rows `byPriority` counts.
 *
 * Every number is computed from the store in THIS call; `computedAt` pins the
 * instant `avgAgeDays` was measured against. Nothing here is stored.
 */

import type { GraphBackend, NodeRecord } from '@adhd/sox-graph-store';
import { isStatusTerminal } from '../card.js';
import type { IIssueFilter } from '../types.js';
import type { IQueryStoreHandle } from '../query.js';
import {
  priorityMatrix,
  resolveScopedLiveIssueNodes,
} from './stats.js';

/**
 * `report`'s filter — the four dimensions `priorityMatrix` composes with
 * (`project`/`component`/`kind`/`status`). `status` is the coarse
 * `open`/`closed`/`all` selector (never a name list): `report`'s whole point
 * is a scope-named aggregate, and `statusScope` echoes exactly what was
 * counted. An omitted `status` defaults to `'open'`, matching `priorityMatrix`.
 */
export interface IReportInput {
  filter?: {
    project?: string;
    component?: string;
    kind?: string | string[];
    status?: 'open' | 'closed' | 'all';
  };
}

export interface IReportResult {
  /** Counts by `kind` name (live, in-scope rows only), name-ascending. */
  byKind: Array<{ kind: string; count: number }>;
  /** Counts by `priority` name + rank (composed from `priorityMatrix`). */
  byPriority: Array<{ priority: string; rank?: number; count: number }>;
  /** Status histogram: status name, its terminal flag, and the count. */
  byStatus: Array<{ status: string; terminal: boolean; count: number }>;
  /** Average age in days of OPEN (non-terminal) in-scope items, measured from `tCreated` at report time. */
  avgAgeDays: number;
  /** Names what was counted — `'open'` when the filter omitted `status`. */
  statusScope: NonNullable<IIssueFilter['status']>;
  /** The instant every time-relative number above was computed against. */
  computedAt: string;
}

/**
 * Resolve the `has_kind` target NAME for each of `issues` — one whole-relation
 * `getEdges({rel:'has_kind'})` scan, grouped in memory (the same constant-cost
 * shape every other whole-relation reader in `stats.ts` uses). An issue
 * carrying no live `has_kind` edge resolves to no entry.
 */
async function resolveKindNamesFor(
  graph: GraphBackend,
  issues: readonly NodeRecord[]
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (issues.length === 0) return out;
  const issueIds = new Set(issues.map((i) => i.id));
  const kindIdByIssue = new Map<number, number>();
  for (const e of await graph.getEdges({ rel: 'has_kind' })) {
    if (issueIds.has(e.src) && !kindIdByIssue.has(e.src))
      kindIdByIssue.set(e.src, e.dst);
  }
  const kindIds = [...new Set(kindIdByIssue.values())];
  const kindById = new Map(
    (kindIds.length > 0 ? await graph.getNodesByIds(kindIds) : []).map((n) => [
      n.id,
      n.name ?? '',
    ])
  );
  for (const [issueId, kindId] of kindIdByIssue) {
    const name = kindById.get(kindId);
    if (name !== undefined) out.set(issueId, name);
  }
  return out;
}

/**
 * Resolve the current `has_status` target (name + terminal flag) for each of
 * `issues` — one whole-relation scan, grouped in memory. Terminality is
 * `card.ts`'s exported `isStatusTerminal`, never re-derived here.
 */
async function resolveStatusFor(
  graph: GraphBackend,
  issues: readonly NodeRecord[]
): Promise<Map<number, { name: string; terminal: boolean }>> {
  const out = new Map<number, { name: string; terminal: boolean }>();
  if (issues.length === 0) return out;
  const issueIds = new Set(issues.map((i) => i.id));
  const statusIdByIssue = new Map<number, number>();
  for (const e of await graph.getEdges({ rel: 'has_status' })) {
    if (issueIds.has(e.src) && !statusIdByIssue.has(e.src))
      statusIdByIssue.set(e.src, e.dst);
  }
  const statusIds = [...new Set(statusIdByIssue.values())];
  const statusById = new Map(
    (statusIds.length > 0 ? await graph.getNodesByIds(statusIds) : []).map(
      (n) => [n.id, { name: n.name ?? '', terminal: isStatusTerminal(n) }]
    )
  );
  for (const [issueId, statusId] of statusIdByIssue) {
    const s = statusById.get(statusId);
    if (s) out.set(issueId, s);
  }
  return out;
}

/**
 * SPEC.md §5's grouped rollup (DESIGN §5 AC7) — every count computed from the
 * store in this call, none stored. See this file's header for the
 * composition rule.
 */
export async function report(
  handle: IQueryStoreHandle,
  input: IReportInput
): Promise<IReportResult> {
  const { graph } = handle;
  const computedAt = new Date().toISOString();

  // ONE scope resolution, shared by every field below (and by the composed
  // `priorityMatrix`), so no two numbers can describe different row sets.
  const { nodes, statusScope } = await resolveScopedLiveIssueNodes(
    graph,
    input.filter
  );

  // Composed, never re-derived (ADR-0002): `byPriority` IS `priorityMatrix`'s
  // rows, re-projected to the report's shape.
  const matrix = await priorityMatrix(handle, { filter: input.filter });
  const byPriority = matrix.rows.map((r) => ({
    priority: r.priority,
    ...(r.rank !== undefined ? { rank: r.rank } : {}),
    count: r.count,
  }));

  const kindNameById = await resolveKindNamesFor(graph, nodes);
  const statusById = await resolveStatusFor(graph, nodes);

  const kindCounts = new Map<string, number>();
  const statusCounts = new Map<string, { terminal: boolean; count: number }>();
  const nowMs = Date.parse(computedAt);
  let openCount = 0;
  let ageSumMs = 0;

  for (const node of nodes) {
    const kind = kindNameById.get(node.id) ?? node.kind;
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);

    const status = statusById.get(node.id);
    const statusName = status?.name ?? '';
    const terminal = status?.terminal ?? false;
    const entry = statusCounts.get(statusName) ?? { terminal, count: 0 };
    entry.count += 1;
    statusCounts.set(statusName, entry);

    if (!terminal) {
      openCount += 1;
      const createdMs = Date.parse(node.tCreated);
      if (!Number.isNaN(createdMs)) ageSumMs += nowMs - createdMs;
    }
  }

  const byKind = [...kindCounts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
  const byStatus = [...statusCounts.entries()]
    .map(([status, v]) => ({ status, terminal: v.terminal, count: v.count }))
    .sort((a, b) => a.status.localeCompare(b.status));

  const avgAgeDays =
    openCount > 0 ? ageSumMs / openCount / 86_400_000 : 0;

  return {
    byKind,
    byPriority,
    byStatus,
    avgAgeDays,
    statusScope,
    computedAt,
  };
}
