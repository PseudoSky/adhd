/**
 * restore.ts — `restore` (S02 AC14 / cluster `backlog-lifecycle-model`
 * `0b0df8f3`): reverse a soft-`delete`.
 *
 * `delete` (`write/delete.ts`) is a bi-temporal soft-invalidate — it stamps
 * `t_invalid` and merges `meta.invalidatedReason`/`invalidatedAt`, and the row
 * "disappears" from every live read (`get` → `item_not_found`). Before this
 * verb there was NO way to reverse it: `SPEC.md` §3 records that the graph
 * store exposes no in-place un-invalidate primitive, so recovery required
 * hand-written raw SQL against the live store (`7a42f8d6`).
 *
 * `restore` is that missing inverse, hand-composed against the caller's own
 * open `tx` (exactly as `delete.ts` hand-composes its `invalidate` mirror, and
 * for the identical reason: the library's own primitives reach `this.adapter`,
 * never an open transaction). One `BEGIN IMMEDIATE` transaction:
 *
 *  1. resolve `uid` (exact or unique prefix) to a SOFT-DELETED `issue` row;
 *  2. refuse a row `remove` made PERMANENT (`meta.permanentlyRemoved`), and
 *     refuse a row that is still live (never deleted);
 *  3. clear `t_invalid` and strip the soft-delete provenance from `meta`
 *     (`invalidatedReason`/`invalidatedAt`), leaving every other meta key and
 *     the content/name/kind byte-for-byte intact;
 *  4. append a `restored` audit row.
 *
 * Never a re-create: the SAME uid and rowid are re-livened, so every edge
 * (citations, notes, part_of children) that pointed at the row is addressable
 * again. Only a `delete` is reversible — a `remove` is not.
 */

import type { ISessionStamp } from './session-stamp.js';
import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import { writeAudit } from './audit.js';
import {
  composeEmbedText,
  scheduleIssueEmbedding,
} from './embedding-observer.js';
import {
  InvalidArgumentError,
  IssueNotRestorableError,
  assertNotBareRoleLiteral,
} from './errors.js';
import {
  type IWriteStoreHandle,
  executeWriteTransaction,
  nowISO,
  resolveRestorableIssueTx,
} from './tx.js';

export interface IRestoreIssueInput extends ISessionStamp {
  /** Exact uid, or a unique uid prefix, of the soft-deleted issue to restore. */
  uid: string;
  /** The acting agent or person, as a name (§6.3's opening rule). REQUIRED. */
  by: string;
}

export interface IRestoreIssueOutcome {
  uid: string;
  restored: true;
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
 * Un-invalidate a soft-deleted issue. One `immediate` transaction: resolve
 * `uid` → soft-deleted `issue` row (tx-scoped, {@link resolveRestorableIssueTx})
 * → refuse a permanently-removed row → hand-composed
 * `UPDATE node SET t_invalid = NULL, meta = ? WHERE rowid = ?` with the
 * `invalidatedReason`/`invalidatedAt` keys stripped (every other meta key
 * preserved) → `writeAudit(action:'restored')`, against the SAME `tx`.
 *
 * Errors: `InvalidArgumentError` (`uid`/`by` missing or blank, or a bare role
 * literal), `IssueNotFoundError` (nothing soft-deleted matches the uid),
 * `IssueNotRestorableError` (the uid names a live issue, or a `remove`d one),
 * `WriteContentionError`/`WriteIOError` (§4c).
 */
export async function restoreIssue(
  handle: IWriteStoreHandle,
  input: IRestoreIssueInput
): Promise<IRestoreIssueOutcome> {
  assertNonBlank('uid', input.uid);
  assertNonBlank('by', input.by);
  assertNotBareRoleLiteral('by', input.by);

  let restored: { rowid: number; uid: string; text: string } | undefined;

  const outcome = await executeWriteTransaction(
    { ...handle, verb: 'restore' },
    async (tx: AdapterTransaction) => {
      const now = nowISO();
      const row = await resolveRestorableIssueTx(tx, input.uid);
      if (row.metadata?.['permanentlyRemoved'] === true) {
        throw new IssueNotRestorableError(row.uid, 'permanently-removed');
      }
      restored = {
        rowid: row.rowid,
        uid: row.uid,
        text: composeEmbedText(row.name ?? '', row.content),
      };

      const rest: Record<string, unknown> = { ...(row.metadata ?? {}) };
      delete rest['invalidatedReason'];
      delete rest['invalidatedAt'];
      const result = await tx.executeRun(
        'UPDATE node SET t_invalid = NULL, meta = ? WHERE rowid = ?',
        [JSON.stringify(rest), row.rowid]
      );
      if (result.rowsAffected !== 1) {
        throw new Error(
          `restoreIssue: un-invalidate UPDATE affected ${result.rowsAffected} rows for uid="${input.uid}", expected exactly 1.`
        );
      }

      await writeAudit({
        tx,
        typePolicy: handle.typePolicy,
        subjectRowid: row.rowid,
        subjectUid: row.uid,
        subjectKind: 'issue',
        actor: input.by,
        action: 'restored',
        note: `restored by ${input.by}`,
        at: now,
      });

      return { uid: row.uid, restored: true as const };
    }
  );

  // Re-index the now-live issue (§4b, mirrors `delete`'s post-commit cleanup):
  // strictly AFTER the subject transaction has committed.
  if (restored) {
    const embedPromise = scheduleIssueEmbedding(handle, {
      action: 'upsert',
      content: restored.text,
      subjectRowid: restored.rowid,
      subjectUid: restored.uid,
      actor: input.by,
    });
    embedPromise.catch(() => {
      /* scheduleIssueEmbedding never rejects — this catch only silences an unhandled-rejection warning if that contract is ever broken. */
    });
  }

  return outcome;
}
