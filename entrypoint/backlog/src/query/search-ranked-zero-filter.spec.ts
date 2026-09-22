/**
 * search-ranked-zero-filter.spec.ts — the S-13 behavioral pin.
 *
 * ## What this pins
 *
 * `query/query.ts`'s `filter.semantic` path passes a `NodeFilter` straight to
 * `StoreSearchBackend.searchRanked` (`@adhd/sox-hybrid-search`), which resolves
 * it to concrete ids against the graph and then runs a filtered KNN against
 * the real Turso vector table. The invariant under test: **a `NodeFilter` that
 * resolves to ZERO candidate ids must yield ZERO results — never an unfiltered
 * scan.**
 *
 * This matters because the vector store's own filter contract is pure `{ ids }`
 * and its `knn`/`iter` drop an EMPTY `ids` array entirely (they compile to
 * `1=1` — no filter), and the graph store's `buildNodeFilterClause` likewise
 * drops `ids: []`. If any of those layers conflates "zero ids" with "no
 * filter", a caller who means "match nothing" instead gets the WHOLE vector
 * table ranked back — silently wrong, and worse than the grep fallback the
 * text-routing decision uses over an empty space.
 *
 * ## The two cases
 *
 * 1. A filter that GENUINELY resolves to zero through the real graph query
 *    (`rowid IN (<absent id>)`) — `searchRanked`'s vec channel must skip
 *    entirely and return nothing.
 * 2. An EMPTY `ids` array — the caller's intent is unambiguously "zero
 *    candidates". The S-13 decision point: if the installed
 *    `@adhd/sox-hybrid-search`/`@adhd/sox-vector-store` honors zero-not-
 *    unfiltered, this returns nothing; if it conflates empty-ids with
 *    unfiltered, this returns the whole space's vectors.
 *
 * Real components throughout: a real store via `openTestIssueStore`, a real
 * `TursoVectorBackend` sharing the store's own adapter (never a second
 * connection), a real `StoreSearchBackend`, and real `createIssue` writes.
 * Nothing is mocked.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openTursoVectorStore,
  type TursoVectorBackend,
  type VectorSpace,
} from '@adhd/sox-vector-store';
import { StoreSearchBackend } from '@adhd/sox-hybrid-search';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { createIssue } from '../write/create-issue.js';

const DIM = 3;
const SPACE: VectorSpace = { modelId: 's13-zero-filter-model', dim: DIM };

describe('StoreSearchBackend.searchRanked — a zero-id NodeFilter returns zero candidates, never an unfiltered scan', () => {
  let dir: string;
  let store: TestIssueStore;
  let vec: TursoVectorBackend;
  let projectUid: string;
  let indexedRowid: number;

  beforeEach(async () => {
    dir = freshTmpDir('search-ranked-zero-filter');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    vec = await openTursoVectorStore(store.adapter, {
      dim: DIM,
      modelId: SPACE.modelId,
    });
    projectUid = (await seedProject(store, 's13-project')).projectUid;

    // A real issue with a real vector in the space, so "zero results" can
    // never be explained by an empty vector table.
    const created = await createIssue(store, {
      project: projectUid,
      title: 's13 indexed issue',
      body: 's13 indexed issue body',
      by: 'filer',
    });
    if (!created.uid) throw new Error('createIssue produced no uid');
    const node = await store.graph.getNodeByUid(created.uid);
    if (!node) throw new Error('no node for the created uid');
    indexedRowid = node.id;
    await vec.upsert(node.id, Float32Array.from([1, 0, 0]), SPACE);
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  function ranked(filters: Record<string, unknown>) {
    const search = new StoreSearchBackend(vec, store.graph);
    return search.searchRanked(
      { vec: Float32Array.from([1, 0, 0]), signals: [{ kind: 'vec' }], filters },
      10
    );
  }

  it('a filter that genuinely resolves to zero ids (an absent rowid) returns zero results', async () => {
    const results = await ranked({ kind: 'issue', ids: [999_999_999] });
    expect(results).toHaveLength(0);
    // Sanity: the vector IS retrievable unfiltered, so the zero above is the
    // filter's doing, not an empty space.
    const unfiltered = await ranked({ kind: 'issue' });
    expect(unfiltered.map((r) => r.id)).toContain(indexedRowid);
  });

  it('an EMPTY ids array (the caller means "zero candidates") returns zero results — never an unfiltered scan', async () => {
    const results = await ranked({ kind: 'issue', ids: [] });
    expect(results).toHaveLength(0);
  });
});
