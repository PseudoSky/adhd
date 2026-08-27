/**
 * ids.ts — human-id allocation (DESIGN.md §2.4).
 *
 * `allocateHumanIdAndInsert` (BUG-BACKLOG-CONCURRENT-ID-ALLOCATION-RACE-001)
 * runs id-resolution AND the caller's insert in ONE `.immediate()`
 * transaction — the two used to be split across separate transactions
 * (compute-next-id here, commit; insert-the-node later, in a second,
 * unrelated write), which left a genuine TOCTOU window: two concurrent
 * `createItem` calls for the same `(repo, family)` could each compute the
 * SAME "max + 1" before either one's node existed yet, and both mint a node
 * claiming the identical humanId — a silent violation of the "humanId is
 * unique within (repo, family)" invariant (SPEC.md §4.1), discovered via the
 * MIGRATION.md §3.3 20-writer scale test (13/20 unique ids under real
 * concurrency, not 20). Wrapping BOTH steps in the same `BEGIN IMMEDIATE`
 * transaction — the identical mechanism `mutate-metadata.ts`/`claim.ts`
 * already rely on for their own CAS correctness — closes the window: no two
 * concurrent `.immediate()` transactions can interleave.
 *
 * BUG-BACKLOG-COMPUTENEXTHUMANID-GRAPH-ONLY-SCAN-001: that fix made
 * "resolve the id" and "insert the node" atomic against EACH OTHER, but it
 * never addressed WHAT `computeNextHumanId` actually scans to find "the
 * current max" — the public `GraphBackend.queryNodes()` it called ALWAYS
 * excludes invalidated (`t_invalid IS NOT NULL`, i.e. soft-deleted/
 * tombstoned) nodes, with no filter flag to opt back in (verified by reading
 * `@adhd/sox-graph-store`'s `queryNodes()`, which hardcodes
 * `buildNodeFilterClause(filter, /* liveOnly *\/ true, 'n')`). A tombstoned
 * node still carries the humanId it was minted with forever —
 * `softDeleteItemNode`/`supersedeItemNode` (crud.ts / structure.ts) never
 * touch that field — so scanning only LIVE nodes for "the max already
 * taken" can compute a "next" id that a DEAD node already holds, silently
 * re-minting a tombstoned identity onto a brand-new, unrelated item. This is
 * not hypothetical: querying the real production store directly (2026-08-21,
 * read-only, via `@adhd/sox-store-adapter`, bypassing this exact
 * `queryNodes` limitation on purpose to look) found 20 existing
 * `(namespace, humanId)` pairs where a LIVE node's humanId is ALSO held by
 * an invalidated node — see `id-uniqueness.spec.ts`'s header for the exact
 * queries and counts. Fix: `computeNextHumanId` now runs the IDENTICAL
 * filter `queryNodes` builds, but via `buildNodeFilterClause(...,
 * liveOnly=false, ...)` (the same public helper `@adhd/sox-graph-store`
 * itself uses internally) over `store.adapter.executeAll` directly — the
 * same sanctioned raw-SQL escape hatch `crud.ts` / `structure.ts` /
 * `repo-migration.ts` already reach for when the public `GraphBackend`
 * surface doesn't expose what's needed (DESIGN.md §14). This scan still runs
 * inside the SAME `.immediate()` transaction as the insert, so it inherits
 * exactly the same concurrency guarantee the fix above already established
 * — only WHICH rows are visible to the max-scan changed, not the atomicity.
 *
 * DEBT-BACKLOG-HUMANID-NOT-UNIQUE-001: the in-app scan above (both before
 * and after the fix immediately above it) is the ONLY thing that ever stood
 * between two writers and a genuine `humanId` collision — nothing in the
 * schema enforced it, despite every lookup in this package
 * (`findItemNode`/`findLiveByHumanId` below) treating `(repo, humanId)` as
 * if it WERE a unique key. A consumer that keys a `Map`/`Set` on `humanId`
 * (as happened over the course of this very session) silently drops one of
 * two colliding rows with no error at all. Closed at the store boundary: a
 * partial `UNIQUE` index over LIVE rows only (`t_invalid IS NULL`), scoped
 * to backlog-item-tagged nodes so it never collides with the UNRELATED
 * `backlog-audit-event` rows that legitimately carry the SAME
 * `meta.humanId` value (pointing at the item their entry documents, not
 * claiming to BE that item). This was verified safe to add, not merely
 * assumed: querying the real production store directly (2026-08-21,
 * read-only) found 1271 live backlog-item nodes and ZERO
 * `(namespace, humanId)` groups with more than one LIVE row under this
 * EXACT (tag-scoped) predicate — a single row (rowid 654,
 * `PseudoSky/adhd::FEAT-APIGEN-TS-TYPE-CODEGEN-001`) would have collided
 * under a naive, untagged grouping, and turned out to be a
 * `backlog-audit-event` row, not a second backlog item — confirming the tag
 * scope is load-bearing, not merely cautious. No reconciliation step was
 * needed: the constraint would not have rejected any row that exists in the
 * real store today. See `id-uniqueness.spec.ts`'s header for the exact
 * queries run and their output.
 */
import { buildNodeFilterClause, type NodeFilter, type NodeRecord } from '@adhd/sox-graph-store';
import type { GraphBacklogStore } from './graph-backlog-store.js';
import { AmbiguousHumanIdError, InvalidArgumentError } from '../model.js';
import { BACKLOG_ITEM_TAG, isLiveBacklogItemNode, type BacklogNodeMeta } from './mapping.js';
import { withImmediateRetry } from './immediate-retry.js';

/**
 * DEBT-BACKLOG-HUMANID-NOT-UNIQUE-001's enforcement primitive: a partial
 * `UNIQUE` index over `(namespace, meta.humanId)`, restricted to LIVE
 * (`t_invalid IS NULL`) backlog-item-tagged rows. See the file-header doc
 * comment above for the full justification and the live-data verification
 * that makes this safe to add unconditionally.
 *
 * `instr(tags, '"${BACKLOG_ITEM_TAG}"')` (rather than `json_each`, which
 * `buildNodeFilterClause` uses for regular queries) is deliberate: SQLite
 * partial-index predicates must be simple deterministic expressions, not
 * correlated subqueries against another table-valued function — `json_each`
 * is not usable here. Matching the literal, double-quoted JSON token is
 * exact (not a loose substring test): a JSON array serializes each string
 * element wrapped in its own quotes and separated by commas/brackets, so
 * `"backlog-item"` can only appear as this substring when `backlog-item` is
 * itself a full array element — a longer tag like `"backlog-item-x"` or
 * `"x-backlog-item"` never produces this exact quoted substring. Verified
 * against the real production store (2026-08-21): the `instr(...)` predicate
 * and a plain `tags LIKE '%backlog-item%'` scan agreed on every single row
 * (zero rows differed) — see `id-uniqueness.spec.ts`'s header.
 */
const HUMAN_ID_LIVE_UNIQUE_INDEX = 'ix_backlog_humanid_live_unique';

/**
 * Idempotently ensures the partial unique index above exists — `IF NOT
 * EXISTS` makes every call after the first a cheap `sqlite_master` lookup,
 * so this is safe to call on every allocation rather than needing its own
 * one-time bootstrap hook (this file does not own `graph-backlog-store.ts`,
 * where `applySchema()` lives, so a call site there is not an option
 * anyway). Always invoked from INSIDE the same retried `.immediate()`
 * transaction as the mint itself (never a separate, unretried DDL call) —
 * DDL is fully transactional in SQLite, so this commits atomically with
 * whatever insert follows it, and a busy/locked contention on the DDL
 * itself is retried by the SAME `withImmediateRetry` wrapper the whole
 * transaction already goes through.
 */
async function ensureHumanIdUniqueIndex(store: GraphBacklogStore): Promise<void> {
  await store.adapter.executeRun(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${HUMAN_ID_LIVE_UNIQUE_INDEX}
    ON node (namespace, json_extract(meta, '$.humanId'))
    WHERE t_invalid IS NULL
      AND json_extract(meta, '$.humanId') IS NOT NULL
      AND instr(tags, '"${BACKLOG_ITEM_TAG}"') > 0
  `);
}

/**
 * Best-effort JSON parse of the raw `node.meta` column. `computeNextHumanId`
 * below reads `meta` directly via raw SQL (to reach invalidated rows
 * `queryNodes`'s `NodeRecord` mapping would otherwise hide — see the file
 * header), so it does not get `NodeRecord.metadata`'s parsing for free.
 * Malformed JSON degrades to "no humanId visible here" rather than throwing
 * — the same as a node with no `meta` at all — since a single corrupt row
 * must never abort the whole max-scan.
 */
function parseNodeMeta(raw: string | null): Partial<BacklogNodeMeta> | undefined {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw) as Partial<BacklogNodeMeta>;
  } catch {
    return undefined;
  }
}

async function scanMaxOrdinal(store: GraphBacklogStore, repo: string, family: string): Promise<number> {
  // BUG-BACKLOG-HUMANID-COLLISION-001 fix #1 (authoritative, in-transaction
  // guard): mirrors `createItemNode`'s early check, but here — inside the
  // SAME `.immediate()` transaction that actually mints the humanId — so
  // EVERY caller that reaches this function (not just `createItemNode`'s
  // fast path, e.g. `supersedeItemNode` in structure.ts, which calls
  // `allocateHumanIdAndInsert` directly) is covered. Without this, an
  // `undefined`/empty `family` reaching the template literal below silently
  // stringifies to the literal `"undefined"`, minting a colliding
  // `humanId: "undefined-001"`.
  if (typeof family !== 'string' || family.trim().length === 0) {
    throw new InvalidArgumentError(
      'family',
      `backlog: cannot allocate a humanId for repo=${JSON.stringify(repo)} — "family" is required and must be a ` +
        `non-empty string, received ${JSON.stringify(family)}. See BUG-BACKLOG-HUMANID-COLLISION-001.`
    );
  }
  // BUG-BACKLOG-COMPUTENEXTHUMANID-GRAPH-ONLY-SCAN-001: this used to be
  // `store.graph.queryNodes({ kind: 'generic', tags: [BACKLOG_ITEM_TAG],
  // namespace: repo, metadata: { family } })` — which ALWAYS excludes
  // invalidated nodes (see the file-header doc comment). `buildNodeFilterClause`
  // is the exact same filter-building primitive `queryNodes` uses
  // internally, called here with `liveOnly=false` so invalidated rows are
  // included in the max-scan too — everything else (the tag/namespace/
  // family match) is byte-identical to what `queryNodes` would have built.
  const nodeFilter: NodeFilter = { kind: 'generic', tags: [BACKLOG_ITEM_TAG], namespace: repo, metadata: { family } };
  const { where, params } = buildNodeFilterClause(nodeFilter, false, 'n');
  const { rows } = await store.adapter.executeAll<{ meta: string | null }>(`SELECT n.meta AS meta FROM node n ${where}`, params);
  let max = 0;
  for (const row of rows) {
    const meta = parseNodeMeta(row.meta);
    const match = /-(\d+)$/.exec(meta?.humanId ?? '');
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

/**
 * BUG-039 / DEBT-BACKLOG-MONOTONIC-HUMANID-001 — the allocator is a COUNTER,
 * not a scan.
 *
 * `scanMaxOrdinal` above is a read-max-then-write: every `create` read every
 * row of the family and took `max + 1`. That single shape is what forced the
 * entire concurrency-control stack around this package — `.immediate()`
 * escalation, `withImmediateRetry`, the partial unique index as a backstop —
 * and it is STILL wrong across processes: two writers on separate connections
 * can read the same max from their own WAL snapshot and both mint it. That is
 * exactly BUG-039's silent-write-loss mechanism, and no amount of retrying or
 * locking fixes a read-modify-write that reads stale.
 *
 * A one-row-per-`(namespace, family)` counter dissolves it. `UPDATE ... SET
 * n = n + 1 ... RETURNING n` is evaluated BY THE ENGINE against the row it is
 * writing under the write lock, so it never observes a stale snapshot, never
 * scans, and cannot hand the same ordinal to two writers. It is also immune to
 * the tombstone-visibility bug class the file header documents: the counter
 * only ever moves forward, so invalidating a row can never make a previously
 * minted ordinal look free again.
 *
 * The scan survives ONLY as the one-time seed for a family whose counter row
 * does not exist yet — which is how the 1300+ items already in the production
 * store keep their ids without a migration.
 */
const HUMAN_ID_COUNTER_TABLE = 'backlog_humanid_counter';

async function ensureHumanIdCounterTable(store: GraphBacklogStore): Promise<void> {
  await store.adapter.executeRun(`
    CREATE TABLE IF NOT EXISTS ${HUMAN_ID_COUNTER_TABLE} (
      namespace TEXT NOT NULL,
      family    TEXT NOT NULL,
      n         INTEGER NOT NULL,
      PRIMARY KEY (namespace, family)
    )
  `);
}

/**
 * Atomically allocate the next ordinal for `(repo, family)`.
 *
 * Hot path is a SINGLE statement with no scan. The cold path (first item ever
 * minted for a family, including every family already in an existing store)
 * seeds from `scanMaxOrdinal` and then upserts — the `ON CONFLICT ... n + 1`
 * makes the seed itself safe against a concurrent writer that seeded first,
 * so even the cold path cannot hand out a duplicate.
 */
async function nextOrdinal(store: GraphBacklogStore, repo: string, family: string): Promise<number> {
  // BUG-BACKLOG-HUMANID-COLLISION-001: this guard used to live in the scan.
  // The scan is now the COLD path only, so it must be re-asserted here or an
  // empty/undefined family would stringify to a colliding `"undefined-001"`
  // on every allocation after the first.
  if (typeof family !== 'string' || family.trim().length === 0) {
    throw new InvalidArgumentError(
      'family',
      `backlog: cannot allocate a humanId for repo=${JSON.stringify(repo)} — "family" is required and must be a ` +
        `non-empty string, received ${JSON.stringify(family)}. See BUG-BACKLOG-HUMANID-COLLISION-001.`
    );
  }
  const bumped = await store.adapter.executeAll<{ n: number }>(
    `UPDATE ${HUMAN_ID_COUNTER_TABLE} SET n = n + 1 WHERE namespace = ? AND family = ? RETURNING n`,
    [repo, family]
  );
  const hit = bumped.rows[0]?.n;
  if (typeof hit === 'number') return hit;

  // Cold path: no counter row yet — seed from the existing rows ONCE.
  const seeded = await scanMaxOrdinal(store, repo, family);
  const created = await store.adapter.executeAll<{ n: number }>(
    `INSERT INTO ${HUMAN_ID_COUNTER_TABLE} (namespace, family, n) VALUES (?, ?, ?)
     ON CONFLICT(namespace, family) DO UPDATE SET n = n + 1
     RETURNING n`,
    [repo, family, seeded + 1]
  );
  const n = created.rows[0]?.n;
  if (typeof n !== 'number') {
    throw new Error(
      `backlog: humanId counter for ${JSON.stringify(repo)}/${JSON.stringify(family)} returned no ordinal — refusing to mint an id`
    );
  }
  return n;
}

/**
 * Keep the counter at or ahead of an explicitly supplied id.
 *
 * Without this, `idOverride` would be invisible to the counter (the old scan
 * saw every row, so it handled overrides for free) and a later auto-allocation
 * could mint straight into an id an override already took. Moves the counter
 * FORWARD only — never rewinds it.
 */
async function reconcileCounterForOverride(store: GraphBacklogStore, repo: string, humanId: string): Promise<void> {
  const match = /^(.*)-(\d+)$/.exec(humanId);
  if (!match) return;
  const [, overrideFamily, ordinal] = match;
  await store.adapter.executeRun(
    `INSERT INTO ${HUMAN_ID_COUNTER_TABLE} (namespace, family, n) VALUES (?, ?, ?)
     ON CONFLICT(namespace, family) DO UPDATE SET n = MAX(n, excluded.n)`,
    [repo, overrideFamily, Number(ordinal)]
  );
}

function formatHumanId(family: string, ordinal: number): string {
  return `${family}-${String(ordinal).padStart(3, '0')}`;
}

async function findLiveByHumanId(store: GraphBacklogStore, repo: string, humanId: string): Promise<NodeRecord | null> {
  // BUG-BACKLOG-IMPORT-TOMBSTONE-BLOCKS-RECREATE-001: this is the authoritative
  // in-transaction existence check `createItemNode` relies on to decide
  // create-vs-idempotent-noop. It MUST agree with `findItemNode`
  // (query.ts) — which filters `isLiveBacklogItemNode` — or the two disagree:
  // a soft-deleted (invalidated) node with this humanId made this function
  // return the TOMBSTONE, so the insert short-circuited to created:false, but
  // every downstream lookup (`updateItemNode`→`requireItemNode`→`findItemNode`)
  // then failed with "backlog item not found" because those DO filter dead
  // nodes — leaving a real markdown item (e.g. a distinct bug reusing an id a
  // prior supersede/merge tombstoned) permanently unimportable. A soft-deleted
  // id must read as ABSENT here so re-import resurrects it as a fresh live node.
  const nodes = await store.graph.queryNodes({ kind: 'generic', tags: [BACKLOG_ITEM_TAG], namespace: repo, metadata: { humanId } });
  const live = nodes.filter(
    (n) => isLiveBacklogItemNode(n) && (n.metadata as Partial<BacklogNodeMeta> | undefined)?.humanId === humanId,
  );
  // BUG-BACKLOG-HUMANID-COLLISION-001 fix #2: more than one live node
  // sharing this exact (repo, humanId) key is a pre-existing data-integrity
  // defect (the "undefined-001" collisions) — refuse to silently pick one
  // (this used to be `nodes.find(...)`, which took whichever node the query
  // happened to return first) rather than let `allocateHumanIdAndInsert`'s
  // idOverride path silently treat the wrong node as "the existing item".
  if (live.length > 1) {
    throw new AmbiguousHumanIdError(repo, humanId, live.map((n) => n.id));
  }
  return live[0] ?? null;
}

/**
 * Resolves the humanId to insert under (either `idOverride`, re-verified for
 * an already-live node, or the next auto-allocated `family-NNN`) and invokes
 * `insert(humanId, existing)` — ALL inside one retried `.immediate()`
 * transaction, so no other concurrent `.immediate()`-wrapped write can
 * interleave between "the id was resolved" and "a node claiming it landed".
 * `existing` is the already-live node under `idOverride` (re-checked HERE,
 * not just by an earlier, racy caller-side check) — `insert` is expected to
 * short-circuit on a non-null `existing` exactly like `createItemNode`'s
 * documented idempotent-reimport behavior, but now race-free.
 *
 * `ensureHumanIdUniqueIndex` runs first, on BOTH branches (not just the
 * auto-mint path) — DEBT-BACKLOG-HUMANID-NOT-UNIQUE-001's DB-level backstop
 * must exist before ANY insert this function drives, including an
 * `idOverride`-only import flow that might be the very first write a fresh
 * store ever sees.
 */
export async function allocateHumanIdAndInsert<T>(
  store: GraphBacklogStore,
  repo: string,
  family: string,
  idOverride: string | undefined,
  insert: (humanId: string, existing: NodeRecord | null) => T,
): Promise<T> {
  return withImmediateRetry(() =>
    store.adapter.transaction(
      async () => {
        await ensureHumanIdUniqueIndex(store);
        await ensureHumanIdCounterTable(store);
        if (idOverride) {
          const existing = await findLiveByHumanId(store, repo, idOverride);
          await reconcileCounterForOverride(store, repo, idOverride);
          return insert(idOverride, existing);
        }
        const humanId = formatHumanId(family, await nextOrdinal(store, repo, family));
        return insert(humanId, null);
      },
      { mode: 'immediate' }
    )
  );
}

/**
 * @deprecated kept ONLY as a standalone id-generator for any caller that does
 * not need an atomic insert alongside it. `createItemNode`/
 * `supersedeItemNode` no longer use this (see `allocateHumanIdAndInsert`'s
 * doc comment for why splitting allocate-then-insert-later is unsafe under
 * concurrency). Still correct in isolation — just NOT TOCTOU-safe when the
 * caller's own insert happens in a separate, later transaction.
 */
export async function allocateHumanId(store: GraphBacklogStore, repo: string, family: string): Promise<string> {
  return withImmediateRetry(() =>
    store.adapter.transaction(
      async () => {
        await ensureHumanIdUniqueIndex(store);
        await ensureHumanIdCounterTable(store);
        return formatHumanId(family, await nextOrdinal(store, repo, family));
      },
      { mode: 'immediate' }
    )
  );
}
