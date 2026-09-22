/**
 * vocabulary-guard.ts — fail LOUDLY when a store is written under a node
 * vocabulary this build does not recognize.
 *
 * ## The failure this exists to stop
 *
 * This build reads and writes backlog items as nodes of `kind: 'issue'`. A
 * store written by a build whose item vocabulary was something else holds
 * items under a DIFFERENT kind, so every item read here matches zero rows:
 * the query path reports `{ok:true, total:0}` against a full store, and a
 * write fails with a confusing downstream error about a missing project.
 * A healthy store looks empty and every caller is told it succeeded. The
 * data is intact — nothing can see it. That is silent data loss.
 *
 * The guard converts that silence into ONE self-explaining failure: a store
 * that holds live nodes but NONE of a kind this build understands is refused
 * outright, with the expected vocabulary, the vocabularies actually present,
 * and the likely cause named in the error.
 *
 * ## Where it runs — twice, deliberately
 *
 *  - At store open ({@link assertRecognizedStoreVocabulary} called from
 *    `openGraphBacklogStore`) — a process that starts against an unrecognized
 *    store fails immediately instead of serving emptiness.
 *  - On the read and write paths — `query/query.ts`'s `queryIssuesWithMeta`
 *    (via the optional `IQueryStoreHandle.assertVocabulary` member) and
 *    `api.ts`'s `writeHandle`. A long-lived process that opened the store
 *    while it was fine, and is later pointed at a store rewritten by another
 *    process, must still catch the change — which a startup-only check
 *    structurally cannot do.
 *
 * ## The criterion
 *
 * The guard refuses a store iff it is NON-EMPTY and its live-node kinds are
 * ENTIRELY outside {@link RECOGNIZED_NODE_KINDS}. Both halves matter:
 *  - an empty store (zero live nodes) is a fresh store — a read of it
 *    correctly returns zero, and refusing it would be a false positive;
 *  - a store holding only recognized catalog rows (a freshly created project,
 *    say) is legitimately item-empty and must NOT be refused.
 * Only a store whose whole vocabulary is foreign is refused.
 */
import type { StoreAdapter } from '@adhd/sox-store-adapter';

/** The node kind every backlog ITEM is stored under. The read path filters `kind:'issue'`, so a store holding items under any other kind reads as empty. */
export const ITEM_NODE_KIND = 'issue';

/**
 * Every node kind this build's write layer composes — the authoritative list
 * is `write/tx.ts`'s `IWriteNodeTxInput.kind` doc comment (SPEC.md §3): the
 * catalog kinds, the resolved-only kinds, and every subject kind. A store
 * whose live nodes are entirely outside this set was written by a build
 * speaking a different vocabulary.
 */
export const RECOGNIZED_NODE_KINDS: ReadonlySet<string> = new Set([
  'project',
  'component',
  'location',
  'issue',
  'kind',
  'edge_kind',
  'status',
  'priority',
  'agent',
  'note',
  'citation',
  'transition',
  'audit',
]);

/** One row of the live-node kind histogram. */
export interface IObservedKind {
  kind: string;
  count: number;
}

/**
 * A store whose live-node vocabulary this build does not recognize. Carries
 * the observed histogram and the expected kind set as structured fields so a
 * caller (e.g. the `doctor` CLI diagnostic) can render them without parsing
 * the message.
 */
export class StoreVocabularyMismatchError extends Error {
  constructor(
    readonly observed: readonly IObservedKind[],
    readonly recognized: readonly string[]
  ) {
    const observedText =
      observed.length > 0
        ? observed.map((o) => `${o.kind}=${o.count}`).join(', ')
        : '(none)';
    super(
      'backlog: store vocabulary mismatch — refusing to read or write a store this build cannot address.\n' +
        `  expected node kind(s): ${recognized.join(', ')}\n` +
        `  found in store:        ${observedText}\n` +
        '  The store holds live node(s) but none of a kind this build recognizes, so every item read would match zero rows and report a misleading "0 items".\n' +
        '  Likely cause: this store was written by a build with a different item vocabulary and was never converted to the one this build uses. Refusing rather than returning an empty result.'
    );
    this.name = 'StoreVocabularyMismatchError';
  }
}

/**
 * Read the store's live-node kind histogram. A pure read — it never writes,
 * so it is safe to run against any store, including the live one.
 */
export async function inspectStoreVocabulary(
  adapter: StoreAdapter
): Promise<{ total: number; observed: IObservedKind[] }> {
  const { rows } = await adapter.executeAll<{ kind: unknown; n: unknown }>(
    'SELECT kind, COUNT(*) AS n FROM node WHERE t_invalid IS NULL GROUP BY kind ORDER BY n DESC'
  );
  const observed = rows.map((r) => ({
    kind: String(r.kind),
    count: Number(r.n),
  }));
  const total = observed.reduce((sum, o) => sum + o.count, 0);
  return { total, observed };
}

/**
 * Assert the store's live nodes speak a vocabulary this build understands.
 *
 * Passes (no throw) when the store is empty, or when at least one live node
 * is of a recognized kind. Throws {@link StoreVocabularyMismatchError} when
 * the store holds live nodes but none of a recognized kind.
 */
export async function assertRecognizedStoreVocabulary(
  adapter: StoreAdapter
): Promise<void> {
  const { total, observed } = await inspectStoreVocabulary(adapter);
  if (total === 0) return; // fresh/empty store — a read of it is a true zero
  if (observed.some((o) => RECOGNIZED_NODE_KINDS.has(o.kind))) return;
  throw new StoreVocabularyMismatchError(observed, [
    ...RECOGNIZED_NODE_KINDS,
  ]);
}
