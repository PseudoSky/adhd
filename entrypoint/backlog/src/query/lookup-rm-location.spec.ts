/**
 * lookup-rm-location.spec.ts — closes SPEC.md §8 AC-21: "`rmLocation(uid)`
 * invalidates the location; a subsequent `lookup` on that `(locType,value)`
 * no longer resolves it; the location's own record remains addressable by
 * uid."
 *
 * `catalog-verbs.spec.ts` already proves `rmLocation`'s invalidation
 * mechanics (row `t_invalid` stamped, owning `has_location` edge
 * invalidated, one `deleted` audit row, remains addressable by uid). What no
 * existing spec composes is the real `rmLocation` write with a real
 * `lookup(graph, value)` read — the exact pairing AC-21 names. This file
 * composes two already-tested verbs (`upsertLocation`/`rmLocation` from
 * `write/catalog.ts`, `lookup` from `query/views/registry.ts`) against a
 * real store, real components throughout, never mocks.
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
import {
  upsertComponent,
  upsertLocation,
  rmLocation,
} from '../write/catalog.js';
import { CatalogNotFoundError } from '../write/errors.js';
import { lookup } from './views/registry.js';

describe('lookup + rmLocation composition (SPEC.md §8 AC-21, real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;
  let componentUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('lookup-rm-location-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    const seeded = await seedProject(store, 'lookup-rm-location-project');
    projectUid = seeded.projectUid;
    const component = await upsertComponent(store, {
      project: projectUid,
      name: 'lookup-rm-location-component',
      by: 'filer',
    });
    componentUid = component.uid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('AC-21: rmLocation invalidates the location; lookup on the same (locType,value) no longer resolves; the row stays addressable by uid', async () => {
    // "mytool" has no '/', '.', or leading '~' — `classifyLookupQuery` in
    // `registry.ts` reads it as locType 'tool', matching the locType this
    // upsert writes, so `lookup` and `upsertLocation` genuinely agree on
    // classification rather than accidentally colliding.
    const value = 'mytool';
    const created = await upsertLocation(store, {
      component: componentUid,
      locType: 'tool',
      value,
      by: 'filer',
    });

    // Real `lookup` resolves the live location, walking location -> component -> project.
    const found = await lookup(store.graph, value);
    expect(found.location.uid).toBe(created.uid);
    expect(found.component.uid).toBe(componentUid);
    expect(found.project.uid).toBe(projectUid);

    await rmLocation(store, {
      uid: created.uid,
      by: 'remover',
      reason: 'no longer maintained',
    });

    // The IDENTICAL lookup call now resolves nothing — `lookup` throws
    // CatalogNotFoundError('location', ...) on a miss (registry.ts's own
    // documented "never a silent null" contract), never an empty/undefined
    // result.
    await expect(lookup(store.graph, value)).rejects.toThrow(
      CatalogNotFoundError
    );

    // The location's own record remains addressable by uid — a soft
    // invalidate, never a hard row deletion.
    const rawLocation = await store.graph.getNodeByUid(created.uid);
    expect(rawLocation).not.toBeNull();
    expect(rawLocation?.tInvalid).toBeDefined();
    expect(rawLocation?.tInvalid).not.toBeNull();
  });
});
