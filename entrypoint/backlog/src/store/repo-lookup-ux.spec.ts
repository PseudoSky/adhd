/**
 * repo-lookup-ux.spec.ts — BUG-BACKLOG-REPO-LOOKUP-UX-001, both halves,
 * against a real temp SQLite-backed `GraphBacklogStore` (no mocks):
 *
 *  1. Read-time: a `(repo, humanId)` MISS whose humanId lives under a
 *     DIFFERENT repo string now names the actual repo instead of a bare
 *     "not found" — exercised through the real `appendNote`/`getItem`
 *     client functions (the exact two surfaces the bug report cites) AND
 *     the underlying `buildNotFoundError`/`findHumanIdInAnyRepo` helpers.
 *  2. Write-time: `createItem` (and `importFromMarkdown`) soft-warn (never
 *     hard-fail) when `repo` doesn't match any repo value already known to
 *     the store.
 *
 * Every assertion has teeth: negative controls below confirm a CORRECT
 * lookup is completely unaffected (no hint, no throw) and that a genuinely
 * novel repo's first-ever item still succeeds.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import * as client from '../ops-v1.js';
import type { BacklogCtx } from '../client.js';
import { buildBacklogEnv } from '../env.js';
import { BacklogItemNotFoundError } from '../model.js';
import { createItemNode } from './crud.js';
import { buildNotFoundError, findHumanIdInAnyRepo, findItemNode, knownRepos, resolveCanonicalRepo } from './query.js';
import { normalizeRepoKey } from './mapping.js';

const REPO_A = 'PseudoSky/adhd';
// TASK-001: `REPO_B` ('adhd') is the BARE form of `REPO_A`
// ('PseudoSky/adhd') — since `resolveCanonicalRepo` now collapses an
// owner-prefixed repo key and its bare spelling into ONE project (see the
// "owner-prefix repo-key fork" describe block below), these two are NO
// LONGER a valid "genuinely different repo" pair for a test to use. Tests
// that need two repos the store must treat as distinct use `REPO_UNRELATED`
// instead; `REPO_B` is used only where the fork-collapse itself is under
// test.
const REPO_B = 'adhd';
const REPO_UNRELATED = 'some/other-project';

let tmp: TmpStore;
let ctx: BacklogCtx;

beforeEach(async () => {
  tmp = await openTmpStore('repo-lookup-ux-spec');
  ctx = { store: tmp.store, env: buildBacklogEnv({ scope: 'project', adhdRoot: tmp.dir }) };
});

afterEach(() => {
  tmp.cleanup();
});

describe('read-time: helpful hint on a repo/humanId mismatch', () => {
  it('findHumanIdInAnyRepo finds a live node under a DIFFERENT repo string', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-X', title: 't', body: 'b', repo: REPO_A });
    const hits = await findHumanIdInAnyRepo(tmp.store, created.item.humanId);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.namespace).toBe(REPO_A);
  });

  it('buildNotFoundError names the actual repo the humanId lives under', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-X', title: 't', body: 'b', repo: REPO_A });
    const err = await buildNotFoundError(tmp.store, REPO_B, created.item.humanId);
    expect(err).toBeInstanceOf(BacklogItemNotFoundError);
    expect(err.foundInRepos).toEqual([REPO_A]);
    expect(err.message).toContain(`did you mean repo '${REPO_A}'`);
  });

  it('buildNotFoundError names NOTHING for a genuinely nonexistent humanId (no false hint)', async () => {
    const err = await buildNotFoundError(tmp.store, REPO_A, 'BUG-NOPE-999');
    expect(err.foundInRepos).toEqual([]);
    expect(err.message).not.toContain('did you mean');
    expect(err.message).toBe(`backlog item not found: ${REPO_A}::BUG-NOPE-999`);
  });

  it('appendNote throws the enriched hint when called with the WRONG repo for a real item (the exact bug-report scenario)', async () => {
    const created = await client.createItem(ctx, { family: 'BUG-MISMATCH', title: 't', body: 'b', repo: REPO_A });
    await expect(client.appendNote(ctx, REPO_UNRELATED, created.item.humanId, 'agent-x', 'a note')).rejects.toMatchObject({
      name: 'BacklogItemNotFoundError',
      foundInRepos: [REPO_A],
    });
    await expect(client.appendNote(ctx, REPO_UNRELATED, created.item.humanId, 'agent-x', 'a note')).rejects.toThrow(
      `did you mean repo '${REPO_A}'`
    );
  });

  it('appendNote with the CORRECT repo is completely unaffected — succeeds exactly as before', async () => {
    const created = await client.createItem(ctx, { family: 'BUG-CORRECT', title: 't', body: 'b', repo: REPO_A });
    const updated = await client.appendNote(ctx, REPO_A, created.item.humanId, 'agent-x', 'a real note');
    expect(updated.notes[updated.notes.length - 1]?.text).toBe('a real note');
  });

  it('getItem: a genuine miss (humanId does not exist under ANY repo) still returns null — unchanged', async () => {
    const result = await client.getItem(ctx, REPO_A, 'BUG-TOTALLY-MISSING-001');
    expect(result).toBeNull();
  });

  it('getItem: a repo/humanId mismatch now THROWS the enriched hint instead of silently returning null', async () => {
    const created = await client.createItem(ctx, { family: 'BUG-GETMISMATCH', title: 't', body: 'b', repo: REPO_A });
    await expect(client.getItem(ctx, REPO_UNRELATED, created.item.humanId)).rejects.toMatchObject({
      name: 'BacklogItemNotFoundError',
      foundInRepos: [REPO_A],
    });
  });

  it('getItem with the CORRECT repo is completely unaffected — resolves the real item, never throws', async () => {
    const created = await client.createItem(ctx, { family: 'BUG-GETCORRECT', title: 't', body: 'b', repo: REPO_A });
    const fetched = await client.getItem(ctx, REPO_A, created.item.humanId);
    expect(fetched).not.toBeNull();
    expect(fetched?.humanId).toBe(created.item.humanId);
  });
});

describe('write-time: soft repo-drift warning on createItem', () => {
  it('knownRepos is empty for a fresh store — the very FIRST item under any repo string never warns', async () => {
    expect((await knownRepos(tmp.store)).size).toBe(0);
    const result = await client.createItem(ctx, { family: 'BUG-FIRST', title: 't', body: 'b', repo: REPO_A });
    expect(result.created).toBe(true);
    expect(result.repoWarning).toBeUndefined();
  });

  it('a second item under the SAME already-known repo never warns', async () => {
    await client.createItem(ctx, { family: 'BUG-SAME1', title: 't1', body: 'b', repo: REPO_A });
    const second = await client.createItem(ctx, { family: 'BUG-SAME2', title: 't2', body: 'b', repo: REPO_A });
    expect(second.repoWarning).toBeUndefined();
  });

  it('a genuinely NEW repo value still succeeds (never hard-blocked) but carries a repoWarning naming the existing repo(s)', async () => {
    await client.createItem(ctx, { family: 'BUG-ORIG', title: 't', body: 'b', repo: REPO_A });
    const drifted = await client.createItem(ctx, { family: 'BUG-DRIFT', title: 'drifted', body: 'b', repo: REPO_UNRELATED });
    expect(drifted.created).toBe(true);
    expect(drifted.item.repo).toBe(REPO_UNRELATED);
    expect(drifted.repoWarning).toBeDefined();
    expect(drifted.repoWarning).toContain(REPO_A);
    expect(drifted.repoWarning).toContain(`'${REPO_UNRELATED}'`);
  });

  it('an unrelated, deliberately different repo also succeeds with a warning — the warning never blocks legitimate first-time use of a new repo', async () => {
    await client.createItem(ctx, { family: 'BUG-ORIG2', title: 't', body: 'b', repo: REPO_A });
    const result = await client.createItem(ctx, { family: 'BUG-NEWPROJ', title: 't', body: 'b', repo: REPO_UNRELATED });
    expect(result.created).toBe(true);
    expect(result.item.repo).toBe(REPO_UNRELATED);
    expect(result.repoWarning).toContain(REPO_A);
  });
});

describe('write-time: importFromMarkdown carries the same repoWarning, once per import (not per item)', () => {
  it('warns once when importing under a repo value not already known to the store', async () => {
    await client.createItem(ctx, { family: 'BUG-PREEXIST', title: 't', body: 'b', repo: REPO_A });

    const md = ['### BUG-IMPORTED-001 — an imported bug', '', 'Body text.', ''].join('\n');
    const path = `${tmp.dir}/import-test.md`;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, md, 'utf8');

    const result = await client.importFromMarkdown(ctx, { path, repo: REPO_B });
    expect(result.created).toBe(1);
    expect(result.repoWarning).toBeDefined();
    expect(result.repoWarning).toContain(REPO_A);
  });

  it('does not warn when importing under an already-known repo', async () => {
    await client.createItem(ctx, { family: 'BUG-PREEXIST2', title: 't', body: 'b', repo: REPO_A });

    const md = ['### BUG-IMPORTED2-001 — another imported bug', '', 'Body text.', ''].join('\n');
    const path = `${tmp.dir}/import-test2.md`;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, md, 'utf8');

    const result = await client.importFromMarkdown(ctx, { path, repo: REPO_A });
    expect(result.created).toBe(1);
    expect(result.repoWarning).toBeUndefined();
  });
});

describe('write-time: a case/whitespace-only variant of an EXISTING repo is now a hard reject, not a silent warning', () => {
  it('normalizeRepoKey trims and lowercases, nothing else', () => {
    expect(normalizeRepoKey('PseudoSky/adhd')).toBe('pseudosky/adhd');
    expect(normalizeRepoKey('  PseudoSky/adhd  ')).toBe('pseudosky/adhd');
    expect(normalizeRepoKey('adhd')).toBe('adhd'); // not equal to the above — different path, not a case variant
  });

  it('resolveCanonicalRepo: an exact known match returns itself, isNewRepo:false', async () => {
    await createItemNode(tmp.store, { family: 'BUG-EXACT', title: 't', body: 'b', repo: REPO_A });
    const resolved = await resolveCanonicalRepo(tmp.store, REPO_A);
    expect(resolved).toEqual({ canonical: REPO_A, isNewRepo: false });
  });

  it('resolveCanonicalRepo: a case/whitespace-only variant of a known repo resolves to the STORED canonical form', async () => {
    await createItemNode(tmp.store, { family: 'BUG-CANON', title: 't', body: 'b', repo: REPO_A });
    expect(await resolveCanonicalRepo(tmp.store, 'pseudosky/ADHD')).toEqual({ canonical: REPO_A, isNewRepo: false });
    expect(await resolveCanonicalRepo(tmp.store, `  ${REPO_A}  `)).toEqual({ canonical: REPO_A, isNewRepo: false });
  });

  it('resolveCanonicalRepo: a genuinely novel repo (not a case variant of anything known) is isNewRepo:true, canonical unchanged', async () => {
    await createItemNode(tmp.store, { family: 'BUG-NOVEL', title: 't', body: 'b', repo: REPO_A });
    expect(await resolveCanonicalRepo(tmp.store, REPO_UNRELATED)).toEqual({ canonical: REPO_UNRELATED, isNewRepo: true });
  });

  it('createItem HARD-REJECTS a case-variant of an already-known repo instead of silently writing under the new casing', async () => {
    await client.createItem(ctx, { family: 'BUG-GUARD1', title: 't', body: 'b', repo: REPO_A });
    await expect(client.createItem(ctx, { family: 'BUG-GUARD2', title: 't2', body: 'b', repo: 'pseudosky/ADHD' })).rejects.toMatchObject(
      { name: 'InvalidArgumentError', message: expect.stringContaining(`use '${REPO_A}' instead`) }
    );
    // Negative-control proof: without the fix (comparing exact strings only,
    // as the pre-fix code did), the line above would NOT throw — it would
    // silently create a second, permanently disjoint 'pseudosky/ADHD' scope,
    // exactly reproducing the real PseudoSky/adhd-vs-adhd split found live.
  });

  it('createItem still succeeds for the EXACT known casing after the guard was added — no regression on the hot path', async () => {
    await client.createItem(ctx, { family: 'BUG-EXACT1', title: 't', body: 'b', repo: REPO_A });
    const second = await client.createItem(ctx, { family: 'BUG-EXACT2', title: 't2', body: 'b', repo: REPO_A });
    expect(second.created).toBe(true);
    expect(second.repoWarning).toBeUndefined();
  });

  it('createItem still succeeds for a genuinely NEW repo after the guard was added — never blocks first-time use', async () => {
    await client.createItem(ctx, { family: 'BUG-STILLNEW1', title: 't', body: 'b', repo: REPO_A });
    const result = await client.createItem(ctx, { family: 'BUG-STILLNEW2', title: 't', body: 'b', repo: REPO_UNRELATED });
    expect(result.created).toBe(true);
    expect(result.repoWarning).toContain(REPO_A);
  });
});

describe('read-time: get/query resolve a case/whitespace-variant repo to the canonical stored scope instead of matching zero rows', () => {
  it('findItemNode resolves a case-variant repo argument to the item filed under the canonical casing', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-READCANON', title: 't', body: 'b', repo: REPO_A });
    const node = await findItemNode(tmp.store, 'pseudosky/ADHD', created.item.humanId);
    expect(node).not.toBeNull();
    expect(node?.namespace).toBe(REPO_A);
  });

  it('getItem (client layer) resolves a case-variant repo the same way', async () => {
    const created = await client.createItem(ctx, { family: 'BUG-READCANON2', title: 't', body: 'b', repo: REPO_A });
    const fetched = await client.getItem(ctx, ' PseudoSky/Adhd ', created.item.humanId);
    expect(fetched).not.toBeNull();
    expect(fetched?.humanId).toBe(created.item.humanId);
  });
});
