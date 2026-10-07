/**
 * reservation.ts — the persisted claim reservation (46cf1086, S11.R1; B-AC1).
 *
 * A claim is more than `claimedBy`/`claimedAt` on the issue: it RESERVES the
 * paths the issue's work touches, so another agent can ask "who holds file F"
 * without knowing any uid (`query {view:"reservations"}`).
 *
 * - `reservation` node, meta
 *   `{issueUid, paths[], holder, sessionId?, claimedAt, leaseExpiry, endedAt?, endReason?}`,
 *   linked from the issue by the internal `has_reservation` edge (`1:n`).
 * - `paths` = the distinct ABSOLUTE targets of the issue's live `path`
 *   citations at that instant (a relative target resolves against the owning
 *   project's root) UNION the optional explicit `IClaimInput.paths`.
 *   The explicit paths are also persisted as `explicitPaths` so a refresh
 *   (renew / re-claim by the holder) re-includes them (56f736c9).
 * - `leaseExpiry = claimedAt + project_policy.claim_stale_after_min`
 *   ({@link leaseExpiryOf}, the same arithmetic `isClaimStale` uses).
 * - claim / reclaim: any live reservation of the issue is ENDED and a new one
 *   written. Re-claim by the holder (`held`) and `renew` refresh the live one in
 *   place. `release` ends it. Ended reservations are never deleted — the
 *   interval history survives close and reopen.
 *
 * Every function runs inside the caller's own verb transaction.
 */
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import type { TypePolicy } from '@adhd/sox-graph-store';
import { resolveEdgeKindTx } from './catalog.js';
import { canonicalizePath } from './citation-path.js';
import { writeEdgeTx, writeNodeTx } from './tx.js';

/** Why a reservation ended. */
export type ReservationEndReason = 'released' | 'reclaimed-stale' | 'expired-superseded';

/** The persisted reservation record (node meta). */
export interface IReservationMeta {
  issueUid: string;
  paths: string[];
  /** The caller-supplied `IClaimInput.paths` (trimmed, un-canonicalised), kept so a refresh (`renew` / re-claim by the holder) re-includes them: `paths` is recomputed from the live citations on every refresh and would otherwise drop them (56f736c9). */
  explicitPaths?: string[];
  holder: string;
  sessionId?: string;
  claimedAt: string;
  leaseExpiry: string;
  endedAt?: string;
  endReason?: ReservationEndReason;
}

interface ILiveReservationRow {
  rowid: number;
  meta: string | null;
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function canonical(p: string): Promise<string> {
  const abs = resolvePath(p);
  try {
    return await canonicalizePath(abs);
  } catch {
    return abs; // an unreadable ancestor must never block a claim
  }
}

/**
 * The distinct absolute reservation paths of an issue: its live `path`
 * citations plus `explicit`. Sorted for a stable record.
 */
export async function collectReservationPathsTx(
  tx: AdapterTransaction,
  issueRowid: number,
  explicit: readonly string[] = []
): Promise<string[]> {
  const ownsComponent = await tx.executeGet<{ src: number }>(
    "SELECT src FROM edge WHERE dst = ? AND rel = 'owns_component' AND t_invalid IS NULL",
    [issueRowid]
  );
  let projectRoot: string | undefined;
  if (ownsComponent) {
    const ownsProject = await tx.executeGet<{ src: number }>(
      "SELECT src FROM edge WHERE dst = ? AND rel = 'owns_project' AND t_invalid IS NULL",
      [ownsComponent.src]
    );
    if (ownsProject) {
      const project = await tx.executeGet<{ meta: string | null }>('SELECT meta FROM node WHERE rowid = ?', [
        ownsProject.src,
      ]);
      const path = parseMeta(project?.meta ?? null)['path'];
      if (typeof path === 'string' && path.length > 0) projectRoot = path;
    }
  }
  const { rows } = await tx.executeAll<{ meta: string | null }>(
    `SELECT n.meta AS meta
     FROM edge e JOIN node n ON n.rowid = e.dst
     WHERE e.src = ? AND e.rel = 'has_citation' AND e.t_invalid IS NULL AND n.t_invalid IS NULL
     ORDER BY n.rowid ASC`,
    [issueRowid]
  );
  const out = new Set<string>();
  for (const r of rows) {
    const meta = parseMeta(r.meta);
    if (meta['target_type'] !== undefined && meta['target_type'] !== 'path') continue;
    const target = meta['target'];
    if (typeof target !== 'string' || target.length === 0) continue;
    let abs: string | undefined;
    if (isAbsolute(target)) abs = target;
    else if (projectRoot !== undefined) abs = join(projectRoot, target);
    if (abs === undefined) continue;
    out.add(await canonical(abs));
  }
  for (const p of explicit) {
    if (typeof p === 'string' && p.trim().length > 0) out.add(await canonical(p.trim()));
  }
  return [...out].sort();
}

async function liveReservationsTx(tx: AdapterTransaction, issueRowid: number): Promise<ILiveReservationRow[]> {
  const { rows } = await tx.executeAll<ILiveReservationRow>(
    `SELECT n.rowid AS rowid, n.meta AS meta
     FROM edge e JOIN node n ON n.rowid = e.dst
     WHERE e.src = ? AND e.rel = 'has_reservation' AND e.t_invalid IS NULL AND n.t_invalid IS NULL
       AND json_extract(n.meta, '$.endedAt') IS NULL
     ORDER BY n.rowid ASC`,
    [issueRowid]
  );
  return rows;
}

async function writeMetaTx(tx: AdapterTransaction, rowid: number, meta: Record<string, unknown>, at: string): Promise<void> {
  const r = await tx.executeRun('UPDATE node SET meta = ?, t_updated = ? WHERE rowid = ?', [
    JSON.stringify(meta),
    at,
    rowid,
  ]);
  if (r.rowsAffected !== 1) {
    throw new Error(`reservation: UPDATE affected ${r.rowsAffected} rows for rowid=${rowid}, expected exactly 1.`);
  }
}

/** End every live reservation of the issue (history is kept). */
export async function endReservationsTx(
  tx: AdapterTransaction,
  args: { issueRowid: number; reason: ReservationEndReason; at: string }
): Promise<number> {
  const live = await liveReservationsTx(tx, args.issueRowid);
  for (const row of live) {
    await writeMetaTx(
      tx,
      row.rowid,
      { ...parseMeta(row.meta), endedAt: args.at, endReason: args.reason },
      args.at
    );
  }
  return live.length;
}

/**
 * The explicit claim paths persisted on the LIVE reservation held by `holder`
 * (empty when none is live, it belongs to someone else, or it predates the
 * `explicitPaths` field). A refresh unions these with any newly supplied paths.
 */
export async function liveExplicitPathsTx(
  tx: AdapterTransaction,
  issueRowid: number,
  holder: string
): Promise<string[]> {
  const live = await liveReservationsTx(tx, issueRowid);
  const current = live[live.length - 1];
  if (current === undefined) return [];
  const meta = parseMeta(current.meta);
  if (meta['holder'] !== holder) return [];
  const explicit = meta['explicitPaths'];
  return Array.isArray(explicit) ? explicit.filter((p): p is string => typeof p === 'string') : [];
}

/**
 * Record the reservation for a successful claim-family action.
 *
 * - `mode:'new'` (first claim, or a reclaim): end the live reservation(s) with
 *   `endReason` (default `'expired-superseded'`; `'reclaimed-stale'` for a
 *   reclaim) and write a fresh reservation + `has_reservation`.
 * - `mode:'refresh'` (re-claim by the holder, renew): update the live
 *   reservation in place; if none is live (a claim that predates this record),
 *   write one.
 */
export async function recordReservationTx(
  tx: AdapterTransaction,
  typePolicy: TypePolicy,
  args: {
    issueRowid: number;
    issueUid: string;
    holder: string;
    sessionId?: string;
    claimedAt: string;
    leaseExpiry: string;
    paths: string[];
    /** Explicit claim paths to persist alongside `paths` (see {@link IReservationMeta.explicitPaths}). */
    explicitPaths?: string[];
    mode: 'new' | 'refresh';
    endReason?: ReservationEndReason;
    at: string;
  }
): Promise<void> {
  const base: IReservationMeta = {
    issueUid: args.issueUid,
    paths: args.paths,
    ...(args.explicitPaths !== undefined && args.explicitPaths.length > 0 ? { explicitPaths: args.explicitPaths } : {}),
    holder: args.holder,
    ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
    claimedAt: args.claimedAt,
    leaseExpiry: args.leaseExpiry,
  };
  if (args.mode === 'refresh') {
    const live = await liveReservationsTx(tx, args.issueRowid);
    const current = live[live.length - 1];
    if (current !== undefined && parseMeta(current.meta)['holder'] === args.holder) {
      await writeMetaTx(tx, current.rowid, { ...parseMeta(current.meta), ...base }, args.at);
      return;
    }
  }
  await endReservationsTx(tx, {
    issueRowid: args.issueRowid,
    reason: args.endReason ?? 'expired-superseded',
    at: args.at,
  });
  const node = await writeNodeTx(tx, {
    at: args.at,
    kind: 'reservation',
    name: args.issueUid,
    content: '',
    metadata: { ...base },
  });
  const rule = await resolveEdgeKindTx(tx, 'has_reservation');
  await writeEdgeTx(tx, {
    at: args.at,
    srcRowid: args.issueRowid,
    srcUid: args.issueUid,
    srcKind: 'issue',
    dstRowid: node.rowid,
    dstUid: node.uid,
    dstKind: 'reservation',
    rel: 'has_reservation',
    rule,
    typePolicy,
  });
}
