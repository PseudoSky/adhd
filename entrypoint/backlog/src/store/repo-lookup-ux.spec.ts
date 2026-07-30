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
import * as client from '../client.js';
import type { BacklogCtx } from '../client.js';
import { buildBacklogEnv } from '../env.js';
import { BacklogItemNotFoundError } from '../model.js';
import { createItemNode } from './crud.js';
import { buildNotFoundError, findHumanIdInAnyRepo, knownRepos } from './query.js';

const REPO_A = 'PseudoSky/adhd';
const REPO_B = 'adhd';
const REPO_UNRELATED = 'some/other-project';

let tmp: TmpStore;
let ctx: BacklogCtx;

beforeEach(() => {
  tmp = openTmpStore('repo-lookup-ux-spec');
  ctx = { store: tmp.store, env: buildBacklogEnv({ scope: 'project', adhdRoot: tmp.dir }) };
});

afterEach(() => {
  tmp.cleanup();
});

describe('read-time: helpful hint on a repo/humanId mismatch', () => {
  it('findHumanIdInAnyRepo finds a live node under a DIFFERENT repo string', () => {
    const created = createItemNode(tmp.store, { family: 'BUG-X', title: 't', body: 'b', repo: REPO_A });
    const hits = findHumanIdInAnyRepo(tmp.store, created.item.humanId);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.namespace).toBe(REPO_A);
  });

  it('buildNotFoundError names the actual repo the humanId lives under', () => {
    const created = createItemNode(tmp.store, { family: 'BUG-X', title: 't', body: 'b', repo: REPO_A });
    const err = buildNotFoundError(tmp.store, REPO_B, created.item.humanId);
    expect(err).toBeInstanceOf(BacklogItemNotFoundError);
    expect(err.foundInRepos).toEqual([REPO_A]);
    expect(err.message).toContain(`did you mean repo '${REPO_A}'`);
  });

  it('buildNotFoundError names NOTHING for a genuinely nonexistent humanId (no false hint)', () => {
    const err = buildNotFoundError(tmp.store, REPO_A, 'BUG-NOPE-999');
    expect(err.foundInRepos).toEqual([]);
    expect(err.message).not.toContain('did you mean');
    expect(err.message).toBe(`backlog item not found: ${REPO_A}::BUG-NOPE-999`);
  });

  it('appendNote throws the enriched hint when called with the WRONG repo for a real item (the exact bug-report scenario)', async () => {
    const created = await client.createItem(ctx, { family: 'BUG-MISMATCH', title: 't', body: 'b', repo: REPO_A });
    await expect(client.appendNote(ctx, REPO_B, created.item.humanId, 'agent-x', 'a note')).rejects.toMatchObject({
      name: 'BacklogItemNotFoundError',
      foundInRepos: [REPO_A],
    });
    await expect(client.appendNote(ctx, REPO_B, created.item.humanId, 'agent-x', 'a note')).rejects.toThrow(
      `did you mean repo '${REPO_A}'`
    );
  });

  it('appendNote with the CORRECT repo is completely unaffected — succeeds exactly as before', async () => {
    const created = await client.createItem(ctx, { family: 'BUG-CORRECT', title: 't', body: 'b', repo: REPO_A });
    const updated = await client.appendNote(ctx, REPO_A, created.item.humanId, 'agent-x', 'a real note');
    expect(updated.notes.at(-1)?.text).toBe('a real note');
  });

  it('getItem: a genuine miss (humanId does not exist under ANY repo) still returns null — unchanged', async () => {
    const result = await client.getItem(ctx, REPO_A, 'BUG-TOTALLY-MISSING-001');
    expect(result).toBeNull();
  });

  it('getItem: a repo/humanId mismatch now THROWS the enriched hint instead of silently returning null', async () => {
    const created = await client.createItem(ctx, { family: 'BUG-GETMISMATCH', title: 't', body: 'b', repo: REPO_A });
    await expect(client.getItem(ctx, REPO_B, created.item.humanId)).rejects.toMatchObject({
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
    expect(knownRepos(tmp.store).size).toBe(0);
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
    const drifted = await client.createItem(ctx, { family: 'BUG-DRIFT', title: 'drifted', body: 'b', repo: REPO_B });
    expect(drifted.created).toBe(true);
    expect(drifted.item.repo).toBe(REPO_B);
    expect(drifted.repoWarning).toBeDefined();
    expect(drifted.repoWarning).toContain(REPO_A);
    expect(drifted.repoWarning).toContain(`'${REPO_B}'`);
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
