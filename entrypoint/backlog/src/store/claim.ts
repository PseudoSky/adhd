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
import { writeAuditEvent } from './audit-log.js';

/** `claim.ts`'s three ops only ever receive `nodeId` (never `repo`/`humanId`
 *  directly — see their own call sites in `client.ts`), so this reads the
 *  two identifying fields straight back off the node's own (already
 *  freshly-written) metadata rather than widening every signature here just
 *  for audit logging (DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001). */
async function logClaimEvent(store: GraphBacklogStore, nodeId: number, detail: Record<string, unknown>): Promise<void> {
  const node = await store.graph.getNode(nodeId);
  const meta = node?.metadata as Partial<BacklogNodeMeta> | undefined;
  if (meta?.repo && meta?.humanId) {
    await writeAuditEvent(store, nodeId, meta.repo, meta.humanId, 'claim', detail);
  }
}

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

export async function claimItemNode(store: GraphBacklogStore, nodeId: number, by: string, opts: ClaimOpts = {}): Promise<ClaimResult> {
  const staleAfterMs = (opts.staleAfterMin ?? DEFAULT_STALE_AFTER_MIN) * 60_000;
  let result!: ClaimResult;
  await mutateMetadata<BacklogNodeMeta>(store, nodeId, (meta) => {
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
      return meta;
    }

    result = { status: 'reclaimed-stale', claimedBy: by, claimedAt: nowIso, previousClaimant: meta.claimedBy };
    return { ...meta, claimedBy: by, claimedAt: nowIso, updatedAt: nowIso };
  });
  if (result.status !== 'held') {
    await logClaimEvent(store, nodeId, { status: result.status, by });
  }
  return result;
}

export async function renewClaimNode(store: GraphBacklogStore, nodeId: number, by: string): Promise<ClaimResult> {
  let result!: ClaimResult;
  await mutateMetadata<BacklogNodeMeta>(store, nodeId, (meta) => {
    const nowIso = new Date().toISOString();
    result = { status: meta.claimedBy ? 'renewed' : 'claimed', claimedBy: by, claimedAt: nowIso };
    return { ...meta, claimedBy: by, claimedAt: nowIso, updatedAt: nowIso };
  });
  await logClaimEvent(store, nodeId, { status: result.status, by });
  return result;
}

export async function releaseClaimNode(store: GraphBacklogStore, nodeId: number, by: string, opts: { force?: boolean } = {}): Promise<ReleaseResult> {
  let result!: ReleaseResult;
  await mutateMetadata<BacklogNodeMeta>(store, nodeId, (meta) => {
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
  if (result.status !== 'release-noop') {
    await logClaimEvent(store, nodeId, { status: result.status, by, wasClaimedBy: (result as { wasClaimedBy?: string }).wasClaimedBy });
  }
  return result;
}
