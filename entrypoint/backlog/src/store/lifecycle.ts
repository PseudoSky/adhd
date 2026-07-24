/**
 * lifecycle.ts — startWork/transitionStatus/addCitation/appendNote/
 * resolveItem/archiveResolved (SPEC.md §5.4). `transitionStatus` is the
 * status-vocabulary teeth gate (SPEC.md §7 DoD clause 6): a transition INTO
 * any terminal-done/terminal-workaround status with zero citations, or any
 * terminal-dismissed status with no reason, THROWS.
 */
import type { ArchiveOpts, BacklogItem, BacklogStatus, Citation, StatsScope, TransitionOpts } from '../model.js';
import { BacklogItemNotFoundError, CitationRequiredError, ClaimHeldError, ReasonRequiredError, isTerminalStatus, requiresCitation, requiresReason, TERMINAL_STATUSES } from '../model.js';
import type { GraphBacklogStore } from './graph-backlog-store.js';
import { claimItemNode } from './claim.js';
import { findItemNode, listItems } from './query.js';
import { mutateMetadata } from './mutate-metadata.js';
import { toBacklogItem, type BacklogNodeMeta } from './mapping.js';
import { writeAuditEvent } from './audit-log.js';

function requireItemNode(store: GraphBacklogStore, repo: string, humanId: string) {
  const node = findItemNode(store, repo, humanId);
  if (!node) throw new BacklogItemNotFoundError(repo, humanId);
  return node;
}

export function transitionStatusNode(store: GraphBacklogStore, repo: string, humanId: string, status: BacklogStatus, opts: TransitionOpts): BacklogItem {
  const node = requireItemNode(store, repo, humanId);
  let fromStatus: BacklogStatus | undefined;

  mutateMetadata<BacklogNodeMeta>(store, node.id, (meta) => {
    fromStatus = meta.status;
    const citations = opts.citations && opts.citations.length > 0 ? [...meta.citations, ...opts.citations] : meta.citations;

    if (requiresCitation(status) && citations.length === 0) {
      throw new CitationRequiredError(status);
    }
    if (requiresReason(status) && !opts.reason) {
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
  writeAuditEvent(store, node.id, repo, humanId, 'transition', { from: fromStatus, to: status, by: opts.by, ...(opts.reason ? { reason: opts.reason } : {}) });

  const updated = store.graph.getNode(node.id);
  if (!updated) throw new BacklogItemNotFoundError(repo, humanId);
  return toBacklogItem(updated);
}

/** Sugar for transitionStatus into any terminal status (SPEC.md §5.4). */
export function resolveItemNode(store: GraphBacklogStore, repo: string, humanId: string, status: BacklogStatus, opts: TransitionOpts): BacklogItem {
  return transitionStatusNode(store, repo, humanId, status, opts);
}

/**
 * `transitionStatus(id, 'IN_PROGRESS', ...)` + an implicit `claimItem(id, by)`.
 * If the item is actively claimed (not stale) by someone else, the claim
 * step returns `held` and startWork refuses — starting work on a
 * contended item would silently override the claim protocol otherwise.
 */
export function startWorkNode(store: GraphBacklogStore, repo: string, humanId: string, by: string): BacklogItem {
  const node = requireItemNode(store, repo, humanId);
  const claim = claimItemNode(store, node.id, by);
  if (claim.status === 'held') {
    throw new ClaimHeldError(claim.heldBy ?? 'unknown', claim.heldSince ?? 'unknown');
  }
  return transitionStatusNode(store, repo, humanId, 'IN_PROGRESS', { by });
}

export function addCitationNode(store: GraphBacklogStore, repo: string, humanId: string, citation: Citation): BacklogItem {
  const node = requireItemNode(store, repo, humanId);
  mutateMetadata<BacklogNodeMeta>(store, node.id, (meta) => ({
    ...meta,
    citations: [...meta.citations, citation],
    updatedAt: new Date().toISOString(),
  }));
  const updated = store.graph.getNode(node.id);
  if (!updated) throw new BacklogItemNotFoundError(repo, humanId);
  return toBacklogItem(updated);
}

export function appendNoteNode(store: GraphBacklogStore, repo: string, humanId: string, by: string, text: string): BacklogItem {
  const node = requireItemNode(store, repo, humanId);
  mutateMetadata<BacklogNodeMeta>(store, node.id, (meta) => {
    const nowIso = new Date().toISOString();
    return { ...meta, notes: [...meta.notes, { by, at: nowIso, text }], updatedAt: nowIso };
  });
  const updated = store.graph.getNode(node.id);
  if (!updated) throw new BacklogItemNotFoundError(repo, humanId);
  return toBacklogItem(updated);
}

/**
 * Marks every terminal, non-excluded item in scope as archived
 * (`metadata.archivedAt`) and returns them — the graph node itself is NEVER
 * deleted (bi-temporal history is permanent). Rendering the archived set to
 * CHANGELOG.md-formatted markdown is `client.ts`'s job (via `markdown.ts`) —
 * store/* never depends on markdown.ts (DESIGN.md §1 layering).
 */
export function archiveTerminalItems(store: GraphBacklogStore, scope: StatsScope, opts: ArchiveOpts = {}): BacklogItem[] {
  const exclude = new Set((opts.exclude ?? []).map((id) => id.toUpperCase()));
  const items = listItems(store, { repo: scope.repo, projectPath: scope.projectPath, status: 'closed' });
  const archived: BacklogItem[] = [];
  for (const item of items) {
    if (exclude.has(item.humanId.toUpperCase())) continue;
    if (!isTerminalStatus(item.status)) continue;
    const nowIso = new Date().toISOString();
    mutateMetadata<BacklogNodeMeta>(store, item.nodeId, (meta) => ({ ...meta, archivedAt: nowIso, updatedAt: nowIso }));
    const updated = store.graph.getNode(item.nodeId);
    if (updated) archived.push(toBacklogItem(updated));
  }
  return archived;
}
