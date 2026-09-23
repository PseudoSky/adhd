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
 *
 * ## Bounded, because it runs on the hot path
 *
 * The criterion is decided by a single `LIMIT 1` existence probe — "is there
 * at least one live node of a RECOGNIZED kind?" — which passes and stops. That
 * probe is the whole cost on the healthy path; the O(live nodes) `GROUP BY
 * kind` histogram runs ONLY when the probe finds nothing, because that is the
 * one branch whose output (the observed vocabulary) is the diagnostic the
 * refusal error carries. The full histogram is never paid per verb.
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
 * Bounded criterion check: `true` iff at least one live node is of a kind this
 * build recognizes. `LIMIT 1` — the store stops at the first match, so this is
 * O(1) on the healthy path and never the O(live nodes) histogram. The kinds are
 * bound as query parameters (never string-interpolated), one placeholder each.
 */
async function hasRecognizedLiveNode(adapter: StoreAdapter): Promise<boolean> {
  const kinds = [...RECOGNIZED_NODE_KINDS];
  const placeholders = kinds.map(() => '?').join(', ');
  const { rows } = await adapter.executeAll<{ one: unknown }>(
    `SELECT 1 AS one FROM node WHERE t_invalid IS NULL AND kind IN (${placeholders}) LIMIT 1`,
    kinds
  );
  return rows.length > 0;
}

/**
 * Assert the store's live nodes speak a vocabulary this build understands.
 *
 * Passes (no throw) when the store is empty, or when at least one live node
 * is of a recognized kind. Throws {@link StoreVocabularyMismatchError} when
 * the store holds live nodes but none of a recognized kind.
 *
 * BOUNDED BY CONSTRUCTION: this runs on every write verb (`api.ts`'s
 * `writeHandle`) and every query (`api.ts`'s `queryHandle` → `query.ts`), so it
 * must not scan the store per call. The criterion is answered by a single
 * `LIMIT 1` existence probe ({@link hasRecognizedLiveNode}); only when that
 * finds no recognized node — the empty-store and foreign-store cases — does the
 * full histogram run, and there it is either trivial (no rows) or the payload
 * of the error we are about to throw.
 */
export async function assertRecognizedStoreVocabulary(
  adapter: StoreAdapter
): Promise<void> {
  // Healthy path: one bounded probe, then stop. A recognized live node means
  // the store speaks this build's vocabulary — nothing more to learn.
  if (await hasRecognizedLiveNode(adapter)) return;

  // No recognized live node. Either the store is empty (a true zero — pass) or
  // its whole live vocabulary is foreign (refuse, with the histogram as the
  // diagnostic). Only this branch pays for the full `GROUP BY kind` read.
  const { total, observed } = await inspectStoreVocabulary(adapter);
  if (total === 0) return; // fresh/empty store — a read of it is a true zero
  throw new StoreVocabularyMismatchError(observed, [
    ...RECOGNIZED_NODE_KINDS,
  ]);
}
