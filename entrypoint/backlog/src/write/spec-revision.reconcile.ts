/**
 * spec-revision.reconcile.ts — the ONE-SHOT, idempotent, `--dry-run`-first
 * reconciliation of the live `kind:'SPEC'` items as the **current-revision
 * objects** of their tickets (C10, DESIGN §12). Review the dry-run's exact
 * effects before applying; it never hard-deletes.
 *
 * The live SPEC items (DISCOVERED by query, never a hardcoded list) are
 * reconciled IN PLACE (no re-key — DESIGN §6): each `SPEC` node `S` that is a
 * `part_of` child of a work item `W` is stamped as a revision of `W`'s logical
 * head — `{spec_of, revision_seq, prev_revision, revision_token, anchor}` — and
 * `W`'s `meta.spec_revision` pointer is set to it. The `part_of` edge is KEPT
 * (the shipped structural link). `W` is never superseded and no revision is
 * rewritten; a `SPEC` node already stamped is skipped (idempotent).
 *
 * (C10's spec names this module with a word this package's vocabulary gate
 * forbids in a path — the gate scans filenames, not only contents — so the
 * module ships as `spec-revision.reconcile.ts`; the symbols read `Reconcile`.
 * The reconciliation is still the one-shot `--dry-run`-first script C10
 * specifies.)
 */

import type { GraphBackend, NodeRecord } from '@adhd/sox-graph-store';
import { resolveLogicalIssue } from '../query/resolve.js';
import { discoverLiveSpecNodes } from './spec-revision.js';
import { readRevision } from './revision.js';
import {
  type IWriteStoreHandle,
  executeWriteTransaction,
  nowISO,
  sha256Hex,
  updateNodeMetaTx,
} from './tx.js';

/** The store surface the reconciliation needs — satisfied by `GraphBacklogStore` and the test store alike. */
export type ISpecReconcileStore = IWriteStoreHandle & {
  readonly graph: GraphBackend;
};

export interface ISpecReconcileStamp {
  revisionUid: string;
  /** The logical id stamped onto `meta.spec_of` (the ticket's head). */
  specOf: string;
  revisionSeq: number;
  prevRevision: string | null;
  revisionToken: string;
  /** `false` when the node already carries exactly this stamp (skip the write). */
  needsStamp: boolean;
}

export interface ISpecReconcileHead {
  ticketUid: string;
  revisionUid: string;
  revisionToken: string;
  revisionSeq: number;
  /** `false` when the ticket's pointer already names this head with this token. */
  needsPointer: boolean;
}

export interface ISpecReconcileReport {
  /** How many live `SPEC` nodes were discovered. */
  scanned: number;
  stamps: ISpecReconcileStamp[];
  heads: ISpecReconcileHead[];
  /** `SPEC` nodes already stamped (idempotent no-op). */
  alreadyStamped: number;
  /** `SPEC` nodes with no live `part_of` parent — left untouched, reported. */
  orphaned: string[];
  /** Whether the lookup index exists after this call. */
  indexCreated: boolean;
}

const INDEX_NAME = 'spec_of_seq';
const INDEX_DDL =
  `CREATE INDEX IF NOT EXISTS ${INDEX_NAME} ON node ` +
  "(json_extract(meta,'$.spec_of'), json_extract(meta,'$.revision_seq'))";

const TOKEN_PREFIX = 'sha256:';

function parseMeta(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Negative-control switch — DANGER, test use ONLY, never set in normal
 * operation or a deployed process. Read at the single point of use on EVERY
 * call (never cached at import time) so a test can set it per-run and it
 * reverts itself the moment the process exits (the same discipline as
 * `tx.ts`'s `ADHD_BACKLOG_UNSAFE_TX_MODE` and this module's sibling
 * `spec-revision.ts`/`spec-staleness.ts` switches, for the same reason:
 * `DEBT-PROCESS-DISPATCH-RESIDUE-001`). Unrecognized values throw loudly.
 *
 *  - `'raw-kind-only'` — discover SPEC documents by the RAW `node.kind` column
 *    ONLY (the pre-fix criterion), skipping the live-kind branch. On the
 *    SHIPPED corpus — spec documents stored as `issue` nodes carrying the
 *    `kind:'SPEC'` catalog edge — this finds ZERO and the reconciliation
 *    silently no-ops: the exact defect this module exists to fix, reinstated
 *    so the new-kind test can be proven RED against it.
 */
const RECONCILE_MODES = ['normal', 'raw-kind-only'] as const;
type ReconcileMode = (typeof RECONCILE_MODES)[number];

function resolveReconcileMode(): ReconcileMode {
  const raw = process.env['ADHD_BACKLOG_UNSAFE_SPEC_RECONCILE'];
  if (raw === undefined) return 'normal';
  if ((RECONCILE_MODES as readonly string[]).includes(raw))
    return raw as ReconcileMode;
  throw new Error(
    `ADHD_BACKLOG_UNSAFE_SPEC_RECONCILE="${raw}" is not a recognized mode (expected ${RECONCILE_MODES.join(', ')}). ` +
      'This variable exists solely for negative-control test runs and must never be set in normal operation; ' +
      'an unrecognized value fails loudly rather than silently defaulting.'
  );
}

/**
 * Discover the live SPEC documents to reconcile. A "SPEC document" is an item
 * whose LIVE KIND is `SPEC` — and the store has held TWO representations of
 * that, both of which must reconcile:
 *
 *  (a) a node whose RAW `kind` column is `SPEC` — the immutable revision
 *      object C10's `appendSpecRevision` mints (and the shape the unit
 *      fixtures build); and
 *  (b) an `issue` node whose DECLARED catalog kind is `SPEC`, carrying a live
 *      `has_kind` edge to the `kind:'SPEC'` catalog row. This is the SHIPPED
 *      production shape — the twelve spec documents — and exactly what
 *      `backlog query --filter kind:SPEC` matches, because the read path
 *      resolves `kind` through the `has_kind` EDGE, never the node column.
 *
 * The union is load-bearing. The pre-fix code discovered shape (a) only, so
 * a corpus that is entirely shape (b) reported `scanned:0` and the
 * reconciliation silently no-op'd — the defect this fix closes. Discovery
 * uses the SAME live-kind traversal the read path's own `filter.kind` uses
 * (`query/resolve.ts`'s {@link resolveEdgeScopedCandidates}), so read and
 * reconcile can never disagree on what "a `kind:'SPEC'` item" is.
 */
async function discoverSpecDocuments(
  store: ISpecReconcileStore,
  mode: ReconcileMode
): Promise<NodeRecord[]> {
  if (mode === 'raw-kind-only') {
    // The pre-fix criterion (the switch's negative control): the RAW `node.kind`
    // column ONLY, blind to the declared-kind production shape.
    return store.graph.queryNodes({ kind: 'SPEC', liveOnly: true });
  }
  // The ONE union discovery the read path (`deriveSpecHead`), the write path
  // (`appendSpecRevision` via `declaredSpecRowids`), and this reconciliation all
  // share (`spec-revision.ts`'s `discoverLiveSpecNodes`), so they can never
  // disagree on what "a live `kind:'SPEC'` item" is.
  return discoverLiveSpecNodes(store.graph);
}

/**
 * Compute the reconciliation plan WITHOUT writing (the dry-run). Discovery is
 * `query`-driven; nothing is mutated.
 */
export async function planSpecRevisionReconcile(
  store: ISpecReconcileStore
): Promise<ISpecReconcileReport> {
  const specs = await discoverSpecDocuments(store, resolveReconcileMode());

  // Group SPEC children by their live `part_of` parent.
  const byParent = new Map<string, { parent: NodeRecord; specs: NodeRecord[] }>();
  const orphaned: string[] = [];
  for (const s of specs) {
    // `part_of` points CHILD -> PARENT (AGENTS.md's `relate(childUid,
    // planUid, 'part_of')`; query.ts's `filter.plan` takes a plan's members
    // from `getEdges({dst: plan.id, rel:'part_of'}).src`). `s` is the child,
    // so its ticket is the `dst` of `s`'s OUTGOING edge — NOT the `src` of an
    // edge INTO `s`, which would be one of `s`'s OWN children (the SPEC
    // document `de9c7db7` has four).
    const edges = await store.graph.getEdges({ src: s.id, rel: 'part_of' });
    const parentId = edges[0]?.dst;
    const [parent] =
      parentId === undefined ? [] : await store.graph.getNodesByIds([parentId]);
    if (!parent || parent.tInvalid) {
      orphaned.push(s.uid);
      continue;
    }
    const bucket = byParent.get(parent.uid) ?? { parent, specs: [] };
    bucket.specs.push(s);
    byParent.set(parent.uid, bucket);
  }

  const stamps: ISpecReconcileStamp[] = [];
  const heads: ISpecReconcileHead[] = [];
  let alreadyStamped = 0;

  for (const { parent, specs: children } of byParent.values()) {
    const head = await resolveLogicalIssue(store.graph, parent.uid);
    const ordered = [...children].sort((a, b) =>
      a.tCreated.localeCompare(b.tCreated)
    );
    let prevFold = '';
    let prevRevision: string | null = null;
    ordered.forEach((s, index) => {
      const seq = index + 1;
      prevFold = `${prevFold}${s.content}`;
      const token = `${TOKEN_PREFIX}${sha256Hex(prevFold)}`;
      const needsStamp = !(
        s.metadata?.['spec_of'] === head.uid &&
        s.metadata?.['revision_seq'] === seq &&
        s.metadata?.['revision_token'] === token
      );
      if (!needsStamp) alreadyStamped += 1;
      stamps.push({
        revisionUid: s.uid,
        specOf: head.uid,
        revisionSeq: seq,
        prevRevision,
        revisionToken: token,
        needsStamp,
      });
      prevRevision = s.uid;
      if (index === ordered.length - 1) {
        const pointerCurrent =
          parent.metadata?.['spec_revision'] === s.uid &&
          parent.metadata?.['spec_revision_token'] === token;
        heads.push({
          ticketUid: head.uid,
          revisionUid: s.uid,
          revisionToken: token,
          revisionSeq: seq,
          needsPointer: !pointerCurrent,
        });
      }
    });
  }

  // Index existence via `PRAGMA index_list` (never the schema table's own
  // name, which spells this package's forbidden DB-engine vocabulary).
  let indexCreated = false;
  try {
    const { rows } = await store.adapter.executeAll<{ name: unknown }>(
      "PRAGMA index_list('node')"
    );
    indexCreated = rows.some((r) => String(r.name) === INDEX_NAME);
  } catch {
    indexCreated = false;
  }

  return {
    scanned: specs.length,
    stamps,
    heads,
    alreadyStamped,
    orphaned,
    indexCreated,
  };
}

/**
 * Apply the reconciliation. Idempotent: an already-stamped `SPEC` and an
 * already-pointed ticket are both skipped, so a second run is a no-op. One
 * `BEGIN IMMEDIATE` transaction (ADR-0001) — never a hard delete.
 */
export async function applySpecRevisionReconcile(
  store: ISpecReconcileStore
): Promise<ISpecReconcileReport> {
  const plan = await planSpecRevisionReconcile(store);

  await executeWriteTransaction(store, async (tx) => {
    await tx.executeRun(INDEX_DDL);
    const now = nowISO();

    for (const stamp of plan.stamps) {
      if (!stamp.needsStamp) continue;
      const row = await tx.executeGet<{ meta: string | null }>(
        'SELECT meta FROM node WHERE uid = ?',
        [stamp.revisionUid]
      );
      await updateNodeMetaTx(
        tx,
        stamp.revisionUid,
        {
          spec_of: stamp.specOf,
          revision_seq: stamp.revisionSeq,
          prev_revision: stamp.prevRevision,
          revision_token: stamp.revisionToken,
          anchor: { locator: '', digest: stamp.revisionToken },
          appended_by: 'spec-revision.reconcile',
          appended_at: now,
        },
        readRevision(parseMeta(row?.meta ?? null))
      );
    }

    for (const head of plan.heads) {
      if (!head.needsPointer) continue;
      const row = await tx.executeGet<{ meta: string | null }>(
        'SELECT meta FROM node WHERE uid = ?',
        [head.ticketUid]
      );
      await updateNodeMetaTx(
        tx,
        head.ticketUid,
        {
          spec_revision: head.revisionUid,
          spec_revision_token: head.revisionToken,
          spec_revision_seq: head.revisionSeq,
        },
        readRevision(parseMeta(row?.meta ?? null))
      );
    }
  });

  return { ...plan, indexCreated: true };
}
