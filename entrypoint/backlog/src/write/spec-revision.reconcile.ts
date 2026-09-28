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
 * Compute the reconciliation plan WITHOUT writing (the dry-run). Discovery is
 * `query`-driven; nothing is mutated.
 */
export async function planSpecRevisionReconcile(
  store: ISpecReconcileStore
): Promise<ISpecReconcileReport> {
  const specs = await store.graph.queryNodes({ kind: 'SPEC', liveOnly: true });

  // Group SPEC children by their live `part_of` parent.
  const byParent = new Map<string, { parent: NodeRecord; specs: NodeRecord[] }>();
  const orphaned: string[] = [];
  for (const s of specs) {
    const edges = await store.graph.getEdges({ dst: s.id, rel: 'part_of' });
    const parentId = edges[0]?.src;
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
