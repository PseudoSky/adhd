/**
 * merge-project.ts — `merge-project` / `rm-project`: the reviewed, atomic
 * retirement verbs for duplicate `project` rows (C1, DESIGN §2 Primitive 1 /
 * §7 condition 5).
 *
 * **Why these exist as explicit verbs.** A duplicate `project` row (the same
 * repo registered twice under two names, or a name/repoUrl split) corrupts
 * every `owns_project` read at once — issue counts double, `query
 * {filter:{project}}` splits, a component's `projectUid` points at the wrong
 * row. The design's stated posture is that over-merge is the dominant failure
 * and the correction is a REVIEWED operator act, never an automatic write: the
 * `sox-store` duplicates are a sox-side decision (ADR-0002 D4), and even within
 * one adhd store the merge is named by two uids, not inferred. `merge-project`
 * is that act; `upsertProjectTx`'s repoUrl pre-guard (`write/catalog.ts`) is
 * only advisory de-duplication at MINT time, not a merge.
 *
 * **Never hard-delete, never reuse an id.** The retired row keeps its uid
 * forever. It is soft-retired exactly the way `delete.ts` retires an issue:
 * `t_invalid` is stamped and the reason is merged into `meta` (never a
 * wholesale `meta` replace). In addition, a merged row carries
 * `meta.redirectTo` — the canonical survivor's uid — so the retired NAME still
 * resolves through one hop (`query/resolve.ts`'s `tryResolveRef` fallback +
 * `query/redirect.ts`'s `followRedirect`) even though the row is invisible to
 * every list view. A later `create` therefore always mints a fresh uid; there
 * is no reuse path (AC6).
 *
 * **Atomicity is the store's job (ADR-0001).** Both verbs run inside ONE
 * `executeWriteTransaction` (`BEGIN IMMEDIATE`, §4c) — no temp file, no lock
 * file, no rename trick. Either every component is re-pointed and the audit is
 * written, or nothing is.
 */

import type { IWriteStoreHandle } from './tx.js';
import {
  executeWriteTransaction,
  getNodeByUidTx,
  invalidateEdgeTx,
  nowISO,
  writeEdgeTx,
} from './tx.js';
import { resolveEdgeKindTx, resolveProjectTx } from './catalog.js';
import { writeAudit } from './audit.js';
import {
  CatalogNotFoundError,
  InvalidArgumentError,
  assertNotBareRoleLiteral,
} from './errors.js';

export interface IMergeProjectInput {
  /** The duplicate / retiring row — an exact uid. */
  fromUid: string;
  /** The canonical survivor — a uid or a name (resolved live). */
  toUid: string;
  /** identity; asserted non-blank + not a bare role literal */
  by: string;
}

export interface IMergeProjectOutcome {
  survivorUid: string;
  retiredUid: string;
  /** How many issues' `owns_component` chains were re-pointed onto the survivor. */
  movedIssues: number;
  /** Always true — the retired uid is never reusable. */
  retired: true;
}

export interface IRmProjectInput {
  uid: string;
  reason: string;
  by: string;
}

/** Local mirror of every other write verb's own `assertNonBlank` (each verb file keeps its own — see `claim.ts`/`delete.ts`/`update.ts`). */
function assertNonBlank(
  field: string,
  value: string | undefined
): asserts value is string {
  if (value === undefined || value.trim().length === 0) {
    throw new InvalidArgumentError(field, 'is required');
  }
}

/** Parse a `node.meta` JSON object, degrading corrupt data to `undefined` exactly like `tx.ts`'s own parser. */
function parseMetaObject(
  raw: string | null
): Record<string, unknown> | undefined {
  if (raw === null) return undefined;
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
 * Merge duplicate project `fromUid` into canonical `toUid` in ONE
 * `BEGIN IMMEDIATE` transaction: re-point every component owned by `fromUid`
 * (its `owns_project` edges AND each component's `meta.projectUid`) onto
 * `toUid`, set `fromUid.meta.redirectTo = toUid` + `fromUid.meta.retiredAt`,
 * stamp `t_invalid`, and write an audit row.
 *
 * Idempotent: a second call with the same `(from,to)` is a no-op success
 * (`movedIssues: 0`) — the retired `from` row is still readable by uid, its
 * `meta.redirectTo` already names the survivor.
 *
 * @throws CatalogNotFoundError `fromUid` is not a `project` row, or `toUid`
 *   does not resolve to a LIVE project.
 * @throws InvalidArgumentError `toUid` equals `fromUid`, or `fromUid` is
 *   already retired pointing at a DIFFERENT survivor (never silently
 *   re-chain).
 */
export async function mergeProject(
  handle: IWriteStoreHandle,
  input: IMergeProjectInput
): Promise<IMergeProjectOutcome> {
  assertNonBlank('fromUid', input.fromUid);
  assertNonBlank('toUid', input.toUid);
  assertNonBlank('by', input.by);
  assertNotBareRoleLiteral('by', input.by);

  return executeWriteTransaction(handle, async (tx) => {
    const now = nowISO();
    const from = await getNodeByUidTx(tx, input.fromUid);
    if (from?.kind !== 'project') {
      throw new CatalogNotFoundError('project', input.fromUid);
    }
    const to = await resolveProjectTx(tx, input.toUid);
    if (from.uid === to.uid) {
      throw new InvalidArgumentError('toUid', 'must differ from fromUid');
    }

    if (from.tInvalid !== null) {
      // Already retired. Idempotent only when it points at THIS survivor.
      const via = from.metadata?.redirectTo;
      if (via === to.uid) {
        return {
          survivorUid: to.uid,
          retiredUid: from.uid,
          movedIssues: 0,
          retired: true,
        };
      }
      throw new InvalidArgumentError(
        'fromUid',
        `"${from.uid}" is already retired` +
          (typeof via === 'string' ? ` (redirectTo "${via}")` : '') +
          ' and cannot be re-merged onto a different survivor'
      );
    }

    const ownsProjectRule = await resolveEdgeKindTx(tx, 'owns_project');
    const { rows: owned } = await tx.executeAll<{
      rowid: number;
      uid: string;
      meta: string | null;
    }>(
      `SELECT c.rowid AS rowid, c.uid AS uid, c.meta AS meta
       FROM edge e JOIN node c ON c.rowid = e.dst
       WHERE e.src = ? AND e.rel = 'owns_project' AND e.t_invalid IS NULL
         AND c.t_invalid IS NULL`,
      [from.rowid]
    );

    let movedIssues = 0;
    for (const component of owned) {
      // Every issue hanging off this component is being re-pointed with it.
      const { rows: issueEdges } = await tx.executeAll<{ n: number }>(
        "SELECT COUNT(*) AS n FROM edge WHERE src = ? AND rel = 'owns_component' AND t_invalid IS NULL",
        [component.rowid]
      );
      movedIssues += issueEdges[0]?.n ?? 0;

      // Re-point the ownership edge: invalidate project→component, write
      // survivor→component (same tx). Then keep the component's read-path
      // `meta.projectUid` in agreement with the edge — every
      // `tryResolveComponentRef`/`filter.project` read keys off that field.
      await invalidateEdgeTx(tx, {
        srcRowid: from.rowid,
        dstRowid: component.rowid,
        rel: 'owns_project',
        reason: 'project-merge',
        at: now,
      });
      await writeEdgeTx(tx, {
        at: now,
        srcRowid: to.rowid,
        srcUid: to.uid,
        srcKind: 'project',
        dstRowid: component.rowid,
        dstUid: component.uid,
        dstKind: 'component',
        rel: 'owns_project',
        rule: ownsProjectRule,
        typePolicy: handle.typePolicy,
      });
      const componentMeta = parseMetaObject(component.meta) ?? {};
      await tx.executeRun(
        'UPDATE node SET meta = ? WHERE rowid = ? AND t_invalid IS NULL',
        [JSON.stringify({ ...componentMeta, projectUid: to.uid }), component.rowid]
      );
    }

    // Soft-retire the duplicate: merge the redirect + timestamp into meta,
    // stamp t_invalid. Never a hard delete, never a uid reuse.
    const fromMeta = {
      ...(from.metadata ?? {}),
      redirectTo: to.uid,
      retiredAt: now,
      retiredReason: 'project-merge',
    };
    await tx.executeRun(
      'UPDATE node SET meta = ?, t_invalid = ? WHERE rowid = ? AND t_invalid IS NULL',
      [JSON.stringify(fromMeta), now, from.rowid]
    );

    await writeAudit({
      tx,
      typePolicy: handle.typePolicy,
      subjectRowid: from.rowid,
      subjectUid: from.uid,
      subjectKind: 'project',
      actor: input.by,
      action: 'merged',
      to: to.uid,
      note: `merged into ${to.uid}`,
      at: now,
    });

    return {
      survivorUid: to.uid,
      retiredUid: from.uid,
      movedIssues,
      retired: true,
    };
  });
}

/**
 * Soft-retire a project WITHOUT a survivor: set `meta.retiredAt`, stamp
 * `t_invalid`, and audit. No `redirectTo` is written, so its old name resolves
 * to nothing (the row is retired, not redirected).
 *
 * Idempotent: a second call against an already-retired row is a success no-op.
 *
 * @throws CatalogNotFoundError `uid` is not a `project` row.
 */
export async function rmProject(
  handle: IWriteStoreHandle,
  input: IRmProjectInput
): Promise<{ uid: string; retired: true }> {
  assertNonBlank('uid', input.uid);
  assertNonBlank('reason', input.reason);
  assertNonBlank('by', input.by);
  assertNotBareRoleLiteral('by', input.by);

  return executeWriteTransaction(handle, async (tx) => {
    const now = nowISO();
    const row = await getNodeByUidTx(tx, input.uid);
    if (row?.kind !== 'project') {
      throw new CatalogNotFoundError('project', input.uid);
    }
    if (row.tInvalid !== null) return { uid: row.uid, retired: true };

    const meta = {
      ...(row.metadata ?? {}),
      retiredAt: now,
      retiredReason: input.reason,
    };
    await tx.executeRun(
      'UPDATE node SET meta = ?, t_invalid = ? WHERE rowid = ? AND t_invalid IS NULL',
      [JSON.stringify(meta), now, row.rowid]
    );

    await writeAudit({
      tx,
      typePolicy: handle.typePolicy,
      subjectRowid: row.rowid,
      subjectUid: row.uid,
      subjectKind: 'project',
      actor: input.by,
      action: 'removed',
      note: input.reason,
      at: now,
    });

    return { uid: row.uid, retired: true };
  });
}
