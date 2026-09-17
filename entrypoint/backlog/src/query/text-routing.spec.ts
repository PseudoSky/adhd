/**
 * text-routing.spec.ts — `IIssueQueryInput.text` (query/types.ts), routed
 * ONCE by `resolveTextInput` inside `queryIssues` (query/query.ts) into
 * `filter.grep` or `filter.semantic` depending on whether the vector space
 * can return ranked results (`isSemanticSearchReadable`, store/semantic-search.ts).
 *
 * Real components throughout: a real store via `openTestIssueStore`/
 * `seedProject`, real `createIssue` writes, `queryIssues` driven exactly as
 * `api.ts`'s mounted `query` verb drives it — mirroring `paging.spec.ts`'s
 * harness. The one exception is the sort-precedence assertion, which calls
 * the exported `resolveTextInput` directly: the ranked grep/semantic branch
 * of `queryList` never echoes the resolved `sort` back in its output, so
 * there is no way to observe "explicit sort survived" from `queryIssues`'s
 * return value alone (see `resolveTextInput`'s own doc comment). That is not
 * a mock of the thing under test — `resolveTextInput` IS the real routing
 * function `queryIssues` calls, called directly rather than through the one
 * layer that would otherwise swallow its output.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTursoVectorStore } from '@adhd/sox-vector-store';
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
import {
  bootstrapSemanticBackend,
  configureSemanticBackend,
  isSemanticSearchConfigured,
} from '../store/semantic-search.js';
import type { GraphBacklogStore } from '../store/graph-backlog-store.js';

const E2E_TIMEOUT = 180_000;

describe('IIssueQueryInput.text — grep route (real store, no semantic backend configured)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    // No semantic backend is ever configured in this describe block, so
    // `isSemanticSearchReadable()` is false and every `text` query below
    // routes to `filter.grep`.
    expect(isSemanticSearchConfigured()).toBe(false);
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
    if (result.view !== 'list')
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
    expect(isSemanticSearchConfigured()).toBe(false); // this describe block never configures a backend
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

describe('IIssueQueryInput.text — semantic route (real fastembed + real Turso vectors)', () => {
  const MODEL = 'bge-base-en-v1.5';
  const EMBEDDING = { type: 'fastembed', model: MODEL } as const;

  let dir: string | undefined;
  let store: TestIssueStore | undefined;

  afterEach(async () => {
    configureSemanticBackend(null); // never leak a live backend into another suite
    if (store) {
      await store.close();
      store = undefined;
    }
    if (dir) {
      removeTestIssueStoreDir(dir);
      dir = undefined;
    }
  });

  it(
    'a real readable vector space routes `text` to filter.semantic and finds the meaning-matching issue by paraphrase, not keywords',
    async () => {
      expect(isSemanticSearchConfigured()).toBe(false);
      dir = freshTmpDir('query-text-routing-semantic');
      const bareStore = await openTestIssueStore(join(dir, 'backlog.db'));
      const result = await bootstrapSemanticBackend(
        bareStore as unknown as GraphBacklogStore,
        { embedding: EMBEDDING }
      );
      if (!result.ok) {
        throw new Error(
          `real semantic backend unavailable (${result.failure.reason}): ${result.failure.detail}`
        );
      }
      const backend = result.backend;
      configureSemanticBackend(backend);

      const vec = await openTursoVectorStore(bareStore.adapter, {
        dim: backend.dim,
        modelId: backend.modelId,
      });
      const search = {
        backend: new StoreSearchBackend(vec, bareStore.graph),
        embedQuery: (text: string) => backend.embedQuery(text),
      };
      const handle: TestIssueStore & {
        embedding: typeof backend;
        search: typeof search;
      } = {
        ...bareStore,
        embedding: backend,
        search,
      };
      store = bareStore;

      const { projectUid } = await seedProject(
        bareStore,
        'text-routing-semantic-project'
      );

      // Deliberately shares no meaningful token with the target title/body —
      // only a real semantic (not keyword/FTS) match can find it.
      const target = await createIssue(handle, {
        project: projectUid,
        title: 'Vector index refuses a dimension mismatch',
        body: 'Inserting an embedding whose length differs from the configured space dimension is rejected structurally.',
        by: 'filer',
        awaitEmbed: true,
      });
      if (!target.created || !target.uid)
        throw new Error(
          `expected the target issue to be created, got ${JSON.stringify(
            target
          )}`
        );
      const unrelated = await createIssue(handle, {
        project: projectUid,
        title: 'Storybook theme tokens drift between builds',
        body: 'Nothing to do with publishing or vectors.',
        by: 'filer',
        awaitEmbed: true,
      });
      if (!unrelated.created || !unrelated.uid)
        throw new Error(
          `expected the unrelated issue to be created, got ${JSON.stringify(
            unrelated
          )}`
        );

      const queried = await queryIssues(handle, {
        text: 'the embedding length does not match the configured dimension',
      });
      if (queried.view !== 'list')
        throw new Error(`expected view 'list', got '${queried.view}'`);
      const uids = queried.items.map((i) => i.uid);
      // Only two issues exist in this store, so BOTH are returned by a
      // ranked search over the whole corpus (there is no relevance-threshold
      // cutoff) — the teeth here are the ORDER: only a genuine semantic match
      // ranks the meaning-matching, zero-shared-token target ABOVE the
      // unrelated item; a keyword/FTS-only comparison (or a broken route that
      // fell through to grep) would not, since neither title/body shares any
      // token with the query text.
      expect(uids[0]).toBe(target.uid);
      expect(uids.indexOf(target.uid)).toBeLessThan(
        uids.indexOf(unrelated.uid)
      );
    },
    E2E_TIMEOUT
  );
});
