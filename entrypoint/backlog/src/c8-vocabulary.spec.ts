/**
 * c8-vocabulary.spec.ts — C8: closed primitives, readable catalogs, and a
 * self-describing surface.
 *
 * One describe per acceptance criterion (AC1–AC7), each driven through the
 * REAL components: the live store + `queryIssues` for the catalog view, the
 * real `createIssue` verb and the real `mintOrResolveCatalogTx` for the
 * deprecation rule, the real `planCaseFragmentMerge`/`applyCaseFragmentMerge`
 * for the `kind` repair, and the real BUILT `dist/index.js` for the surface
 * self-check.
 *
 * Negative controls are proven by temporary local revert (see the report);
 * the tests are written so that reverting the corresponding code turns them
 * RED — e.g. removing `'kind'` from the guard, or dropping the `kinds` view.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from './test/helpers/open-test-issue-store.js';
import { freshTmpDir } from './test/helpers/tmp-store.js';
import { createIssue } from './write/create-issue.js';
import {
  applyCaseFragmentMerge,
  planCaseFragmentMerge,
} from './write/catalog-merge.js';
import {
  mintOrResolveCatalogTx,
  type FlatCatalogKind,
} from './write/catalog.js';
import { InvalidArgumentError } from './write/errors.js';
import {
  executeWriteTransaction,
  writeNodeTx,
} from './write/tx.js';
import { inspectCatalogInvariants } from './store/catalog-invariant-guard.js';
import { catalogView } from './query/views/catalog.js';
import { queryIssues } from './query/query.js';
import { BACKLOG_VERBS } from './vocabulary.js';

const requireDist = createRequire(import.meta.url);

interface IBuiltSurfaceModule {
  describeBacklogSurface(): Array<{ id: string; mcpTool: string; cliCommand: string }>;
  assertSurfaceIsReal(): void;
}

describe('C8 — closed primitives, readable catalogs, self-describing surface', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('c8-vocabulary');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'c8-project')).projectUid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  /** Seed a live catalog row directly (bypassing the mint) — the setup a case-fragment fixture needs. */
  async function seedKindRow(name: string): Promise<string> {
    const node = await executeWriteTransaction(store, (tx) =>
      writeNodeTx(tx, { kind: 'kind', name, metadata: {} })
    );
    return node.uid;
  }

  async function liveKindNames(): Promise<string[]> {
    const rows = await store.graph.queryNodes({ kind: 'kind', liveOnly: true });
    return rows.map((r) => r.name ?? '').sort();
  }

  // -------------------------------------------------------------------------
  // AC1 — `query {view:"kinds"}` returns a generated catalog
  // -------------------------------------------------------------------------
  describe('AC1 — the generated catalog read view', () => {
    it('view:"kinds" returns terms with name + source + lifecycle from the validating sources', async () => {
      const result = await queryIssues(store, { view: 'kinds' });
      expect(result.view).toBe('kinds');
      if (result.view !== 'kinds') return; // narrow for TS
      const view = result.catalogs;

      expect(view.catalogs).toEqual(
        expect.arrayContaining([
          'kind',
          'status',
          'priority',
          'relation',
          'field',
          'error_code',
          'location_type',
          'verb',
        ])
      );
      expect(view.terms.length).toBeGreaterThan(0);
      for (const term of view.terms) {
        expect(typeof term.name).toBe('string');
        expect(typeof term.source).toBe('string');
        expect(['active', 'deprecated']).toContain(term.lifecycle);
      }

      // Generated from the in-code validating sources — a `relation` term
      // straight from EDGE_KIND_TABLE, a `verb` term from BACKLOG_VERBS.
      expect(
        view.terms.some((t) => t.catalog === 'relation' && t.name === 'attests')
      ).toBe(true);
      expect(
        view.terms.some((t) => t.catalog === 'verb' && t.name === 'get')
      ).toBe(true);
      expect(
        view.terms.some(
          (t) =>
            t.catalog === 'status' &&
            t.source === 'reserved_terminal_status_names' &&
            t.name === 'closed'
        )
      ).toBe(true);
    });

    it('view:"catalogs" narrows to one catalog and agrees with view:"kinds"', async () => {
      const whole = await queryIssues(store, { view: 'kinds' });
      const narrowed = await queryIssues(store, {
        view: 'catalogs',
        catalog: 'relation',
      });
      expect(narrowed.view).toBe('catalogs');
      if (whole.view !== 'kinds' || narrowed.view !== 'catalogs') return;
      const relationTerms = whole.catalogs.terms.filter(
        (t) => t.catalog === 'relation'
      );
      expect(narrowed.terms).toEqual(relationTerms);
    });

    it('rejects format:"markdown" for the catalog views (no markdown projection)', async () => {
      await expect(
        queryIssues(store, { view: 'kinds', format: 'markdown' })
      ).rejects.toThrow(InvalidArgumentError);
    });
  });

  // -------------------------------------------------------------------------
  // AC2 — a newly minted kind appears with NO separate edit
  // -------------------------------------------------------------------------
  describe('AC2 — the catalog is generated, not hand-maintained', () => {
    it('a kind minted through the validating registry appears in the catalog', async () => {
      const novel = `C8NOVEL${Date.now().toString(36).toUpperCase()}`;
      await createIssue(store, {
        project: projectUid,
        title: 'novel kind',
        body: 'mints a brand-new kind through the registry',
        kind: novel,
        by: 'agent:t',
      });

      const view = await catalogView(store.graph);
      const term = view.terms.find(
        (t) => t.catalog === 'kind' && t.name === novel
      );
      expect(term, `minted kind "${novel}" must appear with no separate edit`).toBeDefined();
      expect(term?.source).toBe('store');
      expect(term?.usageCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // AC5 — the `kind` case-fragment repair reconciles a fold
  // -------------------------------------------------------------------------
  describe('AC5 — the kind case-fragment repair', () => {
    it('collapses `BUG`/`bug` to one canonical and repoints both issues', async () => {
      const bugUid = await seedKindRow('bug');
      const BUGUid = await seedKindRow('BUG');
      await createIssue(store, {
        project: projectUid,
        title: 'points at bug',
        body: 'first spelling',
        kind: bugUid,
        by: 'agent:t',
      });
      await createIssue(store, {
        project: projectUid,
        title: 'points at BUG',
        body: 'second spelling',
        kind: BUGUid,
        by: 'agent:t',
      });

      // Pre-state: the guard detects the collision (the invariant the read
      // layer depends on is violated until the repair runs).
      const before = await inspectCatalogInvariants(store.adapter);
      expect(
        before.some(
          (v) => v.kind === 'case-fragment-duplicate' && v.fold === 'bug'
        )
      ).toBe(true);

      const statuses = await store.graph.queryNodes({
        kind: 'status',
        liveOnly: true,
      });
      const priorities = await store.graph.queryNodes({
        kind: 'priority',
        liveOnly: true,
      });
      const kinds = await store.graph.queryNodes({ kind: 'kind', liveOnly: true });
      const plan = planCaseFragmentMerge(statuses, priorities, kinds);
      expect(plan.unmergeable).toEqual([]);
      expect(plan.groups).toHaveLength(1);
      await applyCaseFragmentMerge(store, plan);

      // One live row, canonical lowercase; the count matches the independently
      // computed distinct-fold count.
      const expectedFolds = new Set(
        kinds.map((r) => (r.name ?? '').normalize('NFKC').toLowerCase())
      );
      expect(await liveKindNames()).toHaveLength(expectedFolds.size);
      expect(await liveKindNames()).toEqual(['bug']);

      // Both issues' `has_kind` edges now point at the survivor.
      const survivor = await store.graph.queryNodes({
        kind: 'kind',
        name: 'bug',
        liveOnly: true,
        limit: 1,
      });
      const edges = await store.graph.getEdges({ rel: 'has_kind' });
      expect(edges.filter((e) => e.dst === survivor[0]?.id)).toHaveLength(2);

      // Guard green for `kind`; catalog reports no collisions.
      const after = await inspectCatalogInvariants(store.adapter);
      expect(
        after.filter((v) => v.kind === 'case-fragment-duplicate')
      ).toEqual([]);
      const view = await catalogView(store.graph);
      expect(view.hasCaseCollisions).toBe(false);
    });

    it('the MINT fold-resolves a variant onto the survivor (no re-minted twin)', async () => {
      await createIssue(store, {
        project: projectUid,
        title: 'mints bug',
        body: 'lowercase canonical',
        kind: 'bug',
        by: 'agent:t',
      });
      // `BUG` must fold-resolve to the live `bug`, not mint a second row.
      await createIssue(store, {
        project: projectUid,
        title: 'variant',
        body: 'must fold-resolve',
        kind: 'BUG',
        by: 'agent:t',
      });
      expect(await liveKindNames()).toEqual(['bug']);
    });

    it('NEGATIVE CONTROL: a fold group with no canonical member is unmergeable and stays a violation', async () => {
      await seedKindRow('WONKY');
      await seedKindRow('Wonky');
      const kinds = await store.graph.queryNodes({ kind: 'kind', liveOnly: true });
      const plan = planCaseFragmentMerge([], [], kinds);
      // No lowercase member ⇒ nothing to merge into; surfaced, never merged.
      expect(plan.unmergeable.map((g) => g.kind)).toContain('kind');
      expect(
        plan.groups.filter((g) =>
          kinds
            .filter((k) => g.fragmentUids.includes(k.uid))
            .some((k) => (k.name ?? '').toLowerCase() === 'wonky')
        )
      ).toHaveLength(0);

      // Applying the (empty) repair changes nothing; the guard still reports
      // the collision — the "unmergeable-only plan must fail" control.
      await applyCaseFragmentMerge(store, plan);
      const violations = await inspectCatalogInvariants(store.adapter);
      expect(
        violations.some(
          (v) => v.kind === 'case-fragment-duplicate' && v.fold === 'wonky'
        )
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // AC6 — EPIC is deprecated with a replacement; mint is refused
  // -------------------------------------------------------------------------
  describe('AC6 — deprecated kind vocabulary', () => {
    it('refuses a new `EPIC` kind on mint and names its replacement', async () => {
      const err = await createIssue(store, {
        project: projectUid,
        title: 'epic',
        body: 'must be refused',
        kind: 'EPIC',
        by: 'agent:t',
      }).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(InvalidArgumentError);
      expect((err as Error).message).toContain('FEAT');
      expect(await liveKindNames()).not.toContain('EPIC');
    });

    it('reports `EPIC` deprecated with replacedBy, and `allowDeprecated` permits the write', async () => {
      await seedKindRow('EPIC');
      const view = await catalogView(store.graph);
      const term = view.terms.find(
        (t) => t.catalog === 'kind' && t.name === 'EPIC'
      );
      expect(term?.lifecycle).toBe('deprecated');
      expect(term?.replacedBy).toBe('FEAT');

      const resolved = await executeWriteTransaction(store, (tx) =>
        mintOrResolveCatalogTx(tx, {
          catalogKind: 'kind' as FlatCatalogKind,
          ref: 'EPIC',
          allowDeprecated: true,
        })
      );
      expect(resolved.name).toBe('EPIC');
    });
  });

  // -------------------------------------------------------------------------
  // AC7 — the five-part promotion gate is documented + referenced
  // -------------------------------------------------------------------------
  describe('AC7 — the promotion gate is documented and referenced', () => {
    it('CONTRACT.md states the five-part gate and the governed-extension rule', () => {
      const contract = readFileSync(join(__dirname, 'write', 'CONTRACT.md'), 'utf8');
      for (const phrase of [
        'five-part promotion gate',
        'Not expressible by existing primitives',
        '≥2 independent in-repo consumers',
        'rename-proof id',
        'Validatable by the closed grammar',
        'Discoverable on a catalog surface',
        'Governed extension namespace',
        'canonical rule',
      ]) {
        expect(contract, `CONTRACT.md must state "${phrase}"`).toContain(phrase);
      }
    });

    it('the catalog surface references the gate', () => {
      const catalogSrc = readFileSync(
        join(__dirname, 'query', 'views', 'catalog.ts'),
        'utf8'
      );
      expect(catalogSrc).toContain('five-part promotion gate');
      expect(catalogSrc).toContain('write/CONTRACT.md');
    });
  });

  // -------------------------------------------------------------------------
  // AC3 — the BUILT package advertises exactly its mounted surface
  // -------------------------------------------------------------------------
  describe('AC3 — the surface self-check drives the built package', () => {
    const distIndex = join(__dirname, '..', 'dist', 'index.js');

    it('describeBacklogSurface enumerates the pinned verbs and assertSurfaceIsReal passes on the build', () => {
      expect(
        existsSync(distIndex),
        `${distIndex} missing — nx build backlog must run first`
      ).toBe(true);
      const built = requireDist(distIndex) as IBuiltSurfaceModule;

      const surface = built.describeBacklogSurface();
      expect(surface.map((e) => e.id).sort()).toEqual(
        BACKLOG_VERBS.map((v) => `backlog/${v}`).sort()
      );

      // The AC3 mechanism: every advertised verb resolves in the built package
      // (and the build advertises nothing absent from the pinned list).
      expect(() => built.assertSurfaceIsReal()).not.toThrow();
    });
  });
});
