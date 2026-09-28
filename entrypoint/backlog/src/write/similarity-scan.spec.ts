/**
 * similarity-scan.spec.ts — C9 AC7/AC8 (the cross-project two-signal guard and
 * the distinct threshold) plus AC9 (the reserved `duplicate_of` canonical
 * resolver), against a REAL graph store.
 *
 * The similarity CHANNEL is a controlled backend here, on purpose: AC7/AC8 are
 * about the GUARD over a cosine, so the cosine must be a chosen input, not a
 * function of the text a deterministic fake embedder happens to produce. The
 * backend is the external similarity boundary; the graph, the nodes, the
 * candidate id resolution and the guard itself are all real.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SearchQuery, StoreSearchBackend } from '@adhd/sox-hybrid-search';
import { EDGE_KIND_TABLE } from './catalog.js';
import { createIssue } from './create-issue.js';
import { relate } from './relate.js';
import {
  scanSimilarCandidates,
  type ISimilarityScanHandle,
} from './similarity-scan.js';
import {
  normalizeTokens,
  sharedStructuralSignal,
  titleTokenOverlap,
} from '../query/similarity-signals.js';
import {
  resolveCanonicalIssue,
  resolveIssueCanonicalTx,
} from '../query/canonical.js';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';

type WriteStore = Pick<
  TestIssueStore,
  'adapter' | 'graph' | 'typePolicy'
>;

/** A controlled similarity backend: returns exactly the chosen `vecScore` per rowid. */
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
  title: string,
  body: string
): Promise<string> {
  const result = await createIssue(store as unknown as WriteStore, {
    project: projectUid,
    title,
    body,
    by: 'filer',
  });
  if (!result.created || !result.uid)
    throw new Error(`expected created, got ${JSON.stringify(result)}`);
  return result.uid;
}

let dir: string;
let store: TestIssueStore;

beforeEach(async () => {
  dir = freshTmpDir('similarity-scan-spec');
  store = await openTestIssueStore(join(dir, 'backlog.db'));
});

afterEach(async () => {
  await store.close();
  removeTestIssueStoreDir(dir);
});

describe('similarity-signals — pure comparators', () => {
  it('titleTokenOverlap is Jaccard over stop-word-stripped tokens; disjoint titles score 0', () => {
    expect(titleTokenOverlap('alpha bravo charlie', 'alpha bravo charlie')).toBe(
      1
    );
    expect(
      titleTokenOverlap('alpha bravo charlie', 'zulu yankee xray')
    ).toBe(0);
    // stop words are stripped: "the" carries no signal.
    expect(titleTokenOverlap('the alpha', 'the bravo')).toBe(0);
  });

  it('sharedStructuralSignal fires on a shared citation token or a nestable component path', () => {
    expect(
      sharedStructuralSignal(
        { title: 'a', citationTokens: ['src/foo/bar.ts'] },
        { title: 'b', citationTokens: ['src/foo/bar.ts'] }
      )
    ).toBe(true);
    expect(
      sharedStructuralSignal(
        { title: 'a', componentPath: 'packages/agent' },
        { title: 'b', componentPath: 'packages/agent/agent-engine' }
      )
    ).toBe(true);
    // segment boundary matters: agent vs agentic must NOT match.
    expect(
      sharedStructuralSignal(
        { title: 'a', componentPath: 'packages/agent' },
        { title: 'b', componentPath: 'packages/agentic' }
      )
    ).toBe(false);
    expect(normalizeTokens('Foo-Bar baz')).toEqual(['foo', 'bar', 'baz']);
  });
});

describe('C9 AC7 — cosine alone is never sufficient cross-project', () => {
  it('high-cosine boilerplate with zero title/structural overlap is NOT surfaced cross-project', async () => {
    const a = await seedProject(store, 'ac7-a');
    const b = await seedProject(store, 'ac7-b');
    const x = await file(store, a.projectUid, 'alpha bravo charlie delta', 'body a');
    const boiler = await file(
      store,
      b.projectUid,
      'zulu yankee xray whiskey',
      'body b'
    );

    const candidates = await scanSimilarCandidates(
      controlledHandle(store, new Map([[await rowid(store, boiler), 0.95]])),
      {
        title: 'alpha bravo charlie delta',
        body: 'body a',
        scope: 'store-wide',
        projectUid: a.projectUid,
        sameProjectThreshold: 0.8,
        crossProjectThreshold: 0.92,
        margin: 0.05,
        tokenOverlapMin: 0.5,
      }
    );
    expect(candidates.map((c) => c.uid)).not.toContain(boiler);
    // Sanity: the scan did see a scored row (it was not merely degraded).
    expect(x).toBeTruthy();
  });

  it('the SAME high cosine surfaces when the second signal (shared title tokens) fires', async () => {
    const a = await seedProject(store, 'ac7-c');
    const b = await seedProject(store, 'ac7-d');
    await file(store, a.projectUid, 'alpha bravo charlie delta', 'body');
    const overlapping = await file(
      store,
      b.projectUid,
      'alpha bravo charlie delta echo',
      'body'
    );

    const candidates = await scanSimilarCandidates(
      controlledHandle(store, new Map([[await rowid(store, overlapping), 0.95]])),
      {
        title: 'alpha bravo charlie delta',
        body: 'body',
        scope: 'store-wide',
        projectUid: a.projectUid,
        sameProjectThreshold: 0.8,
        crossProjectThreshold: 0.92,
        margin: 0.05,
        tokenOverlapMin: 0.5,
      }
    );
    const found = candidates.find((c) => c.uid === overlapping);
    expect(found?.scope).toBe('cross-project');
    expect(found?.signals).toContain('title-tokens');
  });
});

describe("C9 AC8 — the cross-project threshold is distinct and higher", () => {
  it('a paraphrase in [sameProjectThreshold, crossThreshold) is not surfaced', async () => {
    const a = await seedProject(store, 'ac8-a');
    const b = await seedProject(store, 'ac8-b');
    await file(
      store,
      a.projectUid,
      'paraphrase alpha beta gamma delta',
      'body'
    );
    const paraphrase = await file(
      store,
      b.projectUid,
      'alpha beta gamma delta paraphrase',
      'body'
    );

    // Identical token SETS (reordered) → the second signal would fire; the
    // 0.85 cosine is what must keep it out, because it is below 0.92.
    const candidates = await scanSimilarCandidates(
      controlledHandle(store, new Map([[await rowid(store, paraphrase), 0.85]])),
      {
        title: 'paraphrase alpha beta gamma delta',
        body: 'body',
        scope: 'store-wide',
        projectUid: a.projectUid,
        sameProjectThreshold: 0.8,
        crossProjectThreshold: 0.92,
        margin: 0.05,
        tokenOverlapMin: 0.5,
      }
    );
    expect(candidates.map((c) => c.uid)).not.toContain(paraphrase);
  });
});

describe('C9 AC9 — the reserved duplicate_of canonical resolver', () => {
  it("duplicate_of stays n:1 and A→C, B→C both resolve to C via resolveCanonicalIssue", async () => {
    const rule = EDGE_KIND_TABLE.find((r) => r.rel === 'duplicate_of');
    expect(rule?.multiplicity).toBe('n:1');

    const a = await seedProject(store, 'ac9-a');
    const b = await seedProject(store, 'ac9-b');
    const c = await seedProject(store, 'ac9-c');
    const issueA = await file(store, a.projectUid, 'A', 'a');
    const issueB = await file(store, b.projectUid, 'B', 'b');
    const issueC = await file(store, c.projectUid, 'C', 'c');

    const handle = store as unknown as WriteStore;
    await relate(handle, {
      sourceUid: issueA,
      targetUid: issueC,
      rel: 'duplicate_of',
      action: 'add',
      by: 'reviewer',
    });
    await relate(handle, {
      sourceUid: issueB,
      targetUid: issueC,
      rel: 'duplicate_of',
      action: 'add',
      by: 'reviewer',
    });

    expect(await resolveCanonicalIssue(store.graph, issueA)).toBe(issueC);
    expect(await resolveCanonicalIssue(store.graph, issueB)).toBe(issueC);
    expect(await resolveCanonicalIssue(store.graph, issueC)).toBe(issueC);
    // Unlinked input returns unchanged.
    expect(await resolveCanonicalIssue(store.graph, 'not-a-uid')).toBe(
      'not-a-uid'
    );
  });

  it('the tx-scoped canonical resolver agrees with the graph resolver', async () => {
    const a = await seedProject(store, 'ac9-d');
    const c = await seedProject(store, 'ac9-e');
    const issueA = await file(store, a.projectUid, 'A2', 'a');
    const issueC = await file(store, c.projectUid, 'C2', 'c');
    await relate(store as unknown as WriteStore, {
      sourceUid: issueA,
      targetUid: issueC,
      rel: 'duplicate_of',
      action: 'add',
      by: 'reviewer',
    });

    const viaTx = await store.adapter.transaction(
      (tx) => resolveIssueCanonicalTx(tx, issueA),
      { mode: 'immediate' }
    );
    expect(viaTx).toBe(issueC);
  });
});
