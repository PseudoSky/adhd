/**
 * views/registry.e2e.ts — §3a's registry read surface (`listProjects`/
 * `listComponents`/`listLocations`/`getRegistryDetail`/`lookup`), driven
 * against a REAL store (`@adhd/sox-store-adapter` + `@adhd/sox-graph-store`,
 * never a mock) via `openTestIssueStore` (this package's own `write/tx.ts`
 * write-layer test harness — see that file's doc comment for why it does
 * NOT go through the doomed `store/graph-backlog-store.ts`).
 *
 * **Seeding.** `upsertProject`/`upsertComponent`/`upsertLocation` (SPEC.md
 * §3a's own registry CRUD) are not yet built — confirmed by grep, and by
 * `open-test-issue-store.ts`'s own doc comment on `seedProject`. So this
 * file seeds registry rows the same way that harness's `seedProject` already
 * does: hand-composed `writeNodeTx`/`writeEdgeTx` inside
 * `executeWriteTransaction` (the ONE frozen transaction wrapper, §4c) —
 * never a bespoke insert, never a second transaction-mode path. Critically,
 * every fixture writes BOTH representations `views/registry.ts` reads from:
 * the `owns_project`/`has_location` EDGES (`getRegistryDetail`'s traversal)
 * and the `projectUid`/`componentUid` METADATA fields (`lookup`'s chase and
 * `listComponents`/`listLocations`' scoping filters) — exactly the dual
 * shape `seedProject` already established for `component.metadata.projectUid`
 * alongside its `owns_project` edge, and the only shape a real
 * `upsertComponent`/`upsertLocation` verb could produce without breaking one
 * of the two independent read paths already built against `component`/
 * `project` (SPEC.md §3a: node payload fields `projectUid`/`componentUid`
 * ARE the specified shape, not an implementation accident).
 *
 * **Node-invalidation gap (disclosed, not fixed here).** `write/tx.ts`'s
 * frozen contract exports `invalidateEdgeTx` but no node-level equivalent —
 * there is no frozen way to soft-delete a `location`/`component`/`project`
 * row (the future `rmLocation` verb, §3a, has nothing to call). Every test
 * in this file that exercises a `tInvalid` rejection or chain-integrity
 * branch therefore flips `node.t_invalid` directly via `adapter.executeRun`
 * raw SQL — a test-fixture-only stand-in for that not-yet-built verb, never
 * a pattern this file's own production code uses.
 *
 * **Chain-integrity coverage.** `views/registry.ts`'s primary lookups
 * (`tryResolveRef`, the location branch's own `getNodeByUid`) already reject
 * a tombstoned target. The SECONDARY chases one hop further — a component's
 * owning project, a project's owned components/locations, a location's
 * owning component/project, `lookup`'s component/project walk — must reject
 * one too: an edge (`owns_project`/`has_location`) can outlive its
 * endpoint's own invalidation (nothing here invalidates edges), so without
 * an explicit check a tombstoned row leaks into a LIVE ancestor's detail as
 * though it were live data. The tests below prove each secondary chase
 * degrades a tombstoned endpoint the same way it already degrades a
 * missing one (empty `{name:'',...}` fields for `getRegistryDetail`,
 * `CatalogNotFoundError`/the data-integrity `hint` for `lookup` — never
 * surfacing the tombstoned row's own data).
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  type TestIssueStore,
} from '../../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../../test/helpers/tmp-store.js';
import {
  executeWriteTransaction,
  nowISO,
  writeEdgeTx,
  writeNodeTx,
  type IWriteStoreHandle,
} from '../../write/tx.js';
import { resolveEdgeKindTx } from '../../write/catalog.js';
import {
  CatalogNotFoundError,
  InvalidArgumentError,
} from '../../write/errors.js';
import {
  getRegistryDetail,
  listComponents,
  listLocations,
  listProjects,
  lookup,
} from './registry.js';

interface Fixture {
  projectA: string;
  projectB: string;
  componentRootA: string;
  componentBacklog: string;
  componentRootB: string;
  componentMemoryServer: string;
  locToolBacklog: string;
  locPathBacklog: string;
  locUrlBacklog: string;
  locToolMemory: string;
}

/**
 * Seeds two projects (`adhd`, multi-component + multi-locType locations;
 * `sox-ecosystem`, a single tool location) — every `project`/`component`
 * writes its reserved `(root)` component analogous to `seedProject`, plus
 * one extra "real" component each, so filtering/scoping tests have more
 * than the trivial one-component case to narrow against.
 */
async function seedFixture(
  handle: Pick<IWriteStoreHandle, 'adapter' | 'typePolicy'>
): Promise<Fixture> {
  return executeWriteTransaction(handle, async (tx) => {
    const now = nowISO();
    const ownsProjectRule = await resolveEdgeKindTx(tx, 'owns_project');
    const hasLocationRule = await resolveEdgeKindTx(tx, 'has_location');

    async function project(name: string, metadata: Record<string, unknown>) {
      return writeNodeTx(tx, { kind: 'project', name, metadata, at: now });
    }
    async function component(
      name: string,
      projectUid: string,
      metadata: Record<string, unknown> = {}
    ) {
      return writeNodeTx(tx, {
        kind: 'component',
        name,
        metadata: { projectUid, ...metadata },
        at: now,
      });
    }
    async function location(
      locType: string,
      value: string,
      componentUid: string
    ) {
      return writeNodeTx(tx, {
        kind: 'location',
        name: value,
        metadata: { locType, value, componentUid },
        at: now,
      });
    }
    async function ownsProject(
      p: { rowid: number; uid: string },
      c: { rowid: number; uid: string }
    ) {
      await writeEdgeTx(tx, {
        at: now,
        rule: ownsProjectRule,
        typePolicy: handle.typePolicy,
        rel: 'owns_project',
        srcRowid: p.rowid,
        srcUid: p.uid,
        srcKind: 'project',
        dstRowid: c.rowid,
        dstUid: c.uid,
        dstKind: 'component',
      });
    }
    async function hasLocation(
      c: { rowid: number; uid: string },
      l: { rowid: number; uid: string }
    ) {
      await writeEdgeTx(tx, {
        at: now,
        rule: hasLocationRule,
        typePolicy: handle.typePolicy,
        rel: 'has_location',
        srcRowid: c.rowid,
        srcUid: c.uid,
        srcKind: 'component',
        dstRowid: l.rowid,
        dstUid: l.uid,
        dstKind: 'location',
      });
    }

    const projectA = await project('adhd', {
      path: '/repo/adhd',
      repoUrl: 'git@github.com:acme/adhd.git',
      monorepo: true,
      description: 'the monorepo',
    });
    const componentRootA = await component('(root)', projectA.uid, {
      path: '.',
    });
    await ownsProject(projectA, componentRootA);
    const componentBacklog = await component('backlog', projectA.uid, {
      path: 'entrypoint/backlog',
      description: 'backlog cli',
    });
    await ownsProject(projectA, componentBacklog);

    const locToolBacklog = await location(
      'tool',
      'adhd-backlog',
      componentBacklog.uid
    );
    await hasLocation(componentBacklog, locToolBacklog);
    const locPathBacklog = await location(
      'path',
      '/repo/adhd/entrypoint/backlog/src/index.ts',
      componentBacklog.uid
    );
    await hasLocation(componentBacklog, locPathBacklog);
    const locUrlBacklog = await location(
      'url',
      'https://github.com/acme/adhd/blob/main/entrypoint/backlog',
      componentBacklog.uid
    );
    await hasLocation(componentBacklog, locUrlBacklog);

    const projectB = await project('sox-ecosystem', {
      path: '/repo/sox-ecosystem',
      repoUrl: 'git@github.com:acme/sox-ecosystem.git',
    });
    const componentRootB = await component('(root)', projectB.uid, {
      path: '.',
    });
    await ownsProject(projectB, componentRootB);
    const componentMemoryServer = await component(
      'memory-server',
      projectB.uid,
      {
        path: 'extensions/bundles/sox-memory-bundle/members/memory-server',
      }
    );
    await ownsProject(projectB, componentMemoryServer);
    const locToolMemory = await location(
      'tool',
      'memory_ping',
      componentMemoryServer.uid
    );
    await hasLocation(componentMemoryServer, locToolMemory);

    return {
      projectA: projectA.uid,
      projectB: projectB.uid,
      componentRootA: componentRootA.uid,
      componentBacklog: componentBacklog.uid,
      componentRootB: componentRootB.uid,
      componentMemoryServer: componentMemoryServer.uid,
      locToolBacklog: locToolBacklog.uid,
      locPathBacklog: locPathBacklog.uid,
      locUrlBacklog: locUrlBacklog.uid,
      locToolMemory: locToolMemory.uid,
    };
  });
}

describe('registry views + lookup (SPEC.md §3a)', () => {
  let dir: string;
  let store: TestIssueStore;
  let fx: Fixture;

  beforeEach(async () => {
    dir = freshTmpDir('registry-views');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    fx = await seedFixture(store);
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  describe('listProjects', () => {
    it('lists every live project, unfiltered', async () => {
      const projects = await listProjects(store.graph);
      expect(projects.map((p) => p.name).sort()).toEqual([
        'adhd',
        'sox-ecosystem',
      ]);
      const adhd = projects.find((p) => p.uid === fx.projectA)!;
      expect(adhd).toMatchObject({
        name: 'adhd',
        path: '/repo/adhd',
        repoUrl: 'git@github.com:acme/adhd.git',
        monorepo: true,
        description: 'the monorepo',
      });
    });

    it('narrows by filter.project (name)', async () => {
      const projects = await listProjects(store.graph, { project: 'adhd' });
      expect(projects).toHaveLength(1);
      expect(projects[0].uid).toBe(fx.projectA);
    });

    it('narrows by filter.project (uid)', async () => {
      const projects = await listProjects(store.graph, {
        project: fx.projectB,
      });
      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe('sox-ecosystem');
    });

    it('returns [] for an unresolved project ref — never an error on a read path (§6.1)', async () => {
      const projects = await listProjects(store.graph, {
        project: 'does-not-exist',
      });
      expect(projects).toEqual([]);
    });
  });

  describe('listComponents', () => {
    it('lists every live component, unfiltered', async () => {
      const components = await listComponents(store.graph);
      expect(components.map((c) => c.name).sort()).toEqual([
        '(root)',
        '(root)',
        'backlog',
        'memory-server',
      ]);
    });

    it('narrows by filter.project', async () => {
      const components = await listComponents(store.graph, {
        project: fx.projectA,
      });
      expect(components.map((c) => c.name).sort()).toEqual([
        '(root)',
        'backlog',
      ]);
      expect(components.every((c) => c.projectUid === fx.projectA)).toBe(true);
    });

    it('returns [] for an unresolved project ref', async () => {
      const components = await listComponents(store.graph, {
        project: 'does-not-exist',
      });
      expect(components).toEqual([]);
    });
  });

  describe('listLocations', () => {
    it('lists every live location, unfiltered', async () => {
      const locations = await listLocations(store.graph);
      expect(locations).toHaveLength(4);
    });

    it('narrows by filter.component (name)', async () => {
      const locations = await listLocations(store.graph, {
        component: 'backlog',
      });
      expect(locations.map((l) => l.locType).sort()).toEqual([
        'path',
        'tool',
        'url',
      ]);
      expect(
        locations.every((l) => l.componentUid === fx.componentBacklog)
      ).toBe(true);
    });

    it('scopes by filter.project + filter.component together', async () => {
      const locations = await listLocations(store.graph, {
        project: fx.projectA,
        component: 'backlog',
      });
      expect(locations).toHaveLength(3);
    });

    it('a project+component scope that does not resolve (wrong project) returns []', async () => {
      // 'backlog' only exists under projectA — scoping it under projectB must not match.
      const locations = await listLocations(store.graph, {
        project: fx.projectB,
        component: 'backlog',
      });
      expect(locations).toEqual([]);
    });

    it('returns [] for an unresolved component ref', async () => {
      const locations = await listLocations(store.graph, {
        component: 'does-not-exist',
      });
      expect(locations).toEqual([]);
    });
  });

  describe('getRegistryDetail', () => {
    it('project detail includes its components and their locations', async () => {
      const detail = await getRegistryDetail(store.graph, {
        registry: 'project',
        name: 'adhd',
      });
      expect(detail.name).toBe('adhd');
      expect(detail.components.map((c) => c.name).sort()).toEqual([
        '(root)',
        'backlog',
      ]);
      expect(detail.locations.map((l) => l.value).sort()).toEqual([
        '/repo/adhd/entrypoint/backlog/src/index.ts',
        'adhd-backlog',
        'https://github.com/acme/adhd/blob/main/entrypoint/backlog',
      ]);
    });

    it('component detail includes its owning project and its locations', async () => {
      const detail = await getRegistryDetail(store.graph, {
        registry: 'component',
        name: 'backlog',
      });
      expect(detail.name).toBe('backlog');
      expect(detail.project.name).toBe('adhd');
      expect(detail.locations).toHaveLength(3);
    });

    it('location detail includes its component and project (resolved by uid — no independent name)', async () => {
      const detail = await getRegistryDetail(store.graph, {
        registry: 'location',
        name: fx.locToolBacklog,
      });
      expect(detail.value).toBe('adhd-backlog');
      expect(detail.component.name).toBe('backlog');
      expect(detail.project.name).toBe('adhd');
    });

    it('throws CatalogNotFoundError for an unresolved project name', async () => {
      await expect(
        getRegistryDetail(store.graph, {
          registry: 'project',
          name: 'does-not-exist',
        })
      ).rejects.toThrow(CatalogNotFoundError);
    });

    it('throws CatalogNotFoundError for an unresolved component name', async () => {
      await expect(
        getRegistryDetail(store.graph, {
          registry: 'component',
          name: 'does-not-exist',
        })
      ).rejects.toThrow(CatalogNotFoundError);
    });

    it('throws InvalidArgumentError for a non-uid location name (a location has no name)', async () => {
      await expect(
        getRegistryDetail(store.graph, {
          registry: 'location',
          name: 'not-a-uid',
        })
      ).rejects.toThrow(InvalidArgumentError);
    });

    it('throws CatalogNotFoundError for an invalidated (soft-deleted) location', async () => {
      // No frozen node-invalidation primitive exists yet (only `invalidateEdgeTx`,
      // `write/tx.ts` CONTRACT) — flip `t_invalid` directly as a test-only stand-in
      // for the not-yet-built `rmLocation` verb (see this file's own header).
      await store.adapter.executeRun(
        'UPDATE node SET t_invalid = ? WHERE uid = ?',
        [nowISO(), fx.locPathBacklog]
      );
      await expect(
        getRegistryDetail(store.graph, {
          registry: 'location',
          name: fx.locPathBacklog,
        })
      ).rejects.toThrow(CatalogNotFoundError);
    });

    // The four tests below prove the chain-integrity fix: a tombstoned
    // location/component/project row must never leak into a LIVE ancestor's
    // detail via a secondary (non-primary) chase — the `has_location`/
    // `owns_project` EDGE stays live (nothing here invalidates it), only the
    // endpoint NODE does, the same fixture-only `t_invalid` flip as the test
    // above (no frozen node-invalidation primitive exists yet, per this
    // file's header).

    it("an invalidated location disappears from its LIVE project's detail (chain integrity)", async () => {
      await store.adapter.executeRun(
        'UPDATE node SET t_invalid = ? WHERE uid = ?',
        [nowISO(), fx.locPathBacklog]
      );
      const detail = await getRegistryDetail(store.graph, {
        registry: 'project',
        name: 'adhd',
      });
      expect(detail.locations.map((l) => l.value)).not.toContain(
        '/repo/adhd/entrypoint/backlog/src/index.ts'
      );
      expect(detail.locations).toHaveLength(2);
    });

    it("an invalidated location disappears from its LIVE component's detail (chain integrity)", async () => {
      await store.adapter.executeRun(
        'UPDATE node SET t_invalid = ? WHERE uid = ?',
        [nowISO(), fx.locPathBacklog]
      );
      const detail = await getRegistryDetail(store.graph, {
        registry: 'component',
        name: 'backlog',
      });
      expect(detail.locations.map((l) => l.value)).not.toContain(
        '/repo/adhd/entrypoint/backlog/src/index.ts'
      );
      expect(detail.locations).toHaveLength(2);
    });

    it("an invalidated component disappears from its LIVE project's detail, and its OWN detail degrades project to empty (chain integrity)", async () => {
      await store.adapter.executeRun(
        'UPDATE node SET t_invalid = ? WHERE uid = ?',
        [nowISO(), fx.componentBacklog]
      );
      const projectDetail = await getRegistryDetail(store.graph, {
        registry: 'project',
        name: 'adhd',
      });
      expect(projectDetail.components.map((c) => c.name)).not.toContain(
        'backlog'
      );
      expect(projectDetail.components).toHaveLength(1);

      // The component itself is still addressable by NAME resolution — `tryResolveRef`'s
      // own `liveOnly` name query means an invalidated component's NAME no longer
      // resolves at all (a distinct, already-covered CatalogNotFoundError case) —
      // so this probes the OTHER direction: a location whose owning component was
      // invalidated must not surface that component's data as live.
      const locationDetail = await getRegistryDetail(store.graph, {
        registry: 'location',
        name: fx.locPathBacklog,
      });
      expect(locationDetail.component).toEqual({ name: '', path: undefined });
    });

    it("an invalidated project degrades a LIVE component's detail to an empty project (chain integrity)", async () => {
      await store.adapter.executeRun(
        'UPDATE node SET t_invalid = ? WHERE uid = ?',
        [nowISO(), fx.projectA]
      );
      // The component's own NAME resolution is project-agnostic (tryResolveRef('component', ...)
      // does not check the component's project's liveness), so it still resolves —
      // but its embedded `project` must degrade, never surface the tombstoned project's data.
      const detail = await getRegistryDetail(store.graph, {
        registry: 'component',
        name: 'backlog',
      });
      expect(detail.project).toEqual({
        name: '',
        path: undefined,
        repoUrl: undefined,
      });
    });
  });

  describe('lookup', () => {
    it('resolves a tool query to its full chain', async () => {
      const result = await lookup(store.graph, 'memory_ping');
      expect(result.project.name).toBe('sox-ecosystem');
      expect(result.project.path).toBe('/repo/sox-ecosystem');
      expect(result.project.repoUrl).toBe(
        'git@github.com:acme/sox-ecosystem.git'
      );
      expect(result.component?.name).toBe('memory-server');
      expect(result.location?.locType).toBe('tool');
      expect(result.location?.value).toBe('memory_ping');
      expect(result.hint).toBeUndefined();
    });

    it('resolves a url query to its full chain', async () => {
      const result = await lookup(
        store.graph,
        'https://github.com/acme/adhd/blob/main/entrypoint/backlog'
      );
      expect(result.project.name).toBe('adhd');
      expect(result.component?.name).toBe('backlog');
      expect(result.location?.locType).toBe('url');
    });

    it('resolves an exact path query to its full chain, no hint', async () => {
      const result = await lookup(
        store.graph,
        '/repo/adhd/entrypoint/backlog/src/index.ts'
      );
      expect(result.project.name).toBe('adhd');
      expect(result.component?.name).toBe('backlog');
      expect(result.location?.locType).toBe('path');
      expect(result.hint).toBeUndefined();
    });

    it('resolves a repo-relative path via suffix fallback, WITH a hint', async () => {
      const result = await lookup(
        store.graph,
        'entrypoint/backlog/src/index.ts'
      );
      expect(result.project.name).toBe('adhd');
      expect(result.component?.name).toBe('backlog');
      expect(result.hint).toBeDefined();
      expect(result.hint).toMatch(/suffix/);
    });

    it('throws CatalogNotFoundError for a query that resolves nothing — never a silent null', async () => {
      await expect(
        lookup(store.graph, 'totally-unknown-tool-xyz')
      ).rejects.toThrow(CatalogNotFoundError);
    });

    it('surfaces a hint when a component resolves but its owning project is a data-integrity gap', async () => {
      // Seed a component whose `metadata.projectUid` points at a uid with no
      // live `project` row — a deliberately orphaned chain (§3a: "never a
      // silent null" applies to THIS gap too — `lookup` must still return a
      // usable partial result, not throw or crash).
      await executeWriteTransaction(store, async (tx) => {
        const now = nowISO();
        const hasLocationRule = await resolveEdgeKindTx(tx, 'has_location');
        const orphanComponent = await writeNodeTx(tx, {
          kind: 'component',
          name: 'orphan-component',
          metadata: { projectUid: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
          at: now,
        });
        const orphanLocation = await writeNodeTx(tx, {
          kind: 'location',
          name: 'orphan-tool',
          metadata: {
            locType: 'tool',
            value: 'orphan-tool',
            componentUid: orphanComponent.uid,
          },
          at: now,
        });
        await writeEdgeTx(tx, {
          at: now,
          rule: hasLocationRule,
          typePolicy: store.typePolicy,
          rel: 'has_location',
          srcRowid: orphanComponent.rowid,
          srcUid: orphanComponent.uid,
          srcKind: 'component',
          dstRowid: orphanLocation.rowid,
          dstUid: orphanLocation.uid,
          dstKind: 'location',
        });
      });

      const result = await lookup(store.graph, 'orphan-tool');
      expect(result.component?.name).toBe('orphan-component');
      expect(result.project.uid).toBe('');
      expect(result.hint).toMatch(/data integrity/);
    });

    it("throws CatalogNotFoundError when the resolved location's component has been invalidated (chain integrity)", async () => {
      // The `has_location` edge stays live — only the component NODE is
      // tombstoned (fixture-only `t_invalid` flip, same stand-in as
      // `getRegistryDetail`'s location test above). `lookup` must reject this
      // exactly like an unresolved component, never resolve the tombstoned
      // component's data as if it were live.
      await store.adapter.executeRun(
        'UPDATE node SET t_invalid = ? WHERE uid = ?',
        [nowISO(), fx.componentBacklog]
      );
      await expect(lookup(store.graph, 'adhd-backlog')).rejects.toThrow(
        CatalogNotFoundError
      );
    });

    it("degrades to the data-integrity hint when the resolved project has been invalidated, not the tombstoned project's data (chain integrity)", async () => {
      await store.adapter.executeRun(
        'UPDATE node SET t_invalid = ? WHERE uid = ?',
        [nowISO(), fx.projectA]
      );
      const result = await lookup(store.graph, 'adhd-backlog');
      expect(result.component?.name).toBe('backlog');
      expect(result.project.uid).toBe('');
      expect(result.project.name).toBe('');
      expect(result.hint).toMatch(/data integrity/);
    });
  });

  /**
   * The suffix/prefix path fallback used to run `graph.queryNodes({kind:
   * 'location', liveOnly: true, metadata: {locType: {eq: 'path'}}})` with NO
   * `limit` — a full scan of every live path location in the store on every
   * miss (blind performance review finding). It is now bounded at
   * `MAX_QUERY_LIMIT` (§types.ts), fetching one row past the cap to detect
   * truncation without a second round trip. These tests prove: (1) the bound
   * really is applied (a large candidate set does not balloon the query),
   * and (2) a truncated scan that misses its match reports THAT — a
   * distinct, honest outcome from an exhaustive "not found" — rather than
   * silently returning the same not-found error an exhaustive miss would.
   *
   * `MAX_QUERY_LIMIT` rows is a lot to seed per test; this suite seeds them
   * once in its own `beforeEach` (not the shared fixture above) so the other
   * `lookup`/`getRegistryDetail`/list* suites stay fast.
   */
  describe('lookup — path fallback scan is bounded (MAX_QUERY_LIMIT)', () => {
    it('a match that lands beyond the cap is reported as an honest truncated-scan miss, not a bare not-found', async () => {
      const needleValue =
        '/some/very/long/absolute/prefix/that/is/not/queried/directly/entrypoint/backlog/src/deep/needle.ts';
      const needleQuery = 'entrypoint/backlog/src/deep/needle.ts';

      await executeWriteTransaction(store, async (tx) => {
        const now = nowISO();
        // MAX_QUERY_LIMIT (1000) non-matching path locations, inserted FIRST so
        // they occupy the capped scan window ahead of the real match.
        for (let i = 0; i < 1000; i++) {
          await writeNodeTx(tx, {
            kind: 'location',
            name: `noise-${i}`,
            metadata: {
              locType: 'path',
              value: `/noise/does-not-match-${i}.ts`,
              componentUid: fx.componentBacklog,
            },
            at: now,
          });
        }
        // The 1001st path location — the one the query actually wants — is
        // seeded LAST, so it falls outside the first-MAX_QUERY_LIMIT slice.
        await writeNodeTx(tx, {
          kind: 'location',
          name: 'needle',
          metadata: {
            locType: 'path',
            value: needleValue,
            componentUid: fx.componentBacklog,
          },
          at: now,
        });
      });

      const rejection = await lookup(store.graph, needleQuery).then(
        () => {
          throw new Error('expected lookup to reject, it resolved instead');
        },
        (e: unknown) => e
      );
      expect(rejection).toBeInstanceOf(CatalogNotFoundError);
      expect((rejection as CatalogNotFoundError).message).toMatch(
        /scanned only the first \d+/
      );
    });

    it('a match within the cap still resolves normally even with many noise rows ahead of it', async () => {
      const needleValue = '/prefix/entrypoint/backlog/src/shallow/needle.ts';
      const needleQuery = 'entrypoint/backlog/src/shallow/needle.ts';

      await executeWriteTransaction(store, async (tx) => {
        const now = nowISO();
        for (let i = 0; i < 50; i++) {
          await writeNodeTx(tx, {
            kind: 'location',
            name: `noise-${i}`,
            metadata: {
              locType: 'path',
              value: `/noise/does-not-match-${i}.ts`,
              componentUid: fx.componentBacklog,
            },
            at: now,
          });
        }
        await writeNodeTx(tx, {
          kind: 'location',
          name: 'needle',
          metadata: {
            locType: 'path',
            value: needleValue,
            componentUid: fx.componentBacklog,
          },
          at: now,
        });
      });

      const result = await lookup(store.graph, needleQuery);
      expect(result.location?.value).toBe(needleValue);
      expect(result.hint).toMatch(/suffix/);
    });
  });
});
