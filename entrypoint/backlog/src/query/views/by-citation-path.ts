/**
 * views/by-citation-path.ts — `query {projection:"byCitationPath", path:P}`
 * (ADR-0007 D7 row B2; backlog 7e5469d3; B-AC10): every live item that cites
 * path P, with no per-issue walk by the caller.
 *
 * ## Matching
 *
 * A citation's identity key is its target resolved to an absolute path: an
 * absolute target as-is; a relative target against its OWNING project's root;
 * a relative target of a path-less project keys as `rel:<normalized>`. P's keys
 * are computed the same way (absolute P -> itself; relative P -> one key per
 * live project root, plus the `rel:` key). A citation matches iff its key is one
 * of P's keys — EXACT path equality, never a prefix or substring (`/a/b` does
 * not match `/a/bc`).
 *
 * ## Cost
 *
 * Citation nodes are fetched with an equality filter on `meta.target` over the
 * candidate spellings of P (as given, absolute, and per-project relative), not by
 * walking every issue; a post-filter on the resolved key removes cross-project
 * relative-spelling collisions. A removed (retired) citation, a citation whose
 * `has_citation` edge was invalidated, and a superseded/invalid issue never
 * appear.
 */
import { isAbsolute, join, normalize, relative, resolve as resolvePath } from 'node:path';
import type { GraphBackend, NodeRecord } from '@adhd/sox-graph-store';
import { BacklogValidationError } from '../../write/errors.js';
import { citationFromNode } from '../../citation.js';
import type { IIssueQueryInput } from '../types.js';

export const DEFAULT_BY_CITATION_PATH_LIMIT = 50;
export const MAX_BY_CITATION_PATH_LIMIT = 1000;

export interface IByCitationPathItem {
  uid: string;
  title: string;
  status: string;
  citationUid: string;
  line?: string;
  verification: string;
}

export interface IByCitationPathResult {
  projection: 'byCitationPath';
  path: string;
  items: IByCitationPathItem[];
  total: number;
  hasMore: boolean;
  limit: number;
}

function strMeta(n: NodeRecord, key: string): string | undefined {
  const v = n.metadata?.[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** The identity key of one citation target within a project whose root is `root` (or `undefined`). */
export function citationKey(target: string, root: string | undefined): string {
  if (isAbsolute(target)) return resolvePath(target);
  if (root !== undefined) return resolvePath(root, target);
  return `rel:${normalize(target)}`;
}

export async function queryByCitationPath(
  graph: GraphBackend,
  input: IIssueQueryInput
): Promise<IByCitationPathResult> {
  const raw = input.path;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new BacklogValidationError('path', 'is required for projection "byCitationPath"');
  }
  const path = raw.trim();
  const limit = input.limit ?? DEFAULT_BY_CITATION_PATH_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_BY_CITATION_PATH_LIMIT) {
    throw new BacklogValidationError('limit', `must be a positive integer <= ${MAX_BY_CITATION_PATH_LIMIT}, got ${limit}`);
  }

  const projects = await graph.queryNodes({ kind: 'project', liveOnly: true });
  const roots = projects.map((p) => strMeta(p, 'path')).filter((r): r is string => r !== undefined);

  // P's keys + the candidate stored spellings to fetch.
  const keys = new Set<string>();
  const spellings = new Set<string>([path]);
  if (isAbsolute(path)) {
    const abs = resolvePath(path);
    keys.add(abs);
    spellings.add(abs);
    for (const root of roots) {
      const rel = relative(root, abs);
      if (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)) spellings.add(rel);
    }
  } else {
    keys.add(`rel:${normalize(path)}`);
    spellings.add(normalize(path));
    for (const root of roots) {
      keys.add(resolvePath(root, path));
      spellings.add(join(root, path));
    }
  }

  const citationNodes = new Map<number, NodeRecord>();
  for (const spelling of spellings) {
    const found = await graph.queryNodes({
      kind: 'citation',
      liveOnly: true,
      metadata: { target: { eq: spelling } },
    });
    for (const n of found) citationNodes.set(n.id, n);
  }
  if (citationNodes.size === 0) {
    return { projection: 'byCitationPath', path, items: [], total: 0, hasMore: false, limit };
  }

  const owners = await graph.getEdges({ rel: 'has_citation' });
  const issueOfCitation = new Map<number, number>();
  for (const e of owners) if (citationNodes.has(e.dst)) issueOfCitation.set(e.dst, e.src);
  const issues = new Map(
    (await graph.getNodesByIds([...new Set(issueOfCitation.values())])).map((n) => [n.id, n])
  );

  const rows: Array<{ issue: NodeRecord; citation: NodeRecord }> = [];
  for (const [citationId, issueId] of issueOfCitation) {
    const issue = issues.get(issueId);
    const citation = citationNodes.get(citationId);
    if (!issue || !citation || issue.kind !== 'issue' || issue.tInvalid) continue;
    if (issue.isSuperseded) continue;
    const target = strMeta(citation, 'target');
    if (target === undefined) continue;
    const targetType = strMeta(citation, 'target_type');
    if (targetType !== undefined && targetType !== 'path') continue;
    const root = await projectRootOfIssue(graph, issue);
    if (!keys.has(citationKey(target, root))) continue;
    rows.push({ issue, citation });
  }
  rows.sort((a, b) => a.issue.uid.localeCompare(b.issue.uid) || a.citation.uid.localeCompare(b.citation.uid));

  const page = rows.slice(0, limit);
  const items: IByCitationPathItem[] = [];
  for (const { issue, citation } of page) {
    const record = citationFromNode({
      uid: citation.uid,
      name: citation.name,
      content: citation.content ?? '',
      metadata: citation.metadata,
      tCreated: citation.tCreated,
    });
    items.push({
      uid: issue.uid,
      title: issue.name ?? '',
      status: await statusNameOf(graph, issue),
      citationUid: citation.uid,
      ...(record.lines !== undefined ? { line: record.lines } : {}),
      verification: record.verification ?? 'unverified-with-reason',
    });
  }
  return { projection: 'byCitationPath', path, items, total: rows.length, hasMore: rows.length > limit, limit };
}

async function projectRootOfIssue(graph: GraphBackend, issue: NodeRecord): Promise<string | undefined> {
  const owns = (await graph.getEdges({ dst: issue.id, rel: 'owns_component' }))[0];
  if (!owns) return undefined;
  const project = (await graph.getEdges({ dst: owns.src, rel: 'owns_project' }))[0];
  if (!project) return undefined;
  const node = (await graph.getNodesByIds([project.src]))[0];
  return node ? strMeta(node, 'path') : undefined;
}

async function statusNameOf(graph: GraphBackend, issue: NodeRecord): Promise<string> {
  const edge = (await graph.getEdges({ src: issue.id, rel: 'has_status' }))[0];
  if (!edge) return '';
  return (await graph.getNodesByIds([edge.dst]))[0]?.name ?? '';
}
