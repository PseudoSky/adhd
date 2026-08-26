/**
 * v2/get.spec.ts — drives `backlogGet` (INTERFACE_v2 §1) through its REAL seam
 * against a REAL store: a turso-substrate SQLite file under `tmp/backlog/`,
 * real `createItemNode`/`transitionStatusNode`/`addDependencyNode`/
 * `splitItemNode`/`softDeleteItemNode` writes, real `queryAuditEvents` rows.
 * Nothing here is mocked — the only thing this file stubs out is nothing at
 * all, which is the point: a composition layer that is only tested against
 * fake store ops proves that the composition compiles, not that it works.
 *
 * The two load-bearing contracts, each with a negative control run against the
 * built assertions (see the file's closing comment for the exact commands and
 * exit codes):
 *
 *  1. **AC-6 (§10.2)** — a missing single item is
 *     `{ ok:false, error:{ code:"item_not_found" } }`, exit 1. Never
 *     `ok:true, data:null`; never the generic `not_found` (exit 4, "unknown
 *     command"). A caller must be able to tell "this ticket does not exist"
 *     from "you typo'd the verb" and from "the server broke" by CODE ALONE.
 *  2. **BUG-BACKLOG-AUDIT-TRAIL-SOFTDELETE-001 (§1, §8)** — a soft-deleted
 *     item's history stays reachable. The store's own `auditTrail` op CANNOT
 *     reach it (it resolves through the live-only `findItemNode`), and this
 *     suite asserts that failure directly, so the fix is measured against the
 *     real gap rather than against a hypothetical one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { closeGraphBacklogStore, openGraphBacklogStore } from '../store/graph-backlog-store.js';
import { createItemNode, softDeleteItemNode } from '../store/crud.js';
import { transitionStatusNode, addCitationNode, appendNoteNode } from '../store/lifecycle.js';
import { addDependencyNode, linkRelatedNode, renameHumanIdNode, splitItemNode } from '../store/structure.js';
import { auditTrail as auditTrailOp } from '../store/query.js';
import {
  DEFAULT_GET_FIELDS,
  exitCodeForEnvelope,
  isOutcomeError,
  isOutcomeOk,
  type IBacklogCard,
  type IOutcomeEnvelope,
} from '../model.js';
import { backlogGet } from './get.js';

const REPO = 'PseudoSky/v2-get-spec';
const OTHER_REPO = 'PseudoSky/v2-get-spec-other';

/** Narrowing helper — a failed `backlogGet` in a test that expected success is a test bug, so it must blow up loudly with the real message. */
function expectOk(env: IOutcomeEnvelope<IBacklogCard>): IBacklogCard {
  if (!isOutcomeOk(env)) throw new Error(`expected ok:true, got ${JSON.stringify(env.error)}`);
  return env.data;
}

/** Seeds one item; every field the default card projects is populated so the projection assertions are exact, not "whatever the defaults happened to be". */
async function seedItem(
  tmp: TmpStore,
  opts: { family?: string; title?: string; body?: string; repo?: string; idOverride?: string } = {}
): Promise<string> {
  const created = await createItemNode(tmp.store, {
    family: opts.family ?? 'BUG-GET',
    idOverride: opts.idOverride,
    title: opts.title ?? 'the item under test',
    body: opts.body ?? 'BODY '.repeat(64),
    repo: opts.repo ?? REPO,
    projectPath: 'entrypoint/backlog',
    priority: 'HIGH',
  });
  return created.item.humanId;
}

describe('backlogGet (INTERFACE_v2 §1) — one item, deep context on demand', () => {
  let tmp: TmpStore;

  beforeEach(async () => {
    tmp = await openTmpStore('v2-get-spec');
  });

  afterEach(async () => {
    // `finally`-equivalent: vitest runs afterEach even when the test threw, so
    // a FAILING run still removes its store directory (AGENTS.md §10).
    await tmp.cleanup();
  });

  // --------------------------------------------------------------------------
  // AC-6 — the not-found contract. THE load-bearing assertion of this file.
  // --------------------------------------------------------------------------

  describe('AC-6 — a missing single item', () => {
    it('is ok:false / item_not_found / exit 1 — never ok:true+data:null, never the generic not_found', async () => {
      await seedItem(tmp); // a populated store, so "empty store" is not what is being measured

      const env = await backlogGet(tmp.store, { humanId: 'BUG-GET-999', repo: REPO });

      // 1. It is a FAILURE. The `ok:true, data:null` shape the spec outlaws
      //    would satisfy neither of these.
      expect(env.ok).toBe(false);
      expect((env as { data?: unknown }).data).toBeUndefined();

      // 2. The code is the DISTINCT single-item code, not the generic one an
      //    unknown *command* returns (exit 4) and not `internal` (a server
      //    fault). A scripter branches on this string.
      if (!isOutcomeError(env)) throw new Error('unreachable — asserted ok:false above');
      expect(env.error.code).toBe('item_not_found');
      expect(env.error.code).not.toBe('not_found');
      expect(env.error.code).not.toBe('internal');

      // 3. Exit code 1, per §7.2 — distinguishable from 4 (unknown command)
      //    and 2 (bad flag) without parsing the message.
      expect(exitCodeForEnvelope(env)).toBe(1);

      // 4. The message names what was actually looked up, so the failure is
      //    actionable without a second round trip.
      expect(env.error.message).toContain('BUG-GET-999');
    });

    it('an item that exists in ANOTHER repo is still item_not_found for this repo — and says where it lives', async () => {
      await seedItem(tmp, { repo: OTHER_REPO, idOverride: 'BUG-ELSEWHERE-001' });

      const env = await backlogGet(tmp.store, { humanId: 'BUG-ELSEWHERE-001', repo: REPO });

      if (!isOutcomeError(env)) throw new Error(`expected a failure, got ${JSON.stringify(env)}`);
      expect(env.error.code).toBe('item_not_found');
      // BUG-BACKLOG-REPO-LOOKUP-UX-001's "did you mean repo X?" hint survives
      // the composition layer instead of being flattened into a bare miss.
      expect(env.error.details?.foundInRepos).toEqual([OTHER_REPO]);
    });
  });

  // --------------------------------------------------------------------------
  // §0.2 / AC-18 — projection discipline.
  // --------------------------------------------------------------------------

  describe('projection (§1, AC-18/AC-19/AC-20)', () => {
    it('defaults to the terse card and NOTHING else — no body, no notes, no citations, no audit trail', async () => {
      const humanId = await seedItem(tmp, { body: 'X'.repeat(4096) });
      await addCitationNode(tmp.store, REPO, humanId, { file: 'src/a.ts', lines: '1-2' });
      await appendNoteNode(tmp.store, REPO, humanId, 'tester', 'a note that must not be in the default card');

      const card = expectOk(await backlogGet(tmp.store, { humanId, repo: REPO }));

      // The consumer-visible outcome: exactly the §7.3 default-get card keys,
      // PLUS `omittedFields` (DEBT-BACKLOG-GET-001) — every pseudo-field this
      // call could have named but didn't, so a caller reading `undefined`
      // below can tell "omitted by projection" from "genuinely empty".
      expect(Object.keys(card).sort()).toEqual([...DEFAULT_GET_FIELDS, 'omittedFields'].sort());
      expect(card.body).toBeUndefined();
      expect(card.notes).toBeUndefined();
      expect(card.citations).toBeUndefined();
      expect(card.audit_trail).toBeUndefined();
      expect(card.blockers).toBeUndefined();
      expect(card.rollup).toBeUndefined();
      expect(card.related).toBeUndefined();
      expect(card.omittedFields).toEqual(
        expect.arrayContaining(['body', 'audit_trail', 'blockers', 'citations', 'notes', 'rollup', 'related', 'closedAt', '_vector'])
      );
      expect(card.omittedFields).toHaveLength(9);
      // 36 items × a 4KB body was the 90KB context blow. Measure the actual
      // payload, not the shape: the serialized card must stay tiny.
      expect(JSON.stringify(card).length).toBeLessThan(512);
    });

    it('`omittedFields` shrinks as pseudo-fields are named, down to just the one no live call can ever request (DEBT-BACKLOG-GET-001)', async () => {
      const humanId = await seedItem(tmp);

      const partial = expectOk(await backlogGet(tmp.store, { humanId, repo: REPO, fields: ['body', 'citations'] }));
      expect(partial.omittedFields).not.toContain('body');
      expect(partial.omittedFields).not.toContain('citations');
      expect(partial.omittedFields).toContain('rollup');

      // `_vector` is the one pseudo-field that ALWAYS throws `rag_not_configured`
      // (AC-12/AC-20 — see `assertGetApplicableFields`) rather than ever
      // landing on a card, so naming every OTHER pseudo-field is the closest a
      // real call gets to "nothing omitted": `omittedFields` shrinks to just it.
      // (`closedAt` — FEAT-BACKLOG-010 — is a real, requestable pseudo-field,
      // so it is named here alongside the rest.)
      const full = expectOk(
        await backlogGet(tmp.store, {
          humanId,
          repo: REPO,
          fields: ['body', 'audit_trail', 'blockers', 'citations', 'closedAt', 'notes', 'rollup', 'related'],
        })
      );
      expect(full.omittedFields).toEqual(['_vector']);
    });

    it('`fields` is ADDITIVE to the card — the identity spine is present even when it is not named', async () => {
      const humanId = await seedItem(tmp, { body: 'the full body' });

      const card = expectOk(await backlogGet(tmp.store, { humanId, repo: REPO, fields: ['body'] }));

      expect(card.body).toBe('the full body');
      // Named nothing but `body`, still got a usable card back.
      expect(card.humanId).toBe(humanId);
      expect(card.title).toBe('the item under test');
      expect(card.status).toBe('OPEN');
    });

    it('an unknown field is a `validation` error (exit 2) naming the field — never a silent omission (AC-19)', async () => {
      const humanId = await seedItem(tmp);

      // Cast: the whole point is that a caller CAN send a string outside the
      // vocabulary (over MCP/REST/CLI it is untyped JSON), and the runtime
      // must reject it rather than trust the compile-time union.
      const env = await backlogGet(tmp.store, { humanId, repo: REPO, fields: ['titel'] as never });

      if (!isOutcomeError(env)) throw new Error(`expected a failure, got ${JSON.stringify(env)}`);
      expect(env.error.code).toBe('validation');
      expect(exitCodeForEnvelope(env)).toBe(2);
      expect(env.error.message).toContain('titel');
      expect(env.error.details?.keys).toEqual(['titel']);
    });

    it('a KNOWN field with no single-item meaning is rejected by name rather than silently absent', async () => {
      const humanId = await seedItem(tmp);

      for (const field of ['items', '_score'] as const) {
        const env = await backlogGet(tmp.store, { humanId, repo: REPO, fields: [field] });
        if (!isOutcomeError(env)) throw new Error(`expected a failure for "${field}", got ${JSON.stringify(env)}`);
        expect(env.error.code).toBe('validation');
        expect(env.error.message).toContain(field);
      }
    });

    it('`_vector` degrades to rag_not_configured (AC-12/AC-20), not to a silent empty array', async () => {
      const humanId = await seedItem(tmp);

      const env = await backlogGet(tmp.store, { humanId, repo: REPO, fields: ['_vector'] });

      if (!isOutcomeError(env)) throw new Error(`expected a failure, got ${JSON.stringify(env)}`);
      expect(env.error.code).toBe('rag_not_configured');
    });
  });

  // --------------------------------------------------------------------------
  // §1 — the 3 → 1 absorption: get-item + audit-trail + blockers.
  // --------------------------------------------------------------------------

  describe('§1 absorption — audit_trail and blockers are fields, not separate commands', () => {
    it('`fields:["audit_trail"]` returns the SAME history the absorbed `audit-trail` command returns', async () => {
      const humanId = await seedItem(tmp);
      await transitionStatusNode(tmp.store, REPO, humanId, 'IN_PROGRESS', { by: 'tester' });
      await appendNoteNode(tmp.store, REPO, humanId, 'tester', 'progress note');

      const card = expectOk(await backlogGet(tmp.store, { humanId, repo: REPO, fields: ['audit_trail'] }));
      const absorbed = await auditTrailOp(tmp.store, REPO, humanId);

      // Equal to the command it replaces — the consolidation must not lose a
      // single event, which is the only way "3 → 1" is a real absorption.
      expect(card.audit_trail).toEqual(absorbed.history);
      expect(card.audit_trail?.map((e) => e.kind)).toContain('created');
      const transition = card.audit_trail?.find((e) => e.kind === 'transition');
      expect(transition?.detail).toMatchObject({ from: 'OPEN', to: 'IN_PROGRESS', by: 'tester' });
    });

    it('`fields:["blockers"]` returns the non-terminal DEPENDS_ON targets, and drops one the moment it closes', async () => {
      const item = await seedItem(tmp, { title: 'blocked item' });
      const depA = await seedItem(tmp, { title: 'dep A' });
      const depB = await seedItem(tmp, { title: 'dep B' });
      await addDependencyNode(tmp.store, REPO, item, depA);
      await addDependencyNode(tmp.store, REPO, item, depB);

      const before = expectOk(await backlogGet(tmp.store, { humanId: item, repo: REPO, fields: ['blockers'] }));
      expect(before.blockers?.slice().sort()).toEqual([depA, depB].sort());

      // Close one dependency WITH evidence (the §5a.2 gate) — the blocker set
      // must shrink with zero writes to the blocked item.
      await transitionStatusNode(tmp.store, REPO, depA, 'RESOLVED', {
        by: 'tester',
        citations: [{ file: 'src/fix.ts', lines: '1-9' }],
      });

      const after = expectOk(await backlogGet(tmp.store, { humanId: item, repo: REPO, fields: ['blockers'] }));
      expect(after.blockers).toEqual([depB]);
    });

    it('`fields:["rollup"]` derives §5a.1 two-axis state on read — a child closing changes the parent with no parent write', async () => {
      const parent = await seedItem(tmp, { title: 'the parent' });
      const [childOne, childTwo] = await splitItemNode(tmp.store, REPO, parent, [
        { family: 'BUG-GET', title: 'child one', body: 'x', repo: REPO },
        { family: 'BUG-GET', title: 'child two', body: 'x', repo: REPO },
      ]);

      const before = expectOk(await backlogGet(tmp.store, { humanId: parent, repo: REPO, fields: ['rollup'] }));
      expect(before.rollup).toEqual({
        childrenTotal: 2,
        childrenClosed: 0,
        childrenOpen: [childOne.humanId, childTwo.humanId],
        selfVerified: false,
      });

      await transitionStatusNode(tmp.store, REPO, childOne.humanId, 'RESOLVED', {
        by: 'tester',
        citations: [{ file: 'src/child.ts' }],
      });

      const after = expectOk(await backlogGet(tmp.store, { humanId: parent, repo: REPO, fields: ['rollup'] }));
      expect(after.rollup?.childrenClosed).toBe(1);
      expect(after.rollup?.childrenOpen).toEqual([childTwo.humanId]);
      // The two axes are independent: the parent is still unverified even
      // though half its children are closed.
      expect(after.rollup?.selfVerified).toBe(false);

      await transitionStatusNode(tmp.store, REPO, parent, 'RESOLVED', {
        by: 'tester',
        citations: [{ file: 'src/parent.ts' }],
      });
      const closed = expectOk(await backlogGet(tmp.store, { humanId: parent, repo: REPO, fields: ['rollup'] }));
      expect(closed.rollup?.selfVerified).toBe(true);
      expect(closed.rollup?.childrenOpen).toEqual([childTwo.humanId]);
    });

    it('`fields:["related"]` returns BUG-025\'s read side: humanIds linked via RELATES_TO, visible from BOTH endpoints', async () => {
      const a = await seedItem(tmp, { title: 'item A' });
      const b = await seedItem(tmp, { title: 'item B' });
      const c = await seedItem(tmp, { title: 'item C' });

      // linkRelated writes ONE direction only (a -> b), and a's own related
      // set is untouched by the OTHER edge (b -> c) it isn't part of.
      await linkRelatedNode(tmp.store, REPO, a, b);
      await linkRelatedNode(tmp.store, REPO, b, c);

      const cardA = expectOk(await backlogGet(tmp.store, { humanId: a, repo: REPO, fields: ['related'] }));
      expect(cardA.related).toEqual([b]);

      // b is the DST of one edge and the SRC of the other — both must show up,
      // proving `related` is not silently direction-scoped to `src`.
      const cardB = expectOk(await backlogGet(tmp.store, { humanId: b, repo: REPO, fields: ['related'] }));
      expect(cardB.related?.slice().sort()).toEqual([a, c].sort());

      const cardC = expectOk(await backlogGet(tmp.store, { humanId: c, repo: REPO, fields: ['related'] }));
      expect(cardC.related).toEqual([b]);
    });

    it('an item with no RELATES_TO edges reports `related: []`, not undefined, when the field is named', async () => {
      const humanId = await seedItem(tmp);

      const card = expectOk(await backlogGet(tmp.store, { humanId, repo: REPO, fields: ['related'] }));

      expect(card.related).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // BUG-BACKLOG-AUDIT-TRAIL-SOFTDELETE-001 — the second load-bearing contract.
  // --------------------------------------------------------------------------

  describe('BUG-BACKLOG-AUDIT-TRAIL-SOFTDELETE-001 — history survives a soft delete', () => {
    it('reaches a soft-deleted item and its FULL history from a REOPENED store, where the store op cannot', async () => {
      const humanId = await seedItem(tmp, { title: 'deleted but not forgotten' });
      await transitionStatusNode(tmp.store, REPO, humanId, 'IN_PROGRESS', { by: 'tester' });
      await appendNoteNode(tmp.store, REPO, humanId, 'tester', 'note recorded before the delete');
      const liveHistory = (await auditTrailOp(tmp.store, REPO, humanId)).history;
      expect(liveHistory.length).toBeGreaterThanOrEqual(3); // created + transition + note

      await softDeleteItemNode(tmp.store, REPO, humanId, 'filed in error');

      // The gap this fix closes, measured directly: the absorbed store op
      // resolves through the live-only `findItemNode`, so after the delete it
      // cannot see the item at all.
      await expect(auditTrailOp(tmp.store, REPO, humanId)).rejects.toThrow(/BUG-GET|not found|no item/i);

      // Reopen from DISK — a fresh adapter, a fresh connection, no in-process
      // state. Reachability must be a property of the store, not of this
      // process's object graph.
      await closeGraphBacklogStore(tmp.store);
      const reopened = await openGraphBacklogStore(tmp.dbPath);
      try {
        const env = await backlogGet(reopened, {
          humanId,
          repo: REPO,
          includeDeleted: true,
          fields: ['audit_trail', 'body'],
        });
        const card = expectOk(env);

        // The history is COMPLETE — every entry the live read produced is
        // still there, not a truncated stub.
        expect(card.audit_trail).toEqual(liveHistory);
        expect(card.title).toBe('deleted but not forgotten');
        // And the tombstone is labelled: a caller can never mistake it for a
        // live item (§7.1 — a read never silently narrows).
        expect(env.warnings?.join(' ')).toMatch(/SOFT-DELETED/);
      } finally {
        await closeGraphBacklogStore(reopened);
        // `tmp.cleanup()` in afterEach closes the ALREADY-closed original
        // handle and removes the directory; closing twice is the documented
        // no-op path, and the directory removal is what actually matters.
      }
    });

    it('without `includeDeleted` a tombstone is a typed `soft_deleted` refusal naming the remedy — never served as if live', async () => {
      const humanId = await seedItem(tmp);
      await softDeleteItemNode(tmp.store, REPO, humanId, 'filed in error');

      const env = await backlogGet(tmp.store, { humanId, repo: REPO });

      if (!isOutcomeError(env)) throw new Error(`expected a refusal, got ${JSON.stringify(env)}`);
      expect(env.error.code).toBe('soft_deleted');
      expect(env.error.code).not.toBe('item_not_found'); // the pre-fix answer, and a lie
      expect(env.error.message).toContain('includeDeleted');
      expect(env.error.details?.deletedAt).toEqual(expect.any(String));
    });
  });

  // --------------------------------------------------------------------------
  // §7 — never accept-and-ignore an input key; ambiguity is never silent.
  // --------------------------------------------------------------------------

  describe('§7 input contracts', () => {
    it('an unknown top-level key is a `validation` error naming the key (exit 2)', async () => {
      const humanId = await seedItem(tmp);

      const env = await backlogGet(tmp.store, { humanId, repo: REPO, includeBody: true } as never);

      if (!isOutcomeError(env)) throw new Error(`expected a failure, got ${JSON.stringify(env)}`);
      expect(env.error.code).toBe('validation');
      expect(exitCodeForEnvelope(env)).toBe(2);
      expect(env.error.message).toContain('includeBody');
      expect(env.error.details?.keys).toEqual(['includeBody']);
    });

    it('a `backlog_query`-only key gets a TARGETED invalid_argument pointing at the right tool (AC-23)', async () => {
      const humanId = await seedItem(tmp);

      const env = await backlogGet(tmp.store, { humanId, repo: REPO, filter: { status: 'open' }, limit: 5 } as never);

      if (!isOutcomeError(env)) throw new Error(`expected a failure, got ${JSON.stringify(env)}`);
      expect(env.error.code).toBe('invalid_argument');
      expect(exitCodeForEnvelope(env)).toBe(2);
      expect(env.error.message).toContain('filter');
      expect(env.error.message).toContain('limit');
      expect(env.error.message).toContain('backlog_query');
    });

    it('an absent humanId is invalid_argument, not an internal crash', async () => {
      const env = await backlogGet(tmp.store, { humanId: '   ' });

      if (!isOutcomeError(env)) throw new Error(`expected a failure, got ${JSON.stringify(env)}`);
      expect(env.error.code).toBe('invalid_argument');
      expect(env.error.details?.argument).toBe('humanId');
    });

    it('the same humanId in two repos is `ambiguous` — never a silent pick — and each is reachable when scoped', async () => {
      await seedItem(tmp, { idOverride: 'BUG-SHARED-001', title: 'the adhd one', repo: REPO });
      await seedItem(tmp, { idOverride: 'BUG-SHARED-001', title: 'the other one', repo: OTHER_REPO });

      const env = await backlogGet(tmp.store, { humanId: 'BUG-SHARED-001' });

      if (!isOutcomeError(env)) throw new Error(`expected a refusal, got ${JSON.stringify(env)}`);
      expect(env.error.code).toBe('ambiguous');
      expect(exitCodeForEnvelope(env)).toBe(1);
      expect(env.error.message).toContain(REPO);
      expect(env.error.message).toContain(OTHER_REPO);
      expect((env.error.details?.repos as string[]).slice().sort()).toEqual([OTHER_REPO, REPO].sort());

      // Scoping resolves it — and resolves it to the RIGHT one, both ways.
      expect(expectOk(await backlogGet(tmp.store, { humanId: 'BUG-SHARED-001', repo: REPO })).title).toBe('the adhd one');
      expect(expectOk(await backlogGet(tmp.store, { humanId: 'BUG-SHARED-001', repo: OTHER_REPO })).title).toBe('the other one');
    });

    it('an unscoped get resolves a unique humanId across repos without requiring the caller to know the repo', async () => {
      const humanId = await seedItem(tmp, { idOverride: 'BUG-UNIQUE-001', repo: OTHER_REPO, title: 'only one of me' });

      const card = expectOk(await backlogGet(tmp.store, { humanId, fields: ['repo'] }));

      expect(card.title).toBe('only one of me');
      expect(card.repo).toBe(OTHER_REPO);
    });
  });

  // --------------------------------------------------------------------------
  // FEAT-BACKLOG-006 — a renamed humanId redirects instead of 404ing forever.
  // --------------------------------------------------------------------------

  describe('rename redirect — a citation to a RETIRED humanId still resolves', () => {
    it('scoped: a get for the OLD (repo, humanId) redirects to the renamed item, with a warning naming the redirect', async () => {
      const created = await createItemNode(tmp.store, {
        family: 'BUG-GET',
        title: 'renamed item',
        body: 'x',
        repo: REPO,
      });
      const oldHumanId = created.item.humanId;
      const renamed = await renameHumanIdNode(tmp.store, REPO, created.item.nodeId, oldHumanId, 'BUG-GET-RENAMED-001');

      const env = await backlogGet(tmp.store, { humanId: oldHumanId, repo: REPO });

      if (!isOutcomeOk(env)) throw new Error(`expected the redirect to succeed, got ${JSON.stringify((env as { error?: unknown }).error)}`);
      // Resolves to the CURRENT item, not a 404 and not the old identity.
      expect(env.data.humanId).toBe('BUG-GET-RENAMED-001');
      expect(env.data.humanId).toBe(renamed.humanId);
      expect(env.data.title).toBe('renamed item');
      // Never silent (§7.1) — the response names both the old id looked up
      // and the current one it was redirected to.
      expect(env.warnings?.some((w) => w.includes(oldHumanId) && w.includes('BUG-GET-RENAMED-001'))).toBe(true);
    });

    it('unscoped: a repo-omitted get for the OLD humanId also redirects', async () => {
      const created = await createItemNode(tmp.store, {
        family: 'BUG-GET',
        title: 'renamed item, unscoped lookup',
        body: 'x',
        repo: REPO,
      });
      const oldHumanId = created.item.humanId;
      await renameHumanIdNode(tmp.store, REPO, created.item.nodeId, oldHumanId, 'BUG-GET-RENAMED-002');

      const card = expectOk(await backlogGet(tmp.store, { humanId: oldHumanId }));

      expect(card.humanId).toBe('BUG-GET-RENAMED-002');
    });

    it('a genuinely unknown humanId (never renamed, never created) still 404s — the redirect never masks a real miss', async () => {
      const env = await backlogGet(tmp.store, { humanId: 'BUG-GET-NEVER-EXISTED-001', repo: REPO });

      if (!isOutcomeError(env)) throw new Error(`expected a failure, got ${JSON.stringify(env)}`);
      expect(env.error.code).toBe('item_not_found');
    });

    it('a rename chain (A -> B -> C) redirects from EITHER retired id to the current item', async () => {
      const created = await createItemNode(tmp.store, { family: 'BUG-GET', title: 'twice renamed', body: 'x', repo: REPO });
      const idA = created.item.humanId;
      const afterFirst = await renameHumanIdNode(tmp.store, REPO, created.item.nodeId, idA, 'BUG-GET-CHAIN-B-001');
      const idB = afterFirst.humanId;
      await renameHumanIdNode(tmp.store, REPO, created.item.nodeId, idB, 'BUG-GET-CHAIN-C-001');

      const fromA = expectOk(await backlogGet(tmp.store, { humanId: idA, repo: REPO }));
      const fromB = expectOk(await backlogGet(tmp.store, { humanId: idB, repo: REPO }));
      expect(fromA.humanId).toBe('BUG-GET-CHAIN-C-001');
      expect(fromB.humanId).toBe('BUG-GET-CHAIN-C-001');
    });
  });
});

/*
 * NEGATIVE CONTROLS (run 2026-08-21, `npx vitest run --config
 * entrypoint/backlog/vite.config.ts entrypoint/backlog/src/v2/get.spec.ts`):
 *
 *  A. AC-6 — reverted the not-found contract by returning `okEnvelope(null)`
 *     for `BacklogItemNotFoundError` in `backlogGet`'s catch (the exact
 *     `ok:true, data:null` shape §10.2 outlaws): suite exit code 1, both
 *     "AC-6 — a missing single item" tests red (2 failed | 15 passed) on
 *     `expect(env.ok).toBe(false)`. Restored → suite exit code 0, 17 passed.
 *
 *  B. BUG-BACKLOG-AUDIT-TRAIL-SOFTDELETE-001 — reverted the fix by making
 *     `findSoftDeletedItemNodes` return `[]` (i.e. live-only resolution, the
 *     pre-fix behaviour): suite exit code 1, both soft-delete tests red (2 failed | 15 passed)
 *     (`item_not_found` instead of the tombstone and instead of
 *     `soft_deleted`). Restored → exit code 0.
 */
