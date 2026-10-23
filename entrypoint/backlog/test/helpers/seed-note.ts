/**
 * seed-note.ts — test-only fixture helpers for `remove-note` (0f9b6132).
 *
 * No production write path lets a test choose a note's recorded `author`, nor
 * set a project's `policy.noteRemovers` allow-list, so these helpers write the
 * rows directly against the REAL store. They mirror the exact node/edge shape
 * `create-issue.ts`'s duplicate-`comment` branch writes (kind `note`, metadata
 * `{ author, text, at }`, a `has_note` edge from the issue). Nothing here is a
 * mock: the rows land in the real `node`/`edge` tables and are read back by the
 * production verbs under test.
 */
import { getNodeByUidTx, nowISO, writeEdgeTx, writeNodeTx, type IWriteStoreHandle } from '../../src/write/tx.js';
import { resolveEdgeKindTx } from '../../src/write/catalog.js';

export interface ISeedNoteInput {
  /** The owning issue's uid. */
  issueUid: string;
  /** The note text. */
  text: string;
  /**
   * The recorded author. OMIT to seed a legacy note with no `metadata.author`
   * (the author-less case `removeNote` must refuse for any non-listed actor).
   */
  author?: string;
}

/** Seed one live `note` attached to a live issue via `has_note`. Returns the note's uid and rowid. */
export async function seedNote(
  handle: IWriteStoreHandle,
  input: ISeedNoteInput
): Promise<{ uid: string; rowid: number }> {
  return handle.adapter.transaction(async (tx) => {
    const issue = await getNodeByUidTx(tx, input.issueUid);
    if (!issue) throw new Error(`seedNote: no issue with uid "${input.issueUid}"`);
    const now = nowISO();
    const metadata: Record<string, unknown> = { text: input.text, at: now };
    if (input.author !== undefined) metadata['author'] = input.author;
    const note = await writeNodeTx(tx, { kind: 'note', content: input.text, metadata, at: now });
    const rule = await resolveEdgeKindTx(tx, 'has_note');
    await writeEdgeTx(tx, {
      at: now,
      srcRowid: issue.rowid,
      srcUid: issue.uid,
      srcKind: 'issue',
      dstRowid: note.rowid,
      dstUid: note.uid,
      dstKind: 'note',
      rel: 'has_note',
      rule,
      typePolicy: handle.typePolicy,
    });
    return { uid: note.uid, rowid: note.rowid };
  });
}

/**
 * Set `project.metadata.policy.noteRemovers` on a live project, leaving every
 * other policy key and metadata key untouched (`json_set`, never a replace).
 */
export async function setProjectNoteRemovers(
  handle: IWriteStoreHandle,
  projectUid: string,
  noteRemovers: readonly string[]
): Promise<void> {
  const result = await handle.adapter.executeRun(
    `UPDATE node SET meta = json_set(COALESCE(meta, '{}'), '$.policy.noteRemovers', json(?))
      WHERE uid = ? AND kind = 'project' AND t_invalid IS NULL`,
    [JSON.stringify([...noteRemovers]), projectUid]
  );
  if (result.rowsAffected !== 1) {
    throw new Error(`setProjectNoteRemovers: expected 1 live project "${projectUid}", updated ${result.rowsAffected}`);
  }
}
