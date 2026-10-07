/**
 * membership-backfill.ts — the reversible migration that gives every existing
 * issue its `in_component` membership rows (e54bd58b A-AC5, S02.S2; the n:m
 * model lives in `membership.ts`). Modelled on `catalog-repair.ts`:
 * plan / apply / reverse, a journal that records exactly what was written, and
 * idempotency (a re-run plans zero writes).
 *
 * The migration only ADDS membership. It never writes, re-points or invalidates
 * `owns_component`, so per-project issue counts keyed by primary owner are
 * unchanged by construction; {@link measureMembership} proves it by reading the
 * counts before and after. It reuses {@link reconcileMembershipTx} verbatim so
 * the migration and the live write hooks can never disagree about what a
 * correct row set is.
 *
 * Batched (default 200 issues per `BEGIN IMMEDIATE`), resumable and safe under
 * concurrent writers: a `create` that lands mid-run is membership-complete at
 * write time, and the post-run plan must show zero pending.
 */
import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import { resolveEdgeKindTx } from './catalog.js';
import { reconcileMembershipTx } from './membership.js';
import {
  type IWriteStoreHandle,
  executeWriteTransaction,
  invalidateEdgeTx,
  nowISO,
  writeEdgeTx,
} from './tx.js';

/** Default issues per write transaction. */
export const MEMBERSHIP_BACKFILL_BATCH = 200;

/** One `in_component` edge as journaled. */
export interface IMembershipJournalEdge {
  srcRowid: number;
  srcUid: string;
  dstRowid: number;
  dstUid: string;
  /** Edge meta at the time (`{via, citationUid?}`). */
  metadata: Record<string, unknown>;
}

/** The apply journal: exactly the edges created and (rarely) invalidated, so `--reverse` restores the prior state. */
export interface IMembershipBackfillJournal {
  at: string;
  created: IMembershipJournalEdge[];
  invalidated: IMembershipJournalEdge[];
}

/** Issues the plan found needing writes. */
export interface IMembershipBackfillPlan {
  at: string;
  /** Live head issues examined. */
  issuesExamined: number;
  /** Issues whose reconcile would write at least one edge. */
  pendingIssueUids: string[];
  /** Total edge writes the apply would make. */
  pendingWrites: number;
}

/** Counts used to prove the migration neither dropped nor re-owned anything. */
export interface IMembershipMeasurement {
  /** projectUid → issue count keyed by PRIMARY owner (`owns_component` → `owns_project`). */
  countsByPrimaryProject: Record<string, number>;
  /** projectUid → sorted issue uids that are members of any of the project's components. */
  membershipByProject: Record<string, string[]>;
  /** Live head issues that do not have exactly one live `owns_component` (I1). */
  i1Violations: string[];
  /** Live head issues lacking a live `via:'primary'` `in_component` to their primary component (I2). */
  i2Violations: string[];
}

class RollbackProbe extends Error {
  constructor(readonly payload: unknown) {
    super('membership-backfill: dry-run probe (rolled back)');
  }
}

interface IIssueRow {
  rowid: number;
  uid: string;
}

async function liveHeadIssues(
  tx: AdapterTransaction | IWriteStoreHandle['adapter'],
  afterRowid: number,
  limit: number
): Promise<IIssueRow[]> {
  const { rows } = await tx.executeAll<IIssueRow>(
    `SELECT rowid, uid FROM node
     WHERE kind = 'issue' AND t_invalid IS NULL AND COALESCE(is_superseded, 0) = 0 AND rowid > ?
     ORDER BY rowid ASC LIMIT ?`,
    [afterRowid, limit]
  );
  return rows;
}

interface IEdgeSnapshotRow {
  srcRowid: number;
  srcUid: string;
  dstRowid: number;
  dstUid: string;
  meta: string | null;
}

async function snapshotInComponent(
  tx: AdapterTransaction,
  issueRowid: number
): Promise<Map<number, IMembershipJournalEdge>> {
  const { rows } = await tx.executeAll<IEdgeSnapshotRow>(
    `SELECT e.src AS srcRowid, s.uid AS srcUid, e.dst AS dstRowid, d.uid AS dstUid, e.meta AS meta
     FROM edge e JOIN node s ON s.rowid = e.src JOIN node d ON d.rowid = e.dst
     WHERE e.src = ? AND e.rel = 'in_component' AND e.t_invalid IS NULL`,
    [issueRowid]
  );
  const out = new Map<number, IMembershipJournalEdge>();
  for (const r of rows) {
    let metadata: Record<string, unknown> = {};
    if (r.meta !== null) {
      try {
        const parsed: unknown = JSON.parse(r.meta);
        if (parsed !== null && typeof parsed === 'object') metadata = parsed as Record<string, unknown>;
      } catch {
        metadata = {};
      }
    }
    out.set(r.dstRowid, {
      srcRowid: r.srcRowid,
      srcUid: r.srcUid,
      dstRowid: r.dstRowid,
      dstUid: r.dstUid,
      metadata,
    });
  }
  return out;
}

/**
 * Plan the backfill without writing: each batch runs the real reconcile inside
 * a transaction that is rolled back by a sentinel throw, so "pending" is the
 * exact write count an apply would make — never a re-derived approximation.
 */
export async function planMembershipBackfill(
  handle: IWriteStoreHandle,
  opts: { batchSize?: number; at?: string } = {}
): Promise<IMembershipBackfillPlan> {
  const batch = opts.batchSize ?? MEMBERSHIP_BACKFILL_BATCH;
  const at = opts.at ?? nowISO();
  const pendingIssueUids: string[] = [];
  let pendingWrites = 0;
  let issuesExamined = 0;
  let cursor = 0;
  for (;;) {
    const issues = await liveHeadIssues(handle.adapter, cursor, batch);
    if (issues.length === 0) break;
    cursor = issues[issues.length - 1]!.rowid;
    issuesExamined += issues.length;
    try {
      await executeWriteTransaction(
        { ...handle, verb: 'admin(membership-backfill-plan)' },
        async (tx: AdapterTransaction) => {
          const found: Array<{ uid: string; writes: number }> = [];
          for (const issue of issues) {
            const writes = await reconcileMembershipTx(tx, handle, {
              issueRowid: issue.rowid,
              issueUid: issue.uid,
              at,
            });
            if (writes > 0) found.push({ uid: issue.uid, writes });
          }
          throw new RollbackProbe(found);
        }
      );
    } catch (err) {
      if (!(err instanceof RollbackProbe)) throw err;
      for (const f of err.payload as Array<{ uid: string; writes: number }>) {
        pendingIssueUids.push(f.uid);
        pendingWrites += f.writes;
      }
    }
  }
  return { at, issuesExamined, pendingIssueUids, pendingWrites };
}

/** Apply the backfill batch by batch; returns the journal of every edge it created or invalidated. */
export async function applyMembershipBackfill(
  handle: IWriteStoreHandle,
  opts: { batchSize?: number; at?: string } = {}
): Promise<IMembershipBackfillJournal> {
  const batch = opts.batchSize ?? MEMBERSHIP_BACKFILL_BATCH;
  const at = opts.at ?? nowISO();
  const journal: IMembershipBackfillJournal = { at, created: [], invalidated: [] };
  let cursor = 0;
  for (;;) {
    const issues = await liveHeadIssues(handle.adapter, cursor, batch);
    if (issues.length === 0) break;
    cursor = issues[issues.length - 1]!.rowid;
    const entries = await executeWriteTransaction(
      { ...handle, verb: 'admin(membership-backfill)' },
      async (tx: AdapterTransaction) => {
        const created: IMembershipJournalEdge[] = [];
        const invalidated: IMembershipJournalEdge[] = [];
        for (const issue of issues) {
          const before = await snapshotInComponent(tx, issue.rowid);
          const writes = await reconcileMembershipTx(tx, handle, {
            issueRowid: issue.rowid,
            issueUid: issue.uid,
            at,
          });
          if (writes === 0) continue;
          const after = await snapshotInComponent(tx, issue.rowid);
          for (const [dst, edge] of after) {
            const prior = before.get(dst);
            if (prior === undefined || JSON.stringify(prior.metadata) !== JSON.stringify(edge.metadata)) {
              created.push(edge);
              if (prior !== undefined) invalidated.push(prior);
            }
          }
          for (const [dst, edge] of before) {
            if (!after.has(dst)) invalidated.push(edge);
          }
        }
        return { created, invalidated };
      }
    );
    journal.created.push(...entries.created);
    journal.invalidated.push(...entries.invalidated);
  }
  return journal;
}

/**
 * Reverse a journal: invalidate every edge it created and re-write every edge
 * it invalidated (with its prior meta). Idempotent.
 */
export async function reverseMembershipBackfill(
  handle: IWriteStoreHandle,
  journal: IMembershipBackfillJournal,
  opts: { batchSize?: number } = {}
): Promise<void> {
  const batch = opts.batchSize ?? MEMBERSHIP_BACKFILL_BATCH;
  const at = nowISO();
  for (let i = 0; i < journal.created.length; i += batch) {
    const slice = journal.created.slice(i, i + batch);
    await executeWriteTransaction(
      { ...handle, verb: 'admin(membership-backfill-reverse)' },
      async (tx: AdapterTransaction) => {
        for (const e of slice) {
          await invalidateEdgeTx(tx, {
            srcRowid: e.srcRowid,
            dstRowid: e.dstRowid,
            rel: 'in_component',
            reason: 'membership-backfill reversed',
            at,
          });
        }
      }
    );
  }
  for (let i = 0; i < journal.invalidated.length; i += batch) {
    const slice = journal.invalidated.slice(i, i + batch);
    await executeWriteTransaction(
      { ...handle, verb: 'admin(membership-backfill-reverse)' },
      async (tx: AdapterTransaction) => {
        const rule = await resolveEdgeKindTx(tx, 'in_component');
        for (const e of slice) {
          await writeEdgeTx(tx, {
            at,
            srcRowid: e.srcRowid,
            srcUid: e.srcUid,
            srcKind: 'issue',
            dstRowid: e.dstRowid,
            dstUid: e.dstUid,
            dstKind: 'component',
            rel: 'in_component',
            metadata: e.metadata,
            rule,
            typePolicy: handle.typePolicy,
          });
        }
      }
    );
  }
}

/**
 * Read the numbers the A-AC5 equality is stated over: per-project primary
 * counts, per-project membership sets, and the I1/I2 invariant violations.
 * Plain reads against the bare adapter.
 */
export async function measureMembership(handle: IWriteStoreHandle): Promise<IMembershipMeasurement> {
  const a = handle.adapter;
  const { rows: issues } = await a.executeAll<IIssueRow>(
    `SELECT rowid, uid FROM node
     WHERE kind = 'issue' AND t_invalid IS NULL AND COALESCE(is_superseded, 0) = 0`
  );
  const { rows: owners } = await a.executeAll<{ issue: number; comp: number }>(
    `SELECT dst AS issue, src AS comp FROM edge WHERE rel = 'owns_component' AND t_invalid IS NULL`
  );
  const { rows: projOf } = await a.executeAll<{ comp: number; project: string }>(
    `SELECT e.dst AS comp, p.uid AS project
     FROM edge e JOIN node p ON p.rowid = e.src
     WHERE e.rel = 'owns_project' AND e.t_invalid IS NULL`
  );
  const { rows: members } = await a.executeAll<{ issue: number; comp: number; meta: string | null }>(
    `SELECT src AS issue, dst AS comp, meta FROM edge WHERE rel = 'in_component' AND t_invalid IS NULL`
  );
  const projectOfComp = new Map(projOf.map((r) => [r.comp, r.project]));
  const ownersByIssue = new Map<number, number[]>();
  for (const o of owners) ownersByIssue.set(o.issue, [...(ownersByIssue.get(o.issue) ?? []), o.comp]);
  const membersByIssue = new Map<number, Array<{ comp: number; via: string }>>();
  for (const m of members) {
    let via = 'primary';
    if (m.meta !== null) {
      try {
        const parsed = JSON.parse(m.meta) as { via?: unknown };
        if (typeof parsed.via === 'string') via = parsed.via;
      } catch {
        /* keep default */
      }
    }
    membersByIssue.set(m.issue, [...(membersByIssue.get(m.issue) ?? []), { comp: m.comp, via }]);
  }

  const countsByPrimaryProject: Record<string, number> = {};
  const membershipSets = new Map<string, Set<string>>();
  const i1Violations: string[] = [];
  const i2Violations: string[] = [];
  const addMember = (project: string, uid: string): void => {
    let s = membershipSets.get(project);
    if (s === undefined) membershipSets.set(project, (s = new Set()));
    s.add(uid);
  };
  for (const issue of issues) {
    const own = ownersByIssue.get(issue.rowid) ?? [];
    if (own.length !== 1) {
      i1Violations.push(issue.uid);
      continue;
    }
    const primaryComp = own[0]!;
    const primaryProject = projectOfComp.get(primaryComp);
    if (primaryProject !== undefined) {
      countsByPrimaryProject[primaryProject] = (countsByPrimaryProject[primaryProject] ?? 0) + 1;
    }
    const rows = membersByIssue.get(issue.rowid) ?? [];
    if (!rows.some((r) => r.comp === primaryComp && r.via === 'primary')) i2Violations.push(issue.uid);
    for (const r of rows) {
      const project = projectOfComp.get(r.comp);
      if (project !== undefined) addMember(project, issue.uid);
    }
  }
  const membershipByProject: Record<string, string[]> = {};
  for (const [project, set] of membershipSets) membershipByProject[project] = [...set].sort();
  return { countsByPrimaryProject, membershipByProject, i1Violations, i2Violations };
}

/**
 * The PRIMARY-only membership set of each project, derived from `owns_component`
 * — what `membershipByProject` was before any `in_component` row existed. The
 * after-run membership set must be a SUPERSET of this (n:m adds, never drops).
 */
export async function primaryMembershipByProject(
  handle: IWriteStoreHandle
): Promise<Record<string, string[]>> {
  const { rows } = await handle.adapter.executeAll<{ project: string; issue: string }>(
    `SELECT p.uid AS project, i.uid AS issue
     FROM edge oc
     JOIN edge op ON op.dst = oc.src AND op.rel = 'owns_project' AND op.t_invalid IS NULL
     JOIN node p ON p.rowid = op.src
     JOIN node i ON i.rowid = oc.dst
     WHERE oc.rel = 'owns_component' AND oc.t_invalid IS NULL
       AND i.kind = 'issue' AND i.t_invalid IS NULL AND COALESCE(i.is_superseded, 0) = 0`
  );
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.project] ??= []).push(r.issue);
  for (const k of Object.keys(out)) out[k]!.sort();
  return out;
}
