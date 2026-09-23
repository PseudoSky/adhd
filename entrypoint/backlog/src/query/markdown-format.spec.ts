/**
 * markdown-format.spec.ts — `query`'s `format:'markdown'` (SPEC.md §6.5/§6.6,
 * DATA_MODEL.md §8). Drives the real `queryIssuesWithMeta`/`queryIssues`
 * against a real store (`openTestIssueStore`/`seedProject`/`createIssue`) —
 * proves the wire-level behaviour a CLI/MCP/HTTP caller actually sees, not
 * `renderIssueCardsMarkdown` in isolation.
 *
 * Negative-control-proven (BUG-BACKLOG-QUERY-MARKDOWN-UNIMPLEMENTED-001):
 * before this fix, `format:'markdown'` on ANY view unconditionally threw
 * `InvalidArgumentError('format', '"markdown" rendering is not implemented
 * in this slice...')` — schema-valid (ajv accepted it) but functionally
 * dead. Reverting `query.ts`'s markdown branch back to that throw turns
 * every assertion below red (verified by hand during this fix).
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
import { createIssue } from '../write/create-issue.js';
import { InvalidArgumentError } from '../write/errors.js';
import { queryIssues, queryIssuesWithMeta } from './query.js';

describe('query — format:"markdown" (real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('query-markdown');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'markdown-project')).projectUid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('view:"list" (default) renders each issue as a "## <title>" header, never the uid, with meta and body', async () => {
    const created = await createIssue(store, {
      project: projectUid,
      title: 'Fix the flaky retry loop',
      body: 'The retry loop double-fires under load.',
      by: 'filer',
    });

    const result = await queryIssues(store, {
      filter: { project: projectUid },
      fields: ['uid', 'title', 'kind', 'status', 'priority', 'body'],
      format: 'markdown',
    });

    if (result.view !== 'list' || result.format !== 'markdown') {
      throw new Error(`expected markdown list result, got ${JSON.stringify(result)}`);
    }
    expect(result.markdown).toContain('## Fix the flaky retry loop');
    expect(result.markdown).toContain('The retry loop double-fires under load.');
    expect(result.markdown).toContain('kind: issue');
    // DATA_MODEL.md §8: "uids are not rendered inline."
    expect(result.markdown).not.toContain(created.uid);
  });

  it('an item created with a `gitContext` renders it ONCE at the head of its `Citations:` block; an item created without one renders NO block (no regression)', async () => {
    await createIssue(store, {
      project: projectUid,
      title: 'disclosed item',
      body: 'body',
      gitContext: 'feat/backlog-hard-replacement @ 4bf902fc',
      citations: [{ file: 'src/x.ts', lines: '1-2' }],
      by: 'filer',
    });
    await createIssue(store, {
      project: projectUid,
      title: 'plain item',
      body: 'body',
      by: 'filer',
    });

    const result = await queryIssues(store, {
      filter: { project: projectUid },
      fields: ['uid', 'title', 'citations', 'gitContext'],
      format: 'markdown',
    });
    if (result.view !== 'list' || result.format !== 'markdown') {
      throw new Error(`expected markdown list result, got ${JSON.stringify(result)}`);
    }

    // Split into per-card sections (`## <title>` at line start) so the
    // assertion is independent of the page's item order.
    const sections = result.markdown.split(/^## /m);
    const disclosedSection = sections.find((s) => s.startsWith('disclosed item'));
    const plainSection = sections.find((s) => s.startsWith('plain item'));
    if (disclosedSection === undefined || plainSection === undefined) {
      throw new Error(
        `setup: expected both card sections, got ${JSON.stringify(sections)}`
      );
    }

    // The disclosed item's block leads with the git context, exactly ONCE,
    // followed by the citation line.
    expect(disclosedSection).toContain(
      'Citations: [feat/backlog-hard-replacement @ 4bf902fc]'
    );
    expect(
      disclosedSection.match(/feat\/backlog-hard-replacement @ 4bf902fc/g)
    ).toHaveLength(1);
    expect(disclosedSection).toContain('[src/x.ts:1-2 sha:unverified]');

    // The plain item has neither a git context nor citations — no block at all.
    expect(plainSection).not.toContain('Citations');
  });

  it('meta (total/returned/limit) is still reported for a markdown-formatted view:"list" call — only `result` changes shape, never `meta`', async () => {
    await createIssue(store, {
      project: projectUid,
      title: 'One issue',
      body: 'body',
      by: 'filer',
    });

    const { meta } = await queryIssuesWithMeta(store, {
      filter: { project: projectUid },
      format: 'markdown',
    });
    expect(meta).toEqual({ total: 1, returned: 1, limit: 50 });
  });

  it('an empty result set renders a stated "no matching issues" line, never a blank string', async () => {
    const emptyProjectUid = (await seedProject(store, 'markdown-empty-project'))
      .projectUid;
    const result = await queryIssues(store, {
      filter: { project: emptyProjectUid },
      format: 'markdown',
    });
    if (result.view !== 'list' || result.format !== 'markdown') {
      throw new Error(`expected markdown list result, got ${JSON.stringify(result)}`);
    }
    expect(result.markdown.trim().length).toBeGreaterThan(0);
    expect(result.markdown).toContain('No matching issues');
  });

  for (const view of ['ready', 'stale', 'similar'] as const) {
    it(`view:"${view}" also supports format:"markdown" (every item-list view, not just the default)`, async () => {
      const created = await createIssue(store, {
        project: projectUid,
        title: `${view} candidate`,
        body: 'body',
        by: 'filer',
      });

      if (view === 'stale') {
        // `view:'stale'` needs an actively-claimed issue whose `claimedAt` is
        // older than `staleAfterMin` — a negative `staleAfterMin` pushes the
        // threshold into the future, so a claim made THIS instant is already
        // "older than" it, without any real clock wait.
        const { claim } = await import('../write/claim.js');
        await claim(store, { uid: created.uid, by: 'filer', action: 'claim' });
      }

      let input: {
        view: typeof view;
        filter: { project: string; semantic?: string };
        staleAfterMin?: number;
        format: 'markdown';
      };
      if (view === 'similar') {
        input = {
          view,
          filter: { project: projectUid, semantic: 'candidate' },
          format: 'markdown',
        };
      } else if (view === 'stale') {
        input = {
          view,
          filter: { project: projectUid },
          staleAfterMin: -60,
          format: 'markdown',
        };
      } else {
        input = { view, filter: { project: projectUid }, format: 'markdown' };
      }

      // `similar` needs a configured search backend — this store has none
      // (RAG-SPEC.md's opt-in embedding stack is not enabled in this test),
      // so it throws for an UNRELATED reason (no search backend), not the
      // markdown path. Assert that distinction explicitly rather than
      // silently skipping.
      if (view === 'similar') {
        await expect(queryIssues(store, input)).rejects.toThrow(
          /semantic search is not configured/
        );
        return;
      }

      const result = await queryIssues(store, input);
      if (!('format' in result) || result.format !== 'markdown') {
        throw new Error(`expected markdown result for view:${view}, got ${JSON.stringify(result)}`);
      }
      expect(result.view).toBe(view);
      expect(result.markdown).toContain(`## ${view} candidate`);
    });
  }

  for (const view of ['graph', 'order', 'projects', 'components', 'locations'] as const) {
    it(`view:"${view}" rejects format:"markdown" — no item-list shape to render`, async () => {
      await expect(
        queryIssues(store, { view, format: 'markdown' })
      ).rejects.toThrow(InvalidArgumentError);
    });
  }

  it('view:"overlap" rejects format:"markdown" too (its own required overlapAxis/overlapUids error never masks the format rejection ordering — format is checked AFTER the view runs, so a caller must satisfy overlap\'s own required params first)', async () => {
    await expect(
      queryIssues(store, {
        view: 'overlap',
        format: 'markdown',
        overlapAxis: 'project',
        overlapUids: ['nonexistent-a', 'nonexistent-b'],
      })
    ).rejects.toThrow(InvalidArgumentError);
  });
});
