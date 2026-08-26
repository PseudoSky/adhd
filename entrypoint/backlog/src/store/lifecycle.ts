/**
 * lifecycle.ts — startWork/transitionStatus/addCitation/appendNote/
 * resolveItem/archiveResolved (SPEC.md §5.4). `transitionStatus` is the
 * status-vocabulary teeth gate (SPEC.md §7 DoD clause 6): a transition INTO
 * any terminal-done/terminal-workaround status with zero citations, or any
 * terminal-dismissed status with no reason, THROWS.
 */
import type { ArchiveOpts, BacklogItem, BacklogStatus, Citation, StatsScope, TransitionOpts } from '../model.js';
import {
  CitationRequiredError,
  ClaimHeldError,
  InvalidArgumentError,
  ReasonRequiredError,
  isTerminalStatus,
  requiresCitation,
  requiresReason,
  TERMINAL_STATUSES,
} from '../model.js';
import type { GraphBacklogStore } from './graph-backlog-store.js';
import { claimItemNode } from './claim.js';
import { buildNotFoundError, findItemNode, listItems } from './query.js';
import { mutateMetadata } from './mutate-metadata.js';
import { toBacklogItem, type BacklogNodeMeta } from './mapping.js';
import { writeAuditEvent } from './audit-log.js';
import { enrichCitationsBlastRadius } from './enrichment.js';
import { dispatchBacklogHook } from './hooks.js';

async function requireItemNode(store: GraphBacklogStore, repo: string, humanId: string) {
  const node = await findItemNode(store, repo, humanId);
  if (!node) throw await buildNotFoundError(store, repo, humanId);
  return node;
}

/**
 * `Citation.file` is required at the TypeScript/JSON-Schema level
 * (BUG-APIGEN-CORE-CLIENT-001 makes that presence check reach the extracted
 * schema), but presence alone still accepts `""`/whitespace — a citation
 * with no actual file is not evidence. Every write path that accepts a
 * caller-supplied `Citation` (inline on `transitionStatus`/`resolveItem`, and
 * standalone `addCitation`) runs every entry through this before it is
 * persisted. Also reused by `crud.ts`'s `createItemNode` and
 * `structure.ts`'s `supersedeItemNode` for citations supplied inline on
 * `CreateItemInput` (BUG-BACKLOG-CREATE-ITEM-DROPS-CITATIONS-001) — one
 * validation rule, every write path.
 */
export function assertValidCitation(citation: Citation): void {
  if (typeof citation.file !== 'string' || citation.file.trim().length === 0) {
    throw new InvalidArgumentError(
      'citation.file',
      `backlog: a citation requires a non-empty "file" — received file=${JSON.stringify(citation.file)}.`
    );
  }
}

export async function transitionStatusNode(store: GraphBacklogStore, repo: string, humanId: string, status: BacklogStatus, opts: TransitionOpts): Promise<BacklogItem> {
  // Validated up front, BEFORE the mutateMetadata transaction opens — a
  // malformed inline citation must never partially write (mirrors the
  // "a rejected transition is not a partial write" guarantee already proven
  // for the citation/reason presence gate below).
  if (opts.citations) {
    for (const citation of opts.citations) assertValidCitation(citation);
  }
  const node = await requireItemNode(store, repo, humanId);
  let fromStatus: BacklogStatus | undefined;

  // FEAT-BACKLOG-006 — best-effort blast-radius enrichment, BEFORE the
  // metadata transaction opens (`mutateMetadata`'s updater is synchronous —
  // see mutate-metadata.ts — so async I/O cannot live inside it). Bounded by
  // `enrichCitationBlastRadius`'s own timeout; a slow/missing/unindexed
  // gitnexus degrades the citation to un-enriched, it never blocks or fails
  // this transition.
  const enrichedCitations = opts.citations && opts.citations.length > 0 ? await enrichCitationsBlastRadius(opts.citations, repo) : opts.citations;

  await mutateMetadata<BacklogNodeMeta>(store, node.id, (meta) => {
    fromStatus = meta.status;
    const citations = enrichedCitations && enrichedCitations.length > 0 ? [...meta.citations, ...enrichedCitations] : meta.citations;

    if (requiresCitation(status) && citations.length === 0) {
      throw new CitationRequiredError(status);
    }
    // `!opts.reason` alone accepts a whitespace-only string (`"   "` is
    // truthy in JS) — a reason that carries no actual content is not
    // evidence, so this checks for trimmed non-emptiness, not mere presence.
    if (requiresReason(status) && (!opts.reason || opts.reason.trim().length === 0)) {
      throw new ReasonRequiredError(status);
    }

    const nowIso = new Date().toISOString();
    const notes = [...meta.notes];
    if (opts.note) notes.push({ by: opts.by, at: nowIso, text: opts.note });
    if (opts.reason) notes.push({ by: opts.by, at: nowIso, text: `[transition to ${status}] ${opts.reason}` });

    const next: BacklogNodeMeta = { ...meta, status, citations, notes, updatedAt: nowIso };
    // §4.2 rule 4 — claimedBy/claimedAt are cleared on ANY terminal transition.
    if (TERMINAL_STATUSES.has(status)) {
      delete next.claimedBy;
      delete next.claimedAt;
    }
    return next;
  });
  // Only reached once mutateMetadata's updater returns WITHOUT throwing — a
  // rejected transition (missing citation/reason) never logs a fake event
  // (DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001).
  await writeAuditEvent(store, node.id, repo, humanId, 'transition', { from: fromStatus, to: status, by: opts.by, ...(opts.reason ? { reason: opts.reason } : {}) });

  const updated = await store.graph.getNode(node.id);
  if (!updated) throw await buildNotFoundError(store, repo, humanId);
  const item = toBacklogItem(updated);
  // FEAT-BACKLOG-001 — fired only after the audit event above, so a hook
  // observer never sees the transition before the audit trail does.
  dispatchBacklogHook(store, { type: 'itemTransitioned', item, from: fromStatus, to: status, by: opts.by });
  return item;
}

/** Sugar for transitionStatus into any terminal status (SPEC.md §5.4). */
export async function resolveItemNode(store: GraphBacklogStore, repo: string, humanId: string, status: BacklogStatus, opts: TransitionOpts): Promise<BacklogItem> {
  const item = await transitionStatusNode(store, repo, humanId, status, opts);
  // FEAT-BACKLOG-001 — a SECOND, more specific event on top of the
  // `itemTransitioned` `transitionStatusNode` already fired: a hook that
  // only cares about "this item just closed" (e.g. a notifier) can listen
  // for `itemResolved` alone instead of re-deriving terminality from every
  // `itemTransitioned` event's `to` status.
  dispatchBacklogHook(store, { type: 'itemResolved', item, by: opts.by });
  return item;
}

/**
 * `transitionStatus(id, 'IN_PROGRESS', ...)` + an implicit `claimItem(id, by)`.
 * If the item is actively claimed (not stale) by someone else, the claim
 * step returns `held` and startWork refuses — starting work on a
 * contended item would silently override the claim protocol otherwise.
 */
export async function startWorkNode(store: GraphBacklogStore, repo: string, humanId: string, by: string): Promise<BacklogItem> {
  const node = await requireItemNode(store, repo, humanId);
  const claim = await claimItemNode(store, node.id, by);
  if (claim.status === 'held') {
    throw new ClaimHeldError(claim.heldBy ?? 'unknown', claim.heldSince ?? 'unknown');
  }
  return transitionStatusNode(store, repo, humanId, 'IN_PROGRESS', { by });
}

export async function addCitationNode(store: GraphBacklogStore, repo: string, humanId: string, citation: Citation): Promise<BacklogItem> {
  assertValidCitation(citation);
  const node = await requireItemNode(store, repo, humanId);
  // FEAT-BACKLOG-006 — see transitionStatusNode's identical enrichment step
  // for why this runs BEFORE mutateMetadata's synchronous updater.
  const [enrichedCitation] = await enrichCitationsBlastRadius([citation], repo);
  await mutateMetadata<BacklogNodeMeta>(store, node.id, (meta) => ({
    ...meta,
    citations: [...meta.citations, enrichedCitation ?? citation],
    updatedAt: new Date().toISOString(),
  }));
  const updated = await store.graph.getNode(node.id);
  if (!updated) throw await buildNotFoundError(store, repo, humanId);
  const item = toBacklogItem(updated);
  dispatchBacklogHook(store, { type: 'itemUpdated', item });
  return item;
}

export async function appendNoteNode(store: GraphBacklogStore, repo: string, humanId: string, by: string, text: string): Promise<BacklogItem> {
  const node = await requireItemNode(store, repo, humanId);
  await mutateMetadata<BacklogNodeMeta>(store, node.id, (meta) => {
    const nowIso = new Date().toISOString();
    return { ...meta, notes: [...meta.notes, { by, at: nowIso, text }], updatedAt: nowIso };
  });
  const updated = await store.graph.getNode(node.id);
  if (!updated) throw await buildNotFoundError(store, repo, humanId);
  return toBacklogItem(updated);
}

/**
 * Marks every terminal, non-excluded item in scope as archived
 * (`metadata.archivedAt`) and returns them — the graph node itself is NEVER
 * deleted (bi-temporal history is permanent). Rendering the archived set to
 * CHANGELOG.md-formatted markdown is `client.ts`'s job (via `markdown.ts`) —
 * store/* never depends on markdown.ts (DESIGN.md §1 layering).
 */
export async function archiveTerminalItems(store: GraphBacklogStore, scope: StatsScope, opts: ArchiveOpts = {}): Promise<BacklogItem[]> {
  const exclude = new Set((opts.exclude ?? []).map((id) => id.toUpperCase()));
  const items = await listItems(store, { repo: scope.repo, projectPath: scope.projectPath, status: 'closed' });
  const archived: BacklogItem[] = [];
  for (const item of items) {
    if (exclude.has(item.humanId.toUpperCase())) continue;
    if (!isTerminalStatus(item.status)) continue;
    const nowIso = new Date().toISOString();
    await mutateMetadata<BacklogNodeMeta>(store, item.nodeId, (meta) => ({ ...meta, archivedAt: nowIso, updatedAt: nowIso }));
    const updated = await store.graph.getNode(item.nodeId);
    if (updated) archived.push(toBacklogItem(updated));
  }
  return archived;
}
