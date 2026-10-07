/**
 * remove.ts — `remove` (S02 AC14 / cluster `backlog-lifecycle-model`
 * `0b0df8f3`): PERMANENT retirement.
 *
 * `delete` is a reversible soft-delete (`restore` undoes it). `remove` is the
 * other half of the lifecycle the store lacked entirely (`4a19c33e`: "No way
 * to permanently remove a mis-filed/duplicate/mis-named item — only
 * soft-delete and merge exist"): a retirement the caller cannot un-retire,
 * gated behind an explicit `confirm: true` because it is destructive.
 *
 * **Never a hard delete.** The graph store is bi-temporal (`SPEC.md` §3,
 * "never a hard delete") and exposes no row-DELETE primitive, so `remove`
 * stamps `t_invalid` exactly like `delete` AND merges `meta.permanentlyRemoved`
 * (plus `removedAt`/`removedReason`). The row, its content and its full audit
 * trail survive; `restore` reads the marker and REFUSES, so the retirement is
 * permanent from every consumer's perspective. This is the smallest faithful
 * implementation of "permanently retires" that does not violate the store's
 * bi-temporal contract.
 *
 * One `BEGIN IMMEDIATE` transaction, hand-composed against the caller's own
 * `tx` for the identical reason `delete.ts` is (the library primitives reach
 * the bare adapter, never an open transaction).
 */

import type { ISessionStamp } from './session-stamp.js';
import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import { writeAudit } from './audit.js';
import { scheduleIssueEmbedding } from './embedding-observer.js';
import {
  InvalidArgumentError,
  RemoveConfirmationRequiredError,
  assertNotBareRoleLiteral,
} from './errors.js';
import {
  type IWriteStoreHandle,
  executeWriteTransaction,
  nowISO,
  resolveLiveIssueTx,
} from './tx.js';

export interface IRemoveIssueInput extends ISessionStamp {
  /** Exact uid, or a unique uid prefix, of the live issue to permanently retire. */
  uid: string;
  /**
   * REQUIRED and must be exactly `true`. `remove` is irreversible (unlike
   * `delete`), so a missing/false value is refused before any write runs rather
   * than defaulted.
   */
  confirm: boolean;
  /** The acting agent or person, as a name (§6.3's opening rule). REQUIRED. */
  by: string;
  /** OPTIONAL human-readable reason, recorded on the node and the audit row. */
  reason?: string;
}

export interface IRemoveIssueOutcome {
  uid: string;
  removed: true;
}

function assertNonBlank(
  field: string,
  value: string | undefined
): asserts value is string {
  if (value === undefined || value.trim().length === 0) {
    throw new InvalidArgumentError(field, 'is required');
  }
}

/**
 * Permanently retire a live issue. One `immediate` transaction: require
 * `confirm === true` (before any resolve) → resolve `uid` → live `issue` row
 * ({@link resolveLiveIssueTx}) → hand-composed
 * `UPDATE node SET t_invalid = ?, meta = ? WHERE rowid = ?` merging
 * `permanentlyRemoved:true` / `removedAt` / optional `removedReason` into the
 * EXISTING meta → `writeAudit(action:'removed')`, against the SAME `tx`.
 *
 * Errors: `InvalidArgumentError` (`uid`/`by` missing or blank, or a bare role
 * literal), `RemoveConfirmationRequiredError` (`confirm !== true`),
 * `IssueNotFoundError` (no LIVE issue matches `uid` — including an
 * already-retired one, so `remove` never re-stamps over a prior retire), and
 * `WriteContentionError`/`WriteIOError` (§4c).
 */
export async function removeIssue(
  handle: IWriteStoreHandle,
  input: IRemoveIssueInput
): Promise<IRemoveIssueOutcome> {
  assertNonBlank('uid', input.uid);
  assertNonBlank('by', input.by);
  assertNotBareRoleLiteral('by', input.by);
  if (input.confirm !== true) {
    throw new RemoveConfirmationRequiredError(input.uid);
  }

  let removed: { rowid: number; uid: string } | undefined;

  const outcome = await executeWriteTransaction(
    { ...handle, verb: 'remove' },
    async (tx: AdapterTransaction) => {
      const now = nowISO();
      const row = await resolveLiveIssueTx(tx, input.uid);
      removed = { rowid: row.rowid, uid: row.uid };

      const mergedMeta: Record<string, unknown> = {
        ...(row.metadata ?? {}),
        permanentlyRemoved: true,
        removedAt: now,
      };
      if (input.reason !== undefined && input.reason.trim().length > 0) {
        mergedMeta['removedReason'] = input.reason;
      }
      const result = await tx.executeRun(
        'UPDATE node SET t_invalid = ?, meta = ? WHERE rowid = ?',
        [now, JSON.stringify(mergedMeta), row.rowid]
      );
      if (result.rowsAffected !== 1) {
        throw new Error(
          `removeIssue: retire UPDATE affected ${result.rowsAffected} rows for uid="${input.uid}", expected exactly 1.`
        );
      }

      await writeAudit({
        tx,
        typePolicy: handle.typePolicy,
        subjectRowid: row.rowid,
        subjectUid: row.uid,
        subjectKind: 'issue',
        actor: input.by,
        action: 'removed',
        note: input.reason ?? 'permanently removed',
        at: now,
      });

      return { uid: row.uid, removed: true as const };
    }
  );

  // §4b/§8 AC-4 ("removing an item removes its vector") — strictly AFTER the
  // subject transaction has committed.
  if (removed) {
    const embedPromise = scheduleIssueEmbedding(handle, {
      action: 'delete',
      subjectRowid: removed.rowid,
      subjectUid: removed.uid,
      actor: input.by,
    });
    embedPromise.catch(() => {
      /* scheduleIssueEmbedding never rejects — this catch only silences an unhandled-rejection warning if that contract is ever broken. */
    });
  }

  return outcome;
}
