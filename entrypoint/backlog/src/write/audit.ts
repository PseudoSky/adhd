/**
 * audit.ts — the single `writeAudit` helper (SPEC.md §4a).
 *
 * "No bare mutation. Every state change writes an `audit` node
 * (`actor`/`action`/`target_uid`/`from`/`to`/`note`/`sha`/`at`) linked by an
 * `audits` edge, emitted by a single `writeAudit` helper at the end of each
 * write transaction — automatic, cannot be forgotten."
 *
 * §4c ("§4a audit-write atomicity") makes this a hard requirement, not a
 * stylistic one: `writeAudit`'s INSERT (and its `audits` edge) MUST execute
 * against the SAME `tx` handle, inside the SAME `immediate` transaction, as
 * the subject write it records — never a separate call, never after the
 * subject transaction has committed. This repo has already produced the
 * failure mode a non-atomic audit write causes
 * (`BUG-BACKLOG-AUDIT-WRITE-FAILS-COMMITTED-CLAIM-001`,
 * `concurrency-scale.spec.ts:303-325`) — an audit call running AFTER the
 * subject write had already committed, with no busy-retry or containment of
 * its own. Every call site below passes the verb's own open `tx`; there is
 * no other way to call this function.
 *
 * The ONE structural exception — the embedding audit row
 * (`embedding_upserted`/`embedding_deleted`/`embedding_failed`, §4a/§4b) — is
 * NOT implemented here. It depends on `createEmbeddingObserver`'s post-commit
 * round-trip, which cannot even start until the subject transaction has
 * committed, so it necessarily runs in its OWN follow-up transaction, opened
 * by a caller that still holds a subject `uid` after this module's
 * transaction has already returned. That caller — and the embedding-observer
 * wiring itself — is out of scope for this slice (see create-issue.ts's own
 * `awaitEmbed` doc comment for the specific gap this leaves).
 */

import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import type { TypePolicy } from '@adhd/sox-graph-store';
import { resolveEdgeKindTx } from './catalog.js';
import { canonicalJSONStringify, nowISO, sha256Hex, writeEdgeTx, writeNodeTx } from './tx.js';

export interface IWriteAuditInput {
  tx: AdapterTransaction;
  typePolicy: TypePolicy;
  /** The node the `audits` edge points FROM — any kind, per `audits`' declared `source_kind: '*'` sentinel (§2). */
  subjectRowid: number;
  subjectUid: string;
  subjectKind: string;
  /** The acting identity — the verb's own `by` (or the resolved `agent` catalog name), never the raw unresolved input. */
  actor: string;
  /** e.g. `'created'`, `'claimed'`, `'released'`, `'renewed'`, `'reclaimed-stale'`, `'transitioned'`, `'moved'`, `'related'`, `'deleted'`. */
  action: string;
  from?: string;
  to?: string;
  note?: string;
  /** Defaults to `nowISO()`. Accepted explicitly so a verb that already computed `now` for its subject write reuses the identical timestamp rather than a microsecond-later second call. */
  at?: string;
}

export interface IAuditWriteResult {
  rowid: number;
  uid: string;
  sha: string;
}

/**
 * Write one `audit` node + its `audits` edge, against the SAME `tx` the
 * caller's own subject write already opened. `sha` is computed HERE,
 * unconditionally — "automatic, cannot be forgotten" (§4a) — as `sha256` over
 * the canonical (sorted-key) JSON serialization of the audit's own recorded
 * fields (DATA_MODEL.md §10 point 2: "the same convention SPEC.md §4a
 * already states for the audit `sha`," applied identically to how
 * `transition.sha` is computed — never hashing external content, unlike a
 * `citation`'s `sha`, §8.5).
 */
export async function writeAudit(input: IWriteAuditInput): Promise<IAuditWriteResult> {
  const at = input.at ?? nowISO();
  const canonicalFields: Record<string, unknown> = {
    actor: input.actor,
    action: input.action,
    target_uid: input.subjectUid,
    from: input.from ?? null,
    to: input.to ?? null,
    note: input.note ?? null,
    at,
  };
  const sha = sha256Hex(canonicalJSONStringify(canonicalFields));

  const metadata = { ...canonicalFields, sha };
  const audit = await writeNodeTx(input.tx, {
    at,
    kind: 'audit',
    name: input.action,
    content: input.note ?? input.action,
    metadata,
  });

  const rule = await resolveEdgeKindTx(input.tx, 'audits');
  await writeEdgeTx(input.tx, {
    at,
    srcRowid: input.subjectRowid,
    srcUid: input.subjectUid,
    srcKind: input.subjectKind,
    dstRowid: audit.rowid,
    dstUid: audit.uid,
    dstKind: 'audit',
    rel: 'audits',
    rule,
    typePolicy: input.typePolicy,
  });

  return { rowid: audit.rowid, uid: audit.uid, sha };
}
