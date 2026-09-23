/**
 * embedding-observer.ts — the write layer's own post-commit embedding hook
 * (SPEC.md §4a's embedding-audit exception + §4b, FEAT-021).
 *
 * **Why this exists instead of the spec's own `createEmbeddingObserver`.**
 * §4b's `createEmbeddingObserver(semanticBackend)` is a `GraphWriteObserver`
 * registered via `createGraphBackend`'s `observers` option — it fires from
 * `GraphWriteObserver.onNodeWritten`, which only fires from INSIDE the
 * library's own `writeNode`/`writeNodeInTx` (`@adhd/sox-graph-store`,
 * verified against the published dist). `tx.ts`'s entire premise (see its
 * own opening doc comment) is that this write layer never calls those
 * library methods — every node here is written via the hand-composed,
 * tx-scoped `writeNodeTx` against a caller-opened `AdapterTransaction`, which
 * the library's own observer wiring has no way to see. So the documented
 * observer mechanism is structurally unreachable from this package, and this
 * module is the write-layer-owned replacement §4a explicitly anticipates:
 * "the write layer records an `embedding_upserted`/`embedding_deleted`/
 * `embedding_failed` audit row after the observer settles (it owns the actor
 * context the observer lacks)." Here, the write layer doesn't just RECORD
 * the outcome — it also RUNS the embed/delete round-trip itself, since there
 * is no separate observer process to run it. The verb-side contract (fire
 * strictly post-commit, never inside the subject transaction; fire-and-
 * forget unless `awaitEmbed:true`; never throw back into the caller; audit
 * every outcome including failure) is identical to §4b either way.
 *
 * **Call-site scope: create + body-changing update, never a pure touch.**
 * §4b names the triggering verbs explicitly — "the write-layer verb
 * (`create`/`update`)" — and §6.2's `awaitEmbed` behavior table says the
 * same: "kept verbatim on `create`/`update`". `update.ts` distinguishes a
 * body-changing call (→ `supersede`, a fresh node + fresh content) from a
 * pure `touch` (title/kind/priority/assignee/author — no content change, no
 * new node). This module is wired ONLY into the supersede branch: a
 * title-only touch has no new/changed CONTENT to embed, and mirrors the
 * spec's OWN documented observer precisely — `onNodeWritten` fires from
 * `writeNode`, never from `touch` (`@adhd/sox-graph-store` dist, confirmed:
 * `touch` and `writeNode` are distinct methods and only the latter is wired
 * to the observer notification). Re-embedding on every touch would also
 * silently violate §4b's own "never holds the write lock open" spirit by
 * firing a network round-trip for changes (an assignee flip, a priority
 * swap) whose embedded text — composed from `title`+`body` alone, per
 * {@link composeEmbedText} — did not change at all.
 *
 * **The old (pre-supersede) node's vector is deliberately deleted, not left
 * stale.** AC-4's literal text ("invalidating an issue removes its vector")
 * covers `delete.ts` only, and a supersede never sets `t_invalid` on the old
 * node (`tx.ts`'s own `resolveLiveIssueTx` doc comment: "the supersede CAS
 * sets `is_superseded` ONLY"). But `update.ts` resolves live issues via
 * `resolveLiveIssueTx`, which already rejects a superseded uid
 * (`StaleSupersedeError`) — so a superseded node is not reachable as a LIVE
 * issue by uid, exactly like an invalidated one, even though `t_invalid`
 * stays `NULL`. Leaving its vector in the vector space would let
 * `searchRanked`'s vec channel surface it anyway (`card.ts` never walks
 * `SUPERSEDES` chains to resolve it back to the current uid), producing a
 * phantom "issue" a semantic query returns but no `get`/`query` call can
 * open. So `update.ts` schedules BOTH a delete for the old rowid and an
 * upsert for the new one on every body change — two `IWriteStoreHandle.
 * embedding` round-trips, two independent post-commit `embedding_*` audit
 * rows (one `embedding_deleted` against the OLD uid, one `embedding_upserted`
 * against the NEW uid) — the narrower reading of AC-4 that keeps the vector
 * space consistent with what `resolveLiveIssueTx` already treats as "gone".
 */

import { writeAudit } from './audit.js';
import {
  type IEmbeddingBackend,
  type IWriteStoreHandle,
  executeWriteTransaction,
} from './tx.js';
import {
  embedDrainFor,
  type EmbedOutcome,
  type IPendingEmbed,
} from './embed-drain.js';

/**
 * The `note` every close-time drain failure carries on its `embedding_failed`
 * audit row — so a vector that was still in flight when the store closed is
 * distinguishable, in the durable audit trail, from one whose round-trip
 * itself failed (`scheduleIssueEmbedding`'s own failure note is the error
 * message). See `graph-backlog-store.ts`'s `closeGraphBacklogStore`.
 */
export const EMBED_DRAIN_TIMEOUT_NOTE =
  'embed did not settle before store close — recorded by the close-time drain (RAG-SPEC.md §2.2)';

/**
 * The exact text an issue is embedded from — `${title}\n${body}`.trim().
 * **This MUST stay byte-identical to `create-issue.ts`'s `scanForDuplicates`
 * text composition.** The two live in different files (this module vs.
 * `create-issue.ts`) and compose text for two different purposes (the
 * on-write vector vs. the pre-write duplicate-scan query vector), but both
 * ultimately populate/query the SAME vector space under the SAME `modelId`.
 * If the two ever diverge, `project_policy.dedupe_threshold`'s default (§6.4
 * point 1's own doc comment: "the scale its own default was chosen against")
 * silently stops meaning what it was calibrated against — AC-19's gate would
 * drift without any test noticing, since both sides would still "work" in
 * isolation. `create-issue.ts` imports this function rather than keeping its
 * own copy, specifically so the two call sites cannot drift apart in source.
 */
export function composeEmbedText(title: string, body: string): string {
  return `${title}\n${body}`.trim();
}

type EmbeddingAuditAction =
  | 'embedding_upserted'
  | 'embedding_deleted'
  | 'embedding_failed';

interface IScheduleEmbeddingBase {
  /** The graph node's store-adapter `rowid` the vector is keyed on — never `uid` (see {@link import('./tx.js').IEmbeddingBackend}'s own doc comment). */
  subjectRowid: number;
  /** The issue's `uid` — carried through only for the audit row's `target_uid` and diagnostic logging; never used to key the vector store. */
  subjectUid: string;
  /** The identity of whoever performed the write — the SAME `input.by` the verb's own subject-write audit row already recorded. */
  actor: string;
}

export type IScheduleEmbeddingInput =
  | (IScheduleEmbeddingBase & { action: 'upsert'; content: string })
  | (IScheduleEmbeddingBase & { action: 'delete' });

/**
 * Schedules the embed-or-delete round-trip and REGISTERS its promise with the
 * per-adapter drain registry (`write/embed-drain.ts`), so a short-lived
 * process can await it before `close()` instead of losing it. A true no-op
 * (no registration, no audit row) when `handle.embedding` is unconfigured —
 * see `IWriteStoreHandle.embedding`'s own doc comment.
 *
 * **Non-async wrapper, deliberately.** The body lives in
 * {@link runEmbedRoundTrip} so this function can register the promise it
 * creates and read its outcome without re-awaiting it. The returned promise
 * is still `Promise<void>` and still never rejects, so every existing
 * `await`/fire-and-forget call site is unchanged. Callers that omit
 * `awaitEmbed` (the default) get fire-and-forget — the close-time drain is
 * the backstop that makes it durable anyway.
 *
 * Must be called strictly AFTER the caller's own `executeWriteTransaction`
 * has resolved (i.e. after the subject transaction committed) — never from
 * inside a transaction closure. `create-issue.ts`/`update.ts`/`delete.ts`
 * each call this exactly once (twice for `update`'s body-change path — see
 * this module's own doc comment) outside their `executeWriteTransaction`
 * callback, and either await the returned promise (`awaitEmbed:true`) or
 * let it run fire-and-forget (the default).
 */
export function scheduleIssueEmbedding(
  handle: IWriteStoreHandle,
  input: IScheduleEmbeddingInput
): Promise<void> {
  const backend = handle.embedding;
  if (!backend) return Promise.resolve(); // unconfigured — true no-op, no audit row (IWriteStoreHandle.embedding's own contract)

  const settled = runEmbedRoundTrip(handle, backend, input); // never rejects (existing contract)
  const entry: IPendingEmbed = {
    subjectRowid: input.subjectRowid,
    subjectUid: input.subjectUid,
    actor: input.actor,
    action: input.action,
    settled,
    outcome: 'pending',
  };
  const unregister = embedDrainFor(handle.adapter).register(entry);
  settled.then(
    (outcome) => {
      entry.outcome = outcome;
      // A recorded outcome's disposer fires (the entry leaves the registry).
      // An `'unrecorded'` entry deliberately STAYS registered so a later
      // drain/close can observe and report it — the drain only awaits
      // `'pending'` entries, so retaining a settled one can never spin it.
      if (outcome !== 'unrecorded') unregister();
    },
    () => {
      // Contract breach: `runEmbedRoundTrip` is documented never to reject, so
      // this is unreachable in practice — but if it ever happens, surface the
      // worst case (`unrecorded`) rather than losing it. The entry stays
      // registered for the same reason as the `'unrecorded'` branch above.
      entry.outcome = 'unrecorded';
    }
  );
  return settled.then(() => undefined);
}

/**
 * Runs the embed-or-delete round-trip against `backend` and unconditionally
 * persists the outcome as one
 * `embedding_upserted`/`embedding_deleted`/`embedding_failed` audit row, in
 * its OWN follow-up `immediate` transaction opened via the SAME
 * `executeWriteTransaction` every subject write uses (§4a: "in its OWN
 * follow-up `immediate` transaction, opened after the subject write's own
 * transaction has already committed").
 *
 * **Never throws** (the contract {@link scheduleIssueEmbedding} depends on).
 * Both the embed/vector round-trip AND the audit write are individually
 * try/caught; a round-trip failure degrades to a `console.error` (§4b:
 * "degrades to a log") AND an `embedding_failed` audit row. The ONE outcome
 * §4b's "never only a log line a caller could miss" guarantee cannot fully
 * close is the audit write itself failing (driver contention/IO exhausted its
 * own retries, §4c): with no further durable sink to fall back to, this
 * returns `'unrecorded'` — the caller's drain/close reports it loudly, and it
 * never propagates back through the `create`/`update` that scheduled it.
 */
async function runEmbedRoundTrip(
  handle: IWriteStoreHandle,
  backend: IEmbeddingBackend,
  input: IScheduleEmbeddingInput
): Promise<Exclude<EmbedOutcome, 'pending'>> {
  let auditAction: EmbeddingAuditAction;
  let note: string | undefined;

  try {
    if (input.action === 'upsert') {
      const vector = await backend.embedDocument(input.content);
      await backend.upsertVector(input.subjectRowid, vector);
      auditAction = 'embedding_upserted';
    } else {
      await backend.deleteVector(input.subjectRowid);
      auditAction = 'embedding_deleted';
    }
  } catch (err) {
    auditAction = 'embedding_failed';
    note = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console -- §4b: "the observer logs the error for operator visibility" — this IS that log, there being no separate observer process.
    console.error(
      `scheduleIssueEmbedding: embed round-trip failed for issue uid="${input.subjectUid}" (action="${input.action}") — degrading to an "embedding_failed" audit row.`,
      err
    );
  }

  try {
    await executeWriteTransaction(handle, async (tx) => {
      await writeAudit({
        tx,
        typePolicy: handle.typePolicy,
        subjectRowid: input.subjectRowid,
        subjectUid: input.subjectUid,
        subjectKind: 'issue',
        actor: input.actor,
        action: auditAction,
        note,
      });
    });
  } catch (auditErr) {
    // eslint-disable-next-line no-console
    console.error(
      `scheduleIssueEmbedding: failed to persist "${auditAction}" audit row for issue uid="${input.subjectUid}" — the embedding outcome itself is unrecorded.`,
      auditErr
    );
    return 'unrecorded';
  }

  switch (auditAction) {
    case 'embedding_upserted':
      return 'upserted';
    case 'embedding_deleted':
      return 'deleted';
    case 'embedding_failed':
      return 'failed';
  }
}

/**
 * Records each still-unsettled embed as a durable `embedding_failed` audit
 * row, BEFORE the store connection closes — the whole point of the bounded
 * drain. Called by `graph-backlog-store.ts`'s `closeGraphBacklogStore` with
 * the `stillPending` list from a timed-out drain.
 *
 * Per entry: one `executeWriteTransaction` + `writeAudit` with the
 * {@link EMBED_DRAIN_TIMEOUT_NOTE}. An entry whose audit write throws lands in
 * `unrecorded` (its outcome is not durably recorded anywhere) rather than
 * failing the whole loop — the remaining entries still get their chance.
 */
export async function recordUnsettledEmbedsAsFailed(
  handle: IWriteStoreHandle,
  pending: readonly IPendingEmbed[]
): Promise<{ recorded: IPendingEmbed[]; unrecorded: IPendingEmbed[] }> {
  const recorded: IPendingEmbed[] = [];
  const unrecorded: IPendingEmbed[] = [];
  for (const entry of pending) {
    try {
      await executeWriteTransaction(handle, async (tx) => {
        await writeAudit({
          tx,
          typePolicy: handle.typePolicy,
          subjectRowid: entry.subjectRowid,
          subjectUid: entry.subjectUid,
          subjectKind: 'issue',
          actor: entry.actor,
          action: 'embedding_failed',
          note: EMBED_DRAIN_TIMEOUT_NOTE,
        });
      });
      entry.outcome = 'failed';
      recorded.push(entry);
    } catch (auditErr) {
      entry.outcome = 'unrecorded';
      unrecorded.push(entry);
      // eslint-disable-next-line no-console
      console.error(
        `recordUnsettledEmbedsAsFailed: could not persist the "embedding_failed" audit row for issue uid="${entry.subjectUid}" — this embed outcome is UNRECORDED.`,
        auditErr
      );
    }
  }
  return { recorded, unrecorded };
}
