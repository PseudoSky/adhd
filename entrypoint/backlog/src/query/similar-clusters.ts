/**
 * similar-clusters.ts — the `view:'similar'` cluster block (C9
 * `similar-clusters.ts` row). ADVISORY: `candidate` runs the shared
 * write-nothing scan (`scanSimilarCandidates`); `linked` is built purely from
 * existing live `similar_to` edges. This module never writes — a reviewed link
 * is the `relate` verb (AC3/AC4).
 *
 * The block is produced only for a SCOPED `view:'similar'` read
 * (`filter.project`/`filter.component`); an unscoped call keeps the existing
 * anchor/semantic behaviour unchanged (the cluster block is additive and
 * optional). Without the embedding substrate `candidate` is `[]` (the
 * documented degraded mode) while `linked` still returns — matching the
 * read-view pattern of `ready`/`stale`.
 */

import type { GraphBackend, NodeRecord } from '@adhd/sox-graph-store';
import type { ISimilarityScanHandle } from '../write/similarity-scan.js';
import { scanSimilarCandidates } from '../write/similarity-scan.js';
import {
  resolveProjectPolicy,
  type IResolvedProjectRow,
} from '../write/catalog.js';
import { resolveIssuePlacement, tryResolveRef } from './resolve.js';
import { resolveSimilarFilterIds } from './views/semantic.js';
import {
  DEFAULT_QUERY_LIMIT,
  type IIssueQueryInput,
  type ISimilarCluster,
  type ISimilarMember,
  type ISimilarViewClusterBlock,
} from './types.js';

/** Load a project's policy (defaults when the row is missing). */
async function loadProjectUidAndPolicy(
  graph: GraphBackend,
  projectUid: string
): Promise<{ projectUid: string; policy: ReturnType<typeof resolveProjectPolicy> } | undefined> {
  const row = await graph.getNodeByUid(projectUid);
  if (!row || row.tInvalid !== undefined) return undefined;
  const policy = resolveProjectPolicy({
    uid: row.uid,
    rowid: row.id,
    name: row.name ?? '',
    metadata: row.metadata,
  } as IResolvedProjectRow);
  return { projectUid: row.uid, policy };
}

/** Resolve a `similar_to` endpoint set to the compact cluster member shape. */
async function buildMembers(
  graph: GraphBackend,
  uids: readonly string[],
  meta: ReadonlyMap<
    string,
    { score?: number; signals?: string[]; linkedTo?: string }
  >
): Promise<ISimilarMember[]> {
  if (uids.length === 0) return [];
  const members: ISimilarMember[] = [];
  for (const uid of uids) {
    const node = await graph.getNodeByUid(uid);
    if (!node || node.tInvalid !== undefined) continue;
    const { project, component } = await resolveIssuePlacement(graph, node.id);
    const extra = meta.get(uid) ?? {};
    members.push({
      uid: node.uid,
      title: node.name ?? '',
      projectUid: project?.uid ?? '',
      projectName: project?.name ?? '',
      ...(component ? { componentUid: component.uid } : {}),
      ...(project && typeof project.metadata?.repoUrl === 'string'
        ? { repoUrl: project.metadata.repoUrl }
        : {}),
      ...(extra.score !== undefined ? { score: extra.score } : {}),
      ...(extra.signals !== undefined ? { signals: extra.signals } : {}),
      ...(extra.linkedTo !== undefined ? { linkedTo: extra.linkedTo } : {}),
    });
  }
  return members;
}

/** Union-find helper over string uids. */
function groupByComponents(
  edges: ReadonlyArray<{ a: string; b: string }>
): Map<string, string[]> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // path-compress
    let cursor = x;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const add = (x: string): void => {
    if (!parent.has(x)) parent.set(x, x);
  };
  for (const { a, b } of edges) {
    add(a);
    add(b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, string[]>();
  for (const uid of parent.keys()) {
    const root = find(uid);
    const list = groups.get(root);
    if (list) list.push(uid);
    else groups.set(root, [uid]);
  }
  return groups;
}

/**
 * Build the additive `view:'similar'` cluster block, or `undefined` when the
 * query is not scope-filtered. Never writes.
 */
export async function buildSimilarClusterBlock(
  handle: ISimilarityScanHandle,
  input: IIssueQueryInput
): Promise<ISimilarViewClusterBlock | undefined> {
  const { graph } = handle;
  if (!graph) return undefined;
  const filter = input.filter;
  if (
    !filter ||
    (filter.project === undefined && filter.component === undefined)
  ) {
    return undefined;
  }
  const computedAt = new Date().toISOString();
  const limit = input.limit ?? DEFAULT_QUERY_LIMIT;

  const scopedIds = await resolveSimilarFilterIds(graph, filter);
  const scopedUidSet = new Set<string>();
  let scopedNodes: NodeRecord[] = [];
  if (scopedIds && scopedIds.size > 0) {
    scopedNodes = await graph.getNodesByIds([...scopedIds]);
    for (const n of scopedNodes) scopedUidSet.add(n.uid);
  }

  // The scoping project (for the scan's same-project id set + policy).
  let projectUid: string | undefined;
  if (filter.project !== undefined) {
    projectUid = (await tryResolveRef(graph, 'project', filter.project))?.uid;
  } else if (filter.component !== undefined) {
    const component = await tryResolveRef(graph, 'component', filter.component);
    const metaProject = component?.record.metadata?.projectUid;
    if (typeof metaProject === 'string') projectUid = metaProject;
  }
  const loaded =
    projectUid !== undefined
      ? await loadProjectUidAndPolicy(graph, projectUid)
      : undefined;

  // --- candidate clusters (advisory scan; [] without the embedding substrate) ---
  const scanEdges: Array<{ a: string; b: string; score: number; signals?: string[] }> =
    [];
  let scanned = 0;
  if (handle.search) {
    for (const seed of scopedNodes.slice(0, limit)) {
      const candidates = await scanSimilarCandidates(handle, {
        title: seed.name ?? '',
        body: seed.content ?? '',
        scope: 'same-project',
        projectUid,
        sameProjectThreshold: loaded?.policy.dedupeThreshold ?? 0.8,
        crossProjectThreshold:
          loaded?.policy.similarityCrossProjectThreshold ?? 0.92,
        margin: loaded?.policy.similarityCrossProjectMargin ?? 0.05,
        tokenOverlapMin:
          loaded?.policy.similarityCrossProjectTokenOverlap ?? 0.5,
        limit,
        // The seed itself is already in the store (unlike the create-time
        // scan, whose subject is not yet written) — a KNN would return it as
        // its own nearest neighbour, so it is excluded explicitly.
        excludeIds: new Set([seed.id]),
      });
      scanned += 1;
      for (const candidate of candidates) {
        scanEdges.push({
          a: seed.uid,
          b: candidate.uid,
          score: candidate.score,
          ...(candidate.signals !== undefined
            ? { signals: candidate.signals }
            : {}),
        });
      }
    }
  }

  const candidate: ISimilarCluster[] = [];
  if (scanEdges.length > 0) {
    const scoreByUid = new Map<string, number>();
    const signalsByUid = new Map<string, string[]>();
    const linkedToByUid = new Map<string, string>();
    for (const edge of scanEdges) {
      scoreByUid.set(
        edge.a,
        Math.max(scoreByUid.get(edge.a) ?? 0, edge.score)
      );
      scoreByUid.set(
        edge.b,
        Math.max(scoreByUid.get(edge.b) ?? 0, edge.score)
      );
      if (edge.signals !== undefined) signalsByUid.set(edge.b, edge.signals);
      linkedToByUid.set(edge.b, edge.a);
    }
    const groups = groupByComponents(scanEdges);
    for (const uids of groups.values()) {
      if (uids.length < 2) continue;
      // seedUid = the member that anchored the most/highest-scoring links.
      let seedUid = uids[0];
      let best = -1;
      for (const uid of uids) {
        const score = scoreByUid.get(uid) ?? 0;
        if (score > best) {
          best = score;
          seedUid = uid;
        }
      }
      const members = await buildMembers(
        graph,
        [seedUid, ...uids.filter((u) => u !== seedUid)],
        new Map(
          uids.map((uid) => [
            uid,
            {
              score: scoreByUid.get(uid),
              signals: signalsByUid.get(uid),
              linkedTo: linkedToByUid.get(uid),
            },
          ])
        )
      );
      candidate.push({ seedUid, members, linked: false });
    }
  }

  // --- linked clusters (existing live `similar_to` edges only) ---
  const linkedEdges: Array<{ a: string; b: string }> = [];
  for (const edge of await graph.getEdges({ rel: 'similar_to' })) {
    const [src] = await graph.getNodesByIds([edge.src]);
    const [dst] = await graph.getNodesByIds([edge.dst]);
    if (!src || !dst) continue;
    if (scopedUidSet.size > 0) {
      if (!scopedUidSet.has(src.uid) && !scopedUidSet.has(dst.uid)) continue;
    }
    linkedEdges.push({ a: src.uid, b: dst.uid });
  }
  const linked: ISimilarCluster[] = [];
  if (linkedEdges.length > 0) {
    const linkedToByUid = new Map<string, string>();
    for (const edge of linkedEdges) linkedToByUid.set(edge.a, edge.b);
    const groups = groupByComponents(linkedEdges);
    for (const uids of groups.values()) {
      if (uids.length < 2) continue;
      const members = await buildMembers(
        graph,
        uids,
        new Map(
          uids.map((uid) => [uid, { linkedTo: linkedToByUid.get(uid) }])
        )
      );
      linked.push({ seedUid: uids[0], members, linked: true });
    }
  }

  return { candidate, linked, scanned, computedAt };
}
