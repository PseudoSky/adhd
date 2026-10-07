/**
 * views/reservations.ts — `query {view:"reservations"}` (46cf1086, S11.R2-R4;
 * B-AC2..B-AC4): the store-wide enumeration of ACTIVE claim reservations, with
 * no uid supplied. One row per (reservation x path).
 *
 * LIVE = the reservation has no `endedAt` AND `leaseExpiry > now`. `now` is
 * `input.now` (ISO) or the current time — the single clock seam, so tests prove
 * lease expiry by injecting `now`, never by sleeping (B-AC4).
 *
 * Filters (all AND): `pathPrefix` (segment-aware, never substring), `sessionId`,
 * `holder`, and the existing primary-owner `project`/`component` filters,
 * resolved on the OWNING issue through the caller-supplied scope resolver so
 * this module stays free of an import cycle with `query.ts`.
 */
import { resolve as resolvePath, sep } from 'node:path';
import type { GraphBackend } from '@adhd/sox-graph-store';
import { BacklogValidationError } from '../../write/errors.js';
import type { IIssueQueryInput, IReservationRow } from '../types.js';

export const DEFAULT_RESERVATIONS_LIMIT = 100;
export const MAX_RESERVATIONS_LIMIT = 1000;

/** True when `path` equals `prefix` or lies under it, by whole path segments. */
export function pathUnderPrefix(path: string, prefix: string): boolean {
  const p = prefix.length > 1 ? prefix.replace(/\/+$/, '') : prefix;
  if (path === p) return true;
  return path.startsWith(p.endsWith(sep) ? p : p + sep);
}

export interface IReservationsResult {
  items: IReservationRow[];
  total: number;
  hasMore: boolean;
  limit: number;
}

/**
 * @param resolveScope maps `{project?, component?}` to the set of issue node ids
 *   it selects (`undefined` => no scoping). Supplied by `query.ts`.
 */
export async function queryReservations(
  graph: GraphBackend,
  input: IIssueQueryInput,
  resolveScope: (filter: IIssueQueryInput['filter']) => Promise<Set<number> | undefined>
): Promise<IReservationsResult> {
  const limit = input.limit ?? DEFAULT_RESERVATIONS_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_RESERVATIONS_LIMIT) {
    throw new BacklogValidationError('limit', `must be a positive integer <= ${MAX_RESERVATIONS_LIMIT}, got ${limit}`);
  }
  const now = input.now ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(now))) {
    throw new BacklogValidationError('now', `must be an ISO-8601 timestamp, got ${JSON.stringify(input.now)}`);
  }
  const f = input.filter ?? {};
  const prefix = f.pathPrefix !== undefined ? resolvePath(f.pathPrefix) : undefined;

  const scopeFilter = {
    ...(f.project !== undefined ? { project: f.project } : {}),
    ...(f.component !== undefined ? { component: f.component } : {}),
  };
  const scope =
    scopeFilter.project !== undefined || scopeFilter.component !== undefined
      ? await resolveScope(scopeFilter)
      : undefined;

  const nodes = await graph.queryNodes({ kind: 'reservation', liveOnly: true });
  const ownerEdges = scope !== undefined ? await graph.getEdges({ rel: 'has_reservation' }) : [];
  const issueOfReservation = new Map(ownerEdges.map((e) => [e.dst, e.src]));

  const rows: IReservationRow[] = [];
  for (const n of nodes) {
    const m = n.metadata ?? {};
    if (typeof m['endedAt'] === 'string') continue;
    const leaseExpiry = m['leaseExpiry'];
    const claimedAt = m['claimedAt'];
    const holder = m['holder'];
    if (typeof leaseExpiry !== 'string' || typeof claimedAt !== 'string' || typeof holder !== 'string') continue;
    if (!(Date.parse(leaseExpiry) > Date.parse(now))) continue;
    const sessionId = typeof m['sessionId'] === 'string' ? (m['sessionId'] as string) : null;
    if (f.sessionId !== undefined && sessionId !== f.sessionId) continue;
    if (f.holder !== undefined && holder !== f.holder) continue;
    if (scope !== undefined) {
      const issueId = issueOfReservation.get(n.id);
      if (issueId === undefined || !scope.has(issueId)) continue;
    }
    const issueUid = typeof m['issueUid'] === 'string' ? (m['issueUid'] as string) : '';
    const paths = Array.isArray(m['paths']) ? (m['paths'] as unknown[]).filter((p): p is string => typeof p === 'string') : [];
    for (const path of paths) {
      if (prefix !== undefined && !pathUnderPrefix(path, prefix)) continue;
      rows.push({ path, uid: issueUid, holder, sessionId, claimedAt, leaseExpiry });
    }
  }
  rows.sort((a, b) => a.path.localeCompare(b.path) || a.uid.localeCompare(b.uid));
  return { items: rows.slice(0, limit), total: rows.length, hasMore: rows.length > limit, limit };
}
