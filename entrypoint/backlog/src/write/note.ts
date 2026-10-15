/**
 * write/note.ts — `remove-note` (first-class note removal, mounted as the
 * `removeNote` verb).
 *
 * A note is a `note` node attached to its issue by a live `has_note` edge
 * (minted by `create`'s `duplicateAction: 'comment'` branch). Removal is a
 * bi-temporal soft-delete, never a hard row deletion: the note node and its
 * `has_note` edge are stamped `t_invalid` with a merged `invalidatedReason`/
 * `invalidatedAt`, and a `note-removed` audit row is written against the
 * OWNING ISSUE so the removal is visible in that issue's `auditTrail`.
 *
 * **Authorization.** The caller must be the note's recorded author
 * (`metadata.author`, set at mint time) or be listed in the owning project's
 * `policy.noteRemovers`. The allow-list is per-project TYPED config resolved
 * from the store, never from the request. `by` is the caller-ASSERTED identity
 * (SPEC §6.3), so this gate is attribution against that asserted identity, not
 * authentication; binding `by` to a server-side identity is a tracked follow-up.
 * Refusal happens before any write.
 *
 * Hand-composed against the caller's own open `tx` (never the bare adapter),
 * per the same §4c rule as every other write verb in this package.
 */

import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import type { ISessionStamp } from './session-stamp.js';
import {
  type IProjectPolicy,
  type IResolvedProjectRow,
  resolveProjectPolicy,
} from './catalog.js';
import { writeAudit } from './audit.js';
import {
  CatalogNotFoundError,
  InvalidArgumentError,
  NoteNotFoundError,
  NoteRemovalNotPermittedError,
  assertNotBareRoleLiteral,
} from './errors.js';
import {
  type ITxNodeRow,
  type IWriteStoreHandle,
  executeWriteTransaction,
  getNodeByRowidTx,
  invalidateEdgeTx,
  nowISO,
  resolveUidPrefixTx,
} from './tx.js';

/**
 * Input for {@link removeNote}. Every field is caller-asserted except the
 * policy, which is read from the store.
 */
export interface IRemoveNoteInput extends ISessionStamp {
  /** The `note` uid to soft-remove — the id `create` returns as `commentedOn.noteId`. */
  uid: string;
  /**
   * The acting identity (§6.3's opening rule), e.g. `"claude:1"`. Must be the
   * note's author or on the project's `noteRemovers`. REQUIRED.
   */
  by: string;
  /**
   * Why the note is being removed. Recorded on the note's invalidation and on
   * the issue's audit row. REQUIRED.
   */
  reason: string;
}

/** Outcome of a successful {@link removeNote}. */
export interface IRemoveNoteOutcome {
  /** The removed note's uid (unchanged from the input). */
  uid: string;
  /** The issue the note was attached to, whose audit trail records the removal. */
  issueUid: string;
  /** Always `true` on success; a refused removal throws instead of returning. */
  invalidated: true;
}

interface IRawEdgeSrcRow {
  src: number;
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
 * Two-hop `owns_component`/`owns_project` walk from an issue to its project,
 * mirroring `citation.ts`'s `resolveIssueProjectTx`. Each write-path file keeps
 * its own copy of this small tx-scoped helper by package convention.
 */
async function resolveIssueProjectTx(
  tx: AdapterTransaction,
  issueRowid: number
): Promise<IResolvedProjectRow> {
  const componentEdge = await tx.executeGet<IRawEdgeSrcRow>(
    'SELECT src FROM edge WHERE dst = ? AND rel = ? AND t_invalid IS NULL',
    [issueRowid, 'owns_component']
  );
  if (!componentEdge) {
    throw new Error(
      `remove-note: issue rowid=${issueRowid} has no live "owns_component" edge — graph invariant violation.`
    );
  }
  const projectEdge = await tx.executeGet<IRawEdgeSrcRow>(
    'SELECT src FROM edge WHERE dst = ? AND rel = ? AND t_invalid IS NULL',
    [componentEdge.src, 'owns_project']
  );
  if (!projectEdge) {
    throw new Error(
      `remove-note: component rowid=${componentEdge.src} has no live "owns_project" edge — graph invariant violation.`
    );
  }
  const projectRow = await getNodeByRowidTx(tx, projectEdge.src);
  if (projectRow?.kind !== 'project' || projectRow.tInvalid !== null) {
    throw new Error(
      `remove-note: resolved project rowid=${projectEdge.src} is missing, invalidated, or not a "project" node — graph invariant violation.`
    );
  }
  return {
    rowid: projectRow.rowid,
    uid: projectRow.uid,
    name: projectRow.name ?? '',
    metadata: projectRow.metadata,
  };
}

/**
 * Resolve a note uid (exact or unique prefix) to its live `note` node, mapping
 * a miss to {@link NoteNotFoundError}.
 */
async function resolveNoteNodeTx(
  tx: AdapterTransaction,
  uid: string
): Promise<ITxNodeRow> {
  try {
    return await resolveUidPrefixTx(tx, uid, { expectedKind: 'note' });
  } catch (err) {
    if (err instanceof CatalogNotFoundError) {
      throw new NoteNotFoundError(uid);
    }
    throw err;
  }
}

/**
 * Whether `actor` may remove a note authored by `author`: the author always
 * may; anyone else only when the project policy lists them. Pure, so the rule
 * is testable without a store.
 */
export function mayRemoveNote(
  policy: Pick<IProjectPolicy, 'noteRemovers'>,
  author: string | undefined,
  actor: string
): boolean {
  if (author !== undefined && author === actor) return true;
  return policy.noteRemovers.includes(actor);
}

/**
 * Soft-remove ONE note by its own `uid` (`remove-note`). One `immediate`
 * transaction: resolve `uid` → live `note` node → find its live owning issue
 * via `has_note` → resolve the issue's project policy → authorize
 * ({@link mayRemoveNote}) → bi-temporally invalidate the note node and its
 * `has_note` edge → `writeAudit` against the OWNING ISSUE, all against the
 * SAME `tx`. Nothing is written when authorization or resolution fails.
 *
 * Errors: `InvalidArgumentError` (blank `uid`/`by`/`reason`, or a bare role
 * literal `by`), `NoteNotFoundError` (no LIVE `note` carries `uid`, including an
 * already-removed one, or a note with no live owning issue),
 * `NoteRemovalNotPermittedError` (the caller is neither the author nor on the
 * project's `noteRemovers`), `WriteContentionError`/`WriteIOError` (§4c).
 */
export async function removeNote(
  handle: IWriteStoreHandle,
  input: IRemoveNoteInput
): Promise<IRemoveNoteOutcome> {
  assertNonBlank('uid', input.uid);
  assertNonBlank('by', input.by);
  assertNotBareRoleLiteral('by', input.by);
  assertNonBlank('reason', input.reason);

  return executeWriteTransaction(
    { ...handle, verb: 'remove-note' },
    async (tx: AdapterTransaction) => {
      const now = nowISO();
      const noteRow = await resolveNoteNodeTx(tx, input.uid);

      const ownerEdge = await tx.executeGet<IRawEdgeSrcRow>(
        `SELECT src FROM edge WHERE dst = ? AND rel = 'has_note' AND t_invalid IS NULL`,
        [noteRow.rowid]
      );
      const issueRow = ownerEdge
        ? await getNodeByRowidTx(tx, ownerEdge.src)
        : null;
      if (!ownerEdge || issueRow?.kind !== 'issue' || issueRow.tInvalid !== null) {
        throw new NoteNotFoundError(input.uid);
      }

      const project = await resolveIssueProjectTx(tx, issueRow.rowid);
      const policy = resolveProjectPolicy(project);
      const author =
        typeof noteRow.metadata?.author === 'string'
          ? noteRow.metadata.author
          : undefined;
      if (!mayRemoveNote(policy, author, input.by)) {
        throw new NoteRemovalNotPermittedError(noteRow.uid, input.by);
      }

      const mergedMeta = {
        ...(noteRow.metadata ?? {}),
        invalidatedReason: input.reason,
        invalidatedAt: now,
      };
      const result = await tx.executeRun(
        'UPDATE node SET t_invalid = ?, meta = ? WHERE rowid = ? AND t_invalid IS NULL',
        [now, JSON.stringify(mergedMeta), noteRow.rowid]
      );
      if (result.rowsAffected !== 1) {
        throw new Error(
          `removeNote: invalidate UPDATE affected ${result.rowsAffected} rows for uid="${noteRow.uid}", expected exactly 1.`
        );
      }

      await invalidateEdgeTx(tx, {
        srcRowid: issueRow.rowid,
        dstRowid: noteRow.rowid,
        rel: 'has_note',
        reason: input.reason,
        at: now,
      });

      await writeAudit({
        tx,
        typePolicy: handle.typePolicy,
        subjectRowid: issueRow.rowid,
        subjectUid: issueRow.uid,
        subjectKind: 'issue',
        actor: input.by,
        action: 'note-removed',
        from: noteRow.uid,
        note: input.reason,
        at: now,
      });

      return {
        uid: noteRow.uid,
        issueUid: issueRow.uid,
        invalidated: true as const,
      };
    }
  );
}
