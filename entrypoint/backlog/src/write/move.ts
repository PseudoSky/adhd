/**
 * move.ts — `move` (SPEC.md §4, §4c, §6.3.6, §8 AC-17).
 *
 * Reparents an issue onto a (possibly different) project's (possibly
 * different) component: a hand-composed edge-invalidate (the OLD live
 * `owns_component` edge) + hand-composed edge-upsert (the NEW `owns_component`
 * edge) + `writeAudit`, atomically, against the SAME `tx` handle — never a
 * call to the library's `invalidateEdge`/`writeEdge` themselves, both of
 * which run against the bare adapter and would autocommit outside this file's
 * own `immediate` transaction (§4c). `move` is kept a dedicated verb rather
 * than folded into `relate`'s five-rel union specifically so this
 * invalidate-then-write sequence can never be skipped: `owns_component` is a
 * structural placement (exactly one live edge per issue, AC-17), not a peer
 * relation a caller could otherwise `relate(...,'owns_component','add')`
 * without ever retiring the old edge.
 *
 * **Why this file carries no `project` field on the issue side.**
 * `IMoveIssueInput` has no way to ask "what project is this issue in today" —
 * an issue's placement is reachable only by walking its own edges, exactly
 * `claim.ts`'s `resolveIssueProjectPolicyTx` does for the identical reason
 * (that file's own doc comment: "an issue's project is reachable only by
 * walking its edges"). This file reuses that same two-hop
 * `owns_component`→`owns_project` walk, hand-composed against `tx` (never
 * `getEdges()`, which is bare-adapter-only, §4c).
 *
 * **The `(root)` default, both ends (§8 AC-23, mirrored here).** `toProject`
 * omitted resolves to the issue's OWN CURRENT project — this is a
 * component-only move, the identical project. `toComponent` omitted resolves
 * to the DESTINATION project's reserved `(root)` component (whichever project
 * that is — the current one, or a newly given `toProject`) via
 * `resolveDefaultComponentTx`, never minted. Passing neither field is a
 * legitimate, non-degenerate call: "detach this issue back to its own
 * project's `(root)`" — the same operation `createIssue`'s own omitted-
 * `component` case performs at creation time, just run later against an
 * existing issue.
 *
 * **Same-placement calls are a no-op — nothing invalidated, nothing
 * written, no audit.** SPEC.md §6.3.2's `create+supersedes` composition text
 * states this explicitly for `move`'s OWN sequence when reused internally
 * ("a `project`/`component` matching the target's current placement is a
 * no-op — nothing invalidated or rewritten"): a standalone `move` call
 * resolving to the SAME component it already lives in performs the identical
 * no-op. This mirrors `relate`'s own `noop:true` semantics (§6.3.6) and
 * `claim.ts`'s shipped `release-noop` branch (claim.ts:279-280) — an
 * idempotent call is STATED via the outcome, never disguised as a real write
 * that happened to change nothing. §4a's "every state change writes an audit
 * node" does not apply here because nothing changed.
 */

import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import {
  type IResolvedCatalogRow,
  resolveComponentTx,
  resolveDefaultComponentTx,
  resolveEdgeKindTx,
  resolveProjectTx,
} from './catalog.js';
import { writeAudit } from './audit.js';
import {
  InvalidArgumentError,
  IssueNotFoundError,
  assertNotBareRoleLiteral,
} from './errors.js';
import {
  type IWriteStoreHandle,
  executeWriteTransaction,
  getNodeByRowidTx,
  getNodeByUidTx,
  invalidateEdgeTx,
  nowISO,
  writeEdgeTx,
  resolveLiveIssueTx,
} from './tx.js';

export interface IMoveIssueInput {
  /** The `issue` uid to move (§6.3, an "Issue verb"). */
  uid: string;
  /**
   * uid or name of the destination project, resolved per §6.1 —
   * RESOLVE-ONLY, exactly like `createIssue`'s own `project` field: never
   * minted by this verb. Omitted (undefined) is a distinct third case, never
   * an error: it resolves to the issue's OWN CURRENT project (a
   * component-only move — see this file's own doc comment).
   */
  toProject?: string;
  /**
   * uid or name of the destination component, scoped within the RESOLVED
   * destination project (whichever project that is), resolved per §6.1 —
   * RESOLVE-ONLY, never minted (see §6.1's project-vs-component asymmetry:
   * use `upsertComponent` first if the component does not yet exist).
   * Omitted (undefined) resolves instead to the destination project's
   * reserved default component `(root)`, already guaranteed live by
   * `upsertProject` (§3/§8 AC-23) — never minted here either.
   */
  toComponent?: string;
  /** The acting agent or person performing the move (§6.3's opening rule). REQUIRED. */
  by: string;
}

export interface IMoveIssueOutcome {
  uid: string;
  /** `true` when the resolved destination component is the SAME live component the issue already occupied — an idempotent call, stated rather than disguised (see this file's own doc comment). No edge was invalidated or written, and no audit row was produced. */
  noop: boolean;
  fromProject: string;
  toProject: string;
  fromComponent: string;
  toComponent: string;
}

function assertNonBlank(
  field: string,
  value: string | undefined
): asserts value is string {
  if (value === undefined || value.trim().length === 0) {
    throw new InvalidArgumentError(field, 'is required');
  }
}

interface IRawEdgeSrcRow {
  src: number;
}

interface IResolvedPlacementRow {
  rowid: number;
  uid: string;
  name: string;
}

/**
 * The component that owns `issueRowid` (`owns_component: component → issue
 * (1:n)`), hand-composed against `tx` (never `getEdges()`, §4c). Every live
 * issue is guaranteed exactly one live `owns_component` edge from the moment
 * it is created (`createIssue` writes it unconditionally; this verb's own
 * invalidate+write sequence below preserves the SAME invariant, §8 AC-17) —
 * so a missing edge here is a genuine graph invariant violation, never a
 * caller error. Throws a PLAIN `Error` (never a `BacklogWriteError`
 * subclass), mirroring `claim.ts`'s identical `resolveIssueProjectPolicyTx`
 * convention exactly, so it is never mistaken for one of this verb's own
 * validation outcomes.
 */
async function resolveOwningComponentTx(
  tx: AdapterTransaction,
  issueRowid: number
): Promise<IResolvedPlacementRow> {
  const edge = await tx.executeGet<IRawEdgeSrcRow>(
    'SELECT src FROM edge WHERE dst = ? AND rel = ? AND t_invalid IS NULL',
    [issueRowid, 'owns_component']
  );
  if (!edge) {
    throw new Error(
      `move: issue rowid=${issueRowid} has no live "owns_component" edge — graph invariant violation ` +
        '(every live issue must own exactly one live parent component).'
    );
  }
  const row = await getNodeByRowidTx(tx, edge.src);
  if (row?.kind !== 'component' || row.tInvalid !== null) {
    throw new Error(
      `move: resolved component rowid=${edge.src} is missing, invalidated, or not a "component" node — ` +
        'graph invariant violation.'
    );
  }
  // A live `component` row's `name` is never null in practice (§1/§6.1 — component
  // is resolved-only/mint-on-name, and every mint path names it); `?? ''` is a
  // defensive fallback for the type only, never expected to fire.
  return { rowid: row.rowid, uid: row.uid, name: row.name ?? '' };
}

/**
 * The project that owns `componentRowid` (`owns_project: project →
 * component (1:n)`), hand-composed against `tx` — the same two-hop walk
 * `claim.ts`'s `resolveIssueProjectPolicyTx` runs, one hop further. Same
 * invariant/error convention as {@link resolveOwningComponentTx}.
 */
async function resolveOwningProjectTx(
  tx: AdapterTransaction,
  componentRowid: number
): Promise<IResolvedPlacementRow> {
  const edge = await tx.executeGet<IRawEdgeSrcRow>(
    'SELECT src FROM edge WHERE dst = ? AND rel = ? AND t_invalid IS NULL',
    [componentRowid, 'owns_project']
  );
  if (!edge) {
    throw new Error(
      `move: component rowid=${componentRowid} has no live "owns_project" edge — graph invariant violation ` +
        '(every live component must be owned by exactly one live project).'
    );
  }
  const row = await getNodeByRowidTx(tx, edge.src);
  if (row?.kind !== 'project' || row.tInvalid !== null) {
    throw new Error(
      `move: resolved project rowid=${edge.src} is missing, invalidated, or not a "project" node — ` +
        'graph invariant violation.'
    );
  }
  return { rowid: row.rowid, uid: row.uid, name: row.name ?? '' };
}

/**
 * Reparent an issue onto a (possibly different) project's (possibly
 * different) component (§6.3.6, §8 AC-17). One `immediate` transaction:
 * resolve `uid` → live `issue` node (tx-scoped, §4c) → walk its CURRENT
 * `owns_component`/`owns_project` edges → resolve the DESTINATION project
 * (given, or the current one) → resolve the DESTINATION component within
 * that project (given, or that project's reserved `(root)`, §8 AC-23) → if
 * the destination component is the SAME live component the issue already
 * occupies, return a no-op outcome (nothing invalidated, nothing written, no
 * audit — see this file's own doc comment); otherwise hand-composed
 * `invalidateEdgeTx` (the OLD `owns_component` edge) THEN hand-composed
 * `writeEdgeTx` (the NEW one) THEN `writeAudit` — all against the SAME `tx`,
 * so the invalidate and the write either both land or neither does (never a
 * write-then-write that can half-apply). The invalidate runs strictly BEFORE
 * the write so `writeEdgeTx`'s own `1:n`-multiplicity check (the target
 * issue's in-degree capped at one, tx.ts's `checkMultiplicityTx`) sees the
 * old edge already retired and never raises a false
 * `SingleValuedRelationConflictError` against the issue's own prior
 * placement.
 *
 * Errors: `InvalidArgumentError` (`uid`/`by` missing/blank),
 * `IssueNotFoundError` (no live `issue` node carries `uid`),
 * `CatalogNotFoundError('project', toProject)` (a given `toProject` did not
 * resolve — resolve-only, never minted, exactly like `createIssue`'s own
 * `project` field), `CatalogNotFoundError('component', toComponent)` (a given
 * `toComponent` did not resolve WITHIN the resolved destination project —
 * resolve-only, never minted; a uid belonging to a DIFFERENT project is
 * treated identically to an unresolved ref, per `resolveComponentTx`'s own
 * contract), `SingleValuedRelationConflictError` (defensive — the generic
 * `1:n` multiplicity guard `writeEdgeTx` runs for every edge write; expected
 * unreachable here given the invalidate-before-write ordering above),
 * `WriteContentionError`/`WriteIOError` (§4c — an exhausted driver-level
 * retry on the underlying `immediate` transaction).
 */
export async function move(
  handle: IWriteStoreHandle,
  input: IMoveIssueInput
): Promise<IMoveIssueOutcome> {
  assertNonBlank('uid', input.uid);
  assertNonBlank('by', input.by);
  assertNotBareRoleLiteral('by', input.by);

  return executeWriteTransaction(handle, async (tx: AdapterTransaction) => {
    const now = nowISO();

    const issueRow = await resolveLiveIssueTx(tx, input.uid);

    const currentComponent = await resolveOwningComponentTx(tx, issueRow.rowid);
    const currentProject = await resolveOwningProjectTx(
      tx,
      currentComponent.rowid
    );

    let destProject: IResolvedPlacementRow;
    if (input.toProject !== undefined) {
      const resolved = await resolveProjectTx(tx, input.toProject);
      destProject = {
        rowid: resolved.rowid,
        uid: resolved.uid,
        name: resolved.name,
      };
    } else {
      destProject = currentProject;
    }

    let destComponent: IResolvedCatalogRow;
    if (input.toComponent !== undefined) {
      destComponent = await resolveComponentTx(tx, {
        projectUid: destProject.uid,
        ref: input.toComponent,
      });
    } else {
      destComponent = await resolveDefaultComponentTx(tx, {
        projectRowid: destProject.rowid,
      });
    }

    if (destComponent.rowid === currentComponent.rowid) {
      // Same live component, either because the caller named it explicitly
      // or because both the current and resolved-default component landed
      // on the identical row (e.g. omitting both fields when the issue is
      // already at its own project's `(root)`). Nothing invalidated,
      // nothing written, no audit — see this file's own doc comment.
      return {
        uid: issueRow.uid,
        noop: true,
        fromProject: currentProject.uid,
        toProject: destProject.uid,
        fromComponent: currentComponent.uid,
        toComponent: destComponent.uid,
      };
    }

    await invalidateEdgeTx(tx, {
      srcRowid: currentComponent.rowid,
      dstRowid: issueRow.rowid,
      rel: 'owns_component',
      reason: `moved to component "${destComponent.name}"`,
      at: now,
    });

    const ownsComponentRule = await resolveEdgeKindTx(tx, 'owns_component');
    await writeEdgeTx(tx, {
      at: now,
      srcRowid: destComponent.rowid,
      srcUid: destComponent.uid,
      srcKind: 'component',
      dstRowid: issueRow.rowid,
      dstUid: issueRow.uid,
      dstKind: 'issue',
      rel: 'owns_component',
      rule: ownsComponentRule,
      typePolicy: handle.typePolicy,
    });

    await writeAudit({
      tx,
      typePolicy: handle.typePolicy,
      subjectRowid: issueRow.rowid,
      subjectUid: issueRow.uid,
      subjectKind: 'issue',
      actor: input.by,
      action: 'moved',
      from: currentComponent.uid,
      to: destComponent.uid,
      at: now,
    });

    return {
      uid: issueRow.uid,
      noop: false,
      fromProject: currentProject.uid,
      toProject: destProject.uid,
      fromComponent: currentComponent.uid,
      toComponent: destComponent.uid,
    };
  });
}
