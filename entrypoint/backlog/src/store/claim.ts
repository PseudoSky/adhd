/**
 * claim.ts — claimItem/renewClaim/releaseClaim (DESIGN.md §4). Mirrors the
 * plan-state-machine skill's plan-level claim/renew/release lease exactly
 * (state-transition.js:566-680), generalized to one backlog item among
 * potentially thousands, across a shared multi-process, multi-repo SQLite
 * file.
 */
import type { ClaimOpts, ClaimResult, ReleaseResult } from '../model.js';
import type { GraphBacklogStore } from './graph-backlog-store.js';
import { mutateMetadata } from './mutate-metadata.js';
import type { BacklogNodeMeta } from './mapping.js';

/** DESIGN.md §4.2 — matches STALE_CLAIM_S = 30*60 at state-transition.js:601. */
export const DEFAULT_STALE_AFTER_MIN = 30;

export class ClaimContentionError extends Error {
  constructor(
    public readonly heldBy: string,
    by: string
  ) {
    super(`cannot release claim held by "${heldBy}" as "${by}" without force`);
    this.name = 'ClaimContentionError';
  }
}

/**
 * DESIGN.md §4.2 — the exact branch table:
 *   unclaimed                              -> claimed
 *   by === claimedBy                       -> renewed (no contention check, ever)
 *   by !== claimedBy, age <= staleAfterMin -> held (refuse, no write)
 *   by !== claimedBy, age >  staleAfterMin -> reclaimed-stale
 *   by !== claimedBy, opts.force           -> proceeds anyway (reclaimed-stale-shaped)
 */
export function claimItemNode(store: GraphBacklogStore, nodeId: number, by: string, opts: ClaimOpts = {}): ClaimResult {
  const staleAfterMs = (opts.staleAfterMin ?? DEFAULT_STALE_AFTER_MIN) * 60_000;
  let result!: ClaimResult;
  mutateMetadata<BacklogNodeMeta>(store, nodeId, (meta) => {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    if (!meta.claimedBy || meta.claimedBy === by) {
      result = { status: meta.claimedBy ? 'renewed' : 'claimed', claimedBy: by, claimedAt: nowIso };
      return { ...meta, claimedBy: by, claimedAt: nowIso, updatedAt: nowIso };
    }

    const ageMs = meta.claimedAt ? now - Date.parse(meta.claimedAt) : Number.POSITIVE_INFINITY;
    if (ageMs <= staleAfterMs && !opts.force) {
      result = {
        status: 'held',
        claimedBy: by,
        claimedAt: nowIso,
        heldBy: meta.claimedBy,
        ...(meta.claimedAt !== undefined ? { heldSince: meta.claimedAt } : {}),
      };
      // Unchanged metadata — still routed through the same code path so
      // there is ONE transaction shape, never a TOCTOU-prone early return
      // (DESIGN.md §4.3).
      return meta;
    }

    result = { status: 'reclaimed-stale', claimedBy: by, claimedAt: nowIso, previousClaimant: meta.claimedBy };
    return { ...meta, claimedBy: by, claimedAt: nowIso, updatedAt: nowIso };
  });
  return result;
}

/** SPEC.md §5.3 — "always succeeds (bumps claimedAt), no contention check, ever." */
export function renewClaimNode(store: GraphBacklogStore, nodeId: number, by: string): ClaimResult {
  let result!: ClaimResult;
  mutateMetadata<BacklogNodeMeta>(store, nodeId, (meta) => {
    const nowIso = new Date().toISOString();
    result = { status: meta.claimedBy ? 'renewed' : 'claimed', claimedBy: by, claimedAt: nowIso };
    return { ...meta, claimedBy: by, claimedAt: nowIso, updatedAt: nowIso };
  });
  return result;
}

/** DESIGN.md §4.2 — releasing an already-unclaimed item is a no-op, never an error. */
export function releaseClaimNode(store: GraphBacklogStore, nodeId: number, by: string, opts: { force?: boolean } = {}): ReleaseResult {
  let result!: ReleaseResult;
  mutateMetadata<BacklogNodeMeta>(store, nodeId, (meta) => {
    if (!meta.claimedBy) {
      result = { status: 'release-noop' };
      return meta;
    }
    if (meta.claimedBy !== by && !opts.force) {
      throw new ClaimContentionError(meta.claimedBy, by);
    }
    const wasClaimedBy = meta.claimedBy;
    result = { status: 'released', wasClaimedBy };
    const nowIso = new Date().toISOString();
    const next: BacklogNodeMeta = { ...meta, updatedAt: nowIso };
    delete next.claimedBy;
    delete next.claimedAt;
    return next;
  });
  return result;
}
