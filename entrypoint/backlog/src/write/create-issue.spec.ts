/**
 * create-issue.spec.ts — `createIssue`'s no-`component` default (SPEC.md §8
 * AC-23; the verb itself lives at `write/create-issue.ts`, §4/§6.3.2).
 *
 * AC-23's literal text: omitting `component` entirely resolves to `project`'s
 * reserved default component `(root)` — already guaranteed live by
 * `upsertProject` — and never throws `CatalogNotFoundError('component', ...)`.
 * The point with teeth: the fallback is a RESOLVE of an already-guaranteed
 * row, never a per-call mint, so two independent no-`component` `createIssue`
 * calls against the SAME project land on the exact same `(root)` component
 * row, never a second one.
 *
 * Every assertion here drives the REAL verbs (`upsertProject`, `createIssue`,
 * `queryIssues`) against a REAL store opened via `openTestIssueStore` — never
 * a mock of any verb, never a mock of the store. The `owns_component` edge
 * and the `(root)` row count are read back via direct SQL, never trusted from
 * either verb's own returned outcome object (mirrors `move.spec.ts`'s
 * `countLiveOwnsComponentEdges` discipline for the same edge kind).
 */
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { createIssue, MAX_GIT_CONTEXT_LENGTH } from './create-issue.js';
import { upsertProject } from './catalog.js';
import { CitationUnverifiableError, InvalidArgumentError } from './errors.js';
import { getNodeByUidTx, type ITxNodeRow } from './tx.js';
import { queryIssues } from '../query/query.js';

async function readNode(
  store: TestIssueStore,
  uid: string
): Promise<ITxNodeRow | null> {
  return store.adapter.transaction(async (tx) => getNodeByUidTx(tx, uid));
}

/** Direct SQL: the rowid of the LIVE `owns_component` edge's source (the component) targeting `issueRowid` — never the outcome object, which is a self-report. Throws if the invariant "exactly one" is violated, so a caller never silently reads a wrong/ambiguous row. */
async function ownsComponentSrcRowid(
  store: TestIssueStore,
  issueRowid: number
): Promise<number> {
  const { rows } = await store.adapter.executeAll<{ src: number }>(
    `SELECT src FROM edge WHERE dst = ? AND rel = 'owns_component' AND t_invalid IS NULL`,
    [issueRowid]
  );
  if (rows.length !== 1)
    throw new Error(
      `expected exactly one live owns_component edge for issue rowid ${issueRowid}, found ${rows.length}`
    );
  return rows[0]!.src;
}

/** Direct SQL count of LIVE `(root)` component rows scoped to `projectUid` — proves the fallback never mints a second row, never just "the outcome says one uid" (which a per-call-mint bug could still self-report consistently if it always returned the newest uid). */
async function countLiveRootComponents(
  store: TestIssueStore,
  projectUid: string
): Promise<number> {
  const { rows } = await store.adapter.executeAll<{ n: number }>(
    `SELECT COUNT(*) as n FROM node
     WHERE kind = 'component' AND name = '(root)' AND t_invalid IS NULL
       AND json_extract(meta, '$.projectUid') = ?`,
    [projectUid]
  );
  return rows[0]?.n ?? 0;
}

describe('createIssue — component-omitted defaults to (root), never orphaned (SPEC.md §8 AC-23)', () => {
  let dir: string;
  let store: TestIssueStore;

  beforeEach(async () => {
    dir = freshTmpDir('create-issue-root-default-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('two independent no-component createIssue calls resolve the SAME (root) target, exactly one (root) row ever exists, never throw CatalogNotFoundError, and both issues are reachable through filter.project — never orphaned', async () => {
    // (1) upsertProject a fresh project — the REAL registry verb, not the
    // hand-composed seedProject test helper, per AC-23's own wording.
    const project = await upsertProject(store, {
      name: 'ac23-root-default-project',
      by: 'filer',
    });
    expect(project.created).toBe(true);

    // Exactly one (root) row exists the moment the project is minted —
    // this is the "already-guaranteed row" AC-23's fallback is defined to
    // resolve, never mint.
    expect(await countLiveRootComponents(store, project.uid)).toBe(1);

    // (2) Two SEPARATE createIssue calls, `component` omitted entirely on
    // both — distinct title/body per call so neither the duplicate-gate
    // (§6.4, default duplicateAction:'abort') nor content-hash dedupe can
    // suppress either write for an unrelated reason.
    const first = await createIssue(store, {
      project: project.uid,
      title: 'ac23 first no-component issue',
      body: 'first issue filed with component omitted entirely',
      by: 'filer',
    });
    const second = await createIssue(store, {
      project: project.uid,
      title: 'ac23 second no-component issue',
      body: 'second issue filed with component omitted entirely',
      by: 'filer',
    });

    // (6) Never throws CatalogNotFoundError('component', ...) on the
    // omitted-component path — both calls above already had to complete
    // without throwing for this line to be reached at all; asserted
    // explicitly here as the criterion's own stated invariant.
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(first.uid).toBeTruthy();
    expect(second.uid).toBeTruthy();
    expect(first.uid).not.toBe(second.uid);

    const firstIssueRow = await readNode(store, first.uid);
    const secondIssueRow = await readNode(store, second.uid);
    expect(firstIssueRow).not.toBeNull();
    expect(secondIssueRow).not.toBeNull();

    // (3) Both calls resolve the SAME owns_component target uid — the
    // criterion's own named verification method (direct SQL against the
    // edge table), never the outcome object.
    const firstComponentRowid = await ownsComponentSrcRowid(
      store,
      firstIssueRow!.rowid
    );
    const secondComponentRowid = await ownsComponentSrcRowid(
      store,
      secondIssueRow!.rowid
    );
    expect(secondComponentRowid).toBe(firstComponentRowid);

    // That shared rowid IS the project's (root) component, by uid — not
    // merely "the same rowid as each other" but the SAME row minted at
    // upsertProject time.
    const { rows: componentRows } = await store.adapter.executeAll<{
      uid: string;
      name: string | null;
    }>(`SELECT uid, name FROM node WHERE rowid = ? AND t_invalid IS NULL`, [
      firstComponentRowid,
    ]);
    expect(componentRows).toHaveLength(1);
    expect(componentRows[0]!.name).toBe('(root)');

    // (4) Exactly ONE live (root) component row exists for the project
    // throughout — proves the fallback is a RESOLVE, never a per-call
    // mint. If either createIssue call had minted its own (root) row
    // (even one that happened to share a uid by coincidence — impossible,
    // but the point is this check does not rely on uid equality alone),
    // this count would be 2, not 1.
    expect(await countLiveRootComponents(store, project.uid)).toBe(1);

    // (5) A subsequent query({filter:{project}}) returns BOTH new uids —
    // proving the issues are reachable through the project filter rather
    // than orphaned, never merely "createIssue's own outcome object claims
    // success."
    const result = await queryIssues(store, {
      filter: { project: project.uid },
      limit: 100,
    });
    if (result.view !== 'list')
      throw new Error(`expected view:'list', got ${result.view}`);
    const uids = result.items.map((item) => item.uid);
    expect(uids).toContain(first.uid);
    expect(uids).toContain(second.uid);
  });
});

/**
 * The citation-sha gate (SPEC.md §8.5 / §2's `citation_requires_sha`) applies
 * only where verification is POSSIBLE — a project with a non-empty
 * filesystem `path`. A path-less project cannot hash a citation at all, so it
 * records `sha:"unverified"` verbatim (matching the ETL's own precedent);
 * a path-PRESENT project citing a missing/escaping file still hard-fails.
 * Every assertion drives the REAL `upsertProject`/`createIssue` verbs against
 * a REAL store and reads the persisted `sha` back via direct SQL — never the
 * returned outcome object, and never a mock of any verb or the store.
 */
describe('createIssue — citation sha gate applies only where verification is possible (SPEC.md §8.5)', () => {
  let dir: string;
  let store: TestIssueStore;

  beforeEach(async () => {
    dir = freshTmpDir('create-issue-citation-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  /** The dst rowid of the single LIVE `has_citation` edge for `issueRowid`, or `undefined` — direct SQL, never the outcome object. */
  async function citationDstRowid(
    issueRowid: number
  ): Promise<number | undefined> {
    const { rows } = await store.adapter.executeAll<{ dst: number }>(
      `SELECT dst FROM edge WHERE src = ? AND rel = 'has_citation' AND t_invalid IS NULL`,
      [issueRowid]
    );
    return rows[0]?.dst;
  }

  /** The persisted `sha` on the issue's live citation node. Throws if the edge/node is absent so a silent mis-read is impossible. */
  async function persistedCitationSha(issueRowid: number): Promise<unknown> {
    const dst = await citationDstRowid(issueRowid);
    if (dst === undefined)
      throw new Error(
        `expected a live has_citation edge for issue rowid ${issueRowid}, found none`
      );
    const { rows } = await store.adapter.executeAll<{ uid: string }>(
      'SELECT uid FROM node WHERE rowid = ?',
      [dst]
    );
    const uid = rows[0]?.uid;
    if (uid === undefined)
      throw new Error(`citation node for edge dst ${dst} not found`);
    const citationRow = await readNode(store, uid);
    return citationRow?.metadata?.['sha'];
  }

  /** Direct SQL count of every LIVE node — the strongest "nothing was written" probe: an issue, a citation, or an audit row all land here. */
  async function liveNodeCount(): Promise<number> {
    const { rows } = await store.adapter.executeAll<{ n: number }>(
      'SELECT COUNT(*) as n FROM node WHERE t_invalid IS NULL'
    );
    return rows[0]?.n ?? 0;
  }

  /** Direct SQL count of every LIVE edge — pairs with {@link liveNodeCount}; a half-write shows up as a node/edge count that moved. */
  async function liveEdgeCount(): Promise<number> {
    const { rows } = await store.adapter.executeAll<{ n: number }>(
      'SELECT COUNT(*) as n FROM edge WHERE t_invalid IS NULL'
    );
    return rows[0]?.n ?? 0;
  }

  it('path-less project: a citation is ACCEPTED and persists sha:"unverified" (the default citationRequiresSha:true gate is waived, not the policy)', async () => {
    // `upsertProject` with no `path` — the project has no known filesystem
    // root, so no citation target can be hashed. The policy itself is left at
    // its default (`citationRequiresSha:true`); the gate simply has nothing
    // to reject.
    const project = await upsertProject(store, {
      name: 'citation-pathless-project',
      by: 'filer',
    });
    const created = await createIssue(store, {
      project: project.uid,
      title: 'path-less citation',
      body: 'a project with no registered path cannot hash its citations',
      by: 'filer',
      citations: [{ file: 'src/whatever.ts' }],
    });
    expect(created.created).toBe(true);
    const issueRow = await readNode(store, created.uid);
    if (!issueRow) throw new Error('setup: issue not found after createIssue');
    expect(await persistedCitationSha(issueRow.rowid)).toBe('unverified');
  });

  it('the path-less waiver is no longer SILENT — it emits an operator-visible warning naming the project (DEBT a934e089)', async () => {
    const project = await upsertProject(store, {
      name: 'citation-pathless-warn-project',
      by: 'filer',
    });
    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      const created = await createIssue(store, {
        project: project.uid,
        title: 'path-less citation warn',
        body: 'the waiver must be observable, not silent',
        by: 'filer',
        citations: [{ file: 'src/whatever.ts' }],
      });
      expect(created.created).toBe(true);
      const messages = spy.mock.calls.map((c) => String(c[0]));
      expect(
        messages.some(
          (m) =>
            m.includes('citation_requires_sha waived') &&
            m.includes(project.uid) &&
            m.includes('src/whatever.ts')
        )
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('the waiver warning fires ONLY on the waiver branch — a path-PRESENT hard-fail does NOT emit it', async () => {
    const project = await upsertProject(store, {
      name: 'citation-pathpresent-nowarn-project',
      path: dir,
      by: 'filer',
    });
    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      await expect(
        createIssue(store, {
          project: project.uid,
          title: 'missing citation nowarn',
          body: 'a path-present project hard-fails and must NOT claim a waiver',
          by: 'filer',
          citations: [{ file: 'does-not-exist.ts' }],
        })
      ).rejects.toThrow(CitationUnverifiableError);
      expect(
        spy.mock.calls
          .map((c) => String(c[0]))
          .some((m) => m.includes('citation_requires_sha waived'))
      ).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('path-PRESENT project citing a MISSING file still hard-fails with CitationUnverifiableError — nothing is written', async () => {
    const project = await upsertProject(store, {
      name: 'citation-pathpresent-missing-project',
      path: dir,
      by: 'filer',
    });
    // Snapshot BEFORE the rejected call. The gate throws in the pre-resolve
    // loop, BEFORE `executeWriteTransaction` is ever entered, so both counts
    // must be byte-identical after — no issue node, no citation node, no
    // audit row, no edge. Direct SQL, never the outcome object (a partial
    // write could still self-report a clean rejection).
    const nodesBefore = await liveNodeCount();
    const edgesBefore = await liveEdgeCount();
    await expect(
      createIssue(store, {
        project: project.uid,
        title: 'missing citation',
        body: 'the cited file does not exist under the registered project path',
        by: 'filer',
        citations: [{ file: 'does-not-exist.ts' }],
      })
    ).rejects.toThrow(CitationUnverifiableError);
    // The teeth the title claims: if the gate ever moved to AFTER the write
    // (or a partial write slipped through before the throw), the counts move
    // and this fails — while `rejects.toThrow` above would stay green.
    expect(await liveNodeCount()).toBe(nodesBefore);
    expect(await liveEdgeCount()).toBe(edgesBefore);
    // Consumer-visible confirmation: the project's filter still yields zero
    // issues — nothing is reachable because nothing was written.
    const result = await queryIssues(store, {
      filter: { project: project.uid },
      limit: 100,
    });
    if (result.view !== 'list')
      throw new Error(`expected view:'list', got ${result.view}`);
    expect(result.items).toHaveLength(0);
  });

  it('path-PRESENT project citing a REAL file computes a genuine sha256 — never "unverified"', async () => {
    const citedPath = 'evidence.ts';
    writeFileSync(join(dir, citedPath), 'export const x = 1;\n');
    const project = await upsertProject(store, {
      name: 'citation-pathpresent-real-project',
      path: dir,
      by: 'filer',
    });
    const created = await createIssue(store, {
      project: project.uid,
      title: 'real citation',
      body: 'the cited file exists under the registered project path',
      by: 'filer',
      citations: [{ file: citedPath }],
    });
    expect(created.created).toBe(true);
    const issueRow = await readNode(store, created.uid);
    if (!issueRow) throw new Error('setup: issue not found after createIssue');
    const sha = await persistedCitationSha(issueRow.rowid);
    expect(sha).not.toBe('unverified');
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('createIssue — item-level gitContext disclosure provenance (SPEC.md §6.3.2/§6.5, DATA_MODEL.md §8)', () => {
  let dir: string;
  let store: TestIssueStore;

  beforeEach(async () => {
    dir = freshTmpDir('create-issue-gitcontext-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('a supplied gitContext is persisted on the issue node metadata AND echoed on the result card; an omitted one leaves no key', async () => {
    const project = await upsertProject(store, {
      name: 'gitcontext-project',
      by: 'filer',
    });

    const withCtx = await createIssue(store, {
      project: project.uid,
      title: 'with git context',
      body: 'body',
      gitContext: 'feat/backlog-hard-replacement @ 4bf902fc',
      by: 'filer',
    });
    expect(withCtx.created).toBe(true);
    expect(withCtx.item?.gitContext).toBe(
      'feat/backlog-hard-replacement @ 4bf902fc'
    );
    if (!withCtx.uid) throw new Error('setup: createIssue returned no uid');
    const row = await readNode(store, withCtx.uid);
    expect(row?.metadata?.['gitContext']).toBe(
      'feat/backlog-hard-replacement @ 4bf902fc'
    );

    const without = await createIssue(store, {
      project: project.uid,
      title: 'without git context',
      body: 'body',
      by: 'filer',
    });
    expect(without.item?.gitContext).toBeUndefined();
    if (!without.uid) throw new Error('setup: createIssue returned no uid');
    const row2 = await readNode(store, without.uid);
    expect(row2?.metadata?.['gitContext']).toBeUndefined();
  });

  it('round-trips on read: `gitContext` in `fields` surfaces it on the card; the default/terse card omits it', async () => {
    const project = await upsertProject(store, {
      name: 'gitcontext-read-project',
      by: 'filer',
    });
    const created = await createIssue(store, {
      project: project.uid,
      title: 'readable git context',
      body: 'body',
      gitContext: 'main @ cafebabe',
      by: 'filer',
    });
    if (!created.uid) throw new Error('setup: createIssue returned no uid');

    const withField = await queryIssues(store, {
      filter: { project: project.uid },
      fields: ['uid', 'gitContext'],
    });
    if (withField.view !== 'list')
      throw new Error(`expected a list result, got view:${withField.view}`);
    expect(
      withField.items.find((i) => i.uid === created.uid)?.gitContext
    ).toBe('main @ cafebabe');

    const terse = await queryIssues(store, {
      filter: { project: project.uid },
      fields: ['uid', 'title'],
    });
    if (terse.view !== 'list')
      throw new Error(`expected a list result, got view:${terse.view}`);
    expect(terse.items.find((i) => i.uid === created.uid)?.gitContext).toBeUndefined();
  });

  it('a blank/whitespace-only gitContext is treated as absent — never stored, never echoed', async () => {
    const project = await upsertProject(store, {
      name: 'gitcontext-blank-project',
      by: 'filer',
    });
    const created = await createIssue(store, {
      project: project.uid,
      title: 'blank git context',
      body: 'body',
      gitContext: '   ',
      by: 'filer',
    });
    expect(created.item?.gitContext).toBeUndefined();
    if (!created.uid) throw new Error('setup: createIssue returned no uid');
    const row = await readNode(store, created.uid);
    expect(row?.metadata?.['gitContext']).toBeUndefined();
  });

  it('a gitContext longer than MAX_GIT_CONTEXT_LENGTH is rejected with InvalidArgumentError before any write runs', async () => {
    const project = await upsertProject(store, {
      name: 'gitcontext-cap-project',
      by: 'filer',
    });

    await expect(
      createIssue(store, {
        project: project.uid,
        title: 'over-long git context',
        body: 'body',
        gitContext: 'x'.repeat(MAX_GIT_CONTEXT_LENGTH + 1),
        by: 'filer',
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);

    // The cap is enforced before the write path runs — nothing was written.
    const listed = await queryIssues(store, {
      filter: { project: project.uid },
    });
    if (listed.view !== 'list')
      throw new Error(`expected a list result, got view:${listed.view}`);
    expect(listed.items).toHaveLength(0);

    // Exactly at the cap is accepted (the boundary is inclusive).
    const atCap = await createIssue(store, {
      project: project.uid,
      title: 'at-cap git context',
      body: 'body',
      gitContext: 'x'.repeat(MAX_GIT_CONTEXT_LENGTH),
      by: 'filer',
    });
    expect(atCap.created).toBe(true);
  });
});
