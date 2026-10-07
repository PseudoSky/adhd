/**
 * membership.ts — the joined evidence model's n:m `in_component` membership
 * (e54bd58b A-AC5, SPEC-SET S02.S2).
 *
 * ## The model
 *
 * - **Primary owner** = the existing `owns_component` edge (component → issue,
 *   `1:n`): exactly one, unchanged, the routing/ACL anchor. Per-project counts
 *   keyed by primary owner cannot change by construction — nothing here writes
 *   or re-points `owns_component`.
 * - **Membership** = the internal `in_component` edge (issue → component,
 *   `n:m`, edge meta `{via:'primary'|'citation', citationUid?}`). NOT on the
 *   public `relate` rel union (ADR-0007 D4: internal edge kinds are additive).
 * - **Project membership is derived**: component → `owns_project` parent. No
 *   project edge is stored.
 *
 * ## Invariants (the migration and the tests assert them)
 *
 * - I1 every live issue has exactly one live `owns_component`.
 * - I2 every live issue has a live `in_component` to its primary component
 *   with `via:'primary'`.
 * - I3 for every live `path` citation whose target resolves to a component C
 *   (longest-prefix match against registered `location` rows and
 *   `component.meta.path`, at most ONE component per project, ALL live projects
 *   searched), a live `in_component` to C exists (`via:'citation'` unless C is
 *   the primary).
 *
 * ## One reconcile, not four incremental writers
 *
 * Every write seam (create, add/remove citation, update's citation diff, move)
 * calls {@link reconcileMembershipTx}: recompute the DESIRED membership from
 * scratch (primary + live citations) and diff it against the live
 * `in_component` edges — write the missing, relabel the changed, invalidate the
 * stale. Idempotent, so the migration reuses it verbatim and a re-run plans
 * zero writes. A citation whose path matches NO registered component adds no
 * membership (never a wrong one: nothing auto-links without a registered
 * location).
 */
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import { resolveEdgeKindTx } from './catalog.js';
import { isPathWithin, type ISiblingRootExecutor } from './citation-path.js';
import {
  type IWriteStoreHandle,
  getNodeByRowidTx,
  invalidateEdgeTx,
  writeEdgeTx,
} from './tx.js';

/** One membership row as read back (`get {fields:["memberships"]}`). */
export interface IMembershipRow {
  componentUid: string;
  projectUid: string;
  via: 'primary' | 'citation';
  citationUid?: string;
}

interface IComponentHit {
  componentRowid: number;
  componentUid: string;
  projectUid: string;
}

interface IDesired {
  componentRowid: number;
  componentUid: string;
  via: 'primary' | 'citation';
  citationUid?: string;
}

/** `p` as an absolute path: itself if absolute, else joined to `base`, else `undefined` (a relative root with no project root cannot be located). */
function absoluteRoot(p: string, base: string | undefined): string | undefined {
  if (isAbsolute(p)) return p;
  return base === undefined ? undefined : join(base, p);
}

/** Primary row first, then by component uid. */
export function compareMemberships(
  a: { via: string; componentUid: string },
  b: { via: string; componentUid: string }
): number {
  if (a.via === b.via) return a.componentUid.localeCompare(b.componentUid);
  return a.via === 'primary' ? -1 : 1;
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Longest-prefix match of an absolute path against every LIVE `location`
 * (`locType:'path'`) value and every live `component.meta.path` (joined to its
 * project's `meta.path`). At most ONE component per project is returned (the
 * one with the longest matching root); every live project is searched, so a
 * citation into a sibling repo yields that repo's component — the cross-project
 * evidence the n:m model exists for.
 */
export async function findComponentsForPathTx(
  exec: ISiblingRootExecutor,
  absPath: string
): Promise<IComponentHit[]> {
  const target = resolvePath(absPath);
  const { rows: projects } = await exec.executeAll<{ uid: string; meta: string | null }>(
    "SELECT uid, meta FROM node WHERE kind = 'project' AND t_invalid IS NULL"
  );
  const projectPath = new Map<string, string | undefined>();
  for (const p of projects) {
    const path = parseMeta(p.meta)['path'];
    projectPath.set(p.uid, typeof path === 'string' && path.length > 0 ? path : undefined);
  }
  const { rows: components } = await exec.executeAll<{
    rowid: number;
    uid: string;
    meta: string | null;
  }>("SELECT rowid, uid, meta FROM node WHERE kind = 'component' AND t_invalid IS NULL");
  const compInfo = new Map<string, { rowid: number; projectUid: string; path?: string }>();
  for (const c of components) {
    const meta = parseMeta(c.meta);
    const projectUid = meta['projectUid'];
    if (typeof projectUid !== 'string' || !projectPath.has(projectUid)) continue;
    const rel = meta['path'];
    compInfo.set(c.uid, {
      rowid: c.rowid,
      projectUid,
      ...(typeof rel === 'string' && rel.length > 0 ? { path: rel } : {}),
    });
  }

  /** (componentUid, root) candidates. */
  const roots: Array<{ componentUid: string; root: string }> = [];
  for (const [uid, info] of compInfo) {
    const base = projectPath.get(info.projectUid);
    if (info.path !== undefined) {
      const abs = absoluteRoot(info.path, base);
      if (abs !== undefined) roots.push({ componentUid: uid, root: resolvePath(abs) });
    }
  }
  const { rows: locations } = await exec.executeAll<{ meta: string | null }>(
    "SELECT meta FROM node WHERE kind = 'location' AND t_invalid IS NULL"
  );
  for (const l of locations) {
    const meta = parseMeta(l.meta);
    const componentUid = meta['componentUid'];
    const value = meta['value'];
    if (meta['locType'] !== 'path' || typeof componentUid !== 'string' || typeof value !== 'string') continue;
    const info = compInfo.get(componentUid);
    if (info === undefined) continue;
    const base = projectPath.get(info.projectUid);
    const abs = absoluteRoot(value, base);
    if (abs !== undefined) roots.push({ componentUid, root: resolvePath(abs) });
  }

  const best = new Map<string, { componentUid: string; rootLen: number }>();
  for (const { componentUid, root } of roots) {
    if (!isPathWithin(root, target)) continue;
    const info = compInfo.get(componentUid)!;
    const cur = best.get(info.projectUid);
    if (cur === undefined || root.length > cur.rootLen) {
      best.set(info.projectUid, { componentUid, rootLen: root.length });
    }
  }
  return [...best.entries()].map(([projectUid, b]) => ({
    componentRowid: compInfo.get(b.componentUid)!.rowid,
    componentUid: b.componentUid,
    projectUid,
  }));
}

/**
 * Recompute and persist the membership of ONE issue (see the module header).
 * Safe to call at any point after the issue's `owns_component` exists inside
 * the verb's own transaction; a no-op write-wise when nothing changed. Returns
 * the number of edge writes it made (the migration's "pending" measure).
 */
export async function reconcileMembershipTx(
  tx: AdapterTransaction,
  handle: IWriteStoreHandle,
  args: { issueRowid: number; issueUid: string; at: string }
): Promise<number> {
  const primaryEdge = await tx.executeGet<{ src: number }>(
    "SELECT src FROM edge WHERE dst = ? AND rel = 'owns_component' AND t_invalid IS NULL",
    [args.issueRowid]
  );
  if (!primaryEdge) return 0; // I1 is the caller's invariant; never invent a primary here.
  const primary = await getNodeByRowidTx(tx, primaryEdge.src);
  if (!primary) return 0;

  const desired = new Map<number, IDesired>();
  desired.set(primary.rowid, {
    componentRowid: primary.rowid,
    componentUid: primary.uid,
    via: 'primary',
  });

  // The owning project's root resolves a RELATIVE citation target.
  const ownsProject = await tx.executeGet<{ src: number }>(
    "SELECT src FROM edge WHERE dst = ? AND rel = 'owns_project' AND t_invalid IS NULL",
    [primary.rowid]
  );
  const project = ownsProject ? await getNodeByRowidTx(tx, ownsProject.src) : null;
  const projectRoot =
    typeof project?.metadata?.['path'] === 'string' ? (project.metadata['path'] as string) : undefined;

  const { rows: citations } = await tx.executeAll<{ rowid: number; uid: string; meta: string | null }>(
    `SELECT n.rowid AS rowid, n.uid AS uid, n.meta AS meta
     FROM edge e JOIN node n ON n.rowid = e.dst
     WHERE e.src = ? AND e.rel = 'has_citation' AND e.t_invalid IS NULL AND n.t_invalid IS NULL
     ORDER BY n.rowid ASC`,
    [args.issueRowid]
  );
  for (const c of citations) {
    const meta = parseMeta(c.meta);
    if (meta['target_type'] !== undefined && meta['target_type'] !== 'path') continue;
    const target = meta['target'];
    if (typeof target !== 'string' || target.length === 0) continue;
    const abs = absoluteRoot(target, projectRoot);
    if (abs === undefined) continue;
    for (const hit of await findComponentsForPathTx(tx, abs)) {
      if (desired.has(hit.componentRowid)) continue; // primary wins; first citation names the row
      desired.set(hit.componentRowid, {
        componentRowid: hit.componentRowid,
        componentUid: hit.componentUid,
        via: 'citation',
        citationUid: c.uid,
      });
    }
  }

  const { rows: live } = await tx.executeAll<{ dst: number; meta: string | null }>(
    "SELECT dst, meta FROM edge WHERE src = ? AND rel = 'in_component' AND t_invalid IS NULL",
    [args.issueRowid]
  );
  const liveByDst = new Map(live.map((l) => [l.dst, parseMeta(l.meta)]));
  const rule = await resolveEdgeKindTx(tx, 'in_component');
  let writes = 0;

  for (const d of desired.values()) {
    const have = liveByDst.get(d.componentRowid);
    if (have?.['via'] === d.via && have['citationUid'] === d.citationUid) continue;
    await writeEdgeTx(tx, {
      at: args.at,
      srcRowid: args.issueRowid,
      srcUid: args.issueUid,
      srcKind: 'issue',
      dstRowid: d.componentRowid,
      dstUid: d.componentUid,
      dstKind: 'component',
      rel: 'in_component',
      metadata: {
        via: d.via,
        ...(d.citationUid !== undefined ? { citationUid: d.citationUid } : {}),
      },
      rule,
      typePolicy: handle.typePolicy,
    });
    writes += 1;
  }
  for (const dst of liveByDst.keys()) {
    if (desired.has(dst)) continue;
    await invalidateEdgeTx(tx, {
      srcRowid: args.issueRowid,
      dstRowid: dst,
      rel: 'in_component',
      reason: 'membership no longer derived (citation removed or primary moved)',
      at: args.at,
    });
    writes += 1;
  }
  return writes;
}

/** Read an issue's live memberships (primary first, then citation-derived by component uid). */
export async function readMembershipsTx(
  exec: ISiblingRootExecutor,
  issueRowid: number
): Promise<IMembershipRow[]> {
  const { rows } = await exec.executeAll<{
    cuid: string;
    cmeta: string | null;
    emeta: string | null;
    puid: string | null;
  }>(
    `SELECT c.uid AS cuid, c.meta AS cmeta, e.meta AS emeta,
            (SELECT p.uid FROM edge pe JOIN node p ON p.rowid = pe.src
              WHERE pe.dst = c.rowid AND pe.rel = 'owns_project' AND pe.t_invalid IS NULL LIMIT 1) AS puid
     FROM edge e JOIN node c ON c.rowid = e.dst
     WHERE e.src = ? AND e.rel = 'in_component' AND e.t_invalid IS NULL AND c.t_invalid IS NULL`,
    [issueRowid]
  );
  const out: IMembershipRow[] = rows.map((r) => {
    const em = parseMeta(r.emeta);
    const projectUid =
      r.puid ?? (typeof parseMeta(r.cmeta)['projectUid'] === 'string' ? (parseMeta(r.cmeta)['projectUid'] as string) : '');
    return {
      componentUid: r.cuid,
      projectUid,
      via: em['via'] === 'citation' ? 'citation' : 'primary',
      ...(typeof em['citationUid'] === 'string' ? { citationUid: em['citationUid'] } : {}),
    };
  });
  return out.sort(compareMemberships);
}
