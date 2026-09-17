/**
 * superseded-ranking.spec.ts — SPEC.md §8 AC-6's ranking half: a body edit
 * must not leave the stale row eligible for relevance ranking.
 *
 * ## The defect
 *
 * Every other read path pushes `isSuperseded: false` into
 * `graph.queryNodes`'s `NodeFilter`. `rankByFusedRelevance` cannot: it hands
 * its filter to `searchRanked`, which belongs to `@adhd/sox-hybrid-search`'s
 * `StoreSearchBackend` — a different filter contract, owned by a different
 * package, with no `isSuperseded` member. With no candidate-id narrowing it
 * filtered on `{kind:'issue'}` alone, so a superseded row stayed rankable
 * forever and `view:'similar'` returned the SAME logical issue twice: the
 * live row and the frozen pre-edit copy. The stale copy routinely outranks
 * the live one, because its text is what the anchor query resembles.
 *
 * ## What has teeth
 *
 * Both assertions fail if `dropSupersededResults` is removed from
 * `rankByFusedRelevance` (`query/views/semantic.ts`): the result list carries
 * two entries for one issue, and the superseded uid is among them.
 *
 * Real components throughout — real fastembed (`bge-base-en-v1.5`), real
 * Turso vector space, real `createIssue`/`update` writes, and `queryIssues`
 * driven exactly as `api.ts`'s mounted `query` verb drives it. The harness
 * mirrors `text-routing.spec.ts`'s.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
import { update } from '../write/update.js';
import { queryIssues } from './query.js';
import {
  bootstrapSemanticBackend,
  configureSemanticBackend,
} from '../store/semantic-search.js';
import type { GraphBacklogStore } from '../store/graph-backlog-store.js';

const E2E_TIMEOUT = 180_000;
const EMBEDDING = { type: 'fastembed', model: 'bge-base-en-v1.5' } as const;

describe('a body edit leaves nothing superseded in a ranked result (real fastembed + real Turso vectors)', () => {
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
    'an edited issue appears exactly once, as its successor — never alongside its own superseded row',
    async () => {
      dir = freshTmpDir('superseded-ranking');
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
      const handle = { ...bareStore, embedding: backend, search };
      store = bareStore;

      const { projectUid } = await seedProject(
        bareStore,
        'superseded-ranking-project'
      );

      const filed = await createIssue(handle, {
        project: projectUid,
        title: 'Vector index refuses a dimension mismatch',
        body: 'Inserting an embedding whose length differs from the configured space dimension is rejected structurally.',
        by: 'filer',
        awaitEmbed: true,
      });
      if (!filed.created || !filed.uid)
        throw new Error(
          `expected the issue to be created, got ${JSON.stringify(filed)}`
        );
      const supersededUid = filed.uid;

      // One body edit: mints the successor, leaves the original live by
      // `t_invalid` and rankable by everything except `isSuperseded`.
      const edited = await update(handle, {
        uid: supersededUid,
        by: 'editor',
        body: 'Inserting an embedding whose length differs from the configured space dimension is rejected structurally, with the expected and actual lengths both named.',
        awaitEmbed: true,
      });
      expect(edited.uid).not.toBe(supersededUid); // the supersede actually happened

      // `view:'similar'` with a BARE `filter.semantic` is the path under test.
      // `resolveSimilarFilterIds` returns `undefined` for a filter carrying no
      // edge-scoped or scalar member, so `rankByFusedRelevance` takes its
      // `{kind:'issue'}` branch — the one with no candidate-id narrowing, where
      // `searchRanked` is free to rank every issue row in the space including
      // the superseded one. Driving `{text}` instead proves nothing here: that
      // routes to the keyword path, which filters on `graph.queryNodes`'s own
      // `isSuperseded` and would stay green with this fix removed.
      const queried = await queryIssues(handle, {
        view: 'similar',
        filter: {
          semantic:
            'the embedding length does not match the configured dimension',
        },
      });
      if (queried.view !== 'similar')
        throw new Error(`expected view 'similar', got '${queried.view}'`);
      const uids = queried.items.map((i) => i.uid);

      // One logical issue exists, so the ranked page holds exactly one row.
      expect(uids).toHaveLength(1);
      expect(uids[0]).toBe(edited.uid);
      // Stated separately: the failure mode is the STALE uid surviving, and a
      // length check alone would pass if the two rows were swapped.
      expect(uids).not.toContain(supersededUid);
    },
    E2E_TIMEOUT
  );
});
