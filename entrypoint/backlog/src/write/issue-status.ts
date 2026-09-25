/**
 * issue-status.ts — resolves a live issue's current `status` node by walking
 * its live `has_status` edge. Shared by `transition.ts` (needs the CURRENT
 * status to compute `fromStatus`) and `claim.ts` (needs it to reject a claim
 * on a terminal issue, BUG-BACKLOG-CLAIM-TERMINAL-001) — extracted here
 * rather than duplicated a second time, per this package's Two-Use Refactor
 * Rule.
 */
import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import { getNodeByRowidTx, type ITxNodeRow } from './tx.js';

interface IRawEdgeDstRow {
  dst: number;
}

/**
 * `caller` is embedded in the invariant-violation error messages so a thrown
 * `Error` still reads as coming from the verb that actually called this,
 * matching the per-file error-message convention both callers already used
 * before this was extracted.
 */
export async function resolveIssueStatusTx(
  tx: AdapterTransaction,
  issueRowid: number,
  caller: string
): Promise<ITxNodeRow> {
  const statusEdge = await tx.executeGet<IRawEdgeDstRow>(
    'SELECT dst FROM edge WHERE src = ? AND rel = ? AND t_invalid IS NULL',
    [issueRowid, 'has_status']
  );
  if (!statusEdge) {
    throw new Error(
      `${caller}: issue rowid=${issueRowid} has no live "has_status" edge — graph invariant violation ` +
        '(every live issue must carry exactly one live status).'
    );
  }
  const statusRow = await getNodeByRowidTx(tx, statusEdge.dst);
  if (statusRow?.kind !== 'status' || statusRow.tInvalid !== null) {
    throw new Error(
      `${caller}: resolved status rowid=${statusEdge.dst} is missing, invalidated, or not a "status" node — ` +
        'graph invariant violation.'
    );
  }
  return statusRow;
}
