/**
 * meta.spec.ts — `queryIssuesWithMeta`'s `meta` contract for `view:'list'`
 * (`envelope.ts`'s `IQueryEnvelopeMeta`; `query.ts`'s `queryList`).
 *
 * Real components throughout: a real store via `openTestIssueStore`/
 * `seedProject`, real `createIssue` writes. The `truncated` case additionally
 * wires a REAL `StoreSearchBackend` over a REAL `TursoVectorBackend`
 * (`@adhd/sox-vector-store`) sharing the store's own adapter — the same
 * pattern `views/semantic.spec.ts` uses — with only the embedding MODEL
 * (`embedQuery`) test-pinned. `searchRanked` itself is never mocked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openTursoVectorStore,
  type TursoVectorBackend,
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
import { isVectorSpacePopulated } from '../write/bootstrap.js';
import { queryIssuesWithMeta, type IQueryStoreHandle } from './query.js';

describe('queryIssuesWithMeta — view:list meta (real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('query-meta');
    store = await openTestIssueStore(`${dir}/backlog.db`);
    projectUid = (await seedProject(store, 'meta-project')).projectUid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  async function mkIssue(title: string): Promise<string> {
    const created = await createIssue(store, {
      project: projectUid,
      title,
      body: `${title} body`,
      by: 'filer',
    });
    return created.uid;
  }

  it('total is the TRUE pre-limit count, not items.length — returned is data.length', async () => {
    const N = 9;
    const k = 4; // k < N: proves total isn't just echoing what came back
    for (let i = 0; i < N; i++)
      await mkIssue(`meta issue ${String(i).padStart(2, '0')}`);

    const { meta } = await queryIssuesWithMeta(store, {
      view: 'list',
      limit: k,
    });

    expect(meta).toBeDefined();
    expect(meta!.total).toBe(N);
    expect(meta!.returned).toBe(k);
    expect(meta!.limit).toBe(k);
  });

  it("an ordinary limited read (caller asked for k of N>k) is NOT truncated — that is the caller's own limit", async () => {
    for (let i = 0; i < 6; i++) await mkIssue(`ordinary issue ${i}`);

    const { meta } = await queryIssuesWithMeta(store, {
      view: 'list',
      limit: 2,
    });

    expect(meta!.total).toBe(6);
    expect(meta!.returned).toBe(2);
    expect(meta!.truncated).toBeUndefined();
  });

  it('meta.offset echoes the effective offset actually applied', async () => {
    for (let i = 0; i < 5; i++) await mkIssue(`offset issue ${i}`);

    const { meta } = await queryIssuesWithMeta(store, {
      view: 'list',
      limit: 2,
      offset: 3,
    });
    expect(meta!.offset).toBe(3);
    expect(meta!.total).toBe(5);
    expect(meta!.returned).toBe(2);
  });

  it('non-list-shaped views (view:"graph") carry no meta — there are no rows to count', async () => {
    await mkIssue('graph issue');
    const outcome = await queryIssuesWithMeta(store, { view: 'graph' });
    expect(outcome.meta).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// truncated: true — the grep+semantic dual-channel intersection loss
// ---------------------------------------------------------------------------

const DIM = 3;
const SPACE = { modelId: 'meta-spec-test-model', dim: DIM } as const;

/** Opens the same real-search topology `views/semantic.spec.ts` uses: real graph, real vector store, real `StoreSearchBackend`, only `embedQuery` pinned. */
async function openSearchableStore(dir: string): Promise<{
  writeHandle: TestIssueStore;
  handle: IQueryStoreHandle;
  vec: TursoVectorBackend;
  pinEmbedding(text: string, v: number[]): void;
  indexIssue(uid: string, v: number[]): Promise<void>;
  close(): Promise<void>;
}> {
  const writeHandle = await openTestIssueStore(`${dir}/issues.db`);
  const vec = await openTursoVectorStore(writeHandle.adapter, {
    dim: DIM,
    modelId: SPACE.modelId,
  });
  const embedMap = new Map<string, Float32Array>();
  let populated = false;

  // `handle.spacePopulated` is the handle-level snapshot `api.ts`'s
  // `queryHandle` sets before the synchronous routing decision reads it. Built
  // directly here (not through `api.ts`), it is a live getter so it flips the
  // moment `indexIssue` seeds a vector — the same per-query truth the real
  // `search.spacePopulated()` probe reads from the vector table.
  const handle: IQueryStoreHandle = {
    graph: writeHandle.graph,
    get spacePopulated(): boolean {
      return populated;
    },
    search: {
      backend: new StoreSearchBackend(vec, writeHandle.graph),
      embedQuery: async (text: string): Promise<Float32Array> => {
        const v = embedMap.get(text);
        if (!v)
          throw new Error(
            `openSearchableStore: no pinned embedding for ${JSON.stringify(
              text
            )}`
          );
        return v;
      },
      spacePopulated: async (): Promise<boolean> => populated,
    },
  };

  return {
    writeHandle,
    handle,
    vec,
    pinEmbedding(text, v) {
      embedMap.set(text, Float32Array.from(v));
    },
    async indexIssue(uid, v) {
      const node = await writeHandle.graph.getNodeByUid(uid);
      if (!node) throw new Error(`indexIssue: no live node for uid ${uid}`);
      await vec.upsert(node.id, Float32Array.from(v), SPACE);
      populated = true;
      // The probe and the flag must agree — otherwise `spacePopulated` is a
      // claim the suite cannot stand behind.
      if (!(await isVectorSpacePopulated(vec, SPACE.modelId))) {
        throw new Error(
          'indexIssue: space reported empty immediately after a successful upsert'
        );
      }
    },
    async close() {
      await writeHandle.close();
    },
  };
}

describe('queryIssuesWithMeta — view:list, filter.grep + filter.semantic together: truncated', () => {
  let dir: string;
  let s: Awaited<ReturnType<typeof openSearchableStore>>;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('query-meta-truncated');
    s = await openSearchableStore(dir);
    projectUid = (await seedProject(s.writeHandle, 'meta-truncated-project'))
      .projectUid;
  });

  afterEach(async () => {
    await s.close();
    removeTestIssueStoreDir(dir);
  });

  it('truncated:true when the grep and semantic channels each independently pre-cap at limit and their intersection drops real matches', async () => {
    // Three issues share the grep token "zzgizmoterm" — a real FTS match for
    // all three. Only ONE is indexed into the vector store; `searchRanked`'s
    // vec channel can only ever rank what is indexed, so it returns exactly
    // that one id, however generous `limit` is. The intersection therefore
    // drops the other two REAL grep matches — not because the caller's
    // `limit` (10) was reached, but because of how the two channels compose.
    const indexed = await createIssue(s.writeHandle, {
      project: projectUid,
      title: 'zzgizmoterm alpha',
      body: 'zzgizmoterm alpha body',
      by: 'filer',
    });
    const unindexedB = await createIssue(s.writeHandle, {
      project: projectUid,
      title: 'zzgizmoterm beta',
      body: 'zzgizmoterm beta body',
      by: 'filer',
    });
    const unindexedC = await createIssue(s.writeHandle, {
      project: projectUid,
      title: 'zzgizmoterm gamma',
      body: 'zzgizmoterm gamma body',
      by: 'filer',
    });
    expect(indexed.uid).not.toBe(unindexedB.uid);
    expect(indexed.uid).not.toBe(unindexedC.uid);

    await s.indexIssue(indexed.uid!, [1, 0, 0]);
    s.pinEmbedding('zzgizmoterm query', [1, 0, 0]);

    const { result, meta } = await queryIssuesWithMeta(s.handle, {
      view: 'list',
      filter: { grep: 'zzgizmoterm', semantic: 'zzgizmoterm query' },
      limit: 10,
    });

    if (result.view !== 'list')
      throw new Error(`expected view 'list', got '${result.view}'`);

    // The true count of issues matching the grep condition (semantic never
    // narrows — see query.ts's own doc comment on this branch).
    expect(meta!.total).toBe(3);
    // Only the vector-indexed issue survives the intersection.
    expect(result.items.map((i) => i.uid)).toEqual([indexed.uid]);
    expect(meta!.returned).toBe(1);
    // 1 < min(total=3, limit=10) — cut short by the channel composition, not by `limit`.
    expect(meta!.truncated).toBe(true);
  });

  it('truncated is absent when the grep+semantic intersection recovers every true match', async () => {
    const only = await createIssue(s.writeHandle, {
      project: projectUid,
      title: 'zzsoloterm only',
      body: 'zzsoloterm only body',
      by: 'filer',
    });
    await s.indexIssue(only.uid!, [1, 0, 0]);
    s.pinEmbedding('zzsoloterm query', [1, 0, 0]);

    const { result, meta } = await queryIssuesWithMeta(s.handle, {
      view: 'list',
      filter: { grep: 'zzsoloterm', semantic: 'zzsoloterm query' },
      limit: 10,
    });

    if (result.view !== 'list')
      throw new Error(`expected view 'list', got '${result.view}'`);
    expect(meta!.total).toBe(1);
    expect(meta!.returned).toBe(1);
    expect(meta!.truncated).toBeUndefined();
  });
});
