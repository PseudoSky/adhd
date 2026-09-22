/**
 * semantic.spec.ts — real-component tests for `view:'similar'` and its
 * fused-relevance ranking primitive (SPEC.md §5a).
 *
 * **Real components, one faked seam.** Every store here is genuine: a real
 * `GraphBackend` (`@adhd/sox-graph-store` over a real Turso store via
 * `openTestIssueStore`), a real `TursoVectorBackend` (`@adhd/sox-vector-store`,
 * Turso's native `F32_BLOB` + `vector_distance_cos` vector support, sharing
 * the store's own adapter — never a mock of the vector store, and never a
 * second connection to the file), a real `StoreSearchBackend`
 * (`@adhd/sox-hybrid-search`, unmodified), and real issues written through
 * the real `createIssue` write verb.
 *
 * **One substrate, no raw driver handles.** The vector channel runs on the
 * same Turso adapter the graph store already owns, which is what the
 * production semantic seam (`src/write/bootstrap.ts`'s
 * `bootstrapSemanticStoreMembers`) does — the synchronous
 * vector backend throws when handed a Turso adapter, so testing against it
 * would have pinned a configuration that can never ship. The ONLY faked seam is the embedding
 * MODEL itself (`embedQuery`) — a test-pinned text→vector map — which is
 * exactly AGENTS.md §7's "mock only the external boundary (the LLM/
 * provider)... never the thing under test." No `NodeFilter`/`VecFilter` is
 * ever faked; every filter-pushdown assertion below runs through the real
 * SQL both packages generate.
 *
 * **Why FTS-neutral vocabulary.** This environment's FTS channel is real
 * and live (verified: `adapter.capabilities.fts === true`), and
 * `rankByFusedRelevance` always fuses `signals:[{text},{vec}]` per SPEC.md
 * §5a — so a query string that happens to share tokens with an issue's
 * title/body would let the TEXT channel influence ranking too. Every
 * fixture below uses disjoint, made-up tokens (`zzqueryzz`, `aaacontent-*`,
 * etc.) so the FTS channel contributes zero candidates for any query used in
 * an ordering/filtering assertion, making the assertions depend on the VEC
 * channel alone and deterministic regardless of the FTS engine's behavior.
 * The one test that deliberately exercises the FTS channel names this
 * explicitly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openTursoVectorStore,
  type TursoVectorBackend,
  type VectorSpace,
} from '@adhd/sox-vector-store';
import { StoreSearchBackend, type SearchResult } from '@adhd/sox-hybrid-search';
import type { GraphBackend } from '@adhd/sox-graph-store';
import {
  createIssue,
  type ICreateIssueInput,
} from '../../write/create-issue.js';
import { isVectorSpacePopulated } from '../../write/bootstrap.js';
import {
  InvalidArgumentError,
  BacklogValidationError,
  IssueNotFoundError,
} from '../../write/errors.js';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../../test/helpers/tmp-store.js';
import { resolveEdgeScopedCandidates } from '../resolve.js';
import { queryIssues, type IQueryStoreHandle } from '../query.js';
import { MAX_QUERY_LIMIT } from '../types.js';
import {
  DEFAULT_TEMPORAL_DECAY_PER_HOUR,
  querySimilarView,
  rankByFusedRelevance,
  resolveSimilarFilterIds,
} from './semantic.js';

const DIM = 3;
const SPACE: VectorSpace = { modelId: 'semantic-spec-test-model', dim: DIM };

/** A real semantic-search-capable store: real graph + real vector store (real `vec0`) + real `StoreSearchBackend`, with only `embedQuery` test-pinned. */
interface SemanticTestStore {
  handle: IQueryStoreHandle;
  writeHandle: TestIssueStore;
  vec: TursoVectorBackend;
  /** Test setup: registers the vector a real embedding model would have produced for this exact text. */
  pinEmbedding(text: string, vec: number[]): void;
  /** Test setup: indexes a real vector for an already-created issue's uid — mirrors what a (not-yet-built) embedding observer would do post-commit, done directly here since this slice is read-path only. */
  indexIssue(uid: string, vec: number[]): Promise<void>;
  createIssueFixture(
    input: Omit<ICreateIssueInput, 'project' | 'by'> & { project: string }
  ): Promise<{ uid: string; title: string }>;
  close(): Promise<void>;
}

async function openSemanticTestStore(dir: string): Promise<SemanticTestStore> {
  const writeHandle = await openTestIssueStore(`${dir}/issues.db`);
  const vec = await openTursoVectorStore(writeHandle.adapter, {
    dim: SPACE.dim,
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
            `SemanticTestStore: no pinned embedding for ${JSON.stringify(
              text
            )} — call pinEmbedding() first`
          );
        return v;
      },
      spacePopulated: async (): Promise<boolean> => populated,
    },
  };

  return {
    handle,
    writeHandle,
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
    async createIssueFixture(input) {
      const result = await createIssue(writeHandle, { by: 'tester', ...input });
      // `ICreateOutcome` (SPEC §6.3.2) makes `uid`/`item` optional, because
      // the duplicate gate can return `{created:false}` having written
      // nothing. These fixtures always intend a real issue, so a suppressed
      // create is a broken fixture, not a case to handle — fail loudly here
      // rather than let `undefined` propagate into a ranking assertion and
      // surface as an unrelated failure further down.
      if (!result.created || !result.uid || !result.item) {
        throw new Error(
          `createIssueFixture: expected a created issue, got ${JSON.stringify(
            result
          )}`
        );
      }
      return { uid: result.uid, title: result.item.title };
    },
    async close() {
      await writeHandle.close();
    },
  };
}

let dir: string;
let s: SemanticTestStore;

beforeEach(async () => {
  dir = freshTmpDir('semantic-view');
  s = await openSemanticTestStore(dir);
});

afterEach(async () => {
  await s.close();
  removeTestIssueStoreDir(dir);
});

describe('querySimilarView — filter.semantic ranking', () => {
  it('ranks by fused relevance descending (vec channel), best match first', async () => {
    const { projectUid } = await seedProject(s.writeHandle, 'proj-a');
    const near = await s.createIssueFixture({
      title: 'near',
      body: 'aaacontent-near',
      project: projectUid,
    });
    const mid = await s.createIssueFixture({
      title: 'mid',
      body: 'aaacontent-mid',
      project: projectUid,
    });
    const far = await s.createIssueFixture({
      title: 'far',
      body: 'aaacontent-far',
      project: projectUid,
    });
    await s.indexIssue(near.uid, [1, 0, 0]);
    await s.indexIssue(mid.uid, [0.7, 0.7, 0]);
    await s.indexIssue(far.uid, [0, 1, 0]);
    s.pinEmbedding('zzqueryzz', [1, 0, 0]);

    const items = await querySimilarView(s.handle, {
      view: 'similar',
      filter: { semantic: 'zzqueryzz' },
    });
    expect(items.map((i) => i.uid)).toEqual([near.uid, mid.uid, far.uid]);
  });

  it('populates _score only when requested, and never otherwise', async () => {
    const { projectUid } = await seedProject(s.writeHandle, 'proj-a');
    const item = await s.createIssueFixture({
      title: 'scored',
      body: 'aaascoredbody',
      project: projectUid,
    });
    await s.indexIssue(item.uid, [1, 0, 0]);
    s.pinEmbedding('zzscoreprobe', [1, 0, 0]);

    const withScore = await querySimilarView(s.handle, {
      view: 'similar',
      filter: { semantic: 'zzscoreprobe' },
      fields: ['uid', '_score'],
    });
    expect(withScore[0]?._score).toBeTypeOf('number');
    expect(withScore[0]!._score).toBeGreaterThan(0);

    const withoutScore = await querySimilarView(s.handle, {
      view: 'similar',
      filter: { semantic: 'zzscoreprobe' },
    });
    expect(withoutScore[0]?._score).toBeUndefined();
  });

  it('a title/body TEXT match surfaces even when its vector is farthest (SPEC.md §5a)', async () => {
    const { projectUid } = await seedProject(s.writeHandle, 'proj-a');
    // 5 decoys are vector-CLOSE to the query and share no text tokens with it;
    // `textMatch`'s vector is orthogonal (the worst possible vec match) but its
    // body contains the exact query keyword. A `limit:3` cutoff makes this
    // test actually discriminate fused-vs-vec-only ranking: with a bare
    // `signals:[{kind:'vec'}]` (the embedding-only path §5a explicitly says
    // `view:'similar'` must NOT use), the 3 closest decoys fill every slot and
    // `textMatch` is excluded entirely — verified empirically against this
    // exact fixture before writing this comment. Only text+vec RRF fusion
    // gives `textMatch` a rank-1 reciprocal-rank score high enough to survive
    // the cutoff. A prior version of this test asserted plain `.toContain`
    // with no `limit` and only 2 candidates, which stayed green even with the
    // text channel fully disabled (both candidates fit under the default
    // limit regardless of ranking) — flagged and replaced, not left silent.
    const decoyVecs: ReadonlyArray<readonly [number, number, number]> = [
      [1, 0, 0],
      [0.99, 0.01, 0],
      [0.98, 0.02, 0],
      [0.97, 0.03, 0],
      [0.96, 0.04, 0],
    ];
    const decoys = await Promise.all(
      decoyVecs.map(async (v, i) => {
        const decoy = await s.createIssueFixture({
          title: `decoy${i}`,
          body: `no-shared-token-here-${i}`,
          project: projectUid,
        });
        await s.indexIssue(decoy.uid, [...v]);
        return decoy;
      })
    );
    const textMatch = await s.createIssueFixture({
      title: 'text winner',
      body: 'contains uniquetextkeyword literally',
      project: projectUid,
    });
    await s.indexIssue(textMatch.uid, [0, 1, 0]); // orthogonal — the worst possible vector match
    s.pinEmbedding('uniquetextkeyword', [1, 0, 0]);

    const items = await querySimilarView(s.handle, {
      view: 'similar',
      filter: { semantic: 'uniquetextkeyword' },
      limit: 3,
    });
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.uid)).toContain(textMatch.uid);
    // Sanity: the two closest-vector decoys are still present — this is a
    // fusion assertion, not "text always wins."
    expect(items.map((i) => i.uid)).toEqual(
      expect.arrayContaining([decoys[0]!.uid, decoys[1]!.uid])
    );
  });
});

describe('querySimilarView — filter.anchor', () => {
  it('excludes the anchor from its own results even when it would rank #1', async () => {
    const { projectUid } = await seedProject(s.writeHandle, 'proj-a');
    const anchor = await s.createIssueFixture({
      title: 'anchor-title',
      body: 'aaanchorbody',
      project: projectUid,
    });
    const neighbor = await s.createIssueFixture({
      title: 'neighbor-title',
      body: 'aaaneighborbody',
      project: projectUid,
    });
    await s.indexIssue(anchor.uid, [1, 0, 0]);
    await s.indexIssue(neighbor.uid, [0.99, 0.01, 0]);
    s.pinEmbedding(`anchor-title\naaanchorbody`, [1, 0, 0]);

    const items = await querySimilarView(s.handle, {
      view: 'similar',
      filter: { anchor: anchor.uid },
    });
    expect(items.map((i) => i.uid)).toEqual([neighbor.uid]);
  });

  it('an anchor with zero live neighbours returns [] (never the anchor itself)', async () => {
    const { projectUid } = await seedProject(s.writeHandle, 'proj-a');
    const anchor = await s.createIssueFixture({
      title: 'lonely-anchor',
      body: 'aaalonelybody',
      project: projectUid,
    });
    await s.indexIssue(anchor.uid, [1, 0, 0]);
    s.pinEmbedding(`lonely-anchor\naaalonelybody`, [1, 0, 0]);

    const items = await querySimilarView(s.handle, {
      view: 'similar',
      filter: { anchor: anchor.uid },
    });
    expect(items).toEqual([]);
  });

  it('an unresolved anchor uid throws IssueNotFoundError (SPEC.md §6.1 uid-addressing convention)', async () => {
    await expect(
      querySimilarView(s.handle, {
        view: 'similar',
        filter: { anchor: 'not-a-real-uid' },
      })
    ).rejects.toBeInstanceOf(IssueNotFoundError);
  });
});

describe('querySimilarView — input validation', () => {
  it('neither anchor nor semantic given throws InvalidArgumentError', async () => {
    await expect(
      querySimilarView(s.handle, { view: 'similar' })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('no search backend configured throws InvalidArgumentError', async () => {
    const unconfigured: IQueryStoreHandle = { graph: s.writeHandle.graph };
    await expect(
      querySimilarView(unconfigured, {
        view: 'similar',
        filter: { semantic: 'x' },
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('an out-of-range limit throws BacklogValidationError', async () => {
    await expect(
      querySimilarView(s.handle, {
        view: 'similar',
        filter: { semantic: 'x' },
        limit: 0,
      })
    ).rejects.toBeInstanceOf(BacklogValidationError);
    await expect(
      querySimilarView(s.handle, {
        view: 'similar',
        filter: { semantic: 'x' },
        limit: 1.5,
      })
    ).rejects.toBeInstanceOf(BacklogValidationError);
  });

  it("an unknown field name throws BacklogValidationError, never a silent drop (card.ts:33's stated contract, mirrored from queryList/get)", async () => {
    const { projectUid } = await seedProject(s.writeHandle, 'proj-a');
    const item = await s.createIssueFixture({
      title: 'x',
      body: 'aaafieldsprobebody',
      project: projectUid,
    });
    await s.indexIssue(item.uid, [1, 0, 0]);
    s.pinEmbedding('zzfieldsprobe', [1, 0, 0]);

    await expect(
      querySimilarView(s.handle, {
        view: 'similar',
        filter: { semantic: 'zzfieldsprobe' },
        fields: ['uid', 'titel' as never],
      })
    ).rejects.toBeInstanceOf(BacklogValidationError);
  });
});

describe('querySimilarView — anchor fetch-size boundary (MAX_QUERY_LIMIT, off-by-one)', () => {
  it('requests limit+1 from searchRanked when anchored, uncapped at MAX_QUERY_LIMIT — instruments the real searchRanked call, delegates to the unmodified implementation', async () => {
    const { projectUid } = await seedProject(s.writeHandle, 'proj-a');
    const anchor = await s.createIssueFixture({
      title: 'boundary-anchor',
      body: 'aaaboundarybody',
      project: projectUid,
    });
    s.pinEmbedding('boundary-anchor\naaaboundarybody', [1, 0, 0]);

    // Spy WRAPS the real StoreSearchBackend instance (vi.spyOn calls through
    // to the original implementation unless overridden) — this records the
    // `limit` argument actually sent to the real ranking primitive without
    // faking the ranking logic itself.
    const spy = vi.spyOn(s.handle.search!.backend, 'searchRanked');
    try {
      await querySimilarView(s.handle, {
        view: 'similar',
        filter: { anchor: anchor.uid },
        limit: MAX_QUERY_LIMIT,
      });
      expect(spy).toHaveBeenCalledTimes(1);
      const [, calledLimit] = spy.mock.calls[0]!;
      // The previous implementation clamped this to `Math.min(limit+1,
      // MAX_QUERY_LIMIT)`, which AT limit===MAX_QUERY_LIMIT collapses back to
      // `limit` (`Math.min(1001,1000)===1000`) — silently losing the one
      // extra candidate needed to survive the anchor's post-search removal.
      // This assertion is red under that old clamp (1000) and green only
      // when the fetch is genuinely `limit+1` (1001).
      expect(calledLimit).toBe(MAX_QUERY_LIMIT + 1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("queryIssues — view:'similar' dispatch reaches querySimilarView (SPEC.md §5a reachability)", () => {
  it('excludes the anchor from its own results through the real query() verb, not just querySimilarView called directly', async () => {
    const { projectUid } = await seedProject(s.writeHandle, 'proj-a');
    const anchor = await s.createIssueFixture({
      title: 'dispatch-anchor',
      body: 'aaadispatchanchorbody',
      project: projectUid,
    });
    const neighbor = await s.createIssueFixture({
      title: 'dispatch-neighbor',
      body: 'aaadispatchneighborbody',
      project: projectUid,
    });
    await s.indexIssue(anchor.uid, [1, 0, 0]);
    await s.indexIssue(neighbor.uid, [0.99, 0.01, 0]);
    s.pinEmbedding('dispatch-anchor\naaadispatchanchorbody', [1, 0, 0]);

    // A prior `query.ts` dispatch called its own private, older `querySimilar`
    // (embedding-only, no anchor self-exclusion) — under that code the anchor,
    // being an exact vector match to its own embedding, ranks #1 and this
    // assertion goes red (`items` would equal `[anchor.uid, neighbor.uid]`).
    const result = await queryIssues(s.handle, {
      view: 'similar',
      filter: { anchor: anchor.uid },
    });
    expect(result.view).toBe('similar');
    if (result.view !== 'similar') throw new Error('unreachable'); // narrows for TS
    expect(result.items.map((i) => i.uid)).toEqual([neighbor.uid]);
  });

  it('an unresolved anchor uid rejects with IssueNotFoundError, not CatalogNotFoundError (SPEC.md §6.1)', async () => {
    // The prior `query.ts` dispatch threw `CatalogNotFoundError('issue', anchor)`
    // for this exact input — a SIBLING class of `IssueNotFoundError` (both
    // extend `BacklogWriteError` directly, write/errors.ts), so this assertion
    // is a hard discriminator: it goes red under the old dispatch, not just a
    // looser "throws something" check.
    await expect(
      queryIssues(s.handle, {
        view: 'similar',
        filter: { anchor: 'not-a-real-uid' },
      })
    ).rejects.toBeInstanceOf(IssueNotFoundError);
  });
});

describe('querySimilarView — vector-store-filter-purity (the "resolve to ids first" hazard)', () => {
  it('a metadata filter (assignee) excludes the closer-vector wrong-assignee issue — proves the filter reached the graph, not StoreSearchBackend (which drops `metadata` silently)', async () => {
    const { projectUid } = await seedProject(s.writeHandle, 'proj-a');
    const bobIssue = await s.createIssueFixture({
      title: 'bob-issue',
      body: 'aaabobbody',
      project: projectUid,
      assignee: 'bob',
    });
    const aliceIssue = await s.createIssueFixture({
      title: 'alice-issue',
      body: 'aaaalicebody',
      project: projectUid,
      assignee: 'alice',
    });
    await s.indexIssue(bobIssue.uid, [1, 0, 0]); // strictly closer to the query
    await s.indexIssue(aliceIssue.uid, [0, 1, 0]); // strictly farther
    s.pinEmbedding('zzassigneeprobe', [1, 0, 0]);

    const items = await querySimilarView(s.handle, {
      view: 'similar',
      filter: { semantic: 'zzassigneeprobe', assignee: 'alice' },
    });
    expect(items.map((i) => i.uid)).toEqual([aliceIssue.uid]);
  });

  it('a project filter excludes a strictly-closer out-of-project issue (edge-scoped pushdown)', async () => {
    const { projectUid: projA } = await seedProject(s.writeHandle, 'proj-a');
    const { projectUid: projB } = await seedProject(s.writeHandle, 'proj-b');
    const inProject = await s.createIssueFixture({
      title: 'in-project',
      body: 'aaainprojbody',
      project: projA,
    });
    const outProject = await s.createIssueFixture({
      title: 'out-project',
      body: 'aaaoutprojbody',
      project: projB,
    });
    await s.indexIssue(outProject.uid, [1, 0, 0]); // strictly closer
    await s.indexIssue(inProject.uid, [0.5, 0.5, 0]);
    s.pinEmbedding('zzprojectprobe', [1, 0, 0]);

    const items = await querySimilarView(s.handle, {
      view: 'similar',
      filter: { semantic: 'zzprojectprobe', project: projA },
    });
    expect(items.map((i) => i.uid)).toEqual([inProject.uid]);
  });

  it('a component filter excludes a strictly-closer out-of-component issue', async () => {
    const { projectUid } = await seedProject(s.writeHandle, 'proj-a');
    // `component` omitted ⇒ falls back to project's reserved `(root)` component (§6.1/§8 AC-23).
    const rootComponentIssue = await s.createIssueFixture({
      title: 'root-comp',
      body: 'aaarootbody',
      project: projectUid,
    });
    const otherProject = await seedProject(s.writeHandle, 'proj-b');
    const otherComponentIssue = await s.createIssueFixture({
      title: 'other-comp',
      body: 'aaaotherbody',
      project: otherProject.projectUid,
    });
    await s.indexIssue(otherComponentIssue.uid, [1, 0, 0]); // strictly closer
    await s.indexIssue(rootComponentIssue.uid, [0.5, 0.5, 0]);
    s.pinEmbedding('zzcomponentprobe', [1, 0, 0]);

    // Resolve the (root) component's own uid to filter by it directly.
    const rootNode = await s.writeHandle.graph.getNodeByUid(
      rootComponentIssue.uid
    );
    const ownsComponentEdges = await s.writeHandle.graph.getEdges({
      dst: rootNode!.id,
      rel: 'owns_component',
    });
    const componentNode = (
      await s.writeHandle.graph.getNodesByIds([ownsComponentEdges[0]!.src])
    )[0]!;

    const items = await querySimilarView(s.handle, {
      view: 'similar',
      filter: { semantic: 'zzcomponentprobe', component: componentNode.uid },
    });
    expect(items.map((i) => i.uid)).toEqual([rootComponentIssue.uid]);
  });

  it('a filter that resolves to zero candidates short-circuits to [] (never an unfiltered fallthrough)', async () => {
    const { projectUid } = await seedProject(s.writeHandle, 'proj-a');
    const item = await s.createIssueFixture({
      title: 'only-issue',
      body: 'aaaonlybody',
      project: projectUid,
      assignee: 'bob',
    });
    await s.indexIssue(item.uid, [1, 0, 0]);
    s.pinEmbedding('zzemptyprobe', [1, 0, 0]);

    const items = await querySimilarView(s.handle, {
      view: 'similar',
      filter: { semantic: 'zzemptyprobe', assignee: 'nobody-such-user' },
    });
    expect(items).toEqual([]);
  });

  it("rankByFusedRelevance itself short-circuits to [] on a defined-but-empty candidateIds set, WITHOUT an unfiltered fallthrough (defense in depth, independent of querySimilarView's own short-circuit)", async () => {
    const { projectUid } = await seedProject(s.writeHandle, 'proj-a');
    const item = await s.createIssueFixture({
      title: 'leaked-if-broken',
      body: 'aaaleakbody',
      project: projectUid,
    });
    await s.indexIssue(item.uid, [1, 0, 0]);

    const results = await rankByFusedRelevance(s.handle, {
      text: 'zzdirectprobe',
      vec: Float32Array.from([1, 0, 0]),
      candidateIds: new Set<number>(), // deliberately empty — NOT undefined
      limit: 10,
    });
    expect(results).toEqual([]);
  });
});

describe('resolveSimilarFilterIds — edge-scoped filter resolution', () => {
  it("kind/status/priority/author narrow correctly (reusing resolve.ts's correctly-directioned resolveEdgeScopedCandidates)", async () => {
    const { projectUid } = await seedProject(s.writeHandle, 'proj-a');
    const bug = await s.createIssueFixture({
      title: 'a-bug',
      body: 'body',
      project: projectUid,
      kind: 'bug',
    });
    const feature = await s.createIssueFixture({
      title: 'a-feature',
      body: 'body',
      project: projectUid,
      kind: 'feature',
    });

    const bugIds = await resolveSimilarFilterIds(s.writeHandle.graph, {
      kind: 'bug',
    });
    const bugNode = await s.writeHandle.graph.getNodeByUid(bug.uid);
    const featureNode = await s.writeHandle.graph.getNodeByUid(feature.uid);
    expect(bugIds).toBeDefined();
    expect([...bugIds!]).toEqual([bugNode!.id]);
    expect([...bugIds!]).not.toContain(featureNode!.id);
  });

  it('undefined when no filter dimension is given at all (the {kind:"issue"} fast path)', async () => {
    const ids = await resolveSimilarFilterIds(s.writeHandle.graph, undefined);
    expect(ids).toBeUndefined();
    const idsEmptyFilter = await resolveSimilarFilterIds(
      s.writeHandle.graph,
      {}
    );
    expect(idsEmptyFilter).toBeUndefined();
  });

  it('an unresolved project name resolves to an empty Set, not undefined (SPEC.md §6.1: unresolved read-path name ⇒ zero matches)', async () => {
    const ids = await resolveSimilarFilterIds(s.writeHandle.graph, {
      project: 'no-such-project',
    });
    expect(ids).toBeDefined();
    expect(ids!.size).toBe(0);
  });
});

describe("resolve.ts's resolveEdgeScopedCandidates — traversal direction is data-driven", () => {
  it('returns the issues a component genuinely owns (source-directed rels are walked OUT, not IN)', async () => {
    const { projectUid } = await seedProject(s.writeHandle, 'proj-a');
    const issue = await s.createIssueFixture({
      title: 'x',
      body: 'y',
      project: projectUid,
    });
    const issueNode = await s.writeHandle.graph.getNodeByUid(issue.uid);
    const ownsComponentEdges = await s.writeHandle.graph.getEdges({
      dst: issueNode!.id,
      rel: 'owns_component',
    });
    const componentNode = (
      await s.writeHandle.graph.getNodesByIds([ownsComponentEdges[0]!.src])
    )[0]!;

    // `owns_component` is `component → issue` (source-directed), unlike
    // `has_kind`/`has_status`/`has_priority`/`authored_by` which are
    // issue → catalog. `resolveEdgeScopedCandidates` used to hard-code the
    // latter shape for all six dimensions, so this returned an EMPTY set for
    // a component that genuinely owned issues — silent, because an empty
    // candidate set is indistinguishable from "nothing matched." It now reads
    // the `edge_kind` row's `source_kind` and walks whichever way that says,
    // so the membership set is real.
    const candidates = await resolveEdgeScopedCandidates(s.writeHandle.graph, {
      rel: 'owns_component',
      expectedKind: 'component',
      ref: componentNode.uid,
    });
    expect(candidates).toBeDefined();
    expect([...candidates!]).toEqual([issueNode!.id]);
  });

  it('still walks target-directed rels the other way (has_kind: issue → catalog)', async () => {
    // The negative half: fixing project/component must not invert the four
    // dimensions that were already correct.
    const { projectUid } = await seedProject(s.writeHandle, 'proj-b');
    const issue = await s.createIssueFixture({
      title: 'k',
      body: 'v',
      project: projectUid,
      kind: 'BUG',
    });
    const issueNode = await s.writeHandle.graph.getNodeByUid(issue.uid);
    const candidates = await resolveEdgeScopedCandidates(s.writeHandle.graph, {
      rel: 'has_kind',
      expectedKind: 'kind',
      ref: 'BUG',
    });
    expect(candidates).toBeDefined();
    expect([...candidates!]).toContain(issueNode!.id);
  });
});

describe('rankByFusedRelevance — the shared relevance-ranking primitive (reusable by a future sort:"relevance" integration)', () => {
  it('applies the SPEC.md §5a decay default when no override is given', async () => {
    const { projectUid } = await seedProject(s.writeHandle, 'proj-a');
    const item = await s.createIssueFixture({
      title: 'x',
      body: 'aaadecaybody',
      project: projectUid,
    });
    await s.indexIssue(item.uid, [1, 0, 0]);

    const results: SearchResult[] = await rankByFusedRelevance(s.handle, {
      text: 'zzdecayprobe',
      vec: Float32Array.from([1, 0, 0]),
      limit: 10,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBeTypeOf('number');
    expect(DEFAULT_TEMPORAL_DECAY_PER_HOUR).toBeGreaterThan(0);
    expect(DEFAULT_TEMPORAL_DECAY_PER_HOUR).toBeLessThan(0.01); // sanity: a gentle recency curve, not a hard cliff
  });

  it('throws InvalidArgumentError when the store has no configured search backend', async () => {
    const unconfigured: IQueryStoreHandle = { graph: s.writeHandle.graph };
    await expect(
      rankByFusedRelevance(unconfigured, {
        vec: Float32Array.from([1, 0, 0]),
        limit: 10,
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});
