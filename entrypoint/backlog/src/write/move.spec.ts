/**
 * move.spec.ts — behavioral proof for `move` (SPEC.md §6.3.6, §9 AC-17,
 * this file's own move.ts doc comment on the `(root)` default mirroring §9
 * AC-23).
 *
 * `move` reparents an issue's ONE live `owns_component` edge onto a
 * (possibly different) project's (possibly different) component. Its
 * correctness bar, proven here against a REAL store (never a mock of `move`
 * itself, never a mock of the store):
 *
 * 1. **AC-17 — exactly one live `owns_component` edge, before AND after.**
 *    A successful move invalidates the OLD edge and writes the NEW one in
 *    the SAME transaction; a direct SQL count against the `edge` table
 *    (never the outcome object, which is a self-report) proves this both
 *    for a component-only move and a cross-project move.
 * 2. **The `(root)` default, both ends.** Omitting `toComponent` resolves to
 *    the destination project's reserved `(root)` (never throws, never
 *    mints); omitting `toProject` resolves to the issue's OWN CURRENT
 *    project (a component-only move); omitting BOTH resolves to the
 *    issue's own project's `(root)`.
 * 3. **Same-placement calls are a stated no-op** — `noop:true`, nothing
 *    invalidated, nothing written, no audit row. Proven with teeth: the
 *    audit trail length and the live-edge's own rowid are asserted
 *    UNCHANGED across the no-op call.
 * 4. **Resolve-only, never minted** — an unresolved `toProject`/`toComponent`
 *    throws `CatalogNotFoundError`, including a component name that exists
 *    only under a DIFFERENT project than the resolved destination.
 * 5. **Automatic audit** — every real move writes exactly one `audit` node
 *    (`action:'moved'`, `from`/`to` = the component uids).
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { createIssue } from './create-issue.js';
import { move } from './move.js';
import { CatalogNotFoundError, InvalidArgumentError, IssueNotFoundError } from './errors.js';
import { getNodeByUidTx, writeNodeTx, writeEdgeTx, nowISO, type ITxNodeRow } from './tx.js';
import { resolveEdgeKindTx } from './catalog.js';

async function readNode(store: TestIssueStore, uid: string): Promise<ITxNodeRow | null> {
  return store.adapter.transaction(async (tx) => getNodeByUidTx(tx, uid));
}

interface RawAuditRow {
  action: string;
  from: string | null;
  to: string | null;
}

/** Reads every `audit` node linked to `subjectRowid` via a live `audits` edge, oldest first — a direct, real SQL read, never a mock. */
async function readAuditTrail(store: TestIssueStore, subjectRowid: number): Promise<RawAuditRow[]> {
  const { rows } = await store.adapter.executeAll<{ meta: string | null }>(
    `SELECT a.meta as meta FROM edge e JOIN node a ON a.rowid = e.dst
     WHERE e.src = ? AND e.rel = 'audits' AND e.t_invalid IS NULL AND a.kind = 'audit'
     ORDER BY a.rowid ASC`,
    [subjectRowid],
  );
  return rows.map((row) => {
    const meta = row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {};
    return {
      action: String(meta['action'] ?? ''),
      from: (meta['from'] as string | null) ?? null,
      to: (meta['to'] as string | null) ?? null,
    };
  });
}

/** Direct SQL count of LIVE `owns_component` edges targeting `issueRowid` — the AC-17 invariant, checked against the real edge table, never the outcome object a broken implementation could self-report incorrectly. */
async function countLiveOwnsComponentEdges(store: TestIssueStore, issueRowid: number): Promise<number> {
  const { rows } = await store.adapter.executeAll<{ n: number }>(
    `SELECT COUNT(*) as n FROM edge WHERE dst = ? AND rel = 'owns_component' AND t_invalid IS NULL`,
    [issueRowid],
  );
  return rows[0]?.n ?? 0;
}

/** Adds a second component to an already-seeded project — the SAME hand-composed `writeNodeTx`/`writeEdgeTx` primitives `seedProject`'s own `(root)` component uses, never a bespoke insert. */
async function addComponent(
  store: TestIssueStore,
  projectUid: string,
  name: string,
): Promise<{ componentUid: string; componentRowid: number }> {
  const projectRow = await readNode(store, projectUid);
  if (!projectRow) throw new Error(`setup: project ${projectUid} not found`);
  return store.adapter.transaction(
    async (tx) => {
      const now = nowISO();
      const component = await writeNodeTx(tx, { kind: 'component', name, metadata: { projectUid }, at: now });
      const rule = await resolveEdgeKindTx(tx, 'owns_project');
      await writeEdgeTx(tx, {
        at: now,
        srcRowid: projectRow.rowid, srcUid: projectUid, srcKind: 'project',
        dstRowid: component.rowid, dstUid: component.uid, dstKind: 'component',
        rel: 'owns_project', rule, typePolicy: store.typePolicy,
      });
      return { componentUid: component.uid, componentRowid: component.rowid };
    },
    { mode: 'immediate' },
  );
}

describe('move — reparent an issue between projects/components (SPEC.md §6.3.6, §9 AC-17, real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectAUid: string;
  let projectARootUid: string;
  let projectBUid: string;
  let projectBRootUid: string;
  let componentXUid: string; // a non-root component under project A
  let issueUid: string;
  let issueRowid: number;

  beforeEach(async () => {
    dir = freshTmpDir('move-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));

    const seededA = await seedProject(store, 'move-spec-project-a');
    projectAUid = seededA.projectUid;
    const rootA = await readNode(store, projectAUid);
    if (!rootA) throw new Error('setup: project A not found');
    // `(root)` uid: resolve via a live query rather than assuming shape.
    const { rows: rootRowsA } = await store.adapter.executeAll<{ uid: string }>(
      `SELECT c.uid as uid FROM edge e JOIN node c ON c.rowid = e.dst
       WHERE e.src = ? AND e.rel = 'owns_project' AND e.t_invalid IS NULL AND c.name = '(root)'`,
      [rootA.rowid],
    );
    projectARootUid = rootRowsA[0]!.uid;

    const seededB = await seedProject(store, 'move-spec-project-b');
    projectBUid = seededB.projectUid;
    const rootB = await readNode(store, projectBUid);
    if (!rootB) throw new Error('setup: project B not found');
    const { rows: rootRowsB } = await store.adapter.executeAll<{ uid: string }>(
      `SELECT c.uid as uid FROM edge e JOIN node c ON c.rowid = e.dst
       WHERE e.src = ? AND e.rel = 'owns_project' AND e.t_invalid IS NULL AND c.name = '(root)'`,
      [rootB.rowid],
    );
    projectBRootUid = rootRowsB[0]!.uid;

    const addedX = await addComponent(store, projectAUid, 'component-x');
    componentXUid = addedX.componentUid;

    const created = await createIssue(store, {
      project: projectAUid,
      component: componentXUid,
      title: 'move target',
      body: 'exercised by move.spec.ts',
      by: 'filer',
    });
    issueUid = created.uid;
    const row = await readNode(store, issueUid);
    if (!row) throw new Error('setup: issue not found immediately after createIssue');
    issueRowid = row.rowid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('component-only move (toProject omitted): reparents within the SAME project, AC-17 holds (exactly one live edge, before and after)', async () => {
    expect(await countLiveOwnsComponentEdges(store, issueRowid)).toBe(1);

    const outcome = await move(store, { uid: issueUid, toComponent: projectARootUid, by: 'agent-a' });

    expect(outcome.noop).toBe(false);
    expect(outcome.fromProject).toBe(projectAUid);
    expect(outcome.toProject).toBe(projectAUid);
    expect(outcome.fromComponent).toBe(componentXUid);
    expect(outcome.toComponent).toBe(projectARootUid);

    expect(await countLiveOwnsComponentEdges(store, issueRowid)).toBe(1);

    const { rows } = await store.adapter.executeAll<{ src: number; t_invalid: string | null }>(
      `SELECT src, t_invalid FROM edge WHERE dst = ? AND rel = 'owns_component' ORDER BY rowid ASC`,
      [issueRowid],
    );
    expect(rows).toHaveLength(2); // old (invalidated) + new (live)
    expect(rows[0]!.t_invalid).not.toBeNull();
    expect(rows[1]!.t_invalid).toBeNull();
  });

  it('cross-project move with an explicit component: fromProject !== toProject, AC-17 still holds', async () => {
    const targetComponentB = await addComponent(store, projectBUid, 'component-y');

    const outcome = await move(store, {
      uid: issueUid,
      toProject: projectBUid,
      toComponent: targetComponentB.componentUid,
      by: 'agent-a',
    });

    expect(outcome.noop).toBe(false);
    expect(outcome.fromProject).toBe(projectAUid);
    expect(outcome.toProject).toBe(projectBUid);
    expect(outcome.fromComponent).toBe(componentXUid);
    expect(outcome.toComponent).toBe(targetComponentB.componentUid);
    expect(await countLiveOwnsComponentEdges(store, issueRowid)).toBe(1);
  });

  it('toComponent omitted resolves to the DESTINATION project\'s reserved (root) — never throws, never mints (mirrors AC-23)', async () => {
    const outcome = await move(store, { uid: issueUid, toProject: projectBUid, by: 'agent-a' });

    expect(outcome.noop).toBe(false);
    expect(outcome.toProject).toBe(projectBUid);
    expect(outcome.toComponent).toBe(projectBRootUid);
    expect(await countLiveOwnsComponentEdges(store, issueRowid)).toBe(1);

    // Never minted: still exactly one `(root)` row under project B.
    const projectBRow = await readNode(store, projectBUid);
    const { rows } = await store.adapter.executeAll<{ n: number }>(
      `SELECT COUNT(*) as n FROM edge e JOIN node c ON c.rowid = e.dst
       WHERE e.src = ? AND e.rel = 'owns_project' AND e.t_invalid IS NULL AND c.name = '(root)'`,
      [projectBRow!.rowid],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('both toProject and toComponent omitted: resolves to the issue\'s OWN project\'s (root) — a genuine, non-degenerate detach-to-root move', async () => {
    const outcome = await move(store, { uid: issueUid, by: 'agent-a' });

    expect(outcome.noop).toBe(false);
    expect(outcome.fromProject).toBe(projectAUid);
    expect(outcome.toProject).toBe(projectAUid);
    expect(outcome.fromComponent).toBe(componentXUid);
    expect(outcome.toComponent).toBe(projectARootUid);
  });

  it('same-placement call is a STATED no-op: noop:true, no edge invalidated/written, no audit row (teeth: audit count and live edge rowid unchanged)', async () => {
    const before = await readAuditTrail(store, issueRowid);
    const { rows: beforeEdge } = await store.adapter.executeAll<{ rowid: number }>(
      `SELECT rowid FROM edge WHERE dst = ? AND rel = 'owns_component' AND t_invalid IS NULL`,
      [issueRowid],
    );

    const outcome = await move(store, { uid: issueUid, toComponent: componentXUid, by: 'agent-a' });
    expect(outcome.noop).toBe(true);
    expect(outcome.fromComponent).toBe(componentXUid);
    expect(outcome.toComponent).toBe(componentXUid);

    const after = await readAuditTrail(store, issueRowid);
    expect(after).toEqual(before); // no new audit row

    const { rows: afterEdge } = await store.adapter.executeAll<{ rowid: number }>(
      `SELECT rowid FROM edge WHERE dst = ? AND rel = 'owns_component' AND t_invalid IS NULL`,
      [issueRowid],
    );
    expect(afterEdge).toEqual(beforeEdge); // the SAME live edge row, never re-written
  });

  it('omitting both fields is ALSO a no-op when the issue already lives at its own project\'s (root)', async () => {
    const rooted = await createIssue(store, {
      project: projectAUid,
      title: 'already at root',
      body: 'no component given at creation',
      by: 'filer',
    });
    const outcome = await move(store, { uid: rooted.uid, by: 'agent-a' });
    expect(outcome.noop).toBe(true);
    expect(outcome.fromComponent).toBe(projectARootUid);
    expect(outcome.toComponent).toBe(projectARootUid);
  });

  it('every real move writes exactly one audit row (action:"moved", from/to = component uids)', async () => {
    await move(store, { uid: issueUid, toComponent: projectARootUid, by: 'agent-a' });
    const trail = await readAuditTrail(store, issueRowid);
    // 'created' (from createIssue) + 'moved'.
    expect(trail.map((r) => r.action)).toEqual(['created', 'moved']);
    expect(trail[1]!.from).toBe(componentXUid);
    expect(trail[1]!.to).toBe(projectARootUid);
  });

  it('CatalogNotFoundError for an unresolvable toProject ref', async () => {
    await expect(move(store, { uid: issueUid, toProject: 'not-a-real-project', by: 'agent-a' })).rejects.toThrow(
      CatalogNotFoundError,
    );
  });

  it('CatalogNotFoundError for a toComponent that does not resolve WITHIN the resolved destination project (exists only under a DIFFERENT project)', async () => {
    // componentXUid belongs to project A; resolving it against destination project B must fail,
    // never silently fork a new component or fall through to project A's row.
    await expect(
      move(store, { uid: issueUid, toProject: projectBUid, toComponent: componentXUid, by: 'agent-a' }),
    ).rejects.toThrow(CatalogNotFoundError);

    // The rejected call must never have mutated anything.
    expect(await countLiveOwnsComponentEdges(store, issueRowid)).toBe(1);
  });

  it('CatalogNotFoundError for an unresolvable toComponent name within the (default, current) project', async () => {
    await expect(move(store, { uid: issueUid, toComponent: 'no-such-component', by: 'agent-a' })).rejects.toThrow(
      CatalogNotFoundError,
    );
  });

  it('IssueNotFoundError for a uid that does not resolve to a live issue', async () => {
    await expect(move(store, { uid: 'not-a-real-uid', by: 'agent-a' })).rejects.toThrow(IssueNotFoundError);
  });

  it('IssueNotFoundError for a uid whose issue has already been soft-deleted (never re-movable)', async () => {
    await store.adapter.executeRun('UPDATE node SET t_invalid = ? WHERE uid = ?', ['2020-01-01T00:00:00.000Z', issueUid]);
    await expect(move(store, { uid: issueUid, by: 'agent-a' })).rejects.toThrow(IssueNotFoundError);
  });

  it('InvalidArgumentError on missing/blank uid or by', async () => {
    await expect(move(store, { uid: '', by: 'agent-a' })).rejects.toThrow(InvalidArgumentError);
    await expect(move(store, { uid: issueUid, by: '   ' })).rejects.toThrow(InvalidArgumentError);
  });
});
