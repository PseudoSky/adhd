/**
 * spec-revision.ts — a work product (a spec) is a REVISION of its ticket
 * (C10, DESIGN §12). Identity is **two ids + one pointer**:
 *
 *  - the ticket's stable **logical id** — resolved through C1's
 *    `resolveLogicalIssue`/`SUPERSEDES` chain, so a body edit that churns the
 *    raw uid does not orphan the spec (AC9);
 *  - an immutable **revision object** (`kind: 'SPEC'`) minted per edit — never
 *    an update to a prior revision (AC1/AC8);
 *  - a single mutable pointer `meta.spec_revision` on the ticket naming the
 *    current revision, written IN PLACE via `updateNodeMetaTx` (the uid is
 *    preserved; only `meta` changes and `meta.revision` bumps, SR-2/SR-6).
 *
 * Each revision node stores ONLY the fragment appended at that edit; the
 * document is the **fold** over the chain's `content` values, and
 * `revision_token` is `sha256:<hex>` of that FOLD (not of the delta) — the
 * O(1)-comparable staleness key. Nothing stores a full snapshot, so a chain of
 * N edits costs O(N) fragments, never O(N²) snapshots (AC8).
 *
 * One `BEGIN IMMEDIATE` transaction (ADR-0001 + ADR-0012 — the store owns
 * atomicity; no temp-file/rename/flock). `appendSpecRevision` never touches a
 * revision node after creation, and never rewrites the ticket body.
 */

import type { GraphBackend, NodeRecord } from '@adhd/sox-graph-store';
import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import { writeAudit } from './audit.js';
import {
  InvalidArgumentError,
  SpecRevisionConflictError,
  assertNotBareRoleLiteral,
} from './errors.js';
import {
  resolveEdgeScopedCandidates,
  resolveLogicalIssue,
} from '../query/resolve.js';
import { readRevision } from './revision.js';
import {
  type IWriteStoreHandle,
  executeWriteTransaction,
  getNodeByRowidTx,
  getNodeByUidTx,
  nowISO,
  resolveUidPrefixTx,
  sha256Hex,
  updateNodeMetaTx,
  writeNodeTx,
  type ITxNodeRow,
} from './tx.js';

/** The long-form file export an anchor points at: `locator + digest` (Primitive 2) — referenced, never embedded. */
export interface ISpecAnchor {
  locator: string;
  digest: string;
}

/**
 * Immutable revision object metadata (node `kind: 'SPEC'`). The node's
 * `content` column holds the FRAGMENT appended at this revision (the delta; the
 * base revision's fragment IS the base document). No revision stores a full
 * snapshot — the document is the fold over the chain's `content` values and
 * `revision_token` is the hash of that fold.
 */
export interface ISpecRevisionMeta {
  /** The ticket's logical id (the head resolved at append time) — see the module header. */
  spec_of: string;
  /** 1,2,3… monotonic within the spec. */
  revision_seq: number;
  /** `'sha256:<hex>'` of the FOLDED document at this revision. */
  revision_token: string;
  /** Predecessor revision uid (`null` for the base revision). */
  prev_revision: string | null;
  /** The long-form file export (Primitive 2). */
  anchor: ISpecAnchor;
  appended_by: string;
  appended_at: string;
}

export interface ISpecAppendInput {
  /** The ticket's logical id — any uid on its `SUPERSEDES` chain is resolved forward. */
  uid: string;
  /** The delta appended at this revision (becomes the node's `content`). */
  fragment: string;
  /** The file export for this revision. */
  anchor?: ISpecAnchor;
  /** REQUIRED CAS token — the revision uid the caller read (`''` when the ticket had no spec yet). */
  base_revision: string;
  by: string;
}

export interface ISpecAppendOutcome {
  /** UNCHANGED — cross-checked by AC1. */
  uid: string;
  /** The NEW revision uid. */
  spec_revision: string;
  /** `'sha256:<hex>'`. */
  spec_revision_token: string;
  revision_seq: number;
}

/** Current revision + its token for a work item. */
export interface ISpecPointer {
  revision_uid: string;
  revision_token: string;
  revision_seq: number;
}

/**
 * The store surface {@link appendSpecRevision} needs. Beyond the ordinary write
 * handle it requires the store's `GraphBackend`, because revision DISCOVERY must
 * run the SAME live-kind traversal the read path (`deriveSpecHead`) and the
 * reconciliation (`spec-revision.reconcile.ts`) use — and that traversal
 * (`query/resolve.ts`'s `resolveEdgeScopedCandidates`) is a `GraphBackend` read
 * that must run BEFORE the `BEGIN IMMEDIATE` transaction opens (a `GraphBackend`
 * call never runs inside it — see `resolveLogicalHeadTx`). `GraphBacklogStore`
 * and the test `TestIssueStore` both satisfy this shape.
 */
export type ISpecAppendStore = IWriteStoreHandle & {
  readonly graph: GraphBackend;
};

/** The token encoding, stated once: `sha256:<hex>` — never bare hex, never a raw uid. */
const TOKEN_PREFIX = 'sha256:';

function tokenFor(fold: string): string {
  return `${TOKEN_PREFIX}${sha256Hex(fold)}`;
}

function readStringMeta(
  meta: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = meta?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumberMeta(
  meta: Record<string, unknown> | undefined,
  key: string
): number | undefined {
  const value = meta?.[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Negative-control switch — DANGER, test use ONLY, never set in normal
 * operation or a deployed process. Read at the single point of use on EVERY
 * call (never cached at import time) so a test can set it per-run and it
 * reverts itself the moment the process exits (the same discipline as
 * `tx.ts`'s `ADHD_BACKLOG_UNSAFE_TX_MODE`, for the same reason:
 * `DEBT-PROCESS-DISPATCH-RESIDUE-001`). Unrecognized values throw loudly.
 *
 *  - `'force'`       — bypass the `base_revision` CAS (AC6 negative control: a
 *    last-writer-wins append the stale-base guard must refuse).
 *  - `'snapshot'`    — store the FULL fold into each revision's `content`
 *    instead of the fragment (AC8 negative control: the O(N²) snapshot the
 *    fragment model forbids).
 */
const APPEND_MODES = ['normal', 'force', 'snapshot'] as const;
type AppendMode = (typeof APPEND_MODES)[number];

function resolveAppendMode(): AppendMode {
  const raw = process.env['ADHD_BACKLOG_UNSAFE_SPEC_APPEND'];
  if (raw === undefined) return 'normal';
  if ((APPEND_MODES as readonly string[]).includes(raw))
    return raw as AppendMode;
  throw new Error(
    `ADHD_BACKLOG_UNSAFE_SPEC_APPEND="${raw}" is not a recognized mode (expected ${APPEND_MODES.join(', ')}). ` +
      'This variable exists solely for negative-control test runs and must never be set in normal operation; ' +
      'an unrecognized value fails loudly rather than silently defaulting.'
  );
}

/**
 * Negative-control switch — DANGER, test use ONLY, never set in normal
 * operation or a deployed process. Read at the single point of use on EVERY
 * call (never cached at import time) so a test can set it per-run and it
 * reverts itself the moment the process exits (the same discipline as
 * `ADHD_BACKLOG_UNSAFE_SPEC_APPEND` above and `spec-revision.reconcile.ts`'s
 * `ADHD_BACKLOG_UNSAFE_SPEC_RECONCILE`, for the same reason:
 * `DEBT-PROCESS-DISPATCH-RESIDUE-001`). Unrecognized values throw loudly.
 *
 *  - `'raw-kind-only'` — discover SPEC revisions by the RAW `node.kind` column
 *    ONLY (the pre-fix criterion) in BOTH discovery sites — the write path's
 *    `findChainHeadTx` (via `declaredRowids=undefined`) and the read path's
 *    `deriveSpecHead`. On the SHIPPED corpus — spec documents stored as `issue`
 *    nodes carrying the `has_kind`→`SPEC` catalog edge — this finds no head:
 *    `appendSpecRevision` throws a spurious {@link SpecRevisionConflictError}
 *    and `deriveSpecHead` is `undefined`. Reinstates the exact defect the
 *    declared-kind branch closes, so the post-reconcile append test can be
 *    proven RED against it. Does NOT touch the reconciliation (which has its own
 *    switch), so a test can reconcile the declared-kind corpus, then flip this
 *    one to isolate the read/write discovery.
 */
const DISCOVERY_MODES = ['normal', 'raw-kind-only'] as const;
type DiscoveryMode = (typeof DISCOVERY_MODES)[number];

function resolveSpecDiscoveryMode(): DiscoveryMode {
  const raw = process.env['ADHD_BACKLOG_UNSAFE_SPEC_DISCOVERY'];
  if (raw === undefined) return 'normal';
  if ((DISCOVERY_MODES as readonly string[]).includes(raw))
    return raw as DiscoveryMode;
  throw new Error(
    `ADHD_BACKLOG_UNSAFE_SPEC_DISCOVERY="${raw}" is not a recognized mode (expected ${DISCOVERY_MODES.join(', ')}). ` +
      'This variable exists solely for negative-control test runs and must never be set in normal operation; ' +
      'an unrecognized value fails loudly rather than silently defaulting.'
  );
}

function specDiscoveryIsRawKindOnly(): boolean {
  return resolveSpecDiscoveryMode() === 'raw-kind-only';
}

/**
 * Walk the ticket's `SUPERSEDES` chain forward from any member uid to its head,
 * collecting every uid encountered (the chain uid set the `spec_of` re-anchor
 * matches against — AC9). Tx-scoped: uses the same hand-composed reads every
 * write verb uses, never `GraphBackend` (which would autocommit outside `tx`).
 */
async function resolveLogicalHeadTx(
  tx: AdapterTransaction,
  uid: string
): Promise<{ head: ITxNodeRow; chainUids: Set<string> }> {
  const start = await resolveUidPrefixTx(tx, uid, { expectedKind: 'issue' });
  const chainUids = new Set<string>([start.uid]);
  const seen = new Set<number>([start.rowid]);
  let cursor: ITxNodeRow = start;

  for (;;) {
    const successor = await tx.executeGet<{ src: number }>(
      'SELECT src FROM edge WHERE dst = ? AND rel = ? AND t_invalid IS NULL LIMIT 1',
      [cursor.rowid, 'SUPERSEDES']
    );
    if (!successor) break;
    const next = await getNodeByRowidTx(tx, successor.src);
    if (next === null) break;
    if (next.tInvalid !== null || seen.has(next.rowid)) break;
    seen.add(next.rowid);
    chainUids.add(next.uid);
    cursor = next;
  }
  return { head: cursor, chainUids };
}

/**
 * Rowids of live items whose DECLARED catalog kind is `SPEC` — an
 * `issue`-shaped node carrying a live `has_kind` edge to the `kind:'SPEC'`
 * catalog row. This is the SHIPPED production shape: the reconciled corpus is
 * `issue` nodes whose DECLARED kind is `SPEC`, and reconciliation stamps them
 * `spec_of`/`revision_seq` WITHOUT changing the raw `node.kind` column. Any
 * discovery keyed on the raw column alone is therefore blind to them.
 *
 * Uses the SAME live-kind traversal the read path's `filter.kind`
 * (`query/views/semantic.ts`) and `spec-revision.reconcile.ts` use —
 * `query/resolve.ts`'s {@link resolveEdgeScopedCandidates} on
 * `has_kind`→`SPEC` — so read, write, and reconcile can never disagree on what
 * "a live `kind:'SPEC'` item" is. Returns `undefined` when `SPEC` resolves to
 * no live catalog row (nothing is declared SPEC).
 */
export async function declaredSpecRowids(
  graph: GraphBackend
): Promise<ReadonlySet<number> | undefined> {
  return resolveEdgeScopedCandidates(graph, {
    rel: 'has_kind',
    expectedKind: 'kind',
    ref: 'SPEC',
  });
}

/**
 * Every live SPEC document — the UNION of two representations the store has
 * held, both of which are specs:
 *
 *  (a) a node whose RAW `kind` column is `SPEC` — the immutable revision object
 *      {@link appendSpecRevision} mints (and the shape the unit fixtures
 *      build); and
 *  (b) an `issue` node whose DECLARED catalog kind is `SPEC` — the reconciled
 *      production corpus (see {@link declaredSpecRowids}).
 *
 * This is the ONE discovery the read path ({@link deriveSpecHead}), the write
 * path (`findChainHeadTx` via {@link declaredSpecRowids}), and the
 * reconciliation all share, so they cannot drift on which items are specs. The
 * union is load-bearing: a raw-kind-only reader missed shape (b) entirely.
 */
export async function discoverLiveSpecNodes(
  graph: GraphBackend
): Promise<NodeRecord[]> {
  const byUid = new Map<string, NodeRecord>();
  for (const n of await graph.queryNodes({ kind: 'SPEC', liveOnly: true })) {
    byUid.set(n.uid, n);
  }
  const declared = await declaredSpecRowids(graph);
  if (declared !== undefined && declared.size > 0) {
    const nodes = await graph.getNodesByIds([...declared], { liveOnly: true });
    for (const n of nodes) byUid.set(n.uid, n);
  }
  return [...byUid.values()];
}

/**
 * The live `SPEC` revision whose `meta.spec_of` is a member of the ticket's
 * `SUPERSEDES`-chain uid set with the MAX `meta.revision_seq` — the derived
 * chain head, backed by the functional index `spec-revision.reconcile.ts` creates on
 * `json_extract(meta,'$.spec_of')`.
 *
 * Discovers BOTH shapes: the RAW `kind:'SPEC'` column AND the DECLARED-kind
 * `issue` nodes (`declaredRowids`, resolved before the tx — see
 * {@link ISpecAppendStore}). The reconciled production corpus is the latter, so
 * a raw-kind-only lookup returned `undefined` for it — a spurious
 * {@link SpecRevisionConflictError} (or a silent forked seq-1 revision).
 */
async function findChainHeadTx(
  tx: AdapterTransaction,
  chainUids: ReadonlySet<string>,
  declaredRowids: ReadonlySet<number> | undefined
): Promise<ITxNodeRow | undefined> {
  const uids = [...chainUids];
  if (uids.length === 0) return undefined;
  const uidPlaceholders = uids.map(() => '?').join(', ');
  const params: unknown[] = [];
  let kindClause = "kind = 'SPEC'";
  const declared = declaredRowids === undefined ? [] : [...declaredRowids];
  if (declared.length > 0) {
    const declaredPlaceholders = declared.map(() => '?').join(', ');
    kindClause = `(kind = 'SPEC' OR rowid IN (${declaredPlaceholders}))`;
    params.push(...declared);
  }
  const row = await tx.executeGet<{ uid: string }>(
    `SELECT uid FROM node
       WHERE ${kindClause} AND t_invalid IS NULL
         AND json_extract(meta, '$.spec_of') IN (${uidPlaceholders})
       ORDER BY json_extract(meta, '$.revision_seq') DESC
       LIMIT 1`,
    [...params, ...uids]
  );
  if (!row) return undefined;
  const full = await getNodeByUidTx(tx, row.uid);
  return full ?? undefined;
}

function pointerFromRevision(row: ITxNodeRow): ISpecPointer {
  return {
    revision_uid: row.uid,
    revision_token: readStringMeta(row.metadata, 'revision_token') ?? '',
    revision_seq: readNumberMeta(row.metadata, 'revision_seq') ?? 0,
  };
}

/** Read the ticket's SPEC pointer (`meta.spec_revision`) — the intent. Pointer-only; no chain derivation. */
async function readPointerTx(
  tx: AdapterTransaction,
  head: ITxNodeRow
): Promise<{ revision_uid: string; revision_token: string } | undefined> {
  const uid = readStringMeta(head.metadata, 'spec_revision');
  if (!uid) return undefined;
  const token = readStringMeta(head.metadata, 'spec_revision_token') ?? '';
  return { revision_uid: uid, revision_token: token };
}

/**
 * Fold the document from the chain ending at `head`: walk `meta.prev_revision`
 * back to the base, then concatenate `content` base→head. O(N) reads, O(N)
 * fragments — never a snapshot.
 */
async function foldChainTx(
  tx: AdapterTransaction,
  head: ITxNodeRow
): Promise<string> {
  const contents: string[] = [];
  const seen = new Set<string>();
  let cursor: ITxNodeRow | undefined = head;
  while (cursor) {
    if (seen.has(cursor.uid)) break; // cyclic guard (impossible by construction)
    seen.add(cursor.uid);
    contents.push(cursor.content);
    const prevUid = readStringMeta(cursor.metadata, 'prev_revision');
    cursor = prevUid ? (await getNodeByUidTx(tx, prevUid)) ?? undefined : undefined;
  }
  return contents.reverse().join('');
}

/**
 * Append a revision. One `BEGIN IMMEDIATE` transaction (ADR-0001 + ADR-0012 —
 * no temp-file/rename/flock; atomicity is the store's job):
 *
 *  1. resolve `uid` → logical head (input may be any `SUPERSEDES`-chain uid — AC9);
 *  2. read the current revision; if it is not `base_revision` →
 *     {@link SpecRevisionConflictError} (stale base — no write; AC6);
 *  3. write a NEW `kind:'SPEC'` node holding the fragment (AC1/AC8);
 *  4. advance the ticket's `meta.spec_revision` IN PLACE via the CAS helper,
 *     bumping `meta.revision` — the uid is preserved (AC1);
 *  5. `writeAudit(action:'spec-appended')`.
 *
 * NEVER update or delete a revision node (AC1/AC8).
 */
export async function appendSpecRevision(
  handle: ISpecAppendStore,
  input: ISpecAppendInput
): Promise<ISpecAppendOutcome> {
  if (typeof input.uid !== 'string' || input.uid.trim().length === 0) {
    throw new InvalidArgumentError('uid', 'is required');
  }
  if (typeof input.fragment !== 'string') {
    throw new InvalidArgumentError('fragment', 'must be a string');
  }
  if (typeof input.base_revision !== 'string') {
    throw new InvalidArgumentError('base_revision', 'is required');
  }
  if (typeof input.by !== 'string' || input.by.trim().length === 0) {
    throw new InvalidArgumentError('by', 'is required');
  }
  assertNotBareRoleLiteral('by', input.by);

  const mode = resolveAppendMode();

  // Resolve the DECLARED-kind SPEC rowids ONCE, before the transaction: the
  // live-kind traversal is a `GraphBackend` read, and a `GraphBackend` call must
  // never run inside `executeWriteTransaction`'s `BEGIN IMMEDIATE` (see
  // `resolveLogicalHeadTx` — it autocommits outside the tx). `findChainHeadTx`
  // unions this set with the raw `kind:'SPEC'` query inside the tx, so the head
  // lookup sees the reconciled production corpus exactly as `deriveSpecHead` and
  // `spec-revision.reconcile.ts` do.
  const declaredRowids = specDiscoveryIsRawKindOnly()
    ? undefined
    : await declaredSpecRowids(handle.graph);

  return executeWriteTransaction(handle, async (tx: AdapterTransaction) => {
    const { head, chainUids } = await resolveLogicalHeadTx(tx, input.uid);
    const now = nowISO();

    const currentRevision = await findChainHeadTx(tx, chainUids, declaredRowids);
    const currentUid = currentRevision?.uid ?? '';
    const currentSeq = currentRevision
      ? readNumberMeta(currentRevision.metadata, 'revision_seq') ?? 0
      : 0;

    // CAS first (AC6): a stale base writes nothing. `''` is the "no spec yet"
    // sentinel a caller uses on a first append.
    if (mode !== 'force' && input.base_revision !== currentUid) {
      throw new SpecRevisionConflictError(input.base_revision, currentUid);
    }

    const revision_seq = currentSeq + 1;
    const prev_revision = currentRevision?.uid ?? null;

    const priorFold = currentRevision
      ? await foldChainTx(tx, currentRevision)
      : '';
    // 'snapshot' stores the FULL document (the O(N²) anti-pattern AC8's
    // negative control inverts); 'normal' stores only the fragment.
    const storedContent =
      mode === 'snapshot' ? `${priorFold}${input.fragment}` : input.fragment;
    const folded = `${priorFold}${input.fragment}`;
    const revision_token = tokenFor(folded);
    const anchor: ISpecAnchor = input.anchor ?? { locator: '', digest: '' };

    const metadata: ISpecRevisionMeta = {
      spec_of: head.uid,
      revision_seq,
      revision_token,
      prev_revision,
      anchor,
      appended_by: input.by,
      appended_at: now,
    };

    const revision = await writeNodeTx(tx, {
      at: now,
      kind: 'SPEC',
      content: storedContent,
      metadata: metadata as unknown as Record<string, unknown>,
    });

    // Advance the pointer IN PLACE (the ONE place it moves). CAS on the
    // ticket's own meta.revision; a null means a concurrent writer bumped it
    // between our read and this write — roll the whole tx back.
    const claimed = await updateNodeMetaTx(
      tx,
      head.uid,
      {
        spec_revision: revision.uid,
        spec_revision_token: revision_token,
        spec_revision_seq: revision_seq,
      },
      readRevision(head.metadata)
    );
    if (claimed === null) {
      throw new SpecRevisionConflictError(input.base_revision, currentUid);
    }

    await writeAudit({
      tx,
      typePolicy: handle.typePolicy,
      subjectRowid: head.rowid,
      subjectUid: head.uid,
      subjectKind: 'issue',
      actor: input.by,
      action: 'spec-appended',
      to: revision.uid,
      note: `seq ${revision_seq}`,
      at: now,
    });

    return {
      uid: head.uid,
      spec_revision: revision.uid,
      spec_revision_token: revision_token,
      revision_seq,
    };
  });
}

/** Resolve a ticket reference (uid or unique prefix) to its logical head on the READ path, or `undefined` when nothing live matches. */
async function resolveTicketHead(
  graph: GraphBackend,
  uid: string
): Promise<{ uid: string; chainUids: Set<string> } | undefined> {
  let record;
  try {
    record = await resolveLogicalIssue(graph, uid);
  } catch {
    return undefined;
  }
  // Collect the full chain uid set by walking forward from the START node,
  // not only the head `resolveLogicalIssue` returned (a spec whose `spec_of`
  // is an interior chain member must still re-anchor — AC9).
  const chainUids = new Set<string>([uid, record.uid]);
  let cursor = record;
  const seen = new Set<number>([record.id]);
  for (;;) {
    const incoming = await graph.getEdges({ dst: cursor.id, rel: 'SUPERSEDES' });
    const next = incoming.find((e) => !seen.has(e.src));
    if (!next) break;
    seen.add(next.src);
    const [successor] = await graph.getNodesByIds([next.src]);
    if (!successor || successor.tInvalid) break;
    chainUids.add(successor.uid);
    cursor = successor;
  }
  return { uid: record.uid, chainUids };
}

/**
 * The derived chain head for a ticket — a live `SPEC` node whose
 * `meta.spec_of` is in the ticket's `SUPERSEDES`-chain uid set with the max
 * `meta.revision_seq` (read-path analogue of {@link findChainHeadTx}, backed by
 * the same reconciliation-created functional index). `undefined` when the ticket has
 * no live revision.
 */
export async function deriveSpecHead(
  graph: GraphBackend,
  uid: string
): Promise<ISpecPointer | undefined> {
  const resolved = await resolveTicketHead(graph, uid);
  if (!resolved) return undefined;
  // The SAME union discovery the read path, the write path, and reconcile use —
  // raw `kind:'SPEC'` AND the DECLARED-kind `issue` corpus (see
  // `discoverLiveSpecNodes`). A raw-kind-only query here is undefined on the
  // reconciled production corpus, which silently skips `checkSpecStaleness`'s
  // AC7 forged-pointer cross-check. The `raw-kind-only` negative control
  // reinstates that pre-fix criterion for teeth.
  const live = specDiscoveryIsRawKindOnly()
    ? await graph.queryNodes({ kind: 'SPEC', liveOnly: true })
    : await discoverLiveSpecNodes(graph);
  const candidates = live.filter((n) => {
    const specOf = n.metadata?.['spec_of'];
    return typeof specOf === 'string' && resolved.chainUids.has(specOf);
  });
  if (candidates.length === 0) return undefined;
  candidates.sort(
    (a, b) =>
      (typeof b.metadata?.['revision_seq'] === 'number'
        ? (b.metadata['revision_seq'] as number)
        : 0) -
      (typeof a.metadata?.['revision_seq'] === 'number'
        ? (a.metadata['revision_seq'] as number)
        : 0)
  );
  const head = candidates[0]!;
  return {
    revision_uid: head.uid,
    revision_token:
      typeof head.metadata?.['revision_token'] === 'string'
        ? (head.metadata['revision_token'] as string)
        : '',
    revision_seq:
      typeof head.metadata?.['revision_seq'] === 'number'
        ? (head.metadata['revision_seq'] as number)
        : 0,
  };
}

/** The pointer ON THE RECORD only (`meta.spec_revision`) — never the derived head. Used by the staleness cross-check. */
export async function readPointerRecord(
  graph: GraphBackend,
  uid: string
): Promise<ISpecPointer | undefined> {
  const resolved = await resolveTicketHead(graph, uid);
  if (!resolved) return undefined;
  const node = await graph.getNodeByUid(resolved.uid);
  if (!node) return undefined;
  const revisionUid =
    typeof node.metadata?.['spec_revision'] === 'string'
      ? (node.metadata['spec_revision'] as string)
      : undefined;
  if (!revisionUid) return undefined;
  return {
    revision_uid: revisionUid,
    revision_token:
      typeof node.metadata?.['spec_revision_token'] === 'string'
        ? (node.metadata['spec_revision_token'] as string)
        : '',
    revision_seq:
      typeof node.metadata?.['spec_revision_seq'] === 'number'
        ? (node.metadata['spec_revision_seq'] as number)
        : 0,
  };
}

/**
 * Current revision + its token for a work item (`undefined` if it has no spec).
 * Prefers the on-record pointer; falls back to the derived chain head so a
 * ticket whose pointer was not (yet) written — pre-reconciliation data — still reads.
 */
export async function readSpecPointer(
  graph: GraphBackend,
  uid: string
): Promise<ISpecPointer | undefined> {
  return (
    (await readPointerRecord(graph, uid)) ??
    (await deriveSpecHead(graph, uid))
  );
}

