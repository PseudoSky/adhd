/**
 * claim.ts — `claim` (SPEC.md §4c + §6.3.5).
 *
 * The ephemeral multi-agent lease: `claim` / `release` / `renew` against a
 * live `issue` node's `meta.metadata.claimedBy`/`claimedAt` pair. This is a
 * genuine compare-and-swap, not a blind write: it runs inside ONE
 * `store.adapter.transaction(fn, {mode:'immediate'})` (via
 * {@link executeWriteTransaction}) that (1) re-fetches the node via the
 * hand-composed, tx-scoped uid lookup ({@link getNodeByUidTx} — never a
 * `getNodeByUid` call, which always runs against the bare adapter, §4c), (2)
 * evaluates the claim/release/renew rule against that fresh read, (3) mirrors
 * the library's `touch(nodeId, meta)` — a WHOLESALE replace of the `meta`
 * column, never a merge (verified against `@adhd/sox-graph-store`'s published
 * dist, `dist/index.js:1482-1524`) — against the SAME `tx`, all before the
 * transaction commits. Two concurrent `claim` calls against the same `uid`
 * therefore serialize through the transaction's RESERVED lock: the loser
 * blocks until the winner commits, then its own read executes against the
 * winner's already-committed state, so it takes the correct branch (already
 * held / already stale / already released) rather than racing on a stale
 * read.
 *
 * `touch` itself is never called here (nor is `invalidate`/`getNodeByUid`) —
 * per §4c's "edge writes and uid lookups inside a transaction" rule, every
 * one of those `GraphBackend` methods runs against `this.adapter` (the bare,
 * un-transacted adapter) and would autocommit outside this file's own
 * `immediate` transaction. This module hand-composes the identical
 * `UPDATE node SET meta = ?, t_updated = ? WHERE rowid = ?` shape `touch`
 * itself runs, issued against `tx`.
 */

import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import {
  type IProjectPolicy,
  type IResolvedProjectRow,
  resolveProjectPolicy,
} from './catalog.js';
import { writeAudit } from './audit.js';
import { ClaimHeldError, InvalidArgumentError, IssueNotFoundError } from './errors.js';
import { type IWriteStoreHandle, executeWriteTransaction, getNodeByRowidTx, getNodeByUidTx, nowISO, resolveLiveIssueTx } from './tx.js';

export interface IClaimInput {
  /** The `issue` uid to claim/release/renew (§6.3, an "Issue verb"). */
  uid: string;
  /** The claimant — the acting agent or person. REQUIRED on every action (§6.3's opening rule). */
  by: string;
  action: 'claim' | 'release' | 'renew';
  /** Human-confirmed override of a NON-stale claim (§6.2). Only consulted on `action:'claim'` when the current claimant differs and the lease is not yet stale. */
  force?: boolean;
}

export interface IClaimOutcome {
  uid: string;
  status: 'claimed' | 'held' | 'reclaimed-stale' | 'renewed' | 'released' | 'release-noop';
  claimedBy?: string;
  claimedAt?: string;
  heldBy?: string;
  heldSince?: string;
  previousClaimant?: string;
  wasClaimedBy?: string;
}

function assertNonBlank(field: string, value: string | undefined): asserts value is string {
  if (value === undefined || value.trim().length === 0) {
    throw new InvalidArgumentError(field, 'is required');
  }
}

interface IRawEdgeSrcRow {
  src: number;
}

/**
 * Resolves the `project_policy.claim_stale_after_min` threshold governing
 * `uid`'s issue, by walking the SAME two-hop `owns_component`/`owns_project`
 * chain §1 already documents for `NodeUniquenessPolicy`'s component-parent
 * resolution — hand-composed against `tx` (never `getEdges()`, which is
 * bare-adapter-only, §4c) since `IClaimInput` carries no `project` field of
 * its own: an issue's project is reachable only by walking its edges.
 *
 * Every live `issue` is guaranteed (by `createIssue`/`moveIssue`) to own
 * exactly one live `owns_component` edge, and every live `component` exactly
 * one live `owns_project` edge — so a missing hop here is a genuine graph
 * invariant violation, not a caller error; it throws a plain `Error` (never a
 * `BacklogWriteError` subclass) so it is never mistaken for one of this
 * verb's own validation outcomes.
 */
async function resolveIssueProjectPolicyTx(tx: AdapterTransaction, issueRowid: number): Promise<IProjectPolicy> {
  const componentEdge = await tx.executeGet<IRawEdgeSrcRow>(
    'SELECT src FROM edge WHERE dst = ? AND rel = ? AND t_invalid IS NULL',
    [issueRowid, 'owns_component'],
  );
  if (!componentEdge) {
    throw new Error(
      `claim: issue rowid=${issueRowid} has no live "owns_component" edge — graph invariant violation ` +
        '(every live issue must own exactly one live parent component).',
    );
  }

  const projectEdge = await tx.executeGet<IRawEdgeSrcRow>(
    'SELECT src FROM edge WHERE dst = ? AND rel = ? AND t_invalid IS NULL',
    [componentEdge.src, 'owns_project'],
  );
  if (!projectEdge) {
    throw new Error(
      `claim: component rowid=${componentEdge.src} has no live "owns_project" edge — graph invariant violation ` +
        '(every live component must be owned by exactly one live project).',
    );
  }

  const projectRow = await getNodeByRowidTx(tx, projectEdge.src);
  if (!projectRow || projectRow.kind !== 'project' || projectRow.tInvalid !== null) {
    throw new Error(
      `claim: resolved project rowid=${projectEdge.src} is missing, invalidated, or not a "project" node — ` +
        'graph invariant violation.',
    );
  }

  const resolvedProject: IResolvedProjectRow = {
    rowid: projectRow.rowid,
    uid: projectRow.uid,
    // A live `project` row's `name` is never null in practice (§1/§6.1 — project is
    // resolved-only, minted only via `upsertProject`, which always names it); the `?? ''`
    // is a defensive fallback for the type only, never expected to fire.
    name: projectRow.name ?? '',
    metadata: projectRow.metadata,
  };
  return resolveProjectPolicy(resolvedProject);
}

/**
 * Hand-composed mirror of `GraphBackend.touch(nodeId, {metadata})`
 * (`@adhd/sox-graph-store` dist/index.js:1482-1524) — a WHOLESALE replace of
 * the `meta` column (never a merge) plus a `t_updated` stamp, issued against
 * `tx` instead of the bare adapter. Every caller in this file already spreads
 * the row's existing metadata into `newMetadata` itself (preserving any
 * unrelated key — `assignee`, or anything else stored there) and only adds/
 * removes the claim-lease keys, so this function never needs to know which
 * keys are "claim" keys — it is a pure, generic wholesale-replace primitive.
 */
async function touchMetadataTx(tx: AdapterTransaction, rowid: number, newMetadata: Record<string, unknown>, at: string): Promise<void> {
  const result = await tx.executeRun('UPDATE node SET meta = ?, t_updated = ? WHERE rowid = ?', [JSON.stringify(newMetadata), at, rowid]);
  if (result.rowsAffected !== 1) {
    throw new Error(`claim: touch UPDATE affected ${result.rowsAffected} rows for rowid=${rowid}, expected exactly 1.`);
  }
}

/**
 * `claim` / `release` / `renew` an issue's lease (§6.3.5). One `immediate`
 * transaction; the CAS decision and the metadata touch both run against the
 * SAME `tx` the transaction opened, so two concurrent callers against the
 * SAME `uid` serialize through the transaction's RESERVED lock — the loser's
 * own re-fetch (inside its own attempt, after the winner commits) sees the
 * winner's already-written `claimedBy`/`claimedAt`, never a stale
 * pre-transaction read.
 *
 * Rule table (SPEC.md §6.3.5, restated here for the metadata-only shape the
 * lease now lives in):
 *
 * | action    | current `claimedBy`                                  | outcome |
 * |-----------|-------------------------------------------------------|---------|
 * | `claim`   | unset                                                   | write `{claimedBy, claimedAt}`; `status:'claimed'` |
 * | `claim`   | `== by`                                                 | no-op write of `claimedAt`; `status:'held'` |
 * | `claim`   | `!= by`, age < `claim_stale_after_min`, `!force`        | throws `ClaimHeldError` |
 * | `claim`   | `!= by`, age ≥ threshold, OR `force:true`               | write `{claimedBy, claimedAt}`; `status:'reclaimed-stale'`, `previousClaimant` |
 * | `release` | `== by`                                                 | clear both fields; `status:'released'` |
 * | `release` | `!= by` or unset                                        | no write; `status:'release-noop'`, `wasClaimedBy` |
 * | `renew`   | `== by`                                                 | bump `claimedAt`; `status:'renewed'` |
 * | `renew`   | `!= by` or unset                                        | throws `ClaimHeldError` |
 *
 * **Audit.** Every branch that performs a real write emits exactly one
 * `audit` node via {@link writeAudit}, inside the SAME transaction (§4a "no
 * bare mutation"). `writeAudit`'s own doc comment enumerates the audit
 * `action` vocabulary as `'claimed'`/`'released'`/`'renewed'`/
 * `'reclaimed-stale'` — four values, not five — so the `claim`-when-`== by`
 * ("held", an idempotent re-affirmation of an already-owned claim) branch
 * reuses `action:'claimed'`; its `IClaimOutcome.status` is still the distinct
 * `'held'` value the rule table names, carried in the OUTCOME, not the audit
 * action string. The two branches the rule table marks "no write"
 * (`release-noop`) perform no touch and emit no audit — nothing changed, so
 * §4a's "every STATE CHANGE writes an audit node" does not apply. This
 * reading resolves a genuine tension in SPEC.md §6.3.5 (see this package's
 * write-verb report for the full citation) between "every branch writes an
 * audit node" and the rule table's own "no write" / four-action vocabulary;
 * it is the only reading consistent with `writeAudit`'s own doc comment.
 *
 * **`renew` against an unclaimed issue.** The rule table assigns this to the
 * SAME `ClaimHeldError` outcome as "held by someone else" — but there is no
 * real holder to report. SPEC.md does not resolve this case explicitly; this
 * implementation reports `ClaimHeldError('', '')` (empty-string sentinels,
 * never a fabricated agent name or timestamp) so the thrown error's shape is
 * still exactly `ClaimHeldError` per the rule table, without inventing data
 * the graph does not have.
 *
 * Errors: `InvalidArgumentError` (`uid`/`by` missing/blank, or `action`
 * outside the closed `'claim'|'release'|'renew'` set — the TS type restricts
 * this at compile time but a transport boundary, e.g. CLI/MCP JSON input, can
 * still send an arbitrary string), `IssueNotFoundError` (no live `issue` node
 * carries `uid`), `ClaimHeldError` (per the rule table above),
 * `WriteContentionError`/`WriteIOError` (§4c — an exhausted driver-level
 * retry on the underlying `immediate` transaction).
 */
export async function claim(handle: IWriteStoreHandle, input: IClaimInput): Promise<IClaimOutcome> {
  assertNonBlank('uid', input.uid);
  assertNonBlank('by', input.by);
  if (input.action !== 'claim' && input.action !== 'release' && input.action !== 'renew') {
    throw new InvalidArgumentError('action', `must be "claim", "release", or "renew" (got ${JSON.stringify(input.action)})`);
  }
  const force = input.force === true;

  return executeWriteTransaction(handle, async (tx: AdapterTransaction) => {
    const now = nowISO();
    const row = await resolveLiveIssueTx(tx, input.uid);

    const meta = { ...(row.metadata ?? {}) };
    const claimedBy = typeof meta['claimedBy'] === 'string' ? (meta['claimedBy'] as string) : undefined;
    const claimedAt = typeof meta['claimedAt'] === 'string' ? (meta['claimedAt'] as string) : undefined;

    if (input.action === 'claim') {
      if (claimedBy === undefined) {
        const newMeta = { ...meta, claimedBy: input.by, claimedAt: now };
        await touchMetadataTx(tx, row.rowid, newMeta, now);
        await writeAudit({
          tx, typePolicy: handle.typePolicy,
          subjectRowid: row.rowid, subjectUid: row.uid, subjectKind: 'issue',
          actor: input.by, action: 'claimed', to: input.by, at: now,
        });
        return { uid: row.uid, status: 'claimed', claimedBy: input.by, claimedAt: now };
      }

      if (claimedBy === input.by) {
        // Idempotent re-claim by the SAME agent — a real write (claimedAt bumps), reported as
        // the distinct 'held' status, but audited under the SAME 'claimed' action (see doc comment above).
        const newMeta = { ...meta, claimedAt: now };
        await touchMetadataTx(tx, row.rowid, newMeta, now);
        await writeAudit({
          tx, typePolicy: handle.typePolicy,
          subjectRowid: row.rowid, subjectUid: row.uid, subjectKind: 'issue',
          actor: input.by, action: 'claimed', from: input.by, to: input.by, note: 're-affirmed (held)', at: now,
        });
        return { uid: row.uid, status: 'held', heldBy: input.by, claimedBy: input.by, claimedAt: now };
      }

      // claimedBy !== undefined && claimedBy !== input.by — someone else holds it.
      const ageMin = claimedAt !== undefined ? (Date.parse(now) - Date.parse(claimedAt)) / 60_000 : Number.POSITIVE_INFINITY;
      const policy = await resolveIssueProjectPolicyTx(tx, row.rowid);
      const stale = ageMin >= policy.claimStaleAfterMin;
      if (!stale && !force) {
        throw new ClaimHeldError(claimedBy, claimedAt ?? now);
      }

      const newMeta = { ...meta, claimedBy: input.by, claimedAt: now, previousClaimant: claimedBy };
      await touchMetadataTx(tx, row.rowid, newMeta, now);
      await writeAudit({
        tx, typePolicy: handle.typePolicy,
        subjectRowid: row.rowid, subjectUid: row.uid, subjectKind: 'issue',
        actor: input.by, action: 'reclaimed-stale', from: claimedBy, to: input.by,
        note: stale ? `stale claim reclaimed after ~${Math.floor(ageMin)}min (threshold ${policy.claimStaleAfterMin}min)` : 'force override of a non-stale claim',
        at: now,
      });
      return { uid: row.uid, status: 'reclaimed-stale', claimedBy: input.by, claimedAt: now, previousClaimant: claimedBy };
    }

    if (input.action === 'release') {
      if (claimedBy === input.by) {
        const newMeta = { ...meta };
        delete newMeta['claimedBy'];
        delete newMeta['claimedAt'];
        await touchMetadataTx(tx, row.rowid, newMeta, now);
        await writeAudit({
          tx, typePolicy: handle.typePolicy,
          subjectRowid: row.rowid, subjectUid: row.uid, subjectKind: 'issue',
          actor: input.by, action: 'released', from: input.by, at: now,
        });
        return { uid: row.uid, status: 'released' };
      }
      // != by or unset — "no write" per the rule table: no touch, no audit (nothing changed).
      return { uid: row.uid, status: 'release-noop', wasClaimedBy: claimedBy };
    }

    // input.action === 'renew'
    if (claimedBy === input.by) {
      const newMeta = { ...meta, claimedAt: now };
      await touchMetadataTx(tx, row.rowid, newMeta, now);
      await writeAudit({
        tx, typePolicy: handle.typePolicy,
        subjectRowid: row.rowid, subjectUid: row.uid, subjectKind: 'issue',
        actor: input.by, action: 'renewed', from: input.by, to: input.by, at: now,
      });
      return { uid: row.uid, status: 'renewed', claimedBy: input.by, claimedAt: now };
    }
    // != by or unset — "renew is not a claim attempt" (SPEC.md §6.3.5) — throws unconditionally.
    // See this function's own doc comment ("renew against an unclaimed issue") for the
    // empty-string sentinel used when there is no real holder to report.
    throw new ClaimHeldError(claimedBy ?? '', claimedAt ?? '');
  });
}
