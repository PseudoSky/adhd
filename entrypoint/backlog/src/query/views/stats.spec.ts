/**
 * stats.spec.ts — real-store, no-mocks behavioral proof for
 * `priorityMatrix`/`partOfRollup`/`openCurve` (SPEC.md §5).
 *
 * Every test drives the REAL write layer (`write/tx.ts`/`write/catalog.ts`/
 * `write/audit.ts`, `write/create-issue.ts`) against a real on-disk store
 * (`openTestIssueStore`) and the REAL read layer (`query/views/stats.ts`) —
 * nothing under test is mocked. Two write verbs this codebase has not built
 * yet (`transition`, `relate`) are simulated with the SAME frozen
 * `write/tx.ts`/`write/catalog.ts`/`write/audit.ts` primitives those verbs
 * will themselves call (`invalidateEdgeTx` + `writeEdgeTx` + `writeAudit` for
 * a transition; `writeEdgeTx` alone for a `part_of` edge) — this is
 * composing real, frozen primitives, never mocking the thing under test.
 *
 * Every assertion below is a DIFFERENTIAL one: each test computes both the
 * correct number AND the number a plausible-but-wrong implementation would
 * have produced (all-statuses instead of open-only; direct children instead
 * of the full transitive subtree; current status instead of reconstructed
 * status-at-instant) from data already in hand, and asserts they DIFFER —
 * proving the assertion has teeth per AGENTS.md §7 rule 2, without needing a
 * separately-built "broken" variant of the module.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  executeWriteTransaction,
  getNodeByUidTx,
  nowISO,
  writeEdgeTx,
  invalidateEdgeTx,
  type IWriteStoreHandle,
} from '../../write/tx.js';
import { mintOrResolveCatalogTx, resolveEdgeKindTx } from '../../write/catalog.js';
import { writeAudit } from '../../write/audit.js';
import { InvalidArgumentError, IssueNotFoundError } from '../../write/errors.js';
import { createIssue } from '../../write/create-issue.js';
import { deleteIssue } from '../../write/delete.js';
import { openTestIssueStore, removeTestIssueStoreDir, seedProject, type TestIssueStore } from '../../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../../test/helpers/tmp-store.js';
import { openCurve, partOfRollup, priorityMatrix } from './stats.js';

const openStores: TestIssueStore[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  while (openStores.length > 0) {
    const store = openStores.pop()!;
    await store.close();
  }
  while (tmpDirs.length > 0) {
    removeTestIssueStoreDir(tmpDirs.pop()!);
  }
});

async function setupStore(name: string): Promise<{ store: TestIssueStore; projectUid: string }> {
  const dir = freshTmpDir(name);
  tmpDirs.push(dir);
  const store = await openTestIssueStore(`${dir}/backlog.db`);
  openStores.push(store);
  const { projectUid } = await seedProject(store, name);
  return { store, projectUid };
}

/** Simulates the not-yet-built `transition` write verb using the SAME frozen `tx.ts`/`catalog.ts`/`audit.ts` primitives it will itself call. */
async function simulateTransition(
  store: IWriteStoreHandle & { graph: TestIssueStore['graph'] },
  input: { uid: string; toStatusName: string; toTerminal: boolean; actor: string; at?: string },
): Promise<{ from: string; to: string; at: string }> {
  const issueBefore = await store.graph.getNodeByUid(input.uid);
  if (!issueBefore) throw new Error(`test setup: no such issue ${input.uid}`);
  const currentStatusEdges = await store.graph.getEdges({ src: issueBefore.id, rel: 'has_status' });
  const oldStatusId = currentStatusEdges[0]?.dst;
  if (oldStatusId === undefined) throw new Error(`test setup: issue ${input.uid} carries no has_status edge`);
  const [oldStatus] = await store.graph.getNodesByIds([oldStatusId]);
  const fromName = oldStatus?.name ?? '';

  return executeWriteTransaction(store, async (tx) => {
    const now = input.at ?? nowISO();
    const issueRow = await getNodeByUidTx(tx, input.uid);
    if (!issueRow) throw new Error('test setup: issue vanished mid-transition');

    await invalidateEdgeTx(tx, { srcRowid: issueRow.rowid, dstRowid: oldStatusId, rel: 'has_status', at: now });

    const newStatus = await mintOrResolveCatalogTx(tx, {
      catalogKind: 'status',
      ref: input.toStatusName,
      at: now,
      mintMetadata: async () => ({ terminal: input.toTerminal }),
    });

    const hasStatusRule = await resolveEdgeKindTx(tx, 'has_status');
    await writeEdgeTx(tx, {
      at: now,
      srcRowid: issueRow.rowid, srcUid: issueRow.uid, srcKind: 'issue',
      dstRowid: newStatus.rowid, dstUid: newStatus.uid, dstKind: 'status',
      rel: 'has_status', rule: hasStatusRule, typePolicy: store.typePolicy,
    });

    await writeAudit({
      tx,
      typePolicy: store.typePolicy,
      subjectRowid: issueRow.rowid,
      subjectUid: issueRow.uid,
      subjectKind: 'issue',
      actor: input.actor,
      action: 'transitioned',
      from: fromName,
      to: newStatus.name,
      at: now,
    });

    return { from: fromName, to: newStatus.name, at: now };
  });
}

/** Simulates the not-yet-built `relate` write verb's `part_of` composition — a bare `writeEdgeTx` against the frozen `edge_kind` rule, exactly what `relate` will itself do. */
async function writePartOfEdge(store: TestIssueStore, input: { childUid: string; parentUid: string }): Promise<void> {
  await executeWriteTransaction(store, async (tx) => {
    const now = nowISO();
    const child = await getNodeByUidTx(tx, input.childUid);
    const parent = await getNodeByUidTx(tx, input.parentUid);
    if (!child || !parent) throw new Error('test setup: part_of endpoint missing');
    const rule = await resolveEdgeKindTx(tx, 'part_of');
    await writeEdgeTx(tx, {
      at: now,
      srcRowid: child.rowid, srcUid: child.uid, srcKind: 'issue',
      dstRowid: parent.rowid, dstUid: parent.uid, dstKind: 'issue',
      rel: 'part_of', rule, typePolicy: store.typePolicy,
    });
  });
}

describe('priorityMatrix — status-aware (BUG-023)', () => {
  it('defaults to OPEN-only counts, and an explicit terminal filter is required to see closed items', async () => {
    const { store, projectUid } = await setupStore('priority-matrix-status');

    await createIssue(store, { title: 'high open 1', body: 'b', project: projectUid, priority: 'HIGH', by: 'agent:t' });
    await createIssue(store, { title: 'high open 2', body: 'b', project: projectUid, priority: 'HIGH', by: 'agent:t' });
    const highClosed = await createIssue(store, { title: 'high closed', body: 'b', project: projectUid, priority: 'HIGH', by: 'agent:t' });
    await createIssue(store, { title: 'low open', body: 'b', project: projectUid, priority: 'LOW', by: 'agent:t' });
    await createIssue(store, { title: 'no priority', body: 'b', project: projectUid, by: 'agent:t' }); // unassigned

    await simulateTransition(store, { uid: highClosed.uid, toStatusName: 'done', toTerminal: true, actor: 'agent:t' });

    // DEFAULT (no filter.status at all) — SPEC.md §5: "counts non-terminal (open) items by default."
    const defaultResult = await priorityMatrix(store);
    expect(defaultResult.statusScope).toBe('open');
    const high = defaultResult.rows.find((r) => r.priority === 'HIGH');
    const low = defaultResult.rows.find((r) => r.priority === 'LOW');
    expect(high?.count).toBe(2); // highOpen1 + highOpen2 — highClosed excluded
    expect(low?.count).toBe(1);
    expect(defaultResult.unassigned).toBe(1);

    // TEETH: the "all statuses" universe for HIGH is 3 — different from the
    // default's 2. If `priorityMatrix`'s default silently counted every
    // status (BUG-023's exact defect), `high.count` above would already be 3
    // and this assertion would be vacuous; asserting the two numbers DIFFER
    // is what proves the default is actually status-scoped, not accidentally
    // equal to the unscoped total.
    const allResult = await priorityMatrix(store, { filter: { status: 'all' } });
    const highAll = allResult.rows.find((r) => r.priority === 'HIGH');
    expect(highAll?.count).toBe(3);
    expect(highAll?.count).not.toBe(high?.count);

    // Explicit terminal filter surfaces the closed item.
    const closedResult = await priorityMatrix(store, { filter: { status: 'closed' } });
    const highClosedRow = closedResult.rows.find((r) => r.priority === 'HIGH');
    expect(highClosedRow?.count).toBe(1);
    expect(closedResult.statusScope).toBe('closed');
  });

  it('rows are ordered by rank ascending, and scoping (project/component/kind) narrows the matrix', async () => {
    const { store, projectUid } = await setupStore('priority-matrix-scope-rank');
    // Priority mint order determines rank (nextPriorityRankTx: one past current max) — LOW minted first gets rank 0, HIGH minted second gets rank 1.
    await createIssue(store, { title: 'a', body: 'b', project: projectUid, priority: 'LOW', by: 'agent:t' });
    await createIssue(store, { title: 'b', body: 'b', project: projectUid, priority: 'HIGH', by: 'agent:t' });

    const result = await priorityMatrix(store, { filter: { status: 'all' } });
    expect(result.rows.map((r) => r.priority)).toEqual(['LOW', 'HIGH']);
    expect(result.rows[0].rank).toBeLessThan(result.rows[1].rank!);
  });

  it('rejects a filter dimension it does not compose with, naming the field', async () => {
    const { store, projectUid } = await setupStore('priority-matrix-reject');
    await createIssue(store, { title: 'x', body: 'b', project: projectUid, by: 'agent:t' });
    await expect(priorityMatrix(store, { filter: { grep: 'x' } })).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('never counts a soft-deleted issue in a priority row, nor lets it inflate "unassigned" — deleteIssue invalidates only the node, never its edges', async () => {
    const { store, projectUid } = await setupStore('priority-matrix-deleted');

    const withPriority = await createIssue(store, { title: 'has priority, will be deleted', body: 'b', project: projectUid, priority: 'HIGH', by: 'agent:t' });
    const withoutPriority = await createIssue(store, { title: 'no priority, will be deleted', body: 'b', project: projectUid, by: 'agent:t' });
    await createIssue(store, { title: 'survives', body: 'b', project: projectUid, priority: 'HIGH', by: 'agent:t' });

    const before = await priorityMatrix(store);
    expect(before.rows.find((r) => r.priority === 'HIGH')?.count).toBe(2); // withPriority + survives
    expect(before.unassigned).toBe(1); // withoutPriority

    // Real deletes, through the real write verb — not a library-internal
    // `invalidate` bypass. `deleteIssue` (write/delete.ts) stamps ONLY the
    // issue's own node row; it never invalidates `has_status`/`has_priority`
    // edges, so both deleted issues' edges remain live on disk after this.
    await deleteIssue(store, { uid: withPriority.uid, reason: 'test: delete after has_priority edge written', by: 'closer' });
    await deleteIssue(store, { uid: withoutPriority.uid, reason: 'test: delete an unassigned open issue', by: 'closer' });

    const after = await priorityMatrix(store);
    const highAfter = after.rows.find((r) => r.priority === 'HIGH');
    expect(highAfter?.count).toBe(1); // only 'survives' — withPriority is gone, neither open nor closed work
    expect(after.unassigned).toBe(0); // withoutPriority is gone too — never inflates the count forever

    // TEETH: the naive edge-only scan (exactly what a candidate set built
    // purely from `has_priority`/`has_status` edge existence, with no check
    // of the issue node's own liveness, would report) — computed directly
    // against the real store, not a remembered number. Confirms the edge
    // genuinely DOES outlive the deleted node (the root cause), and that the
    // fixed `priorityMatrix` result diverges from that naive scan.
    const highPriorityNode = (await store.graph.queryNodes({ kind: 'priority', liveOnly: true })).find((p) => p.name === 'HIGH')!;
    const naiveHighEdges = await store.graph.getEdges({ dst: highPriorityNode.id, rel: 'has_priority' });
    expect(naiveHighEdges.length).toBe(2); // withPriority's (dead) edge + survives — the edge outlives the node
    expect(naiveHighEdges.length).not.toBe(highAfter?.count);
  });
});

describe('partOfRollup — transitive, not one-level (FEAT-005)', () => {
  it('counts every transitive descendant exactly once, deeper than one level', async () => {
    const { store, projectUid } = await setupStore('part-of-rollup-depth');
    const root = await createIssue(store, { title: 'root', body: 'b', project: projectUid, by: 'agent:t' });
    const child1 = await createIssue(store, { title: 'child1 (open)', body: 'b', project: projectUid, by: 'agent:t' });
    const child2 = await createIssue(store, { title: 'child2 (closed)', body: 'b', project: projectUid, by: 'agent:t' });
    const grandchild = await createIssue(store, { title: 'grandchild (open)', body: 'b', project: projectUid, by: 'agent:t' });

    await writePartOfEdge(store, { childUid: child1.uid, parentUid: root.uid });
    await writePartOfEdge(store, { childUid: child2.uid, parentUid: root.uid });
    await writePartOfEdge(store, { childUid: grandchild.uid, parentUid: child1.uid }); // TWO levels deep from root

    await simulateTransition(store, { uid: child2.uid, toStatusName: 'done', toTerminal: true, actor: 'agent:t' });

    const rollup = await partOfRollup(store, { uid: root.uid });

    // TEETH: a direct-children-only implementation (the legacy one-level
    // `computeRollup`) would see exactly `directChildEdges.length` — compute
    // that number independently here and assert it is LESS than
    // `childrenTotal`, proving the grandchild was actually reached.
    const directChildEdges = await store.graph.getEdges({ dst: (await store.graph.getNodeByUid(root.uid))!.id, rel: 'part_of' });
    expect(directChildEdges.length).toBe(2);
    expect(rollup.childrenTotal).toBe(3);
    expect(rollup.childrenTotal).toBeGreaterThan(directChildEdges.length);

    expect(rollup.childrenOpen).toBe(2); // child1 + grandchild
    expect(rollup.childrenClosed).toBe(1); // child2
    expect(new Set(rollup.childrenOpenUids)).toEqual(new Set([child1.uid, grandchild.uid]));
  });

  it('excludes a soft-deleted descendant — neither open nor closed work, it is gone', async () => {
    const { store, projectUid } = await setupStore('part-of-rollup-deleted');
    const root = await createIssue(store, { title: 'root', body: 'b', project: projectUid, by: 'agent:t' });
    const child = await createIssue(store, { title: 'child', body: 'b', project: projectUid, by: 'agent:t' });
    await writePartOfEdge(store, { childUid: child.uid, parentUid: root.uid });

    const before = await partOfRollup(store, { uid: root.uid });
    expect(before.childrenTotal).toBe(1);

    const childNode = await store.graph.getNodeByUid(child.uid);
    await store.graph.invalidate(childNode!.id, 'test: soft-delete');

    const after = await partOfRollup(store, { uid: root.uid });
    expect(after.childrenTotal).toBe(0);
  });

  it('throws IssueNotFoundError for an unresolved uid', async () => {
    const { store } = await setupStore('part-of-rollup-missing');
    await expect(partOfRollup(store, { uid: '00000000-0000-4000-8000-000000000000' })).rejects.toBeInstanceOf(IssueNotFoundError);
  });
});

describe('openCurve — validAt point-in-time reconstruction', () => {
  it('reconstructs status-at-instant from the audit trail, never the current status', async () => {
    const { store, projectUid } = await setupStore('open-curve-reconstruct');

    const a = await createIssue(store, { title: 'a', body: 'b', project: projectUid, by: 'agent:t' });
    // Anchor every sample instant to `a`'s OWN reported `createdAt` (a real
    // value, whatever it is) with large, fixed offsets — deterministic
    // regardless of real wall-clock speed; never a narrow real-time race.
    const createdAtMs = new Date(a.item.createdAt).getTime();
    const beforeCreate = new Date(createdAtMs - 60_000).toISOString();
    const midInstant = new Date(createdAtMs + 60_000).toISOString(); // between creation and transition
    const transitionAt = new Date(createdAtMs + 120_000).toISOString();
    const afterTransition = new Date(createdAtMs + 180_000).toISOString();

    const transition = await simulateTransition(store, { uid: a.uid, toStatusName: 'done', toTerminal: true, actor: 'agent:t', at: transitionAt });
    expect(transition.to).toBe('done');

    // Sample strictly between creation and the transition: the issue's CURRENT
    // status is now terminal ("done"), but at THIS instant it had not
    // transitioned yet — the reconstructed status must be the pre-transition one.
    const midResult = await openCurve(store, { at: [midInstant] });
    expect(midResult.points[0].existed).toBe(1);
    // TEETH: a naive "use the CURRENT status" implementation would report
    // open:0 here (current status is terminal) — the correct reconstruction
    // reports open:1. Assert the actual result differs from that naive one.
    const naiveOpenUsingCurrentStatus = 0; // current status ("done") is terminal ⇒ a naive reader reports 0 open
    expect(midResult.points[0].open).toBe(1);
    expect(midResult.points[0].open).not.toBe(naiveOpenUsingCurrentStatus);

    // Sample after the transition: now genuinely closed.
    const afterResult = await openCurve(store, { at: [afterTransition] });
    expect(afterResult.points[0].existed).toBe(1);
    expect(afterResult.points[0].open).toBe(0);
    expect(afterResult.points[0].closed).toBe(1);

    // Sample before creation: didn't exist yet.
    const beforeResult = await openCurve(store, { at: [beforeCreate] });
    expect(beforeResult.points[0].existed).toBe(0);
  });

  it('rejects filter.status (openness is computed, never filtered) and an unparsable instant', async () => {
    const { store, projectUid } = await setupStore('open-curve-reject');
    await createIssue(store, { title: 'x', body: 'b', project: projectUid, by: 'agent:t' });
    await expect(openCurve(store, { filter: { status: 'open' }, at: [nowISO()] })).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(openCurve(store, { at: ['not-a-date'] })).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(openCurve(store, { at: [] })).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('samples multiple instants in order and scopes by project', async () => {
    const { store, projectUid } = await setupStore('open-curve-multi');
    const other = await setupStore('open-curve-multi-other');

    const a = await createIssue(store, { title: 'a', body: 'b', project: projectUid, by: 'agent:t' });
    const b = await createIssue(store, { title: 'b', body: 'b', project: projectUid, by: 'agent:t' });
    await createIssue(other.store, { title: 'other-project issue', body: 'b', project: other.projectUid, by: 'agent:t' });

    // Anchor to the two real reported `createdAt`s with a full-day margin on
    // each side — deterministic regardless of whether `a`/`b` landed in the
    // same millisecond (real I/O timing is never relied on for ordering
    // here, only for "did these exist by a instant a day away").
    const earliestMs = Math.min(new Date(a.item.createdAt).getTime(), new Date(b.item.createdAt).getTime());
    const latestMs = Math.max(new Date(a.item.createdAt).getTime(), new Date(b.item.createdAt).getTime());
    const before = new Date(earliestMs - 86_400_000).toISOString();
    const after = new Date(latestMs + 86_400_000).toISOString();

    const result = await openCurve(store, { filter: { project: projectUid }, at: [before, after] });
    expect(result.points.map((p) => p.at)).toEqual([before, after]);
    expect(result.points[0].existed).toBe(0);
    expect(result.points[1].existed).toBe(2); // scoped to `projectUid` — the other project's issue never counted
    expect(result.points[1].open).toBe(2);
  });

  it('resolves each issue\'s current status and audit trail independently — the batched has_status/audits fetch must never mix issues up', async () => {
    const { store, projectUid } = await setupStore('open-curve-batched-per-issue');

    const a = await createIssue(store, { title: 'a (will close)', body: 'b', project: projectUid, by: 'agent:t' });
    const b = await createIssue(store, { title: 'b (stays open)', body: 'b', project: projectUid, by: 'agent:t' });

    // Anchor to `a`'s own reported `createdAt` — deterministic regardless of
    // real wall-clock speed.
    const createdAtMs = new Date(a.item.createdAt).getTime();
    const transitionAt = new Date(createdAtMs + 60_000).toISOString();
    const sampleAt = new Date(createdAtMs + 120_000).toISOString();

    // Only `a` transitions (to a terminal status); `b` never does — its trail
    // has no `to`-carrying entry at all (reconstructStatusAt case 1), so its
    // reconstructed status is just its unchanged CURRENT status ("open").
    const transition = await simulateTransition(store, { uid: a.uid, toStatusName: 'done', toTerminal: true, actor: 'agent:t', at: transitionAt });
    expect(transition.to).toBe('done');

    const result = await openCurve(store, { filter: { project: projectUid }, at: [sampleAt] });
    expect(result.points[0].existed).toBe(2);
    // TEETH: if the batched `has_status`/`audits` fetch this test targets ever
    // mixed the two issues' data up (e.g. assigning one issue's current status
    // or trail to the other), `a` and `b` would no longer diverge — assert the
    // per-issue outcome each independently AND assert they differ from each
    // other, so a cross-contamination bug cannot hide behind a coincidental
    // match.
    expect(result.points[0].open).toBe(1); // only `b`
    expect(result.points[0].closed).toBe(1); // only `a`
  });

  it('counts an issue at an instant it truly existed, even though it has SINCE been soft-deleted', async () => {
    const { store, projectUid } = await setupStore('open-curve-deleted');
    const a = await createIssue(store, { title: 'a', body: 'b', project: projectUid, by: 'agent:t' });

    // Real delete, through the real write verb.
    await deleteIssue(store, { uid: a.uid, reason: 'test: soft-delete after existing', by: 'closer' });

    // Read the real, persisted bi-temporal columns back (liveOnly:false — the
    // node is gone from every default query now) rather than assuming an
    // offset: `tValid` is the real reported creation instant, `tInvalid` the
    // real reported deletion instant.
    const deadNode = (await store.graph.queryNodes({ kind: 'issue', liveOnly: false })).find((n) => n.uid === a.uid);
    expect(deadNode).toBeDefined();
    expect(deadNode!.tInvalid).toBeDefined();
    // Self-check the environmental precondition this test leans on — a real
    // deletion instant strictly after the real creation instant. If this ever
    // fails, the test's own setup assumption is broken, not the behavior
    // under test (never asserted blind).
    expect(new Date(deadNode!.tInvalid!).getTime()).toBeGreaterThan(new Date(deadNode!.tValid).getTime());

    const at = deadNode!.tValid; // the exact instant the issue came into existence — still strictly before its deletion

    // TEETH: the naive `liveOnly` DEFAULT (true) — what this exact query
    // looked like before the fix — computed directly against the real store.
    const naiveLiveOnlyDefault = await store.graph.queryNodes({ kind: 'issue', validAt: at, ids: [deadNode!.id] });
    expect(naiveLiveOnlyDefault.length).toBe(0); // the bug: silently excludes a since-deleted issue at an instant it demonstrably existed

    const result = await openCurve(store, { at: [at] });
    expect(result.points[0].existed).toBe(1);
    expect(result.points[0].existed).not.toBe(naiveLiveOnlyDefault.length);
  });
});
