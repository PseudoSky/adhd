/**
 * tx.ts — hand-composed, transaction-scoped SQL primitives (SPEC.md §4c).
 *
 * **Why this file exists at all.** `GraphBackend.writeNode`/`writeEdge`/
 * `invalidateEdge`/`getNodeByUid` (`@adhd/sox-graph-store`) all run against
 * `this.adapter` — the bare, un-transacted adapter — never against an open
 * `AdapterTransaction`, and `GraphBackend.transaction(fn)` never reassigns
 * `this.adapter` for the callback's duration (verified against the published
 * dist, §4c). Calling any of those four methods from INSIDE a
 * `store.adapter.transaction(fn, {mode:'immediate'})` callback autocommits
 * (or reads committed-only state) OUTSIDE that transaction — the exact defect
 * that made the spec unimplementable until this hand-composed layer replaced
 * every such call with a direct `tx.executeGet`/`executeAll`/`executeRun`
 * against the SAME transaction handle. `AdapterTransaction` (`@adhd/sox-store-adapter`)
 * exposes ONLY those three methods plus `exec` — there is no graph-level
 * primitive to fall back on, by design.
 *
 * Every function below mirrors the library's own SQL shape byte-for-byte
 * (cited per-function against `@adhd/sox-graph-store`'s published
 * `dist/index.js`) — never a NEW SQL shape invented for this module — so that
 * a write-layer write behaves identically to what the library's own (non-transactional)
 * primitive would have done, just issued against `tx` instead of the bare
 * adapter.
 */

import type { AdapterTransaction, StoreAdapter } from '@adhd/sox-store-adapter';
import type { TypePolicy } from '@adhd/sox-graph-store';
import { randomUUID, createHash } from 'node:crypto';
import { BacklogWriteError, SingleValuedRelationConflictError, WriteContentionError, WriteIOError, classifyDriverError } from './errors.js';

/**
 * The dependencies a write verb needs to open its own `immediate` transaction
 * and validate the edges it writes. Constructed once at store-open time (out
 * of scope for this slice — see the store-bootstrap file that wires
 * `createGraphBackend`'s own `typePolicy` option, DATA_MODEL.md §0 point 5)
 * and threaded through every write verb.
 */
export interface IWriteStoreHandle {
  /** The `StoreAdapter` the backlog store exposes — never `GraphBackend.transaction`, which cannot request `immediate` mode (§4c). */
  readonly adapter: StoreAdapter;
  /**
   * The SAME injected `TypePolicy` instance the store's `GraphBackend` was
   * constructed with (or `DEFAULT_TYPE_POLICY` — though the spec requires an
   * open-schema policy be injected, DATA_MODEL.md §0 point 5). `writeEdgeTx`
   * calls this directly, in-process, never through `writeEdge` (§2).
   */
  readonly typePolicy: TypePolicy;
}

/** A node row as read back inside a transaction, mapped onto the fields the write layer needs. */
export interface ITxNodeRow {
  rowid: number;
  uid: string;
  kind: string;
  name: string | null;
  content: string;
  metadata: Record<string, unknown> | undefined;
  tInvalid: string | null;
  isSuperseded: boolean;
}

interface IRawNodeRow {
  rowid: number;
  uid: string;
  kind: string;
  name: string | null;
  content: string | null;
  meta: string | null;
  t_invalid: string | null;
  is_superseded: number | null;
}

function parseJsonObject(raw: string | null): Record<string, unknown> | undefined {
  if (raw === null || raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    // A stored meta column that fails to parse is data corruption, not a
    // reason to crash the caller — degrade to "no metadata", matching
    // graph-store's own `rowToNodeRecord` degradation (dist/index.js).
    return undefined;
  }
}

function mapNodeRow(row: IRawNodeRow): ITxNodeRow {
  return {
    rowid: row.rowid,
    uid: row.uid,
    kind: row.kind,
    name: row.name,
    content: row.content ?? '',
    metadata: parseJsonObject(row.meta),
    tInvalid: row.t_invalid,
    isSuperseded: row.is_superseded === 1,
  };
}

/** Current UTC timestamp in the same ISO-8601 shape `@adhd/sox-graph-store` stamps every row with. */
export function nowISO(): string {
  return new Date().toISOString();
}

/** `sha256` hex digest of arbitrary string/Buffer content — used for citation and audit content-addressing (§4a/§8.5), never for the library's own dedupe hash (that stays trim+lowercase, see {@link writeNodeTx}). */
export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Deterministic JSON serialization with keys sorted at every level — the
 * "canonical JSON serialization... with stable (sorted) key order" DATA_MODEL.md
 * §10 point 2 defines for `transition.sha` and states is "the same convention
 * SPEC.md §4a already states for the audit `sha`, applied identically."
 * `undefined` values are omitted (never serialized as `null` silently — a
 * caller that means "explicitly null" must pass `null`, not omit the key).
 */
export function canonicalJSONStringify(value: Record<string, unknown>): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) sorted[key] = sortDeep(record[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * uid → node, inside a tx. Mirrors `getNodeByUid`'s own SELECT
 * (`SELECT * FROM node WHERE uid = ?`, `@adhd/sox-graph-store` dist/index.js:1573-1576)
 * issued against `tx` instead of the bare adapter — never a `getNodeByUid`
 * call itself, which always runs against `this.adapter` (§4c).
 */
export async function getNodeByUidTx(tx: AdapterTransaction, uid: string): Promise<ITxNodeRow | null> {
  const row = await tx.executeGet<IRawNodeRow>('SELECT * FROM node WHERE uid = ?', [uid]);
  return row ? mapNodeRow(row) : null;
}

/** rowid → node, inside a tx (used to resolve an edge endpoint's kind without a redundant round trip when the caller doesn't already know it). */
export async function getNodeByRowidTx(tx: AdapterTransaction, rowid: number): Promise<ITxNodeRow | null> {
  const row = await tx.executeGet<IRawNodeRow>('SELECT * FROM node WHERE rowid = ?', [rowid]);
  return row ? mapNodeRow(row) : null;
}

export interface IWriteNodeTxInput {
  /** The entity-type discriminator — `project`/`component`/`location`/`issue`/`kind`/`edge_kind`/`status`/`priority`/`agent`/`note`/`citation`/`transition`/`audit` (§3). NEVER validated against a closed vocabulary here — the schema is open by design (§0 anti-antipattern 3); the write layer is the only composer of these literals. */
  kind: string;
  /** The business name (`issue.title`, a catalog row's name, …). Omit for a node with no name (none currently exist in §3's table, but the column is nullable). */
  name?: string;
  /** The content column. Defaults to `name` when omitted (mirrors `findOrCreateNode`'s own `opts?.content ?? name` convention, `@adhd/sox-graph-store` dist/index.js:1446). */
  content?: string;
  metadata?: Record<string, unknown>;
  /**
   * The ISO-8601 timestamp stamped onto this row's `t_occurred`/`t_created`/
   * `t_valid` columns. Optional; defaults to a fresh {@link nowISO}() call
   * when omitted, so an existing single-row call site compiles and behaves
   * unchanged.
   *
   * A caller composing ONE logical write out of several rows (e.g.
   * `createIssue`'s issue node + N citation nodes + the `writeAudit` audit
   * node, all inside the SAME `executeWriteTransaction` callback) MUST
   * capture a single `const now = nowISO()` up front and pass it as `at` to
   * EVERY {@link writeNodeTx} (and {@link writeEdgeTx}) call in that closure.
   * Without this, each call computes its own fresh, microseconds-later
   * `nowISO()`, so the issue node's persisted `t_created`, the citations'
   * `t_created`, and the audit row's recorded `at` all drift apart within
   * what is supposed to be one atomic, single-instant write — breaking the
   * guarantee (§4a) that the audit's `at` describes exactly when the subject
   * it records was created.
   */
  at?: string;
}

/**
 * Hand-composed node INSERT, issued against `tx`. Mirrors `writeNodeInTx`'s
 * own INSERT column list and defaults EXACTLY (`@adhd/sox-graph-store`
 * dist/index.js:1410-1421) with `skipDedupe: true` UNCONDITIONALLY — the spec
 * §1 requires this on every entity write ("two identical-body issues are two
 * rows, never one collapsed row"), so this function never runs the
 * content-hash SELECT `writeNodeInTx` runs when `skipDedupe` is falsy; it
 * always inserts a fresh row. `uid` is `crypto.randomUUID()` — the SAME
 * generator the library uses (`generateUid()`, dist/index.js:646-648) — so a
 * write-layer-written row is byte-for-byte indistinguishable in shape from one the
 * library itself would have written, just composed by hand to stay inside
 * the caller's own transaction.
 */
export async function writeNodeTx(tx: AdapterTransaction, input: IWriteNodeTxInput): Promise<{ rowid: number; uid: string }> {
  const uid = randomUUID();
  const now = input.at ?? nowISO();
  const content = input.content ?? input.name ?? '';
  // The library's own dedupe hash (trim + lowercase, dist/index.js:642-644)
  // — stored for schema parity with a library-written row even though
  // skipDedupe:true means the write layer never looks this column up by value.
  const contentHash = sha256Hex(content.trim().toLowerCase());
  const metaJson = input.metadata !== undefined ? JSON.stringify(input.metadata) : null;

  const result = await tx.executeGet<{ rowid: number }>(
    `INSERT INTO node (uid, kind, content, name, summary, topic, tags, importance,
        confidence, content_hash, namespace, meta, agent_id, session_id, source,
        project_path, t_occurred, t_expires, t_created, t_valid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING rowid`,
    [
      uid, input.kind, content,
      input.name ?? null, null, null, null,
      1.0, null, contentHash,
      'global', metaJson,
      null, null, null,
      null, now, null, now, now,
    ],
  );
  if (!result) throw new Error(`writeNodeTx: INSERT returned no rowid for kind="${input.kind}" name="${input.name ?? ''}"`);
  return { rowid: result.rowid, uid };
}

/**
 * The declared `(rel, source_kind, target_kind, multiplicity)` table the spec
 * §3 fixes once — the same "typed rels, each name unique with ONE
 * (source_kind → target_kind)" table, `audits` carrying the one declared
 * `source_kind: '*'` sentinel (§2). This is DATA the write layer already
 * knows at compile time; catalog.ts's `resolveEdgeKindTx` reconciles it with
 * the `edge_kind` catalog ROW (seeded once, never caller-mintable, §1) rather
 * than re-deriving it from this table on every call.
 */
export type EdgeMultiplicity = 'n:1' | '1:n' | 'n:m';

export interface IEdgeKindRule {
  rel: string;
  /** `'*'` is the one declared sentinel (`audits`, §2) — skip the source-kind match for this rule only. */
  sourceKind: string;
  targetKind: string;
  multiplicity: EdgeMultiplicity;
}

export interface IWriteEdgeTxInput {
  srcRowid: number;
  srcUid: string;
  srcKind: string;
  dstRowid: number;
  dstUid: string;
  dstKind: string;
  rel: string;
  metadata?: Record<string, unknown>;
  weight?: number;
  /** The resolved `edge_kind` rule this rel must satisfy (catalog.ts's `resolveEdgeKindTx`). */
  rule: IEdgeKindRule;
  typePolicy: TypePolicy;
  /**
   * The ISO-8601 timestamp stamped onto this edge's `t_created`/`t_valid`
   * columns. Optional; defaults to a fresh {@link nowISO}() call when
   * omitted. Same one-logical-write-one-timestamp rule as
   * {@link IWriteNodeTxInput.at} — a caller writing several edges (or an
   * edge alongside node writes) inside one `executeWriteTransaction`
   * callback should pass the SAME captured `now` to every one of them.
   */
  at?: string;
}

/**
 * `n:1` caps the SOURCE's out-degree at one for `rel` (one target per
 * source); `1:n` caps the TARGET's in-degree at one (one source per target);
 * `n:m` is uncapped on both sides — SPEC.md §2's precise definition, "the
 * SAME check for every row, never two different checks keyed off which side
 * happens to be '1.'" Throws {@link SingleValuedRelationConflictError} — the
 * SAME gate `relate` (§6.3.6) surfaces to its callers for `supersedes`/
 * `duplicate_of`/`part_of`, applied generically here so every future `n:1`/
 * `1:n` rel is enforced identically with no code change (§2's own closing
 * statement).
 */
async function checkMultiplicityTx(tx: AdapterTransaction, input: IWriteEdgeTxInput): Promise<void> {
  const { multiplicity } = input.rule;
  if (multiplicity === 'n:m') return;

  if (multiplicity === 'n:1') {
    const conflict = await tx.executeGet<{ uid: string }>(
      `SELECT n.uid AS uid FROM edge e JOIN node n ON n.rowid = e.dst
       WHERE e.src = ? AND e.rel = ? AND e.dst != ? AND e.t_invalid IS NULL LIMIT 1`,
      [input.srcRowid, input.rel, input.dstRowid],
    );
    if (conflict) {
      throw new SingleValuedRelationConflictError({ side: 'source', cappedUid: input.srcUid, rel: input.rel, conflictingUid: conflict.uid });
    }
    return;
  }

  // multiplicity === '1:n': the TARGET's in-degree is capped at one. Every
  // 1:n rel in createIssue's own write set targets a node freshly minted in
  // the SAME transaction (owns_component's issue, has_citation's citation,
  // audits' audit node), so this branch is unreachable there — it exists so
  // a future caller writing a SECOND edge into an already-owned target (e.g.
  // a bug in `move`'s invalidate-then-write sequence) fails loudly instead of
  // silently double-owning a node.
  //
  // Field semantics for THIS branch (deliberately distinct from the n:1
  // branch above, which is source-capped): `input.dstUid` is the CAPPED node
  // — the one whose in-degree this multiplicity rule limits — so it is
  // `cappedUid`, `side: 'target'`; `conflict.uid` is the PRE-EXISTING SOURCE
  // the join resolves via `n.rowid = e.src` (a node that already holds the
  // one edge into `input.dstUid`), so it is `conflictingUid`. The prior bug
  // here passed `input.dstUid` positionally into a parameter literally named
  // `sourceUid` (and `conflict.uid` into one named `existingTargetUid`) —
  // the named-options constructor makes that class of mistake a compile
  // error instead of a silent field swap.
  const conflict = await tx.executeGet<{ uid: string }>(
    `SELECT n.uid AS uid FROM edge e JOIN node n ON n.rowid = e.src
     WHERE e.dst = ? AND e.rel = ? AND e.src != ? AND e.t_invalid IS NULL LIMIT 1`,
    [input.dstRowid, input.rel, input.srcRowid],
  );
  if (conflict) {
    throw new SingleValuedRelationConflictError({ side: 'target', cappedUid: input.dstUid, rel: input.rel, conflictingUid: conflict.uid });
  }
}

/**
 * Edge write, inside a tx (upsert, re-livening included). Mirrors
 * `writeEdgeInternal`'s own INSERT EXACTLY (`@adhd/sox-graph-store`
 * dist/index.js:1894-1898) — same `ON CONFLICT(src, dst, rel) DO UPDATE`,
 * same `t_invalid = NULL` re-livening — issued against `tx` instead of the
 * bare adapter, never a `writeEdge` call itself (§4c).
 *
 * Endpoint-kind validation (§2: resolve `edge_kind`, check `source_kind`/
 * `target_kind`, THEN call the injected `TypePolicy` directly in-process,
 * never through `writeEdge`) and multiplicity enforcement both run BEFORE the
 * INSERT, against the SAME `tx` handle.
 */
export async function writeEdgeTx(tx: AdapterTransaction, input: IWriteEdgeTxInput): Promise<void> {
  const { rule } = input;
  if (rule.sourceKind !== '*' && rule.sourceKind !== input.srcKind) {
    throw new BacklogEdgeKindMismatchError(input.rel, 'source', rule.sourceKind, input.srcKind);
  }
  if (rule.targetKind !== input.dstKind) {
    throw new BacklogEdgeKindMismatchError(input.rel, 'target', rule.targetKind, input.dstKind);
  }

  await checkMultiplicityTx(tx, input);

  // §2: "resolves the edge_kind catalog row ... THEN calls the SAME injected
  // TypePolicy instance directly, in-process — never through writeEdge."
  if (input.typePolicy.validateEdge) {
    input.typePolicy.validateEdge(input.srcKind, input.rel, input.dstKind);
  } else {
    input.typePolicy.validateRel(input.rel);
  }

  const now = input.at ?? nowISO();
  const metaJson = input.metadata !== undefined ? JSON.stringify(input.metadata) : null;
  await tx.executeRun(
    `INSERT INTO edge (src, dst, rel, weight, origin, meta, t_created, t_valid)
     VALUES (?, ?, ?, ?, 'user_asserted', ?, ?, ?)
     ON CONFLICT(src, dst, rel) DO UPDATE SET
       meta = excluded.meta, weight = excluded.weight,
       t_invalid = NULL, t_valid = excluded.t_valid`,
    [input.srcRowid, input.dstRowid, input.rel, input.weight ?? 1.0, metaJson, now, now],
  );
}

/**
 * Internal — a resolved `edge_kind` rule's declared endpoint kind does not
 * match the actual endpoint being written. This is a write-layer composition
 * defect (the caller passed the wrong node as an endpoint), never a
 * caller-facing input-validation case with its own named class in the spec's
 * taxonomy — every write-layer call site passes endpoint kinds it just resolved or
 * wrote itself in the SAME transaction, so this should be unreachable in
 * practice; it exists to fail loudly rather than silently write a
 * mismatched edge if that invariant is ever broken by a future verb.
 */
export class BacklogEdgeKindMismatchError extends BacklogWriteError {
  readonly code = 'E_VALIDATION' as const;
  readonly retryable = false;

  constructor(rel: string, side: 'source' | 'target', expectedKind: string, actualKind: string) {
    super(`"${rel}" requires a ${side} of kind "${expectedKind}", got "${actualKind}"`);
  }
}

export interface IInvalidateEdgeTxInput {
  srcRowid: number;
  dstRowid: number;
  rel: string;
  reason?: string;
  /**
   * The ISO-8601 timestamp stamped onto `t_invalid`/`meta.invalidatedAt`.
   * Optional; defaults to a fresh {@link nowISO}() call when omitted. Same
   * one-logical-write-one-timestamp rule as {@link IWriteNodeTxInput.at}.
   */
  at?: string;
}

/**
 * Edge invalidate, inside a tx. Mirrors `invalidateEdge` EXACTLY
 * (`@adhd/sox-graph-store` dist/index.js:1846-1855) — same idempotent
 * "already invalidated or absent → no-op" behavior — issued against `tx`
 * instead of the bare adapter.
 */
export async function invalidateEdgeTx(tx: AdapterTransaction, input: IInvalidateEdgeTxInput): Promise<void> {
  const existing = await tx.executeGet<{ rowid: number; meta: string | null }>(
    'SELECT rowid, meta FROM edge WHERE src = ? AND dst = ? AND rel = ? AND t_invalid IS NULL',
    [input.srcRowid, input.dstRowid, input.rel],
  );
  if (!existing) return; // already invalidated or absent — idempotent, matches invalidateEdge

  const now = input.at ?? nowISO();
  const metaObj = {
    ...(parseJsonObject(existing.meta) ?? {}),
    invalidatedAt: now,
    ...(input.reason !== undefined ? { invalidatedReason: input.reason } : {}),
  };
  await tx.executeRun('UPDATE edge SET t_invalid = ?, meta = ? WHERE rowid = ?', [now, JSON.stringify(metaObj), existing.rowid]);
}

/** Linear backoff schedule for `E_CONTENTION` — 250ms, then 500ms (3 total attempts, §4c "Retry semantics"; reuses ADR-0012 §4's own bound rather than a second, differently-tuned schedule). */
const CONTENTION_RETRY_BACKOFFS_MS = [250, 500] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The one transaction wrapper every write verb calls — `store.adapter.transaction(fn,
 * {mode:'immediate'})` (§4c: `BEGIN IMMEDIATE`, the RESERVED-lock-at-BEGIN
 * "compare-and-swap primitive" every check-then-act verb in §4's table
 * depends on), with the §4c retry contract layered on top:
 *
 * - A {@link BacklogWriteError} thrown from `fn` (an app-level validation
 *   failure, or the `supersede` CAS's {@link StaleSupersedeError}) is
 *   ALREADY a decided, terminal, transport-facing error — rethrown
 *   immediately, untouched, never reclassified or retried.
 * - A raw driver-level error is classified via {@link classifyDriverError}.
 *   `E_CONTENTION` retries up to 3 total attempts (linear backoff 250ms then
 *   500ms) before surfacing {@link WriteContentionError}. `E_IO`
 *   (`isDatabaseError(err)` true — a recognized-but-otherwise-unclassified
 *   database/driver error) surfaces {@link WriteIOError} on the FIRST
 *   occurrence, never retried — §4c's uniform reason across every write
 *   class: `writeAudit` (§4a) rides inside literally every write-layer
 *   transaction as an unguarded, keyless-content INSERT, so a retry whose
 *   earlier attempt actually committed would silently double the audit
 *   trail even where the SUBJECT write is safe to retry on its own merits.
 *   An `E_IO` classification whose `err` is NOT database-shaped at all
 *   (`isDatabaseError(err)` false — a genuine app-level bug, never a driver
 *   fault) is rethrown UNTOUCHED instead — never wrapped in
 *   {@link WriteIOError}, which always asserts `retryable: true`.
 * - An `E_CONSTRAINT` this function did not already expect as
 *   {@link StaleSupersedeError} (i.e. a raw, unclassified constraint
 *   violation — structurally unreachable under the hand-composed
 *   find-then-create + `immediate`-mode discipline every verb follows, §1)
 *   is rethrown UNTOUCHED — never swallowed, never coerced into a
 *   not-actually-specified wrapper class.
 */
export async function executeWriteTransaction<T>(
  handle: IWriteStoreHandle,
  fn: (tx: AdapterTransaction) => Promise<T>,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await handle.adapter.transaction(fn, { mode: 'immediate' });
    } catch (err) {
      if (err instanceof BacklogWriteError) throw err;

      const classified = classifyDriverError(err);

      if (classified.code === 'E_CONTENTION') {
        if (attempt < CONTENTION_RETRY_BACKOFFS_MS.length) {
          const backoffMs = CONTENTION_RETRY_BACKOFFS_MS[attempt];
          attempt += 1;
          await sleep(backoffMs);
          continue;
        }
        throw new WriteContentionError(CONTENTION_RETRY_BACKOFFS_MS[CONTENTION_RETRY_BACKOFFS_MS.length - 1], err);
      }

      if (classified.code === 'E_IO') {
        if (classified.retryable) {
          // The SPEC.md §4c case: a recognized-but-otherwise-unclassified
          // database/driver error (`isDatabaseError(err)` true).
          throw new WriteIOError(err);
        }
        // `classified.retryable === false` here means `classifyDriverError`
        // could not recognize `err` as database-shaped AT ALL — a genuine
        // application bug (e.g. a `TypeError`/`SyntaxError` from inside the
        // verb's own transaction callback), not a driver/connection fault.
        // Falls through to the untouched rethrow below rather than
        // `WriteIOError` (which always asserts `retryable: true`) so a
        // caller honouring `retryable` never retries a failure that can
        // never succeed.
      }

      // E_CONSTRAINT / a non-retryable E_IO / anything else: surfaced on the
      // first attempt, unwrapped — retrying a terminal failure cannot change
      // its outcome (§4c), and no named class in this spec covers a generic
      // raw constraint violation outside the supersede CAS (already handled
      // by the `instanceof BacklogWriteError` guard above) or a genuinely
      // unrecognized, non-driver failure.
      throw err;
    }
  }
}
