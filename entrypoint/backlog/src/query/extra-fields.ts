/**
 * extra-fields.ts — the opt-in `get`/`query` pseudo-fields that are assembled
 * AFTER the shared card (`card.ts` is deliberately never touched): the joined
 * evidence model's `primaryOwner` / `memberships` (A-AC5), SUPERSEDED's
 * `supersededBy` / `supersedeReason` (A-AC8) and the spec `specRevisionFragment`
 * (B-AC9).
 *
 * Each is stripped from `fields` BEFORE the card is assembled and merged onto
 * the assembled card afterwards, so a request that names none of them takes the
 * byte-identical pre-existing path. Reads only: nothing here writes.
 */
import type { GraphBackend, NodeRecord } from '@adhd/sox-graph-store';
import {
  assembleIssueCard,
  assembleIssueCards,
} from './card.js';
import { compareMemberships } from '../write/membership.js';
import { readSpecRevisionFragment } from '../write/spec-revision.js';
import type {
  IIssueCard,
  IIssueField,
  IMembershipView,
  IPrimaryOwner,
} from './types.js';
import type { IVerdictRung } from './verdict.js';
import type { IScoreKind } from './types.js';

/** The pseudo-field names this module owns. */
export const EXTRA_ISSUE_FIELDS = [
  'primaryOwner',
  'memberships',
  'supersededBy',
  'supersedeReason',
  'specRevisionFragment',
] as const;
export type IExtraIssueField = (typeof EXTRA_ISSUE_FIELDS)[number];
const EXTRA_SET: ReadonlySet<string> = new Set(EXTRA_ISSUE_FIELDS);

/** Split a requested field list into the card's own fields and this module's extras. */
export function splitExtraFields(fields: readonly IIssueField[]): {
  base: IIssueField[];
  extras: ReadonlySet<IExtraIssueField>;
} {
  const base: IIssueField[] = [];
  const extras = new Set<IExtraIssueField>();
  for (const f of fields) {
    if (EXTRA_SET.has(f)) extras.add(f as IExtraIssueField);
    else base.push(f);
  }
  return { base, extras };
}

async function nodeOf(graph: GraphBackend, id: number): Promise<NodeRecord | undefined> {
  return (await graph.getNodesByIds([id]))[0];
}

/** The project that owns `componentId` (`owns_project`: project → component). */
async function projectOfComponent(
  graph: GraphBackend,
  componentId: number
): Promise<{ uid: string; name: string } | undefined> {
  const edge = (await graph.getEdges({ dst: componentId, rel: 'owns_project' }))[0];
  if (!edge) return undefined;
  const project = await nodeOf(graph, edge.src);
  return project ? { uid: project.uid, name: project.name ?? '' } : undefined;
}

/** The single primary owner of an issue (`owns_component` + `owns_project`). */
export async function readPrimaryOwner(
  graph: GraphBackend,
  issue: NodeRecord
): Promise<IPrimaryOwner | null> {
  const edge = (await graph.getEdges({ dst: issue.id, rel: 'owns_component' }))[0];
  if (!edge) return null;
  const component = await nodeOf(graph, edge.src);
  if (!component) return null;
  const project = await projectOfComponent(graph, component.id);
  return {
    projectUid: project?.uid ?? '',
    projectName: project?.name ?? '',
    componentUid: component.uid,
    componentName: component.name ?? '',
  };
}

/** Every live membership row of an issue, primary first. */
export async function readMembershipViews(
  graph: GraphBackend,
  issue: NodeRecord
): Promise<IMembershipView[]> {
  const edges = await graph.getEdges({ src: issue.id, rel: 'in_component' });
  const out: IMembershipView[] = [];
  for (const e of edges) {
    const component = await nodeOf(graph, e.dst);
    if (!component || component.tInvalid) continue;
    const project = await projectOfComponent(graph, component.id);
    const via = e.metadata?.['via'] === 'citation' ? 'citation' : 'primary';
    const citationUid = e.metadata?.['citationUid'];
    out.push({
      componentUid: component.uid,
      componentName: component.name ?? '',
      projectUid: project?.uid ?? '',
      projectName: project?.name ?? '',
      via,
      ...(typeof citationUid === 'string' ? { citationUid } : {}),
    });
  }
  return out.sort(compareMemberships);
}

/** `supersedes` edge FROM the retired item to its successor → the successor uid, or null. */
export async function readSupersededBy(
  graph: GraphBackend,
  issue: NodeRecord
): Promise<string | null> {
  const edge = (await graph.getEdges({ src: issue.id, rel: 'supersedes' }))[0];
  if (!edge) return null;
  return (await nodeOf(graph, edge.dst))?.uid ?? null;
}

/** The newest `transition` node's `supersede_reason` (the SUPERSEDED transition that recorded one), or null. */
export async function readSupersedeReason(
  graph: GraphBackend,
  issue: NodeRecord
): Promise<string | null> {
  const edges = await graph.getEdges({ src: issue.id, rel: 'has_transition' });
  if (edges.length === 0) return null;
  const nodes = await graph.getNodesByIds(edges.map((e) => e.dst));
  const withReason = nodes
    .filter((n) => typeof n.metadata?.['supersede_reason'] === 'string')
    .sort((a, b) => b.tCreated.localeCompare(a.tCreated) || b.id - a.id);
  const reason = withReason[0]?.metadata?.['supersede_reason'];
  return typeof reason === 'string' ? reason : null;
}

async function mergeExtras(
  graph: GraphBackend,
  issue: NodeRecord,
  card: IIssueCard,
  extras: ReadonlySet<IExtraIssueField>
): Promise<IIssueCard> {
  if (extras.size === 0) return card;
  const out: IIssueCard = { ...card };
  if (extras.has('primaryOwner')) out.primaryOwner = await readPrimaryOwner(graph, issue);
  if (extras.has('memberships')) out.memberships = await readMembershipViews(graph, issue);
  if (extras.has('supersededBy')) out.supersededBy = await readSupersededBy(graph, issue);
  if (extras.has('supersedeReason')) out.supersedeReason = await readSupersedeReason(graph, issue);
  if (extras.has('specRevisionFragment')) {
    out.specRevisionFragment = (await readSpecRevisionFragment(graph, issue.uid)) ?? null;
  }
  return out;
}

/** `assembleIssueCard` + the extras (single-item `get`). */
export async function assembleIssueCardWithExtras(
  graph: GraphBackend,
  issue: NodeRecord,
  fields: readonly IIssueField[],
  opts: Parameters<typeof assembleIssueCard>[3]
): Promise<IIssueCard> {
  const { base, extras } = splitExtraFields(fields);
  const card = await assembleIssueCard(graph, issue, base, opts);
  return mergeExtras(graph, issue, card, extras);
}

/** `assembleIssueCards` + the extras (list `query` paths). */
export async function assembleIssueCardsWithExtras(
  graph: GraphBackend,
  issues: NodeRecord[],
  fields: readonly IIssueField[],
  scoreByUid?: ReadonlyMap<string, number>,
  scoreKindByUid?: ReadonlyMap<string, IScoreKind>,
  verdictOpts?: { rung?: IVerdictRung; onRung?: (rung: number) => void }
): Promise<IIssueCard[]> {
  const { base, extras } = splitExtraFields(fields);
  const cards = await assembleIssueCards(graph, issues, base, scoreByUid, scoreKindByUid, verdictOpts);
  if (extras.size === 0) return cards;
  return Promise.all(cards.map((card, i) => mergeExtras(graph, issues[i]!, card, extras)));
}
