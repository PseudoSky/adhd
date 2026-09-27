/**
 * create-similar-scope.spec.ts — C9 AC1/AC2/AC3: the create-time advisory scan
 * is scope-aware, cross-project candidates carry provenance, and the scan is
 * ADVISORY (writes no `similar_to` edge, ever).
 *
 * Real components throughout, except the embedding model: a real
 * `GraphBackend`, the real production semantic wiring
 * (`bootstrapSemanticStoreMembers`), a real Turso vector space, and real
 * `createIssue`/`relate` calls. Embeddings are the deterministic fake
 * (`fake-embedding-provider.ts`) — identical text embeds to an identical
 * vector, which is all these equality-shaped assertions need.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BacklogConfig } from '../env.js';
import { resolveProjectPolicy } from './catalog.js';
import { createIssue, type ICreateIssueResult } from './create-issue.js';
import { bootstrapSemanticStoreMembers } from './bootstrap.js';
import { createFakeEmbeddingModule } from '../test/helpers/fake-embedding-provider.js';

// Embeddings mocked here — explicit, scoped user authorization (STATE.md),
// covers embedding cost only.
vi.mock('@adhd/sox-embedding-provider', () => createFakeEmbeddingModule());
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';

const EMBEDDING_CFG: BacklogConfig['embedding'] = {
  enabled: true,
  provider: 'fastembed',
  model: 'bge-base-en-v1.5',
};

type Handle = TestIssueStore & {
  search: NonNullable<TestIssueStore['search']>;
  embedding: NonNullable<TestIssueStore['embedding']>;
};

async function openStore(
  dir: string
): Promise<{ handle: Handle; store: TestIssueStore }> {
  const store = await openTestIssueStore(join(dir, 'backlog.db'));
  const members = await bootstrapSemanticStoreMembers(
    store.adapter,
    store.graph,
    EMBEDDING_CFG
  );
  if (!members.search || !members.embedding)
    throw new Error('create-similar-scope.spec: no semantic search backend');
  const handle: Handle = {
    ...store,
    graph: store.graph,
    search: members.search,
    embedding: members.embedding,
  };
  return { handle, store };
}

async function file(
  handle: Handle,
  projectUid: string,
  title: string,
  body: string,
  extra?: Partial<Parameters<typeof createIssue>[1]>
): Promise<ICreateIssueResult> {
  return createIssue(handle, {
    project: projectUid,
    title,
    body,
    by: 'filer',
    awaitEmbed: true,
    ...extra,
  });
}

async function countLiveEdges(
  store: TestIssueStore,
  rel: string
): Promise<number> {
  const { rows } = await store.adapter.executeAll<{ n: number }>(
    'SELECT COUNT(*) AS n FROM edge WHERE rel = ? AND t_invalid IS NULL',
    [rel]
  );
  return rows[0]?.n ?? 0;
}

let dir: string;
let store: TestIssueStore;
let handle: Handle;

beforeEach(async () => {
  dir = freshTmpDir('create-similar-scope-spec');
  const opened = await openStore(dir);
  handle = opened.handle;
  store = opened.store;
});

afterEach(async () => {
  await store.close();
  removeTestIssueStoreDir(dir);
});

describe('C9 AC1 — default policy is same-project', () => {
  it("resolveProjectPolicy's default similarityScope is 'same-project' and the cross-project threshold differs from the same-project one (AC8)", async () => {
    const { projectUid } = await seedProject(store, 'ac1-default-project');
    const project = await store.graph.getNodeByUid(projectUid);
    if (!project) throw new Error('project row missing');
    const policy = resolveProjectPolicy({
      uid: project.uid,
      rowid: project.id,
      name: project.name ?? '',
      metadata: project.metadata,
    });
    expect(policy.similarityScope).toBe('same-project');
    expect(policy.similarityCrossProjectThreshold).not.toBe(
      policy.dedupeThreshold
    );
  });
});

describe('C9 AC2 — multi-project scope surfaces cross-project candidates with provenance', () => {
  it('policy multi-project + shared repoUrl surfaces an identical item in a sibling project as a cross-project candidate', async () => {
    const a = await seedProject(store, 'ac2-project-a', {
      repoUrl: 'shared-repo',
      policy: { similarityScope: 'multi-project' },
    });
    const b = await seedProject(store, 'ac2-project-b', {
      repoUrl: 'shared-repo',
    });

    const seededB = await file(handle, b.projectUid, 'shared refile title', 'shared refile body');
    expect(seededB.created).toBe(true);

    const createdA = await file(
      handle,
      a.projectUid,
      'shared refile title',
      'shared refile body'
    );
    expect(createdA.created).toBe(true);
    expect(createdA.similarCandidates?.length).toBeGreaterThan(0);
    const candidate = createdA.similarCandidates![0];
    expect(candidate.scope).toBe('cross-project');
    expect(candidate.provenance?.projectUid).toBe(b.projectUid);
    expect(candidate.provenance?.repoUrl).toBe('shared-repo');
  });

  it('policy same-project on the SAME fixture surfaces no cross-project candidate', async () => {
    const a = await seedProject(store, 'ac2-project-c', {
      repoUrl: 'shared-repo',
    });
    const b = await seedProject(store, 'ac2-project-d', {
      repoUrl: 'shared-repo',
    });
    await file(handle, b.projectUid, 'same-project title', 'same-project body');

    const createdA = await file(
      handle,
      a.projectUid,
      'same-project title',
      'same-project body'
    );
    expect(createdA.created).toBe(true);
    expect(createdA.similarCandidates ?? []).toEqual([]);
  });
});

describe('C9 AC3 — the scan is advisory and writes nothing', () => {
  it('a create that surfaces a cross-project candidate writes NO similar_to edge and never duplicate_of', async () => {
    const a = await seedProject(store, 'ac3-project-a', {
      repoUrl: 'ac3-shared',
      policy: { similarityScope: 'multi-project' },
    });
    const b = await seedProject(store, 'ac3-project-b', { repoUrl: 'ac3-shared' });
    await file(handle, b.projectUid, 'advisory title', 'advisory body');

    const beforeSimilar = await countLiveEdges(store, 'similar_to');
    const beforeDuplicate = await countLiveEdges(store, 'duplicate_of');

    const created = await file(
      handle,
      a.projectUid,
      'advisory title',
      'advisory body'
    );
    expect(created.created).toBe(true);
    expect(created.similarCandidates?.length).toBeGreaterThan(0);

    expect(await countLiveEdges(store, 'similar_to')).toBe(beforeSimilar);
    expect(await countLiveEdges(store, 'duplicate_of')).toBe(beforeDuplicate);
  });

  it("duplicateAction:'comment' with a cross-project top candidate is rejected InvalidArgumentError('duplicateAction')", async () => {
    const a = await seedProject(store, 'ac3-project-c', {
      repoUrl: 'ac3-shared-2',
      policy: { similarityScope: 'multi-project' },
    });
    const b = await seedProject(store, 'ac3-project-d', {
      repoUrl: 'ac3-shared-2',
    });
    await file(handle, b.projectUid, 'comment-guard title', 'comment-guard body');

    await expect(
      file(handle, a.projectUid, 'comment-guard title', 'comment-guard body', {
        duplicateAction: 'comment',
      })
    ).rejects.toThrow(/duplicateAction/);
  });
});
