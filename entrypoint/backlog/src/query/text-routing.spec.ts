/**
 * text-routing.spec.ts — `IIssueQueryInput.text` (query/types.ts), routed
 * ONCE by `resolveTextInput` inside `queryIssues` (query/query.ts) into
 * `filter.grep` or `filter.semantic`.
 *
 * Real components throughout: a real store via `openTestIssueStore`/
 * `seedProject`, real `createIssue` writes, `queryIssues` driven exactly as
 * `api.ts`'s mounted `query` verb drives it — mirroring `paging.spec.ts`'s
 * harness. The one faked seam in the semantic block is the embedding MODEL
 * (`@adhd/sox-embedding-provider`), replaced with the deterministic fake from
 * `test/helpers/fake-embedding-provider.ts` (embeddings mocked here — explicit
 * scoped authorization, see entrypoint/backlog/STATE.md) — the routing proof
 * needs a retrievable vector, not genuine paraphrase understanding (that
 * belongs to the real-model suite, not this file).
 *
 * The `searchRanked` spy is the exact discriminator between the two routes:
 * `filter.grep` runs through `graph.searchNodes`, while `filter.semantic`
 * runs through `StoreSearchBackend.searchRanked`. Nothing else in this file's
 * assertions can tell the routes apart for a query that shares tokens with its
 * target, so every routing claim below is pinned on that spy.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreSearchBackend } from '@adhd/sox-hybrid-search';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { createIssue } from '../write/create-issue.js';
import { InvalidArgumentError } from '../write/errors.js';
import {
  queryIssues,
  resolveTextInput,
  type IQueryStoreHandle,
} from './query.js';
import { bootstrapSemanticStoreMembers } from '../write/bootstrap.js';
import { createFakeEmbeddingModule } from '../test/helpers/fake-embedding-provider.js';

// Embeddings mocked here — explicit, scoped user authorization (see
// entrypoint/backlog/STATE.md), covers embedding cost only. Intercepts the
// exact `import('@adhd/sox-embedding-provider')` specifier
// `write/bootstrap.ts`'s own local `loadOptional` seam resolves at runtime.
vi.mock('@adhd/sox-embedding-provider', () => createFakeEmbeddingModule());

const E2E_TIMEOUT = 30_000;

describe('IIssueQueryInput.text — grep route (real store, no semantic backend configured)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    // No semantic backend is ever configured in this describe block, so
    // every `text` query below routes to `filter.grep`.
    dir = freshTmpDir('query-text-routing-grep');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'text-routing-grep-project'))
      .projectUid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('finds the keyword-matching issue and not the unrelated one', async () => {
    const target = await createIssue(store, {
      project: projectUid,
      title: 'Publish gate trips intermittently under machine load',
      body: 'The release publish gate reports a spurious failure.',
      by: 'filer',
    });
    const unrelated = await createIssue(store, {
      project: projectUid,
      title: 'Storybook theme tokens drift between builds',
      body: 'Nothing to do with publishing.',
      by: 'filer',
    });

    const result = await queryIssues(store, { text: 'publish gate' });
    if (result.view !== 'list' || !('items' in result))
      throw new Error(`expected view 'list', got '${result.view}'`);
    const uids = result.items.map((i) => i.uid);
    expect(uids).toContain(target.uid);
    expect(uids).not.toContain(unrelated.uid);
  });

  it('throws InvalidArgumentError naming "text" when filter.grep is also explicitly set', async () => {
    const attempt = queryIssues(store, {
      text: 'publish gate',
      filter: { grep: 'publish' },
    });
    await expect(attempt).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(attempt).rejects.toMatchObject({ field: 'text' });
  });

  it('throws InvalidArgumentError naming "text" when filter.semantic is also explicitly set', async () => {
    const attempt = queryIssues(store, {
      text: 'publish gate',
      filter: { semantic: 'publish' },
    });
    await expect(attempt).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(attempt).rejects.toMatchObject({ field: 'text' });
  });

  it('throws InvalidArgumentError on blank/whitespace-only text', async () => {
    const attempt = queryIssues(store, { text: '   ' });
    await expect(attempt).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(attempt).rejects.toMatchObject({ field: 'text' });
  });
});

describe('resolveTextInput — sort precedence (direct unit test; see file header)', () => {
  const bareHandle: IQueryStoreHandle = { graph: {} as never }; // never touched — text is unset or routing short-circuits before any graph call

  it('derives sort:"textMatch" on the grep route when the caller passes no sort', () => {
    const resolved = resolveTextInput(bareHandle, { text: 'publish gate' });
    expect(resolved.sort).toBe('textMatch');
    expect(resolved.filter?.grep).toBe('publish gate');
    expect(resolved.filter?.semantic).toBeUndefined();
    expect(resolved.text).toBeUndefined(); // consumed, never forwarded to queryList
  });

  it('an explicit sort is NOT overwritten by the derived default', () => {
    const resolved = resolveTextInput(bareHandle, {
      text: 'publish gate',
      sort: 'created',
    });
    expect(resolved.sort).toBe('created');
  });

  it('leaves input untouched when text is absent', () => {
    const input = { filter: { grep: 'x' } };
    expect(resolveTextInput(bareHandle, input)).toBe(input);
  });
});

describe('IIssueQueryInput.text — semantic route (real Turso vectors, deterministic fake model)', () => {
  const MODEL = 'bge-base-en-v1.5';
  const EMBEDDING = { enabled: true, provider: 'fastembed', model: MODEL } as const;

  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;
  let handle: TestIssueStore & {
    search: NonNullable<
      Awaited<ReturnType<typeof bootstrapSemanticStoreMembers>>['search']
    >;
    embedding: NonNullable<
      Awaited<ReturnType<typeof bootstrapSemanticStoreMembers>>['embedding']
    >;
  };

  beforeEach(async () => {
    dir = freshTmpDir('query-text-routing-semantic');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    // The production bootstrap seam `api.ts`'s write/query handles both derive
    // from — real Turso vector space, real StoreSearchBackend, only the model
    // faked. Replaces the old `bootstrapSemanticBackend` + hand-built vec store.
    const members = await bootstrapSemanticStoreMembers(
      store.adapter,
      store.graph,
      EMBEDDING
    );
    if (!members.search || !members.embedding) {
      throw new Error(
        'semantic harness unavailable — bootstrapSemanticStoreMembers returned no search/embedding members'
      );
    }
    const searchMembers = members.search;
    const embeddingMembers = members.embedding;

    // A LIVE `handle.spacePopulated`, mirroring the per-query snapshot
    // `api.ts`'s `queryHandle` takes from `search.spacePopulated()` before the
    // (synchronous) `resolveTextInput` reads it. A handle built directly (not
    // through `api.ts`) exposes that snapshot itself; it must flip the moment a
    // vector reaches the space, not at construction, so it is a getter over a
    // flag the real on-write embed sets below.
    let spacePopulated = false;
    const embedding = {
      ...embeddingMembers,
      async upsertVector(nodeRowid: number, vec: Float32Array): Promise<void> {
        await embeddingMembers.upsertVector(nodeRowid, vec);
        spacePopulated = true;
      },
    };
    handle = {
      ...store,
      search: searchMembers,
      embedding,
      get spacePopulated(): boolean {
        return spacePopulated;
      },
    };
    projectUid = (await seedProject(store, 'text-routing-semantic-project'))
      .projectUid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it(
    'a fresh empty space routes text: to grep, and an on-write embed upgrades it to semantic with no restart',
    async () => {
      const spy = vi.spyOn(StoreSearchBackend.prototype, 'searchRanked');
      try {
        const title = 'Vector index refuses a dimension mismatch';
        const body =
          'Inserting an embedding whose length differs from the configured space dimension is rejected structurally.';
        // The query is the target's EXACT composed embed text. The fake is
        // deterministic (identical text -> identical vector), so the rank-1
        // assertion below is a property of the ROUTE (did `text:` reach the
        // semantic ranker at all?), never of the fake's lexical fidelity.
        const queryText = `${title}\n${body}`;

        // (1) Empty vector space: routing must fall back to grep — true both
        // before and after the fix (there is genuinely nothing to rank).
        const empty = await queryIssues(handle, { text: queryText });
        expect(empty.view).toBe('list');
        expect(spy).toHaveBeenCalledTimes(0);

        // (2) Land a vector through the REAL write path: `createIssue`'s own
        // on-write embed (`awaitEmbed:true` so it is durable before we query).
        const target = await createIssue(handle, {
          project: projectUid,
          title,
          body,
          by: 'filer',
          awaitEmbed: true,
        });
        if (!target.created || !target.uid)
          throw new Error(`expected target create, got ${JSON.stringify(target)}`);
        const unrelated = await createIssue(handle, {
          project: projectUid,
          title: 'Storybook theme tokens drift between builds',
          body: 'Nothing to do with publishing or vectors.',
          by: 'filer',
          awaitEmbed: true,
          // The project now holds `target`, so the duplicate scan runs; force
          // the write so a coincidental fake-model similarity cannot suppress it.
          duplicateAction: 'force',
        });
        if (!unrelated.created || !unrelated.uid)
          throw new Error(
            `expected unrelated create, got ${JSON.stringify(unrelated)}`
          );

        // (3) The space is now non-empty: `text` must upgrade to the semantic
        // route WITHOUT a restart. Pre-fix this stays 0 (the startup latch
        // never flips) and this assertion is RED; post-fix it is 1.
        spy.mockClear();
        const queried = await queryIssues(handle, { text: queryText });
        if (queried.view !== 'list' || !('items' in queried))
          throw new Error(`expected view 'list', got '${queried.view}'`);
        expect(spy).toHaveBeenCalledTimes(1);
        const uids = queried.items.map((i) => i.uid);
        expect(uids).toContain(target.uid);
        // The exact-text query ranks the target first; the routing spy above
        // is what proves the ranking came from the SEMANTIC ranker.
        expect(uids[0]).toBe(target.uid);
      } finally {
        spy.mockRestore();
      }
    },
    E2E_TIMEOUT
  );
});
