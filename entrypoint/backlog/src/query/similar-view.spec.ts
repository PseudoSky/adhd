/**
 * similar-view.spec.ts — C9 AC5/AC6 plus the additive `view:'similar'` cluster
 * block. Real store, real `createIssue`/`relate`/`get`/`query`; the cluster
 * scan's similarity channel is a controlled backend where a chosen cosine is
 * the input (the candidates block is about clustering, not the guard, which
 * `similarity-scan.spec.ts` covers).
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SearchQuery, StoreSearchBackend } from '@adhd/sox-hybrid-search';
import { createIssue } from '../write/create-issue.js';
import { relate } from '../write/relate.js';
import { InvalidArgumentError } from '../write/errors.js';
import { getIssue } from './get.js';
import { queryIssues } from './query.js';
import { buildSimilarClusterBlock } from './similar-clusters.js';
import type {
  IIssueCard,
  IIssueQueryResult,
  ISimilarViewClusterBlock,
} from './types.js';
import type { ISimilarityScanHandle } from '../write/similarity-scan.js';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';

type WriteStore = Pick<TestIssueStore, 'adapter' | 'graph' | 'typePolicy'>;

/** Narrow a `query` result to the (non-markdown) list page's items. */
function listItems(result: IIssueQueryResult): IIssueCard[] {
  if (result.view !== 'list' || !('items' in result))
    throw new Error(`expected list, got ${result.view}`);
  return result.items;
}

/** Narrow a `query` result to the similar-view member (with its optional clusters). */
function similarMember(
  result: IIssueQueryResult
): { items: IIssueCard[]; clusters?: ISimilarViewClusterBlock } {
  if (result.view !== 'similar' || !('items' in result))
    throw new Error(`expected similar view, got ${result.view}`);
  return result;
}

function controlledHandle(
  store: TestIssueStore,
  rowScores: ReadonlyMap<number, number>
): ISimilarityScanHandle {
  const backend = {
    async search(_query: SearchQuery, _limit: number) {
      return [...rowScores].map(([id, vecScore]) => ({
        id,
        vecScore,
        score: vecScore,
        fields: {},
      }));
    },
  } as unknown as StoreSearchBackend;
  return {
    graph: store.graph,
    search: { backend, embedQuery: async () => new Float32Array([1]) },
  };
}

async function rowid(store: TestIssueStore, uid: string): Promise<number> {
  const node = await store.graph.getNodeByUid(uid);
  if (!node) throw new Error(`no node for uid ${uid}`);
  return node.id;
}

async function file(
  store: TestIssueStore,
  projectUid: string,
  title: string
): Promise<string> {
  const result = await createIssue(store as unknown as WriteStore, {
    project: projectUid,
    title,
    body: `${title} body`,
    by: 'filer',
  });
  if (!result.created || !result.uid)
    throw new Error(`expected created, got ${JSON.stringify(result)}`);
  return result.uid;
}

let dir: string;
let store: TestIssueStore;
let projectA: string;
let projectB: string;
let issueA: string;
let issueB: string;
let issueC: string;

beforeEach(async () => {
  dir = freshTmpDir('similar-view-spec');
  store = await openTestIssueStore(join(dir, 'backlog.db'));
  projectA = (await seedProject(store, 'similar-view-a')).projectUid;
  projectB = (await seedProject(store, 'similar-view-b')).projectUid;
  issueA = await file(store, projectA, 'view issue A');
  issueB = await file(store, projectA, 'view issue B');
  issueC = await file(store, projectB, 'view issue C');
  // B → A (incoming to A) and A → C (outgoing from A).
  await relate(store as unknown as WriteStore, {
    sourceUid: issueB,
    targetUid: issueA,
    rel: 'similar_to',
    action: 'add',
    by: 'reviewer',
  });
  await relate(store as unknown as WriteStore, {
    sourceUid: issueA,
    targetUid: issueC,
    rel: 'similar_to',
    action: 'add',
    by: 'reviewer',
  });
});

afterEach(async () => {
  await store.close();
  removeTestIssueStoreDir(dir);
});

describe('C9 AC5 — the `similar` card pseudo-field', () => {
  it('get {fields:["similar"]} returns both directions; a card that did not ask for it is unchanged', async () => {
    const card = await getIssue(store.graph, {
      uid: issueA,
      fields: ['uid', 'similar'],
    });
    expect(card.similar?.similarTo.map((r) => r.uid)).toEqual([issueC]);
    expect(card.similar?.similarFrom.map((r) => r.uid)).toEqual([issueB]);
    expect(card.similar?.similarTo[0].projectUid).toBe(projectB);

    const plain = await getIssue(store.graph, {
      uid: issueA,
      fields: ['uid', 'title'],
    });
    expect('similar' in plain).toBe(false);
  });
});

describe('C9 AC6 — similarTo / hasSimilar filter dimensions', () => {
  it('similarTo resolves the SOURCE side; hasSimilar resolves the DST side; both compose with project', async () => {
    const linkedToA = await queryIssues(store, {
      filter: { similarTo: issueA },
    });
    expect(listItems(linkedToA).map((c) => c.uid)).toEqual([issueB]);

    const hasSimilar = await queryIssues(store, {
      filter: { hasSimilar: true },
    });
    expect(new Set(listItems(hasSimilar).map((c) => c.uid))).toEqual(
      new Set([issueA, issueC])
    );

    // Composition with a scalar/edge dimension.
    const composed = await queryIssues(store, {
      filter: { similarTo: issueA, project: projectA },
    });
    expect(listItems(composed).map((c) => c.uid)).toEqual([issueB]);

    // different target: sources into C is A.
    const linkedToC = await queryIssues(store, {
      filter: { similarTo: issueC },
    });
    expect(listItems(linkedToC).map((c) => c.uid)).toEqual([issueA]);
  });
});

describe("C9 — view:'similar' additive cluster block", () => {
  it('a scoped view returns clusters; without the embedding substrate candidate is [] but linked still returns', async () => {
    const result = await queryIssues(store, {
      view: 'similar',
      filter: { project: projectA },
    });
    const sim = similarMember(result);
    expect(sim.clusters).toBeDefined();
    expect(sim.clusters?.candidate).toEqual([]);
    expect(sim.clusters?.linked.length).toBeGreaterThanOrEqual(1);
    const memberUids = new Set(
      sim.clusters!.linked.flatMap((c) => c.members.map((m) => m.uid))
    );
    expect(memberUids.has(issueA)).toBe(true);
  });

  it('candidate clusters are built from the shared scan (controlled cosine)', async () => {
    const issueD = await file(store, projectA, 'view issue D');
    const block = await buildSimilarClusterBlock(
      controlledHandle(
        store,
        new Map([
          [await rowid(store, issueA), 0.99],
          [await rowid(store, issueD), 0.99],
        ])
      ),
      { view: 'similar', filter: { project: projectA }, limit: 50 }
    );
    expect(block).toBeDefined();
    expect(block!.candidate.some((c) => c.members.length >= 2)).toBe(true);
    expect(block!.scanned).toBeGreaterThan(0);
  });

  it('an UNSCOPED view:similar keeps the existing anchor/semantic behaviour (unchanged)', async () => {
    // No scope filter → no cluster block, and the existing
    // `querySimilarViewWithMeta` error path is preserved (no search backend).
    await expect(
      queryIssues(store, { view: 'similar', filter: { semantic: 'anything' } })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});
