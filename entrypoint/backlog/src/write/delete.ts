/**
 * delete.ts — `delete` (SPEC.md §4c + §6.3.7, bi-temporal soft-delete).
 *
 * Maps onto the library's `GraphBackend.invalidate(nodeId, reason)` primitive
 * (§3: "bi-temporal — never a hard delete") — but hand-composed against the
 * caller's own open `tx`, never a call to `invalidate` itself, which runs
 * against `this.adapter` (the bare, un-transacted adapter) and would
 * autocommit outside this file's own `immediate` transaction (§4c, "edge
 * writes and uid lookups inside a transaction: the same rule, extended" —
 * the identical defect proven there for `writeEdge`/`invalidateEdge`/
 * `getNodeByUid` applies equally to `invalidate`/`touch`/`supersede`, every
 * one of which is declared on `GraphBackend` and reaches only `this.adapter`,
 * verified against the published `@adhd/sox-graph-store` dist,
 * `dist/index.js:1465-1480`).
 *
 * No content is destroyed: the row, its `content`, and its entire audit
 * trail (every prior `audit`/`transition`/`citation` node and edge already
 * written against it) remain exactly as they were. Only `t_invalid` is
 * stamped and `meta.invalidatedReason`/`invalidatedAt` are merged into the
 * SAME `meta` blob (never replaced wholesale, unlike `touch` — this mirrors
 * `invalidate`'s own merge-not-replace shape exactly, dist/index.js:1465-
 * 1480: `existingMeta` is spread, not discarded). The node stops appearing in
 * default (`liveOnly`) queries.
 *
 * **Divergence from a bare mirror of `invalidate`, deliberately.** The
 * library's own `invalidate(nodeId, reason)` checks only that the row
 * EXISTS, never that it is still LIVE — calling it twice re-stamps
 * `t_invalid`/`meta.invalidatedAt` a second time, silently overwriting the
 * FIRST deletion's timestamp/reason. This verb instead resolves `uid` via
 * the hand-composed, tx-scoped lookup ({@link getNodeByUidTx}) and requires
 * the row be LIVE (`tInvalid === null`) before proceeding — an
 * already-deleted `uid` throws `IssueNotFoundError`, per that error's own
 * contract ("no LIVE issue node carries `uid`") and consistent with `get`'s
 * identical "no live node" rule (§6.3.1). This preserves the audit trail's
 * integrity: the FIRST deletion's `invalidatedAt`/`invalidatedReason` is
 * never silently overwritten by a second `delete` call racing (or being
 * mistakenly retried) against the same `uid`.
 */

import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import { writeAudit } from './audit.js';
import { scheduleIssueEmbedding } from './embedding-observer.js';
import { InvalidArgumentError, IssueNotFoundError } from './errors.js';
import { type IWriteStoreHandle, executeWriteTransaction, getNodeByUidTx, nowISO, resolveLiveIssueTx } from './tx.js';

export interface IDeleteIssueInput {
  uid: string;
  /** REQUIRED — the human-readable explanation for the invalidation, still a real requirement (§6.3.7). */
  reason: string;
  /** The acting agent/human identity (§6.3's opening rule). REQUIRED. */
  by: string;
  /**
   * §4b/§6.2/§9 AC-4 ("invalidating an issue removes its vector") — waits for
   * the fire-and-forget vector-deletion round-trip before `deleteIssue`
   * returns, when `true` and `handle.embedding` is configured. Default
   * (`false`/omitted): fire-and-forget, matching `create`/`update`'s own
   * default.
   */
  awaitEmbed?: boolean;
}

export interface IDeleteIssueOutcome {
  uid: string;
  invalidated: true;
}

function assertNonBlank(field: string, value: string | undefined): asserts value is string {
  if (value === undefined || value.trim().length === 0) {
    throw new InvalidArgumentError(field, 'is required');
  }
}

/**
 * Soft-invalidate a live issue (§6.3.7). One `immediate` transaction: resolve
 * `uid` → live `issue` node (tx-scoped, never `getNodeByUid` itself, §4c) →
 * hand-composed `UPDATE node SET t_invalid = ?, meta = ? WHERE rowid = ?`
 * (mirroring `invalidate`'s own SQL exactly, merging `invalidatedReason`/
 * `invalidatedAt` into the EXISTING `meta` — never a wholesale replace, §4a)
 * → `writeAudit` (§4a), against the SAME `tx` handle throughout. NEVER a hard
 * row deletion — the row and its full audit trail survive untouched, only
 * `t_invalid`/`meta` change.
 *
 * Errors: `InvalidArgumentError` (`uid`/`by`/`reason` missing or blank),
 * `IssueNotFoundError` (no LIVE `issue` node carries `uid` — including an
 * ALREADY-deleted `uid`, per this file's own doc comment on why that is a
 * deliberate divergence from the library's bare `invalidate` mirror),
 * `WriteContentionError`/`WriteIOError` (§4c — an exhausted driver-level
 * retry on the underlying `immediate` transaction).
 */
export async function deleteIssue(handle: IWriteStoreHandle, input: IDeleteIssueInput): Promise<IDeleteIssueOutcome> {
  assertNonBlank('uid', input.uid);
  assertNonBlank('by', input.by);
  assertNonBlank('reason', input.reason);

  let deletedIssue: { rowid: number; uid: string } | undefined;

  const outcome = await executeWriteTransaction(handle, async (tx: AdapterTransaction) => {
    const now = nowISO();
    const row = await resolveLiveIssueTx(tx, input.uid);
    deletedIssue = { rowid: row.rowid, uid: row.uid };

    const mergedMeta = { ...(row.metadata ?? {}), invalidatedReason: input.reason, invalidatedAt: now };
    const result = await tx.executeRun('UPDATE node SET t_invalid = ?, meta = ? WHERE rowid = ?', [now, JSON.stringify(mergedMeta), row.rowid]);
    if (result.rowsAffected !== 1) {
      throw new Error(`deleteIssue: invalidate UPDATE affected ${result.rowsAffected} rows for uid="${input.uid}", expected exactly 1.`);
    }

    await writeAudit({
      tx,
      typePolicy: handle.typePolicy,
      subjectRowid: row.rowid,
      subjectUid: row.uid,
      subjectKind: 'issue',
      actor: input.by,
      action: 'deleted',
      note: input.reason,
      at: now,
    });

    return { uid: row.uid, invalidated: true as const };
  });

  // §4b/§9 AC-4 ("invalidating removes it") — strictly AFTER the subject
  // transaction above has committed.
  if (deletedIssue) {
    const embedPromise = scheduleIssueEmbedding(handle, {
      action: 'delete',
      subjectRowid: deletedIssue.rowid,
      subjectUid: deletedIssue.uid,
      actor: input.by,
    });
    if (input.awaitEmbed) await embedPromise;
    else embedPromise.catch(() => { /* scheduleIssueEmbedding never rejects — this catch exists only to silence an unhandled-rejection warning if that contract is ever broken. */ });
  }

  return outcome;
}
