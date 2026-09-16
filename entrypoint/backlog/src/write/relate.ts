/**
 * relate.ts — `relate` (SPEC.md §4, §6.3.6, §9 AC-17; carries forward
 * BUG-025/BUG-044's "never silently pick one" rule).
 *
 * A pure composition over this file's own tx-scoped node lookup
 * ({@link getNodeByUidTx}) plus the foundation's `resolveEdgeKindTx`
 * (catalog.ts) and `writeEdgeTx`/`invalidateEdgeTx` (tx.ts) — hand-rolling
 * NOTHING of its own multiplicity logic. §2's own text is explicit about
 * this: "This generic check IS `relate`'s enforcement — §6.3.6 hand-rolls
 * nothing. The single-valued-rel rejection … is this same
 * `edge_kind.multiplicity` gate, applied to those three rows." So the ONE
 * thing this file adds on top of `writeEdgeTx`'s own multiplicity guard is
 * the pre-write "does this exact edge already live?" check that decides
 * `IRelateOutcome.noop` — a concern `writeEdgeTx` itself cannot answer (it
 * upserts unconditionally and returns `void`, never signaling
 * insert-vs-re-touch), and one distinct from the cross-target CONFLICT
 * check `checkMultiplicityTx` already runs inside `writeEdgeTx`.
 *
 * **Why every relate is issue → issue, no catalog resolution at all.** All
 * five closed `rel` values (`relates_to`/`supersedes`/`blocks`/
 * `duplicate_of`/`part_of`) are declared `issue → issue` in §3's edge table
 * — unlike `move`'s `toProject`/`toComponent` (uid-OR-name, §6.1
 * resolve/mint rules), `sourceUid`/`targetUid` here are uids ONLY (§1: "the
 * only identifier is `uid`"). Both endpoints are resolved via the identical
 * hand-composed, tx-scoped {@link getNodeByUidTx} lookup `move.ts`/
 * `claim.ts`/`delete.ts` all use — never `getNodeByUid` itself, which runs
 * against the bare adapter and would read outside this file's own
 * `immediate` transaction (§4c).
 *
 * **`noop` semantics, precisely (§6.3.6, §9 AC-17).** `add`: if a LIVE edge
 * already connects `(sourceUid, targetUid, rel)` exactly, the call is a
 * no-op — nothing invalidated, nothing (re-)written, no audit — mirroring
 * `move.ts`'s own "same-placement calls are a no-op" convention exactly (a
 * stated idempotent outcome, never a disguised real write). Otherwise
 * `writeEdgeTx` runs — which either inserts a fresh edge, re-livens a
 * previously-`remove`d one, or (for a single-valued `rel` naming a
 * DIFFERENT existing target) throws `SingleValuedRelationConflictError` —
 * followed by one `writeAudit` call. `remove`: if NO live edge connects
 * `(sourceUid, targetUid, rel)`, the call is a no-op (already removed, or
 * never added) — nothing invalidated, no audit. Otherwise
 * `invalidateEdgeTx` runs, followed by one `writeAudit` call.
 *
 * **Audit shape (§4a — no dedicated fields exist in the foundation for
 * "which rel", so this is this file's own reasonable choice, not a spec
 * mandate).** One `audit` node per call, subject = the SOURCE issue (the
 * `uid` in `relate(uid, targetUid, rel, action)`'s own §4 phrasing),
 * `action: 'related'`/`'unrelated'`, `to: targetUid`, `note` records the
 * `rel` name (the one field free enough to carry it) — never emitted on a
 * `noop` outcome, matching §4a's "every STATE CHANGE writes an audit node"
 * (a noop is, by definition, not one).
 *
 * **KNOWN GAP RESOLVED, not silently decided — cross-project relate.** The
 * currently shipped tool refuses cross-repo/cross-project relations
 * ("did you mean repo X?"). SPEC.md is NOT silent here: §6.3 (this
 * rebuild's own crosswalk table against the currently shipped tool)'s
 * `IBacklogRelateInput.sourceRepo`/`targetRepo` row states this explicitly —
 * "no replacement — `uid` is globally unique across every project in the
 * store, so a `relate` between two issues in different projects needs no
 * repo parameter at all; `relate(sourceUid, targetUid, rel, action)` just
 * works." This file therefore does NOT check `sourceUid`/`targetUid`
 * resolve into the same project, does not accept a project/repo parameter,
 * and does not restrict `rel` by endpoint project — cross-project relation
 * (e.g. linking a defect in one project to its cause in another) is IN
 * SCOPE and unconditionally supported, closing the currently shipped tool's
 * gap by construction rather than by an added guard.
 */

import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import { resolveEdgeKindTx } from './catalog.js';
import { writeAudit } from './audit.js';
import { InvalidArgumentError, IssueNotFoundError } from './errors.js';
import {
  type IWriteStoreHandle,
  executeWriteTransaction,
  getNodeByUidTx,
  invalidateEdgeTx,
  nowISO,
  writeEdgeTx,
  resolveLiveIssueTx,
} from './tx.js';

/** The closed `rel` union `relate` accepts (§3/§6.3.6) — issue → issue in every case. */
export type RelateRel = 'relates_to' | 'supersedes' | 'blocks' | 'duplicate_of' | 'part_of';

const RELATE_RELS: readonly RelateRel[] = ['relates_to', 'supersedes', 'blocks', 'duplicate_of', 'part_of'];

export interface IRelateInput {
  /** The relation's SOURCE `issue` uid (§1: uid is the only identifier — never a name, never repo-scoped). */
  sourceUid: string;
  /** The relation's TARGET `issue` uid — may belong to ANY project, including a different one than `sourceUid` (see this file's own doc comment on the resolved cross-project gap). */
  targetUid: string;
  rel: RelateRel;
  action: 'add' | 'remove';
  /** The acting agent/human identity (§6.3's opening rule). REQUIRED. */
  by: string;
}

export interface IRelateOutcome {
  sourceUid: string;
  targetUid: string;
  rel: string;
  action: 'add' | 'remove';
  /** `true` when `add` found an already-live matching edge, or `remove` found none — an idempotent call, stated rather than disguised (§6.3.6). No edge was invalidated or written, and no audit row was produced. */
  noop: boolean;
}

function assertNonBlank(field: string, value: string | undefined): asserts value is string {
  if (value === undefined || value.trim().length === 0) {
    throw new InvalidArgumentError(field, 'is required');
  }
}

/**
 * Does a LIVE edge already connect `(srcRowid, dstRowid, rel)` exactly?
 * Hand-composed against `tx` (never `getEdges()`, which is bare-adapter-only,
 * §4c) — the SAME shape `checkMultiplicityTx` (tx.ts) and `move.ts`'s own
 * `resolveOwningComponentTx` use for a live-edge existence check, scoped to
 * the exact `(src, dst)` pair rather than "any edge off this rel."
 */
async function getLiveEdgeRowidTx(tx: AdapterTransaction, srcRowid: number, dstRowid: number, rel: string): Promise<number | null> {
  const row = await tx.executeGet<{ rowid: number }>(
    'SELECT rowid FROM edge WHERE src = ? AND dst = ? AND rel = ? AND t_invalid IS NULL',
    [srcRowid, dstRowid, rel],
  );
  return row ? row.rowid : null;
}

/**
 * Add or remove a typed `issue ↔ issue` relation (§6.3.6). One `immediate`
 * transaction: resolve `sourceUid`/`targetUid` → live `issue` nodes (tx-scoped,
 * §4c) → resolve `rel`'s `edge_kind` rule (`resolveEdgeKindTx`, catalog.ts) →
 * check whether a LIVE `(sourceUid, targetUid, rel)` edge already exists →
 * branch:
 *
 * - `add`, edge already live → `noop:true`, nothing written.
 * - `add`, edge not live (absent, or previously `remove`d) → `writeEdgeTx`
 *   (tx.ts) — inserts fresh or re-livens; throws
 *   `SingleValuedRelationConflictError` if `rel` is single-valued (`n:1`:
 *   `supersedes`/`duplicate_of`/`part_of`) and `sourceUid` already has a
 *   LIVE `rel` edge to a DIFFERENT target (`checkMultiplicityTx`, tx.ts —
 *   this file adds no separate check) — then `writeAudit`, `noop:false`.
 * - `remove`, edge not live → `noop:true`, nothing written.
 * - `remove`, edge live → `invalidateEdgeTx` (tx.ts) then `writeAudit`,
 *   `noop:false`.
 *
 * Errors: `InvalidArgumentError` (`sourceUid`/`targetUid`/`by` missing or
 * blank; `rel` outside the closed 5-value set — the TS type restricts this
 * at compile time but a transport boundary, e.g. CLI/MCP JSON input, can
 * still send an arbitrary string; `action` outside `'add'|'remove'`, same
 * reason; `sourceUid === targetUid` — a self-relation is always a client
 * error, never silently written, §6.3.6), `IssueNotFoundError` (either
 * endpoint is not a live `issue` node), `SingleValuedRelationConflictError`
 * (per the `add` branch above), `WriteContentionError`/`WriteIOError` (§4c —
 * an exhausted driver-level retry on the underlying `immediate`
 * transaction).
 */
export async function relate(handle: IWriteStoreHandle, input: IRelateInput): Promise<IRelateOutcome> {
  assertNonBlank('sourceUid', input.sourceUid);
  assertNonBlank('targetUid', input.targetUid);
  assertNonBlank('by', input.by);
  if (!RELATE_RELS.includes(input.rel)) {
    throw new InvalidArgumentError('rel', `must be one of ${RELATE_RELS.map((r) => `"${r}"`).join(', ')} (got ${JSON.stringify(input.rel)})`);
  }
  if (input.action !== 'add' && input.action !== 'remove') {
    throw new InvalidArgumentError('action', `must be "add" or "remove" (got ${JSON.stringify(input.action)})`);
  }
  if (input.sourceUid === input.targetUid) {
    throw new InvalidArgumentError('targetUid', 'a self-relation (sourceUid === targetUid) is never allowed');
  }

  return executeWriteTransaction(handle, async (tx: AdapterTransaction) => {
    const now = nowISO();

    const sourceRow = await resolveLiveIssueTx(tx, input.sourceUid);
    const targetRow = await resolveLiveIssueTx(tx, input.targetUid);

    const existingRowid = await getLiveEdgeRowidTx(tx, sourceRow.rowid, targetRow.rowid, input.rel);

    if (input.action === 'add') {
      if (existingRowid !== null) {
        // Already live, same source/target/rel — a stated idempotent no-op
        // (§6.3.6's "same target returns noop:true"), never a disguised
        // re-write: nothing invalidated, nothing (re-)written, no audit.
        return { sourceUid: sourceRow.uid, targetUid: targetRow.uid, rel: input.rel, action: 'add' as const, noop: true };
      }

      const rule = await resolveEdgeKindTx(tx, input.rel);
      // Multiplicity (single-valued-rel conflict on a DIFFERENT existing
      // target) is enforced entirely inside writeEdgeTx's own
      // checkMultiplicityTx (tx.ts) — this file hand-rolls nothing (§2).
      await writeEdgeTx(tx, {
        at: now,
        srcRowid: sourceRow.rowid, srcUid: sourceRow.uid, srcKind: 'issue',
        dstRowid: targetRow.rowid, dstUid: targetRow.uid, dstKind: 'issue',
        rel: input.rel, rule, typePolicy: handle.typePolicy,
      });

      await writeAudit({
        tx,
        typePolicy: handle.typePolicy,
        subjectRowid: sourceRow.rowid,
        subjectUid: sourceRow.uid,
        subjectKind: 'issue',
        actor: input.by,
        action: 'related',
        to: targetRow.uid,
        note: input.rel,
        at: now,
      });

      return { sourceUid: sourceRow.uid, targetUid: targetRow.uid, rel: input.rel, action: 'add' as const, noop: false };
    }

    // input.action === 'remove'
    if (existingRowid === null) {
      // Already invalidated, or never existed — a stated idempotent no-op,
      // never a disguised invalidate-of-nothing: nothing written, no audit.
      return { sourceUid: sourceRow.uid, targetUid: targetRow.uid, rel: input.rel, action: 'remove' as const, noop: true };
    }

    await invalidateEdgeTx(tx, {
      srcRowid: sourceRow.rowid,
      dstRowid: targetRow.rowid,
      rel: input.rel,
      reason: `relate: removed by "${input.by}"`,
      at: now,
    });

    await writeAudit({
      tx,
      typePolicy: handle.typePolicy,
      subjectRowid: sourceRow.rowid,
      subjectUid: sourceRow.uid,
      subjectKind: 'issue',
      actor: input.by,
      action: 'unrelated',
      to: targetRow.uid,
      note: input.rel,
      at: now,
    });

    return { sourceUid: sourceRow.uid, targetUid: targetRow.uid, rel: input.rel, action: 'remove' as const, noop: false };
  });
}
