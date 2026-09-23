/**
 * audit-fields.spec.ts — SPEC.md §8 AC-3, the half no other suite reads.
 *
 * AC-3: "every transition/update/move/invalidate/embedding write produces one
 * audit node (`actor`+`action`+`sha`)".
 *
 * Existing suites prove the audit node EXISTS and carry its `action`/`from`/
 * `to`, but nothing reads `actor` or `sha` off the raw node — the two fields
 * that make an audit trail an audit trail rather than a change log. Dropping
 * either from `writeAudit`'s canonical fields would leave every one of those
 * suites green while the trail silently lost attribution or integrity.
 *
 * ## What has teeth
 *
 * `sha` is not merely asserted non-empty: it is RECOMPUTED here, in the test,
 * from the audit's own recorded fields using the same canonical-JSON + sha256
 * convention `writeAudit` documents, and compared. So the assertion fails if
 * the digest is a placeholder, if it is computed over a different field set,
 * or if any recorded field is omitted from the hash — a bare
 * `expect(sha).toBeTruthy()` catches none of those.
 *
 * `actor` is asserted to equal the caller's OWN `by` on every verb, so an
 * implementation that stamps a constant, the subject uid, or an empty string
 * goes red. Negative control: removing `actor` from `writeAudit`'s
 * `canonicalFields` (src/write/audit.ts) turns both the attribution assertion
 * AND the recomputed-sha assertion red, since `actor` is inside the digest.
 *
 * Real store, real verbs, real SQL reads of the `audit` node — never mocks.
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
import { deleteIssue } from './delete.js';
import { move } from './move.js';
import { transition } from './transition.js';
import { update } from './update.js';
import { upsertComponent } from './catalog.js';
import { canonicalJSONStringify, sha256Hex } from './tx.js';

/** The recorded shape of one `audit` node, read straight off its `meta` column. */
interface IRawAudit {
  uid: string;
  actor: unknown;
  action: unknown;
  target_uid: unknown;
  from: unknown;
  to: unknown;
  note: unknown;
  at: unknown;
  sha: unknown;
}

/**
 * Every live `audit` node reachable from `issueUid`, newest last. Reads the
 * `audits` edge and the node's raw `meta` — deliberately NOT through any
 * read-layer projection, so a projection that fabricates or defaults a field
 * cannot mask its absence in the stored row.
 */
async function auditsFor(
  store: TestIssueStore,
  issueUid: string
): Promise<IRawAudit[]> {
  const { rows } = await store.adapter.executeAll<{
    uid: string;
    meta: string | null;
    rowid: number;
  }>(
    `SELECT a.uid AS uid, a.meta AS meta, a.rowid AS rowid
       FROM node AS subject
       JOIN edge AS e ON e.src = subject.rowid AND e.rel = 'audits' AND e.t_invalid IS NULL
       JOIN node AS a ON a.rowid = e.dst
      WHERE subject.uid = ? AND a.t_invalid IS NULL
      ORDER BY a.rowid ASC`,
    [issueUid]
  );
  return rows.map((r) => {
    const meta = (JSON.parse(r.meta ?? '{}') ?? {}) as Record<string, unknown>;
    return {
      uid: r.uid,
      actor: meta['actor'],
      action: meta['action'],
      target_uid: meta['target_uid'],
      from: meta['from'],
      to: meta['to'],
      note: meta['note'],
      at: meta['at'],
      sha: meta['sha'],
    };
  });
}

/**
 * Re-derive the digest from the audit's OWN recorded fields, using the exact
 * convention `writeAudit` documents (§4a: sha256 over the canonical,
 * sorted-key JSON of the recorded fields, `sha` itself excluded).
 */
function recomputeSha(audit: IRawAudit): string {
  return sha256Hex(
    canonicalJSONStringify({
      actor: audit.actor,
      action: audit.action,
      target_uid: audit.target_uid,
      from: audit.from,
      to: audit.to,
      note: audit.note,
      at: audit.at,
    })
  );
}

/** Assert AC-3's three required fields on one audit row, digest included. */
function expectWellFormed(
  audit: IRawAudit,
  expected: { actor: string; action: string }
): void {
  expect(audit.actor).toBe(expected.actor);
  expect(audit.action).toBe(expected.action);
  expect(typeof audit.sha).toBe('string');
  expect((audit.sha as string).length).toBe(64); // sha256 hex
  expect(audit.sha).toBe(recomputeSha(audit));
}

describe('AC-3 — every write stamps actor + action + a recomputable sha on its audit node', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('audit-fields');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'audit-fields-project')).projectUid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  async function seed(title: string, by: string): Promise<string> {
    const created = await createIssue(store, {
      project: projectUid,
      title,
      body: `${title} body`,
      by,
    });
    if (!created.created || !created.uid)
      throw new Error(`expected ${title} to be created`);
    return created.uid;
  }

  it('create stamps the caller as actor, and its sha covers the recorded fields', async () => {
    const uid = await seed('a created issue', 'the-filer');

    const trail = await auditsFor(store, uid);
    expect(trail.length).toBeGreaterThanOrEqual(1);
    const created = trail.find((a) => a.action === 'created');
    if (!created)
      throw new Error(
        `no "created" audit; got: ${trail
          .map((a) => String(a.action))
          .join(', ')}`
      );

    expectWellFormed(created, { actor: 'the-filer', action: 'created' });
    expect(created.target_uid).toBe(uid);
  });

  it('update stamps its OWN actor — never the actor of the write before it', async () => {
    const uid = await seed('an edited issue', 'the-filer');
    const { uid: liveUid } = await update(store, {
      uid,
      body: 'a revised body',
      by: 'the-editor',
    });

    const own = (await auditsFor(store, liveUid)).find(
      (a) => a.action === 'updated'
    );
    if (!own) throw new Error('no "updated" audit on the successor node');

    expectWellFormed(own, { actor: 'the-editor', action: 'updated' });
    // Distinct actors per write is the whole point of attribution: an
    // implementation that carried the creator forward passes a
    // `toBeTruthy()` check and fails this one.
    expect(own.actor).not.toBe('the-filer');
    expect(own.from).toBe(uid);
    expect(own.to).toBe(liveUid);
  });

  it('transition stamps actor + note, and the note is inside the digest', async () => {
    const uid = await seed('a transitioned issue', 'the-filer');
    await transition(store, {
      uid,
      by: 'the-mover',
      toStatus: 'in-progress',
      note: 'picked this up',
    });

    const own = (await auditsFor(store, uid)).find(
      (a) => a.action === 'transitioned'
    );
    if (!own) {
      const seen = (await auditsFor(store, uid))
        .map((a) => String(a.action))
        .join(', ');
      throw new Error(`no "transitioned" audit; got: ${seen}`);
    }

    expectWellFormed(own, { actor: 'the-mover', action: 'transitioned' });
    expect(own.note).toBe('picked this up');
    // `note` is a recorded field, so tampering with it must invalidate the
    // digest — this is what makes the sha an integrity check rather than a
    // decoration.
    expect(recomputeSha({ ...own, note: 'a different note' })).not.toBe(
      own.sha
    );
  });

  it('move stamps the caller as actor on its own audit node', async () => {
    const uid = await seed('a moved issue', 'the-filer');
    await upsertComponent(store, {
      project: projectUid,
      name: 'somewhere-else',
      by: 'the-filer',
    });
    await move(store, {
      uid,
      toComponent: 'somewhere-else',
      by: 'the-relocator',
    });

    const trail = await auditsFor(store, uid);
    const own = trail.find((a) => a.actor === 'the-relocator');
    if (!own)
      throw new Error(
        `no audit attributed to the mover; got: ${trail
          .map((a) => `${String(a.action)}/${String(a.actor)}`)
          .join(', ')}`
      );

    expectWellFormed(own, {
      actor: 'the-relocator',
      action: String(own.action),
    });
    expect(own.sha).toBe(recomputeSha(own));
  });

  it('invalidate stamps the caller as actor and carries the reason as its note', async () => {
    const uid = await seed('a deleted issue', 'the-filer');
    await deleteIssue(store, {
      uid,
      reason: 'filed against the wrong project',
      by: 'the-remover',
    });

    const trail = await auditsFor(store, uid);
    const own = trail.find((a) => a.actor === 'the-remover');
    if (!own)
      throw new Error(
        `no audit attributed to the remover; got: ${trail
          .map((a) => `${String(a.action)}/${String(a.actor)}`)
          .join(', ')}`
      );

    expectWellFormed(own, { actor: 'the-remover', action: String(own.action) });
    expect(own.note).toBe('filed against the wrong project');
  });

  it('every audit in a multi-write history is independently well-formed and independently attributed', async () => {
    // The end-to-end shape AC-3 actually asserts: one audit node per write,
    // each carrying its own actor and its own valid digest, all reachable
    // from the issue's CURRENT uid after a supersede.
    const uid = await seed('a long-lived issue', 'the-filer');
    await transition(store, {
      uid,
      by: 'the-mover',
      toStatus: 'in-progress',
      note: 'starting',
    });
    const { uid: liveUid } = await update(store, {
      uid,
      body: 'a revised body',
      by: 'the-editor',
    });

    const trail = await auditsFor(store, liveUid);
    expect(trail.length).toBeGreaterThanOrEqual(3);

    for (const audit of trail) {
      expect(typeof audit.actor).toBe('string');
      expect((audit.actor as string).length).toBeGreaterThan(0);
      expect(typeof audit.action).toBe('string');
      expect((audit.action as string).length).toBeGreaterThan(0);
      expect(audit.sha).toBe(recomputeSha(audit));
    }

    // Three different people touched this issue; the trail says so.
    const actors = new Set(trail.map((a) => String(a.actor)));
    expect(actors.has('the-filer')).toBe(true);
    expect(actors.has('the-mover')).toBe(true);
    expect(actors.has('the-editor')).toBe(true);

    // Every audit node is a distinct node — one per write, never one reused.
    expect(new Set(trail.map((a) => a.uid)).size).toBe(trail.length);
  });
});
