/**
 * update.spec.ts — behavioral proof for `update` (SPEC.md §4, §6.3.3, §8 AC-14).
 *
 * Real store, real reads, never mocks: a `title`/`assignee`-only patch is a
 * pure touch (same uid, node content untouched); a `kind`/`priority`/`author`
 * patch rewrites the corresponding `n:1` edge in place; a `body` patch runs
 * the guarded supersede CAS (a fresh uid, the OLD node flagged
 * `is_superseded`, a `SUPERSEDES` edge new→old) and carries the FULL
 * identity chain (`owns_component`/`has_kind`/`has_status`/`has_priority`/
 * `authored_by`) forward onto the new node — proven not just by raw SQL edge
 * reads but by driving the real `getIssue` read-layer consumer against the
 * NEW uid, exactly as a caller would. `status` in the raw input is rejected
 * naming `transition` (AC-14) even though `IUpdateIssueInput`'s TS type
 * doesn't have the field at all.
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
import { getIssue } from '../query/get.js';
import { update, type IUpdateIssueInput } from './update.js';
import {
  BacklogValidationError,
  CatalogNotFoundError,
  InvalidArgumentError,
  StaleSupersedeError,
} from './errors.js';
import { getNodeByUidTx, type ITxNodeRow } from './tx.js';

async function readNode(
  store: TestIssueStore,
  uid: string
): Promise<ITxNodeRow | null> {
  return store.adapter.transaction(async (tx) => getNodeByUidTx(tx, uid));
}

interface RawEdgeRow {
  src: number;
  dst: number;
  t_invalid: string | null;
}

async function liveEdges(
  store: TestIssueStore,
  rel: string,
  opts: { src?: number; dst?: number }
): Promise<RawEdgeRow[]> {
  const clauses: string[] = ['rel = ?', 't_invalid IS NULL'];
  const params: unknown[] = [rel];
  if (opts.src !== undefined) {
    clauses.push('src = ?');
    params.push(opts.src);
  }
  if (opts.dst !== undefined) {
    clauses.push('dst = ?');
    params.push(opts.dst);
  }
  const { rows } = await store.adapter.executeAll<RawEdgeRow>(
    `SELECT src, dst, t_invalid FROM edge WHERE ${clauses.join(' AND ')}`,
    params
  );
  return rows;
}

interface RawAuditRow {
  action: string;
  from: string | null;
  to: string | null;
  note: string | null;
}

/** Mirrors `transition.spec.ts`'s identical helper — sets `project.meta.policy` directly (real row, real UPDATE, never a mock). */
async function setProjectPolicy(
  store: TestIssueStore,
  projectUid: string,
  policy: Record<string, unknown>
): Promise<void> {
  await store.adapter.executeRun('UPDATE node SET meta = ? WHERE uid = ?', [
    JSON.stringify({ policy }),
    projectUid,
  ]);
}

/** Raw `t_updated` read — `ITxNodeRow` (the frozen foundation's own contract) deliberately does not expose this column, so this reads it directly off the real row, exactly like this file's own `liveEdges`/`setProjectPolicy` raw-SQL helpers. */
async function readTUpdated(
  store: TestIssueStore,
  uid: string
): Promise<string> {
  const row = await store.adapter.executeGet<{ t_updated: string }>(
    'SELECT t_updated FROM node WHERE uid = ?',
    [uid]
  );
  if (!row) throw new Error(`readTUpdated: no node row for uid=${uid}`);
  return row.t_updated;
}

async function readAuditTrail(
  store: TestIssueStore,
  subjectRowid: number
): Promise<RawAuditRow[]> {
  const { rows } = await store.adapter.executeAll<{ meta: string | null }>(
    `SELECT a.meta as meta FROM edge e JOIN node a ON a.rowid = e.dst
     WHERE e.src = ? AND e.rel = 'audits' AND e.t_invalid IS NULL AND a.kind = 'audit'
     ORDER BY a.rowid ASC`,
    [subjectRowid]
  );
  return rows.map((row) => {
    const meta = row.meta
      ? (JSON.parse(row.meta) as Record<string, unknown>)
      : {};
    return {
      action: String(meta['action'] ?? ''),
      from: (meta['from'] as string | null) ?? null,
      to: (meta['to'] as string | null) ?? null,
      note: (meta['note'] as string | null) ?? null,
    };
  });
}

describe('update — touch/supersede/edge-rewrite (SPEC.md §6.3.3, real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;
  let issueUid: string;
  let issueRowid: number;
  let componentRowid: number;

  beforeEach(async () => {
    dir = freshTmpDir('update-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    const seeded = await seedProject(store, 'update-spec-project');
    projectUid = seeded.projectUid;
    const created = await createIssue(store, {
      project: projectUid,
      title: 'original title',
      body: 'original body',
      by: 'filer',
      kind: 'bug',
      priority: 'p2',
      author: 'original-author',
    });
    issueUid = created.uid;
    const row = await readNode(store, issueUid);
    if (!row)
      throw new Error('setup: issue not found immediately after createIssue');
    issueRowid = row.rowid;
    const componentEdge = (
      await liveEdges(store, 'owns_component', { dst: issueRowid })
    )[0];
    if (!componentEdge) throw new Error('setup: no owns_component edge found');
    componentRowid = componentEdge.src;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('title-only: pure touch — SAME uid, `changed:["title"]`, body/content untouched', async () => {
    const outcome = await update(store, {
      uid: issueUid,
      by: 'editor',
      title: 'new title',
    });
    expect(outcome).toEqual({ uid: issueUid, changed: ['title'] });

    const row = await readNode(store, issueUid);
    expect(row?.name).toBe('new title');
    expect(row?.content).toBe('original body');
    expect(row?.isSuperseded).toBe(false);
  });

  it('assignee-only: touch merges into EXISTING metadata, never a wholesale replace of unrelated keys', async () => {
    await update(store, {
      uid: issueUid,
      by: 'editor',
      assignee: 'first-assignee',
    });
    const outcome = await update(store, {
      uid: issueUid,
      by: 'editor',
      assignee: 'second-assignee',
    });
    expect(outcome.changed).toEqual(['assignee']);

    const row = await readNode(store, issueUid);
    expect(row?.metadata?.['assignee']).toBe('second-assignee');
    expect(row?.name).toBe('original title'); // untouched by an assignee-only patch
  });

  it('zero-field patch throws InvalidArgumentError — a client error, never a silent no-op', async () => {
    await expect(
      update(store, { uid: issueUid, by: 'editor' })
    ).rejects.toThrow(InvalidArgumentError);
  });

  it('§8 AC-14: a `status` field on the raw (untyped) input is REJECTED naming `transition`, never silently applied', async () => {
    const before = await liveEdges(store, 'has_status', { src: issueRowid });
    expect(before).toHaveLength(1);

    const rawInput = {
      uid: issueUid,
      by: 'editor',
      status: 'closed',
    } as unknown as IUpdateIssueInput;
    await expect(update(store, rawInput)).rejects.toThrow(
      BacklogValidationError
    );
    await expect(update(store, rawInput)).rejects.toThrow(/transition/);

    // Nothing was applied — the issue's status edge is untouched, same target row, not merely the same count.
    const after = await liveEdges(store, 'has_status', { src: issueRowid });
    expect(after).toHaveLength(1);
    expect(after[0].dst).toBe(before[0].dst);
  });

  it('kind-only: touch + has_kind edge rewrite (invalidate-old + upsert-new, SAME uid)', async () => {
    const before = await liveEdges(store, 'has_kind', { src: issueRowid });
    expect(before).toHaveLength(1);

    const outcome = await update(store, {
      uid: issueUid,
      by: 'editor',
      kind: 'feature',
    });
    expect(outcome).toEqual({ uid: issueUid, changed: ['kind'] });

    const after = await liveEdges(store, 'has_kind', { src: issueRowid });
    expect(after).toHaveLength(1);
    expect(after[0].dst).not.toBe(before[0].dst); // now points at the freshly-minted "feature" kind row

    const card = await getIssue(store.graph, {
      uid: issueUid,
      fields: ['uid', 'kind'],
    });
    expect(card.kind).toBe('feature');
  });

  it('priority-only: mints a new priority catalog row on an unresolved NAME, rewrites has_priority', async () => {
    const outcome = await update(store, {
      uid: issueUid,
      by: 'editor',
      priority: 'p0-critical',
    });
    expect(outcome).toEqual({ uid: issueUid, changed: ['priority'] });
    const card = await getIssue(store.graph, {
      uid: issueUid,
      fields: ['uid', 'priority'],
    });
    expect(card.priority).toBe('p0-critical');
  });

  it('priority as a uid-shaped ref that does not resolve throws CatalogNotFoundError — never auto-mints for a uid', async () => {
    await expect(
      update(store, {
        uid: issueUid,
        by: 'editor',
        priority: '11111111-1111-4111-8111-111111111111',
      })
    ).rejects.toThrow(CatalogNotFoundError);
  });

  it('author-only: mints a new agent catalog row on an unresolved NAME, rewrites authored_by', async () => {
    const outcome = await update(store, {
      uid: issueUid,
      by: 'editor',
      author: 'new-author',
    });
    expect(outcome).toEqual({ uid: issueUid, changed: ['author'] });
    const card = await getIssue(store.graph, {
      uid: issueUid,
      fields: ['uid', 'author'],
    });
    expect(card.author).toBe('new-author');
  });

  it('SPEC.md §6.3.3 "touch + edge rewrite": a kind/priority/author-ONLY patch (no title/assignee) still bumps t_updated, so the "updated" date-range filter sees the reclassification', async () => {
    // Force a measurable clock delta — the SAME idiom `claim.spec.ts` already
    // establishes for this exact "prove a timestamp actually advanced" shape
    // of assertion, so an equal-millisecond false pass can't slip through.
    const wait = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    // `createIssue` never stamps `t_updated` itself (only a subsequent touch
    // does) — so the FIRST assertion that matters is simply that a
    // kind-only patch stamps a real, parseable `t_updated` at all. Before the
    // fix, a kind/priority/author-only patch called `touchNodeTx` zero times,
    // so this column stayed unset forever.
    await update(store, { uid: issueUid, by: 'editor', kind: 'feature' });
    const t1 = await readTUpdated(store, issueUid);
    expect(t1).toBeTruthy();
    expect(Number.isNaN(Date.parse(t1))).toBe(false);

    await wait(5);
    await update(store, {
      uid: issueUid,
      by: 'editor',
      priority: 'p0-critical',
    });
    const t2 = await readTUpdated(store, issueUid);
    expect(t2).not.toBe(t1);
    expect(Date.parse(t2)).toBeGreaterThan(Date.parse(t1));

    await wait(5);
    await update(store, { uid: issueUid, by: 'editor', author: 'new-author' });
    const t3 = await readTUpdated(store, issueUid);
    expect(t3).not.toBe(t2);
    expect(Date.parse(t3)).toBeGreaterThan(Date.parse(t2));
  });

  it('IssueNotFoundError for a uid that never resolved to a live issue at all', async () => {
    const { IssueNotFoundError } = await import('./errors.js');
    await expect(
      update(store, { uid: 'not-a-real-uid', by: 'editor', title: 'x' })
    ).rejects.toThrow(IssueNotFoundError);
  });

  it('InvalidArgumentError on missing/blank uid or by, or a blank title/body when explicitly given', async () => {
    await expect(
      update(store, { uid: '', by: 'editor', title: 'x' })
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      update(store, { uid: issueUid, by: '   ', title: 'x' })
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      update(store, { uid: issueUid, by: 'editor', title: '   ' })
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      update(store, { uid: issueUid, by: 'editor', body: '' })
    ).rejects.toThrow(InvalidArgumentError);
  });

  it('an untyped caller sending an explicit `null` for uid/by/title gets a clean InvalidArgumentError, never an unhandled TypeError', async () => {
    // `IUpdateIssueInput`'s TS type declares `string | undefined` for every one
    // of these — an untyped CLI/HTTP/MCP JSON caller can still send a literal
    // `null`, which is neither `undefined` nor a blank string.
    const nullUid = {
      uid: null,
      by: 'editor',
      title: 'x',
    } as unknown as IUpdateIssueInput;
    const nullBy = {
      uid: issueUid,
      by: null,
      title: 'x',
    } as unknown as IUpdateIssueInput;
    const nullTitle = {
      uid: issueUid,
      by: 'editor',
      title: null,
    } as unknown as IUpdateIssueInput;
    await expect(update(store, nullUid)).rejects.toThrow(InvalidArgumentError);
    await expect(update(store, nullBy)).rejects.toThrow(InvalidArgumentError);
    await expect(update(store, nullTitle)).rejects.toThrow(
      InvalidArgumentError
    );
  });

  describe('project_policy enforcement (§2 — allowedKinds/requiredFields, generalized from createIssue to update)', () => {
    it('allowedKinds restriction rejects a disallowed kind name with InvalidArgumentError — nothing written', async () => {
      await setProjectPolicy(store, projectUid, {
        allowedKinds: ['bug', 'feature'],
      });
      await expect(
        update(store, { uid: issueUid, by: 'editor', kind: 'chore' })
      ).rejects.toThrow(InvalidArgumentError);
      // negative-control teeth: the identical call for an ALLOWED kind still succeeds under the SAME policy.
      const ok = await update(store, {
        uid: issueUid,
        by: 'editor',
        kind: 'feature',
      });
      expect(ok.changed).toEqual(['kind']);
      const card = await getIssue(store.graph, {
        uid: issueUid,
        fields: ['uid', 'kind'],
      });
      expect(card.kind).toBe('feature');
    });

    it('requiredFields: a project requiring "assignee" rejects a call that sets it blank, but a title-only patch that never touches assignee is UNAFFECTED', async () => {
      await setProjectPolicy(store, projectUid, {
        requiredFields: ['assignee'],
      });
      // title-only: assignee is not part of this call's patch — the required-field
      // gate is scoped to fields THIS call actually touches (see update.ts's own
      // doc comment on the update-vs-createIssue composition gap), never a
      // blanket re-validation of every field already committed at creation time.
      const untouched = await update(store, {
        uid: issueUid,
        by: 'editor',
        title: 'still fine',
      });
      expect(untouched.changed).toEqual(['title']);

      // assignee explicitly given but blank on THIS call — rejected, nothing written.
      await expect(
        update(store, { uid: issueUid, by: 'editor', assignee: '   ' })
      ).rejects.toThrow(InvalidArgumentError);
      const row = await readNode(store, issueUid);
      expect(row?.metadata?.['assignee']).toBeUndefined();

      // the identical call with a real, non-blank assignee succeeds under the SAME policy.
      const ok = await update(store, {
        uid: issueUid,
        by: 'editor',
        assignee: 'real-assignee',
      });
      expect(ok.changed).toEqual(['assignee']);
    });
  });

  describe("body change — the supersede path (§4c's CAS, §8 AC-14/identity-chain carry-forward)", () => {
    it('mints a FRESH uid, flags the OLD node is_superseded, writes a SUPERSEDES edge new→old, moves the content', async () => {
      const outcome = await update(store, {
        uid: issueUid,
        by: 'editor',
        body: 'revised body',
      });
      expect(outcome.changed).toEqual(['body']);
      expect(outcome.uid).not.toBe(issueUid);

      const oldRow = await readNode(store, issueUid);
      expect(oldRow?.isSuperseded).toBe(true);
      expect(oldRow?.content).toBe('original body'); // free text is never rewritten in place

      const newRow = await readNode(store, outcome.uid);
      expect(newRow?.isSuperseded).toBe(false);
      expect(newRow?.content).toBe('revised body');
      expect(newRow?.name).toBe('original title'); // title carried forward, not given this call

      const supersedesEdges = await liveEdges(store, 'SUPERSEDES', {
        dst: issueRowid,
      });
      expect(supersedesEdges).toHaveLength(1);
      expect(supersedesEdges[0].src).toBe(newRow?.rowid);
    });

    it('the freshly-minted node gets t_updated stamped, so the SAME "updatedAt" range filter this file already proves for a kind/priority/author-only touch (above) also sees a body edit — the most substantive update there is', async () => {
      const outcome = await update(store, {
        uid: issueUid,
        by: 'editor',
        body: 'revised body — t_updated proof',
      });
      const stamped = await readTUpdated(store, outcome.uid);
      expect(stamped).toBeTruthy();
      expect(Number.isNaN(Date.parse(stamped))).toBe(false);
    });

    it('carries the FULL identity chain forward: owns_component/has_status/has_kind/has_priority/authored_by all live on the NEW node, proven through the REAL getIssue read path', async () => {
      const outcome = await update(store, {
        uid: issueUid,
        by: 'editor',
        body: 'revised body 2',
      });

      // Proven through the real consumer path (query/get.ts), not just raw SQL —
      // a new node with none of these edges would be structurally unqueryable.
      const card = await getIssue(store.graph, {
        uid: outcome.uid,
        fields: [
          'uid',
          'kind',
          'title',
          'status',
          'priority',
          'project',
          'component',
          'author',
        ],
      });
      expect(card.kind).toBe('bug');
      expect(card.status).toBe('open');
      expect(card.priority).toBe('p2');
      expect(card.project).toBe(projectUid);
      expect(card.author).toBe('original-author');

      // The component edge specifically re-points to the SAME component rowid.
      const newRow = await readNode(store, outcome.uid);
      const newOwnsComponent = await liveEdges(store, 'owns_component', {
        dst: newRow?.rowid,
      });
      expect(newOwnsComponent).toHaveLength(1);
      expect(newOwnsComponent[0].src).toBe(componentRowid);

      // And the OLD node's own identity-chain edges are retired (invalidated),
      // never left live on a retired node.
      const oldOwnsComponent = await liveEdges(store, 'owns_component', {
        dst: issueRowid,
      });
      expect(oldOwnsComponent).toHaveLength(0);
      const oldHasKind = await liveEdges(store, 'has_kind', {
        src: issueRowid,
      });
      expect(oldHasKind).toHaveLength(0);
    });

    it("body + an explicit kind override in the SAME call: the new node's has_kind points at the OVERRIDE, not the carried-forward original", async () => {
      const outcome = await update(store, {
        uid: issueUid,
        by: 'editor',
        body: 'revised body 3',
        kind: 'chore',
      });
      expect(outcome.changed.sort()).toEqual(['body', 'kind']);
      const card = await getIssue(store.graph, {
        uid: outcome.uid,
        fields: ['uid', 'kind'],
      });
      expect(card.kind).toBe('chore');
    });

    it('body + title + assignee together: all three land on the SAME new node', async () => {
      const outcome = await update(store, {
        uid: issueUid,
        by: 'editor',
        body: 'revised body 4',
        title: 'revised title',
        assignee: 'new-assignee',
      });
      expect(outcome.changed.sort()).toEqual(['assignee', 'body', 'title']);
      const newRow = await readNode(store, outcome.uid);
      expect(newRow?.name).toBe('revised title');
      expect(newRow?.content).toBe('revised body 4');
      expect(newRow?.metadata?.['assignee']).toBe('new-assignee');
    });

    it('adds exactly one audit row, and the NEW node carries the issue\'s WHOLE trail (action:"updated", from/to = old/new uid)', async () => {
      const before = await readAuditTrail(store, issueRowid);
      const outcome = await update(store, {
        uid: issueUid,
        by: 'editor',
        body: 'revised body 5',
      });
      const newRow = await readNode(store, outcome.uid);
      const trail = await readAuditTrail(store, newRow!.rowid);

      // AC-3's invariant is "one audit NODE per write", not "one audit edge on
      // the head node". The supersede carries the pre-edit trail forward onto
      // the successor, so the issue's history survives the edit — reading it
      // off the current uid returns the WHOLE chain, in order, with this
      // write's own row appended. Before the carry-forward existed, the
      // inherited rows stayed bound to a node no listing returns and the
      // history simply vanished: this asserts `before.length + 1`, so an
      // implementation that drops the trail again fails here, and so does one
      // that writes a second audit node for a single call.
      expect(trail).toHaveLength(before.length + 1);
      expect(trail.slice(0, before.length).map((r) => r.action)).toEqual(
        before.map((r) => r.action)
      );

      const own = trail[trail.length - 1];
      expect(own.action).toBe('updated');
      expect(own.from).toBe(issueUid);
      expect(own.to).toBe(outcome.uid);

      // The superseded node keeps no live audit edges — the trail MOVED, it
      // was not duplicated, so nothing counts the same history twice.
      const oldTrail = await readAuditTrail(store, issueRowid);
      expect(oldTrail).toHaveLength(0);
    });

    it('a supersede on an issue with NO live has_status edge (a corrupted graph) throws loudly instead of silently minting an unqueryable new node — has_status is NEVER genuinely optional, unlike has_priority', async () => {
      // Corrupt the graph directly (real SQL, real row) exactly the way a
      // real invariant violation would look: invalidate the ONE live
      // has_status edge this issue is guaranteed to have from createIssue.
      await store.adapter.executeRun(
        "UPDATE edge SET t_invalid = ? WHERE src = ? AND rel = 'has_status' AND t_invalid IS NULL",
        [new Date().toISOString(), issueRowid]
      );
      const before = await liveEdges(store, 'has_status', { src: issueRowid });
      expect(before).toHaveLength(0);

      await expect(
        update(store, {
          uid: issueUid,
          by: 'editor',
          body: 'revised body — corrupted graph',
        })
      ).rejects.toThrow(
        /has no live "has_status" edge — graph invariant violation/
      );
    });

    it('StaleSupersedeError against an ALREADY-superseded uid — a second update naming the OLD uid never silently mutates a retired identity', async () => {
      await update(store, {
        uid: issueUid,
        by: 'editor',
        body: 'first revision',
      });
      await expect(
        update(store, { uid: issueUid, by: 'editor', title: 'x' })
      ).rejects.toThrow(StaleSupersedeError);
      await expect(
        update(store, { uid: issueUid, by: 'editor', body: 'second revision' })
      ).rejects.toThrow(StaleSupersedeError);
    });

    it('genuine concurrency: two racing body-updates against the SAME fresh uid — exactly ONE wins, the other gets StaleSupersedeError, never two superseding nodes', async () => {
      const [a, b] = await Promise.allSettled([
        update(store, { uid: issueUid, by: 'writer-a', body: 'race body A' }),
        update(store, { uid: issueUid, by: 'writer-b', body: 'race body B' }),
      ]);
      const outcomes = [a, b];
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        StaleSupersedeError
      );

      // Exactly one SUPERSEDES edge exists — never two forked nodes from the same origin.
      const supersedesEdges = await liveEdges(store, 'SUPERSEDES', {
        dst: issueRowid,
      });
      expect(supersedesEdges).toHaveLength(1);
    });
  });
});
