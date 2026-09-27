/**
 * c1-reference.spec.ts — the C1 Reference contract, driven end-to-end through
 * the REAL mounted verbs (`api.ts`) on a REAL temp store.
 *
 * ## What C1 promises
 *
 * Every token a consumer holds — a short uid prefix, a project name/repoUrl, a
 * component path — gets exactly ONE canonical resolution or a LOUD, typed
 * failure that names the candidates. Nothing silently picks the first match,
 * nothing silently defaults, and a retired id is never reused.
 *
 * AC1–AC8 are exercised below. The negative controls named in the ticket
 * (AC2, AC5, AC7, AC8) were each run by temporarily reverting the guard and
 * observing RED, then restoring exactly:
 *
 *  - AC2 — `write/uid-prefix.ts` `selectUniqueUidCandidate` returning
 *    `candidates[0]` instead of throwing ⇒ the ambiguous-prefix test resolves
 *    an arbitrary item and goes RED.
 *  - AC5 — removing the redirect fallback from `tryResolveRef` ⇒ the retired
 *    name `proj-b` resolves to zero matches and the union assertion goes RED.
 *  - AC7 — using `resolveIssueByUid` in place of `resolveLogicalIssue` ⇒ the
 *    superseded uid throws and the resolution goes RED.
 *  - AC8 — `create` ignoring a supplied `component` and always defaulting to
 *    `(root)` ⇒ the unresolvable-component error assertion goes RED.
 *
 * Every negative control is a REVERT of production behavior, not a mock of it:
 * the assertions read the real envelope/error and fail when the guard is gone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildBacklogEnv } from '../env.js';
import {
  type BacklogCtx,
  create,
  get,
  lookup,
  mergeProject,
  query,
  rmProject,
  update,
  upsertProject,
} from '../api.js';
import { AmbiguousReferenceError } from '../write/errors.js';
import { isOutcomeError, isOutcomeOk } from '../envelope.js';
import { resolveLogicalIssue, resolveUidPrefix } from './resolve.js';
import {
  openTmpStore,
  type TmpStore,
} from '../test/helpers/tmp-store.js';

/**
 * Rewrite a node's uid to a KNOWN value inside one `immediate` transaction —
 * the only way to make a shared 8-hex prefix fixture deterministic, since uids
 * are opaque `randomUUID()` values. Edges reference rowids, never uids.
 */
async function setUid(
  store: TmpStore['store'],
  from: string,
  to: string
): Promise<void> {
  await store.adapter.transaction(
    async (tx) => {
      const { rowsAffected } = await tx.executeRun(
        'UPDATE node SET uid = ? WHERE uid = ?',
        [to, from]
      );
      if (rowsAffected !== 1) {
        throw new Error(
          `setUid fixture: expected 1 row for uid "${from}", updated ${rowsAffected}`
        );
      }
    },
    { mode: 'immediate' }
  );
}

describe('C1 Reference — canonical identity & resolution (real store, mounted verbs)', () => {
  let tmp: TmpStore;
  let ctx: BacklogCtx;

  beforeEach(async () => {
    tmp = await openTmpStore('c1-reference');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  async function mkProject(
    name: string,
    extra: { repoUrl?: string } = {}
  ): Promise<string> {
    const res = await upsertProject(ctx, { name, by: 'operator', ...extra });
    if (!isOutcomeOk(res)) throw new Error(JSON.stringify(res.error));
    return res.data.uid;
  }

  async function mkIssue(
    project: string,
    title: string,
    body = 'body'
  ): Promise<string> {
    const res = await create(ctx, {
      project,
      title,
      body,
      by: 'filer',
    });
    if (!isOutcomeOk(res)) throw new Error(JSON.stringify(res.error));
    if (typeof res.data.uid !== 'string')
      throw new Error('create returned no uid');
    return res.data.uid;
  }

  it('AC1 — `get` with the first 8 hex of a real item returns that item', async () => {
    const project = await mkProject('ac1-project');
    const uid = await mkIssue(project, 'ac1 target');

    const byPrefix = await get(ctx, {
      uid: uid.slice(0, 8),
      fields: ['uid', 'title'],
    });
    expect(isOutcomeOk(byPrefix)).toBe(true);
    if (!isOutcomeOk(byPrefix)) return;
    expect(byPrefix.data.uid).toBe(uid);

    // The full uid is the fast path and returns the byte-identical card.
    const byFull = await get(ctx, { uid, fields: ['uid', 'title'] });
    expect(byFull).toEqual(byPrefix);
  });

  it('AC2 — an AMBIGUOUS prefix is refused, naming every candidate; no item returned', async () => {
    const project = await mkProject('ac2-project');
    const a = await mkIssue(project, 'ac2 first');
    const b = await mkIssue(project, 'ac2 second');
    await setUid(tmp.store, a, 'c0ffee00-1111-4111-8111-111111111111');
    await setUid(tmp.store, b, 'c0ffee00-2222-4222-8222-222222222222');

    const env = await get(ctx, { uid: 'c0ffee00' });
    expect(isOutcomeError(env)).toBe(true);
    if (!isOutcomeError(env)) return;
    expect(env.error.code).toBe('ambiguous_reference');
    expect(env.error.message).toContain('c0ffee00-1111');
    expect(env.error.message).toContain('c0ffee00-2222');

    // The typed candidate set is carried on the error itself.
    const typed = await resolveUidPrefix(tmp.store.graph, 'c0ffee00').then(
      () => {
        throw new Error('expected AmbiguousReferenceError');
      },
      (e: unknown) => e
    );
    expect(typed).toBeInstanceOf(AmbiguousReferenceError);
    const candidates = (typed as AmbiguousReferenceError).candidates;
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((c) => c.uid))).toEqual(
      new Set([
        'c0ffee00-1111-4111-8111-111111111111',
        'c0ffee00-2222-4222-8222-222222222222',
      ])
    );
  });

  it('AC3 — a nonexistent prefix and an ambiguous prefix carry DIFFERENT codes', async () => {
    const project = await mkProject('ac3-project');
    const a = await mkIssue(project, 'ac3 first');
    const b = await mkIssue(project, 'ac3 second');
    await setUid(tmp.store, a, 'c0ffee00-1111-4111-8111-111111111111');
    await setUid(tmp.store, b, 'c0ffee00-2222-4222-8222-222222222222');

    const missing = await get(ctx, { uid: 'ffffffff' });
    const ambiguous = await get(ctx, { uid: 'c0ffee00' });
    expect(isOutcomeError(missing)).toBe(true);
    expect(isOutcomeError(ambiguous)).toBe(true);
    if (!isOutcomeError(missing) || !isOutcomeError(ambiguous)) return;

    expect(missing.error.code).toBe('item_not_found');
    expect(ambiguous.error.code).toBe('ambiguous_reference');
    expect(missing.error.code).not.toBe(ambiguous.error.code);
    // Both still exit non-zero, but as DIFFERENT codes (the structural branch).
    expect(missing.error.message).toContain('no item matches');
  });

  it('AC4 — `lookup` routes a uid, a title and a project; a miss names "location"', async () => {
    const project = await mkProject('adhd');
    const uid = await mkIssue(project, 'zqxwvu42 lookup target');

    const byUid = await lookup(ctx, { q: uid });
    expect(isOutcomeOk(byUid)).toBe(true);
    if (!isOutcomeOk(byUid)) return;
    expect(byUid.data.redirect?.uid).toBe(uid);

    const byTitle = await lookup(ctx, { q: 'zqxwvu42' });
    expect(isOutcomeOk(byTitle)).toBe(true);
    if (!isOutcomeOk(byTitle)) return;
    expect(byTitle.data.redirect?.uid).toBe(uid);

    const byProject = await lookup(ctx, { q: 'adhd' });
    expect(isOutcomeOk(byProject)).toBe(true);
    if (!isOutcomeOk(byProject)) return;
    expect(byProject.data.project.name).toBe('adhd');

    const none = await lookup(ctx, { q: 'no-such-token-xyz' });
    expect(isOutcomeError(none)).toBe(true);
    if (!isOutcomeError(none)) return;
    expect(none.error.code).toBe('not_found');
    expect(none.error.message).toContain('location');
  });

  it('AC5 — `merge-project` unifies the project query; the retired name resolves by one-hop redirect', async () => {
    const survivor = await mkProject('proj-a');
    const retiring = await mkProject('proj-b');
    const issueA = await mkIssue(survivor, 'ac5 issue in a');
    const issueB = await mkIssue(retiring, 'ac5 issue in b');

    const merged = await mergeProject(ctx, {
      fromUid: retiring,
      toUid: survivor,
      by: 'operator',
    });
    expect(isOutcomeOk(merged)).toBe(true);
    if (!isOutcomeOk(merged)) return;
    expect(merged.data.survivorUid).toBe(survivor);
    expect(merged.data.retiredUid).toBe(retiring);
    expect(merged.data.movedIssues).toBe(1);

    // The survivor's filter now returns the UNION.
    const bySurvivor = await query(ctx, {
      view: 'list',
      filter: { project: survivor },
      limit: 50,
    });
    expect(isOutcomeOk(bySurvivor)).toBe(true);
    if (!isOutcomeOk(bySurvivor)) return;
    if (!('items' in bySurvivor.data))
      throw new Error(`expected a list result, got ${bySurvivor.data.view}`);
    expect(new Set(bySurvivor.data.items.map((i) => i.uid))).toEqual(
      new Set([issueA, issueB])
    );

    // The RETIRED NAME resolves (one hop) to the same union.
    const byRetiredName = await query(ctx, {
      view: 'list',
      filter: { project: 'proj-b' },
      limit: 50,
    });
    expect(isOutcomeOk(byRetiredName)).toBe(true);
    if (!isOutcomeOk(byRetiredName)) return;
    if (!('items' in byRetiredName.data))
      throw new Error(`expected a list result, got ${byRetiredName.data.view}`);
    expect(new Set(byRetiredName.data.items.map((i) => i.uid))).toEqual(
      new Set([issueA, issueB])
    );

    // A one-hop redirect chain longer than one hop is refused, not chained.
    const second = await mkProject('proj-c');
    const chain = await mergeProject(ctx, {
      fromUid: survivor,
      toUid: second,
      by: 'operator',
    });
    expect(isOutcomeOk(chain)).toBe(true);
    const follow = await query(ctx, {
      view: 'list',
      filter: { project: 'proj-b' },
      limit: 50,
    });
    expect(isOutcomeError(follow)).toBe(true);
    if (!isOutcomeError(follow)) return;
    expect(follow.error.code).toBe('invalid_argument');
  });

  it('AC6 — merge is idempotent, the retired uid is not listed, and a later create mints a FRESH uid', async () => {
    const survivor = await mkProject('proj-a');
    const retiring = await mkProject('proj-b');
    await mkIssue(retiring, 'ac6 issue');

    const first = await mergeProject(ctx, {
      fromUid: retiring,
      toUid: survivor,
      by: 'operator',
    });
    expect(isOutcomeOk(first)).toBe(true);

    // Idempotent second call.
    const again = await mergeProject(ctx, {
      fromUid: retiring,
      toUid: survivor,
      by: 'operator',
    });
    expect(isOutcomeOk(again)).toBe(true);
    if (!isOutcomeOk(again)) return;
    expect(again.data.movedIssues).toBe(0);
    expect(again.data.retired).toBe(true);

    // The retired uid is absent from the live projects listing.
    const projects = await query(ctx, { view: 'projects' });
    expect(isOutcomeOk(projects)).toBe(true);
    if (!isOutcomeOk(projects)) return;
    if (projects.data.view !== 'projects')
      throw new Error(`expected projects, got ${projects.data.view}`);
    expect(projects.data.items.map((p) => p.uid)).not.toContain(retiring);

    // Re-registering the retired NAME mints a FRESH uid — ids are never reused.
    const remade = await upsertProject(ctx, { name: 'proj-b', by: 'operator' });
    expect(isOutcomeOk(remade)).toBe(true);
    if (!isOutcomeOk(remade)) return;
    expect(remade.data.created).toBe(true);
    expect(remade.data.uid).not.toBe(retiring);
  });

  it('AC7 — a logical-id resolver carries an attestation subject across a body-edit supersede', async () => {
    const project = await mkProject('ac7-project');
    const subjectId = await mkIssue(project, 'ac7 subject', 'original body');

    // A C3 attestation would store exactly this value as `subject.id`.
    const edited = await update(ctx, {
      uid: subjectId,
      body: 'edited body — this supersedes and mints a new uid',
      by: 'editor',
    });
    expect(isOutcomeOk(edited)).toBe(true);
    if (!isOutcomeOk(edited)) return;
    const headUid = edited.data.uid;
    expect(headUid).not.toBe(subjectId);

    // The non-throwing resolver returns the SAME logical item's head.
    const head = await resolveLogicalIssue(tmp.store.graph, subjectId);
    expect(head.uid).toBe(headUid);

    // NEGATIVE CONTROL (in-test): `resolveIssueByUid` — the throwing sibling —
    // refuses the stale uid exactly as it must, which is why C3 uses the
    // logical resolver instead.
    const stale = await get(ctx, { uid: subjectId });
    expect(isOutcomeError(stale)).toBe(true);
    if (!isOutcomeError(stale)) return;
    expect(stale.error.code).toBe('conflict');
  });

  it('AC8 — a supplied component that cannot resolve errors; a resolved one is explicit', async () => {
    const project = await mkProject('ac8-project');
    const components = await tmp.store.graph.queryNodes({
      kind: 'component',
      liveOnly: true,
      metadata: { projectUid: { eq: project } },
    });
    const rootComponent = components[0]?.uid;
    if (rootComponent === undefined)
      throw new Error('AC8 seed: project has no (root) component');

    // A SUPPLIED component that does not resolve fails loudly, naming it.
    const bad = await create(ctx, {
      project,
      title: 'ac8 bad component',
      body: 'b',
      component: 'no-such-component-xyz',
      by: 'filer',
    });
    expect(isOutcomeError(bad)).toBe(true);
    if (!isOutcomeError(bad)) return;
    expect(bad.error.code).toBe('not_found');
    expect(bad.error.message).toContain('no-such-component-xyz');

    // A SUPPLIED component that resolves is marked EXPLICIT.
    const explicit = await create(ctx, {
      project,
      title: 'ac8 explicit',
      body: 'b',
      component: rootComponent,
      by: 'filer',
    });
    expect(isOutcomeOk(explicit)).toBe(true);
    if (!isOutcomeOk(explicit)) return;
    expect(explicit.data.placementResolved).toBe('explicit');

    // OMITTING the component uses the reserved default — VISIBLY.
    const defaulted = await create(ctx, {
      project,
      title: 'ac8 defaulted',
      body: 'b',
      by: 'filer',
    });
    expect(isOutcomeOk(defaulted)).toBe(true);
    if (!isOutcomeOk(defaulted)) return;
    expect(defaulted.data.placementResolved).toBe('default-root');
  });

  it('adjunct — `upsert-project` de-duplicates by repoUrl instead of minting a twin', async () => {
    const first = await upsertProject(ctx, {
      name: 'repo-dup-one',
      repoUrl: 'https://example.test/repo.git',
      by: 'operator',
    });
    expect(isOutcomeOk(first)).toBe(true);
    if (!isOutcomeOk(first)) return;
    expect(first.data.created).toBe(true);

    const second = await upsertProject(ctx, {
      name: 'repo-dup-two',
      repoUrl: 'https://example.test/repo.git',
      by: 'operator',
    });
    expect(isOutcomeOk(second)).toBe(true);
    if (!isOutcomeOk(second)) return;
    expect(second.data.created).toBe(false);
    expect(second.data.uid).toBe(first.data.uid);
  });

  it('adjunct — `rm-project` soft-retires without a redirect; the name resolves to nothing', async () => {
    const project = await mkProject('rm-project-target');
    const removed = await rmProject(ctx, {
      uid: project,
      reason: 'no longer used',
      by: 'operator',
    });
    expect(isOutcomeOk(removed)).toBe(true);
    if (!isOutcomeOk(removed)) return;
    expect(removed.data).toEqual({ uid: project, retired: true });

    // No redirectTo was written, so the retired name resolves to zero matches.
    const listed = await query(ctx, {
      view: 'list',
      filter: { project: 'rm-project-target' },
      limit: 10,
    });
    expect(isOutcomeOk(listed)).toBe(true);
    if (!isOutcomeOk(listed)) return;
    if (!('items' in listed.data))
      throw new Error(`expected a list result, got ${listed.data.view}`);
    expect(listed.data.items).toEqual([]);
  });
});
