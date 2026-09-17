/**
 * filter-plan-project-path.spec.ts — `filter.plan` and `filter.projectPath`
 * on `queryIssues` (`view:'list'`), real store throughout.
 *
 * These two `IIssueFilter` (query/types.ts) keys were reachable end-to-end
 * from `backlog search`/`query --input` in name only: the flags compiled a
 * `filter.plan`/`filter.projectPath` key that `IIssueFilter` never declared,
 * so the apigen-derived schema rejected the request with `invalid_argument
 * ... additionalProperty: "plan"` (resp. `"projectPath"`) before `queryIssues`
 * ever ran — see `search-shortcut-wire.spec.ts` for the wire-level proof of
 * that mount-layer defect and its fix. This file proves the FILTER SEMANTICS
 * now that the key is declared and wired: `plan` resolves via the `part_of`
 * edge into a parent `issue` (a plan is itself an issue, SPEC.md §1052), and
 * `projectPath` resolves via an exact match on `component.meta.path`.
 *
 * Real components throughout: a real store via `openTestIssueStore`/
 * `seedProject`, real `createIssue`/`relate`/`upsertComponent` writes,
 * `queryIssues` driven exactly as `api.ts`'s mounted `query` verb drives it.
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
import { relate } from '../write/relate.js';
import { upsertComponent } from '../write/catalog.js';
import { queryIssues } from './query.js';

describe('queryIssues — filter.plan (real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('query-filter-plan');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'filter-plan-project')).projectUid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  async function mkIssue(title: string, kind?: string): Promise<string> {
    const created = await createIssue(store, {
      project: projectUid,
      title,
      body: `${title} body`,
      by: 'filer',
      ...(kind ? { kind } : {}),
    });
    return created.uid;
  }

  it('resolves candidates via the part_of edge into the named plan, excluding non-members', async () => {
    const planUid = await mkIssue('Q3 rollout plan', 'plan');
    const memberA = await mkIssue('member a');
    const memberB = await mkIssue('member b');
    const outsider = await mkIssue('unrelated issue');

    await relate(store, {
      sourceUid: memberA,
      targetUid: planUid,
      rel: 'part_of',
      action: 'add',
      by: 'filer',
    });
    await relate(store, {
      sourceUid: memberB,
      targetUid: planUid,
      rel: 'part_of',
      action: 'add',
      by: 'filer',
    });

    const result = await queryIssues(store, {
      view: 'list',
      filter: { plan: planUid },
    });
    if (result.view !== 'list')
      throw new Error(`expected view 'list', got '${result.view}'`);

    const uids = result.items.map((i) => i.uid);
    expect(new Set(uids)).toEqual(new Set([memberA, memberB]));
    expect(uids).not.toContain(outsider);
    expect(uids).not.toContain(planUid);
  });

  it('an unresolved plan reference resolves to zero matches, not an error (§6.1 read-path rule)', async () => {
    await mkIssue('some issue');
    const result = await queryIssues(store, {
      view: 'list',
      filter: { plan: 'no-such-plan-title' },
    });
    if (result.view !== 'list')
      throw new Error(`expected view 'list', got '${result.view}'`);
    expect(result.items).toEqual([]);
  });

  it('NEGATIVE CONTROL: without the part_of edge, the member is not returned', async () => {
    const planUid = await mkIssue('plan with no members', 'plan');
    await mkIssue('never attached');

    const result = await queryIssues(store, {
      view: 'list',
      filter: { plan: planUid },
    });
    if (result.view !== 'list')
      throw new Error(`expected view 'list', got '${result.view}'`);
    expect(result.items).toEqual([]);
  });
});

describe('queryIssues — filter.projectPath (real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('query-filter-project-path');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'filter-path-project')).projectUid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('resolves candidates by an EXACT match on component.meta.path, excluding sibling components', async () => {
    const target = await upsertComponent(store, {
      project: projectUid,
      name: 'apigen-core-client',
      path: 'packages/apigen/apigen-core-client',
      by: 'filer',
    });
    const sibling = await upsertComponent(store, {
      project: projectUid,
      name: 'apigen-engine-runtime',
      path: 'packages/apigen/apigen-engine-runtime',
      by: 'filer',
    });

    const inTarget = await createIssue(store, {
      project: projectUid,
      component: target.uid,
      title: 'in target',
      body: 'b',
      by: 'filer',
    });
    const inSibling = await createIssue(store, {
      project: projectUid,
      component: sibling.uid,
      title: 'in sibling',
      body: 'b',
      by: 'filer',
    });

    const result = await queryIssues(store, {
      view: 'list',
      filter: { projectPath: 'packages/apigen/apigen-core-client' },
    });
    if (result.view !== 'list')
      throw new Error(`expected view 'list', got '${result.view}'`);

    const uids = result.items.map((i) => i.uid);
    expect(uids).toEqual([inTarget.uid]);
    expect(uids).not.toContain(inSibling.uid);
  });

  it('an unresolved path resolves to zero matches, not an error (§6.1 read-path rule)', async () => {
    await createIssue(store, {
      project: projectUid,
      title: 'any issue',
      body: 'b',
      by: 'filer',
    });
    const result = await queryIssues(store, {
      view: 'list',
      filter: { projectPath: 'packages/nonexistent/nowhere' },
    });
    if (result.view !== 'list')
      throw new Error(`expected view 'list', got '${result.view}'`);
    expect(result.items).toEqual([]);
  });

  it('NEGATIVE CONTROL: a path that does not match the seeded component returns nothing, proving the match is real', async () => {
    const component = await upsertComponent(store, {
      project: projectUid,
      name: 'only-component',
      path: 'packages/only/component',
      by: 'filer',
    });
    await createIssue(store, {
      project: projectUid,
      component: component.uid,
      title: 'in only component',
      body: 'b',
      by: 'filer',
    });

    const result = await queryIssues(store, {
      view: 'list',
      filter: { projectPath: 'packages/only/component-typo' },
    });
    if (result.view !== 'list')
      throw new Error(`expected view 'list', got '${result.view}'`);
    expect(result.items).toEqual([]);
  });
});
