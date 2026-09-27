/**
 * similarity-scan.ts — the ONE advisory similarity scan shared by the
 * create-time gate (`write/create-issue.ts`) and the `view:'similar'` cluster
 * block (`query/similar-clusters.ts`). Extracted from `create-issue.ts`'s
 * former `scanForDuplicates` so both callers run the IDENTICAL scan (C9
 * `similarity-scan.ts` row; DESIGN Primitive 1).
 *
 * **Advisory only — the scan NEVER writes.** It reads the live `similar_to`
 * relation for nothing and writes no edge of any kind; a reviewed link is the
 * `relate` verb with `rel:'similar_to'` (AC3/AC4). It also never touches the
 * reserved `duplicate_of` relation.
 *
 * **The score is a cosine, and only ever a cosine.** Exactly as the shipped
 * create gate documented: the scan calls `search.backend.search` (NOT
 * `searchRanked`, whose RRF discards magnitude) and reads the raw `vecScore`
 * straight off `vec.knn`. BM25 is deliberately never substituted.
 *
 * **Scope-aware.** `same-project` (the default) reproduces today's create-time
 * behaviour byte-for-byte (AC1). `multi-project` widens the candidate id set to
 * sibling projects reachable via a shared `repoUrl` or a shared
 * `component.meta.path`; `store-wide` drops the id restriction entirely. The
 * WRITE path is unaffected by scope — widening only changes which existing
 * items may be surfaced.
 *
 * **Cross-project needs a second signal (AC7) and a distinct threshold (AC8).**
 * A cross-project candidate is surfaced iff `vecScore >= crossProjectThreshold`
 * AND (`titleTokenOverlap >= tokenOverlapMin` OR `sharedStructuralSignal`) AND
 * the top-vs-next margin holds. Same-project candidates keep the cosine-only
 * rule, so AC1 cannot regress.
 */

import type { GraphBackend, NodeRecord } from '@adhd/sox-graph-store';
import type {
  SearchQuery,
  SignalSpec,
  StoreSearchBackend,
} from '@adhd/sox-hybrid-search';
import { resolveIssuePlacement, tryResolveRef } from '../query/resolve.js';
import {
  sharedStructuralSignal,
  titleTokenOverlap,
} from '../query/similarity-signals.js';
import { resolveSimilarFilterIds } from '../query/views/semantic.js';
import type { IIssueFilter } from '../query/types.js';
import { composeEmbedText } from './embedding-observer.js';

/** The search/graph substrate the scan needs — structurally compatible with the create gate's `IDuplicateScanHandle`. */
export interface ISimilarityScanHandle {
  readonly graph?: GraphBackend;
  readonly search?: {
    readonly backend: StoreSearchBackend;
    embedQuery?(text: string): Promise<Float32Array>;
  };
}

/** Why the scan could not produce a calibrated comparison — never a generic "unavailable". */
export type SimilarityScanDegradedReason =
  | 'no-search-backend'
  | 'no-embed-query'
  | 'no-vector-scores';

/** One advisory similarity candidate, with the provenance a reviewer needs to judge it across projects. */
export interface ISimilarCandidate {
  uid: string;
  title: string;
  /** Cosine similarity in `[0,1]`, straight off the vector channel. */
  score: number;
  scope: 'same-project' | 'cross-project';
  provenance?: {
    projectUid: string;
    projectName: string;
    componentUid?: string;
    repoUrl?: string;
  };
  /** Which independent signals fired, e.g. `['cosine','title-tokens']`. */
  signals?: string[];
}

export interface ISimilarityScanInput {
  title: string;
  body: string;
  scope: 'same-project' | 'multi-project' | 'store-wide';
  /** Required for `same-project`/`multi-project`: the filing project. */
  projectUid?: string;
  sameProjectThreshold: number;
  crossProjectThreshold: number;
  margin: number;
  tokenOverlapMin: number;
  limit?: number;
  /**
   * The filing item's own citation tokens / component path — the "A" side of
   * the structural signal. Optional: absent means the structural signal can
   * only ever fire on the candidate's side, which is the correct default for a
   * caller with no new-item context (the view cluster scan).
   */
  citationTokens?: readonly string[];
  componentPath?: string;
  /** Ids the scan must EXCLUDE (the declared `dedupeExcludeUid` parent + its `part_of` ancestor chain). */
  excludeIds?: ReadonlySet<number>;
}

/** The richer outcome {@link scanSimilarCandidatesWithMeta} returns; {@link scanSimilarCandidates} is its candidates-only projection. */
export interface ISimilarityScanOutcome {
  candidates: ISimilarCandidate[];
  degraded: boolean;
  degradedReason?: SimilarityScanDegradedReason;
}

const DEFAULT_SCAN_LIMIT = 5;

/**
 * Resolve the `same-project` candidate id set — today's path
 * (`resolveSimilarFilterIds({project})`), reused rather than re-traversed.
 */
async function resolveSameProjectIds(
  graph: GraphBackend,
  projectUid: string | undefined
): Promise<Set<number> | undefined> {
  if (projectUid === undefined) return undefined;
  const filter: IIssueFilter = { project: projectUid };
  return resolveSimilarFilterIds(graph, filter);
}

/**
 * `multi-project`: the union of the filing project and every sibling reachable
 * via a shared non-empty `repoUrl` or a shared `component.meta.path`. When no
 * sibling is found the scope degrades to the store-wide id set (`undefined`) —
 * a permissive, advisory read, never a silent match-nothing.
 */
async function resolveMultiProjectIds(
  graph: GraphBackend,
  projectUid: string | undefined
): Promise<Set<number> | undefined> {
  if (projectUid === undefined) return undefined;
  const filing = await tryResolveRef(graph, 'project', projectUid);
  if (!filing) return undefined;

  const filingRepoUrl =
    typeof filing.record.metadata?.repoUrl === 'string' &&
    filing.record.metadata.repoUrl.length > 0
      ? filing.record.metadata.repoUrl
      : undefined;
  const filingPaths = new Set<string>();
  for (const edge of await graph.getEdges({
    src: filing.id,
    rel: 'owns_project',
  })) {
    const [component] = await graph.getNodesByIds([edge.dst]);
    const path = component?.metadata?.path;
    if (typeof path === 'string' && path.length > 0) filingPaths.add(path);
  }

  const siblingUids: string[] = [];
  const projects = await graph.queryNodes({ kind: 'project', liveOnly: true });
  for (const project of projects) {
    if (project.uid === filing.uid) continue;
    const projectRepoUrl = project.metadata?.repoUrl;
    if (
      filingRepoUrl !== undefined &&
      typeof projectRepoUrl === 'string' &&
      projectRepoUrl === filingRepoUrl
    ) {
      siblingUids.push(project.uid);
      continue;
    }
    if (filingPaths.size === 0) continue;
    for (const edge of await graph.getEdges({
      src: project.id,
      rel: 'owns_project',
    })) {
      const [component] = await graph.getNodesByIds([edge.dst]);
      const path = component?.metadata?.path;
      if (
        typeof path === 'string' &&
        path.length > 0 &&
        filingPaths.has(path)
      ) {
        siblingUids.push(project.uid);
        break;
      }
    }
  }
  if (siblingUids.length === 0) return undefined; // store-wide fallback

  const union = new Set<number>();
  for (const uid of [filing.uid, ...siblingUids]) {
    const ids = await resolveSimilarFilterIds(graph, { project: uid });
    if (ids) for (const id of ids) union.add(id);
  }
  return union;
}

/** The candidate id set for `scope`; `undefined` means "no id restriction" (store-wide). */
async function resolveCandidateIds(
  graph: GraphBackend,
  scope: ISimilarityScanInput['scope'],
  projectUid: string | undefined
): Promise<Set<number> | undefined> {
  if (scope === 'store-wide') return undefined;
  if (scope === 'multi-project') return resolveMultiProjectIds(graph, projectUid);
  return resolveSameProjectIds(graph, projectUid);
}

/**
 * Citation-derived structural tokens + owning component path for one issue.
 *
 * Exported so BOTH scan callers can supply the A-side of the AC7 structural
 * signal from a real stored item: the `view:'similar'` cluster block derives
 * its seed's context with this directly (the seed is already written), while
 * the create-time gate derives the not-yet-written filing item's context from
 * its input in `write/create-issue.ts`.
 */
export async function structuralContextFor(
  graph: GraphBackend,
  issueId: number
): Promise<{ citationTokens: string[]; componentPath?: string }> {
  const citationTokens: string[] = [];
  const citationEdges = await graph.getEdges({
    src: issueId,
    rel: 'has_citation',
  });
  if (citationEdges.length > 0) {
    const citationNodes = await graph.getNodesByIds(
      citationEdges.map((e) => e.dst)
    );
    for (const node of citationNodes) {
      for (const key of ['target', 'symbol', 'errorText', 'blastRadius']) {
        const value = node.metadata?.[key];
        if (typeof value === 'string') citationTokens.push(value);
      }
    }
  }
  const { component } = await resolveIssuePlacement(graph, issueId);
  const componentPath =
    typeof component?.metadata?.path === 'string'
      ? component.metadata.path
      : undefined;
  return { citationTokens, componentPath };
}

function provenanceFor(
  project: NodeRecord | undefined,
  component: NodeRecord | undefined
): ISimilarCandidate['provenance'] {
  if (!project) return undefined;
  return {
    projectUid: project.uid,
    projectName: project.name ?? '',
    ...(component ? { componentUid: component.uid } : {}),
    ...(typeof project.metadata?.repoUrl === 'string'
      ? { repoUrl: project.metadata.repoUrl }
      : {}),
  };
}

/**
 * The scan, with its degraded-mode metadata. Returns `{candidates:[], degraded:false}`
 * when the scope is a COMPLETE scan of nothing (the scope resolves to an empty
 * candidate set, or every candidate was excluded); returns a degraded outcome
 * when there ARE rows to compare against but the calibrated (vector) channel
 * could not answer — the distinction the create gate's `abort` fails closed on.
 */
export async function scanSimilarCandidatesWithMeta(
  handle: ISimilarityScanHandle,
  input: ISimilarityScanInput
): Promise<ISimilarityScanOutcome> {
  const { search, graph } = handle;
  if (!graph) {
    return {
      candidates: [],
      degraded: true,
      degradedReason: 'no-search-backend',
    };
  }

  const candidateIds = await resolveCandidateIds(
    graph,
    input.scope,
    input.projectUid
  );
  if (candidateIds?.size === 0) {
    return { candidates: [], degraded: false };
  }
  if (candidateIds && input.excludeIds) {
    for (const id of input.excludeIds) candidateIds.delete(id);
    if (candidateIds.size === 0) return { candidates: [], degraded: false };
  }

  if (!search) {
    return {
      candidates: [],
      degraded: true,
      degradedReason: 'no-search-backend',
    };
  }
  if (typeof search.embedQuery !== 'function') {
    return {
      candidates: [],
      degraded: true,
      degradedReason: 'no-embed-query',
    };
  }

  const text = composeEmbedText(input.title, input.body);
  const vec = await search.embedQuery(text);
  const signals: SignalSpec[] = [{ kind: 'text' }, { kind: 'vec' }];
  const query: SearchQuery = {
    text,
    vec,
    signals,
    filters: candidateIds ? { ids: [...candidateIds] } : { kind: 'issue' },
  };

  const scanLimit = input.limit ?? DEFAULT_SCAN_LIMIT;
  const fetchLimit = scanLimit * 4;
  const results = await search.backend.search(query, fetchLimit);
  if (results.length === 0) {
    return {
      candidates: [],
      degraded: true,
      degradedReason: 'no-vector-scores',
    };
  }

  const nodes = await graph.getNodesByIds(results.map((r) => r.id));
  const byId = new Map(nodes.map((n) => [n.id, n] as const));

  const scored: Array<{ node: NodeRecord; score: number }> = [];
  let sawVecScore = false;
  for (const result of results) {
    const node = byId.get(result.id);
    if (!node) continue;
    if (node.tInvalid !== undefined || node.isSuperseded) continue;
    if (input.excludeIds?.has(result.id)) continue;
    if (candidateIds && !candidateIds.has(result.id)) continue;
    const score = result.vecScore;
    if (score === undefined) continue;
    sawVecScore = true;
    scored.push({ node, score });
  }
  if (!sawVecScore) {
    return {
      candidates: [],
      degraded: true,
      degradedReason: 'no-vector-scores',
    };
  }
  scored.sort((a, b) => b.score - a.score);

  const candidates: ISimilarCandidate[] = [];
  for (let i = 0; i < scored.length; i += 1) {
    const { node, score } = scored[i];
    const placement = await resolveIssuePlacement(graph, node.id);
    const owningProjectUid = placement.project?.uid;
    const isSameProject =
      input.projectUid !== undefined && owningProjectUid === input.projectUid;
    const provenance = provenanceFor(placement.project, placement.component);

    if (isSameProject) {
      if (score < input.sameProjectThreshold) continue;
      candidates.push({
        uid: node.uid,
        title: node.name ?? '',
        score,
        scope: 'same-project',
        provenance,
      });
      continue;
    }

    if (score < input.crossProjectThreshold) continue;
    const candidateContext = await structuralContextFor(graph, node.id);
    const overlap = titleTokenOverlap(input.title, node.name ?? '');
    const structural = sharedStructuralSignal(
      {
        title: input.title,
        citationTokens: input.citationTokens,
        componentPath: input.componentPath,
      },
      {
        title: node.name ?? '',
        citationTokens: candidateContext.citationTokens,
        componentPath: candidateContext.componentPath,
      }
    );
    // AC7 — cosine alone is never sufficient cross-project.
    if (!(overlap >= input.tokenOverlapMin || structural)) continue;
    // Margin guard: a candidate not meaningfully more similar than the
    // runner-up is ambiguous, and ambiguity must not be surfaced as signal.
    const next = scored[i + 1];
    if (next && score - next.score < input.margin) continue;
    const fired = ['cosine'];
    if (overlap >= input.tokenOverlapMin) fired.push('title-tokens');
    if (structural) fired.push('structural');
    candidates.push({
      uid: node.uid,
      title: node.name ?? '',
      score,
      scope: 'cross-project',
      provenance,
      signals: fired,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return { candidates: candidates.slice(0, scanLimit), degraded: false };
}

/**
 * The candidates-only projection of {@link scanSimilarCandidatesWithMeta}
 * (the C9 spec's stated signature): best-first, advisory, never writes, and
 * `[]` when the embedding substrate is absent.
 */
export async function scanSimilarCandidates(
  handle: ISimilarityScanHandle,
  input: ISimilarityScanInput
): Promise<ISimilarCandidate[]> {
  return (await scanSimilarCandidatesWithMeta(handle, input)).candidates;
}
