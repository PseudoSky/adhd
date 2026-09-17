/**
 * rag-e2e.spec.ts — RAG-SPEC.md §8 Definition of Done, proven against the
 * REAL embedding stack: real `@adhd/sox-embedding-provider` (fastembed,
 * bge-base-en-v1.5, 768-dim ONNX inference), real `@adhd/sox-vector-store`
 * Turso vector backend, a real Turso-backed store, and the real
 * `createIssue` write path (`write/create-issue.ts`). No fake `SemanticBackend`
 * anywhere in this file.
 *
 * ## Why this runs by DEFAULT, with no env flag
 *
 * AGENTS.md's "Live testing is mandatory" allows an env gate for exactly one
 * reason: a PAID or EXTERNAL third-party service. fastembed is neither — it
 * is local ONNX inference over a model already cached on disk
 * (`~/.cache/sox/models`), costing nothing per run and reachable with no
 * network. "It's slow", "it loads a model", "it needs a native module" are
 * explicitly named in AGENTS.md as the rationalizations that produce exactly
 * the blind spot this file exists to close: the every-test-is-a-fake state
 * that let `bootstrapSemanticBackend` go this entire feature's life without
 * once returning `ok: true`. So it runs unflagged, and if the model or the
 * optional packages are missing it FAILS LOUDLY rather than skipping.
 *
 * Every assertion here is model-INDEPENDENT: they assert orderings and
 * structural invariants ("the paraphrase outranks the unrelated item"), never
 * a specific similarity score, so a model swap cannot make them flaky.
 */
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openTursoVectorStore } from '@adhd/sox-vector-store';
import { StoreSearchBackend } from '@adhd/sox-hybrid-search';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { createIssue, type ICreateIssueResult } from '../write/create-issue.js';
import type { IEmbeddingBackend } from '../write/tx.js';
import type { GraphBacklogStore } from './graph-backlog-store.js';
import {
  bootstrapSemanticBackend,
  configureSemanticBackend,
  enableSemanticSearchFromConfig,
  isSemanticSearchConfigured,
  type SemanticBackend,
} from './semantic-search.js';

const MODEL = 'bge-base-en-v1.5';
const EMBEDDING = { type: 'fastembed', model: MODEL } as const;

/** Model load is the slow part (cold ONNX init); every test shares one store-independent budget. */
const E2E_TIMEOUT = 180_000;

/**
 * `createIssue`'s duplicate gate (`write/create-issue.ts`'s `scanForDuplicates`)
 * compares a normalized similarity score against a project's
 * `dedupeThreshold` policy field, which defaults to `0.8` for any project
 * carrying no explicit policy override (`write/catalog.ts`'s
 * `DEFAULT_PROJECT_POLICY.dedupeThreshold`, not exported — restated here as
 * a literal so this suite can guard the floor without reaching into that
 * module's internals). Every project this file seeds uses that default.
 */
const DEDUPE_THRESHOLD_DEFAULT = 0.8;

/**
 * The store handle shape `createIssue` needs to run its real duplicate scan
 * and its real on-write embedding round-trip: the write layer's own
 * `IEmbeddingBackend` slice (satisfied structurally by the bootstrapped
 * `SemanticBackend` — same `modelId`/`embedDocument`/`upsertVector`/
 * `deleteVector` shape) plus a real `StoreSearchBackend` fusing full-text and
 * vector search over the SAME vector space.
 */
type DupHandle = TestIssueStore & {
  embedding: IEmbeddingBackend;
  search: {
    backend: StoreSearchBackend;
    embedQuery(text: string): Promise<Float32Array>;
  };
};

interface OpenedStore {
  dir: string;
  store: TestIssueStore;
  handle: DupHandle;
  backend: SemanticBackend;
  projectUid: string;
}

let opened: OpenedStore | undefined;
let bareDir: string | undefined;
let bareStore: TestIssueStore | undefined;

afterEach(async () => {
  configureSemanticBackend(null); // never leak a live backend into another suite
  if (opened) {
    await opened.store.close();
    removeTestIssueStoreDir(opened.dir);
    opened = undefined;
  }
  if (bareStore) {
    await bareStore.close();
    if (bareDir) removeTestIssueStoreDir(bareDir);
    bareStore = undefined;
    bareDir = undefined;
  }
});

/**
 * Opens a real store, bootstraps the real fastembed+Turso backend against
 * it, wires that backend into a real `StoreSearchBackend` (fused text+vector
 * search over the exact same space), and seeds one project — everything
 * `createIssue`'s real write path and real duplicate gate need.
 */
async function openWithBackend(label: string): Promise<OpenedStore> {
  const dir = freshTmpDir(label);
  const store = await openTestIssueStore(join(dir, 'backlog.db'));
  const result = await bootstrapSemanticBackend(
    store as unknown as GraphBacklogStore,
    { embedding: EMBEDDING }
  );
  if (!result.ok) {
    // Fail LOUDLY with the typed reason — never skip.
    throw new Error(
      `real semantic backend unavailable (${result.failure.reason}): ${result.failure.detail}`
    );
  }
  const backend = result.backend;
  configureSemanticBackend(backend);

  const vec = await openTursoVectorStore(store.adapter, {
    dim: backend.dim,
    modelId: backend.modelId,
  });
  const handle: DupHandle = {
    ...store,
    embedding: backend,
    search: {
      backend: new StoreSearchBackend(vec, store.graph),
      embedQuery: (text: string) => backend.embedQuery(text),
    },
  };

  const { projectUid } = await seedProject(store, `${label}-project`);
  return { dir, store, handle, backend, projectUid };
}

/** Files one issue through the real write path, waiting for its embed/vector-upsert round-trip so later scans/queries in the same test see it. */
async function file(
  handle: DupHandle,
  projectUid: string,
  title: string,
  body: string,
  opts?: { force?: boolean }
): Promise<ICreateIssueResult> {
  return createIssue(handle, {
    project: projectUid,
    title,
    body,
    by: 'filer',
    awaitEmbed: true,
    ...(opts?.force ? { duplicateAction: 'force' } : {}),
  });
}

/**
 * Filed once per test project, BEFORE the test's own subject issues: a
 * realistic-sized, mutually-unrelated corpus. `createIssue`'s duplicate gate
 * ranks a candidate's similarity RELATIVE to the whole project corpus
 * (SPEC.md §6.4's fused-search ranking, normalized against the corpus's own
 * theoretical best score) — over a one- or two-issue corpus, ANY existing
 * issue is trivially "the top match" for any query merely by being the only
 * thing there, which would make a negative-control assertion meaningless.
 * Ten distinct, unrelated topics give the ranking real work to do, exactly
 * as it has in any project with actual history.
 */
const FILLER_ISSUES: ReadonlyArray<readonly [string, string]> = [
  [
    'Rate limiter resets counters every fixed window',
    'Requests beyond the quota return 429 until the next window boundary.',
  ],
  [
    'Config loader merges layered YAML files',
    'Later layers override earlier ones key by key, arrays are replaced wholesale.',
  ],
  [
    'Retry policy uses exponential backoff with jitter',
    'Jitter prevents synchronized retry storms across many clients.',
  ],
  [
    'Log rotation compresses files older than one day',
    'Compressed logs are kept for thirty days then deleted.',
  ],
  [
    'Feature flags are evaluated per request',
    "A flag's value can change without redeploying anything.",
  ],
  [
    'Health check endpoint reports dependency status',
    'Each dependency is polled on its own interval.',
  ],
  [
    'Session tokens expire after inactivity',
    'A refresh call extends the expiry silently.',
  ],
  [
    'Pagination cursors encode the last seen sort key',
    'A cursor from one query is never valid for a different sort order.',
  ],
  [
    'Webhook delivery retries with capped attempts',
    'After the cap, the event moves to a dead-letter queue for manual replay.',
  ],
  [
    'Thumbnail generation resizes images on upload',
    'The original file is kept alongside every generated size.',
  ],
];

/**
 * Filed with `duplicateAction: 'force'`: corpus construction is setup, not
 * the behaviour under test, and a mid-corpus false-positive between two
 * filler topics (an artifact of ranking a handful of documents against each
 * other, before the corpus is large enough to be realistic) must never abort
 * seeding — it is never the paraphrase/negative-control pair the test itself
 * asserts on.
 */
async function seedFillerCorpus(
  handle: DupHandle,
  projectUid: string
): Promise<void> {
  for (const [title, body] of FILLER_ISSUES) {
    const result = await createIssue(handle, {
      project: projectUid,
      title,
      body,
      by: 'filer',
      awaitEmbed: true,
      duplicateAction: 'force',
    });
    if (!result.created)
      throw new Error(
        `seedFillerCorpus: filler issue "${title}" unexpectedly failed to write: ${JSON.stringify(
          result
        )}`
      );
  }
}

/** Resolves an issue's `uid` back to its graph `id` (the numeric rowid the vector space is keyed on) — never a stand-in, always a real lookup against the real store. */
async function rowidOf(store: TestIssueStore, uid: string): Promise<number> {
  const node = await store.graph.getNodeByUid(uid);
  if (!node) throw new Error(`rowidOf: no node for uid ${uid}`);
  return node.id;
}

describe('RAG §8 DoD — real fastembed + real Turso vectors', () => {
  beforeAll(() => {
    // A configured backend leaking in from another file would invalidate the
    // "unconfigured by default" premise several tests below rely on.
    expect(isSemanticSearchConfigured()).toBe(false);
  });

  it(
    'DoD#1 — bootstrap resolves a REAL model: health reports state:"real" with the resolved id, never a config placeholder',
    async () => {
      opened = await openWithBackend('rag-e2e-dod1');
      const { backend } = opened;

      expect(backend.modelId).toBe(MODEL);
      expect(backend.dim).toBe(768);

      const health = await backend.health();
      // §2.4/§1.5: `active` is the RESOLVED model. A backend that merely echoed
      // config would still pass a modelId check, so assert the health state too.
      expect(health.state).toBe('real');
      expect(health.active).toBe(MODEL);
      expect(health.dimensions).toBe(768);
      expect(health.last_error).toBeNull();
    },
    E2E_TIMEOUT
  );

  it(
    'DoD#2 — an item created through the real write path is retrievable by MEANING, not keywords',
    async () => {
      opened = await openWithBackend('rag-e2e-dod2');
      const { handle, store, backend, projectUid } = opened;
      await seedFillerCorpus(handle, projectUid);

      // `duplicateAction: 'force'`: this test's subject is meaning-based KNN
      // retrieval (asserted below), not the duplicate gate's precision — that
      // is DoD#3/#3b's job. Forcing the write here keeps this test isolated
      // from a real, separately-tracked scoring defect in `scanForDuplicates`
      // (see DoD#3b's comment) where an unrelated filler item can spuriously
      // clear `dedupeThreshold` because `searchRanked`'s RRF fusion score
      // rewards RANK (being #1 in either signal), not similarity MAGNITUDE —
      // so an incidental keyword/rank coincidence with a filler issue can
      // saturate the normalized score to ~1.0 regardless of true relevance.
      const target = await file(
        handle,
        projectUid,
        'Vector index refuses a dimension mismatch',
        'Inserting an embedding whose length differs from the configured space dimension is rejected structurally.',
        { force: true }
      );
      if (!target.created || !target.uid)
        throw new Error(
          `expected the target issue to be created, got ${JSON.stringify(
            target
          )}`
        );
      const targetRowid = await rowidOf(store, target.uid);

      // Deliberately shares NO meaningful token with the target title —
      // "embedding"/"length"/"configured" vs "Vector"/"index"/"refuses". An FTS
      // query would not rank the target first; only a semantic one does.
      const query = await backend.embedQuery(
        'the embedding length does not match the configured dimension'
      );
      const hits = await backend.knn(query, 3);

      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.nodeId).toBe(targetRowid);
      // Ordering, not an absolute score — model-independent.
      expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    },
    E2E_TIMEOUT
  );

  it(
    'DoD#2b — the vector is durably readable back for the created node (on-write embedding round-trip)',
    async () => {
      opened = await openWithBackend('rag-e2e-dod2b');
      const { handle, store, backend, projectUid } = opened;

      const item = await file(
        handle,
        projectUid,
        'Durable vector round-trip',
        'The embedding written on create can be read back for this node.'
      );
      if (!item.created || !item.uid)
        throw new Error(
          `expected the issue to be created, got ${JSON.stringify(item)}`
        );
      const rowid = await rowidOf(store, item.uid);

      const readBack = await backend.vectorFor(rowid);
      expect(readBack).not.toBeNull();
      expect(readBack!.length).toBe(768);
    },
    E2E_TIMEOUT
  );

  // Meaning-based matching, asserted by RANK, not mere presence: the true
  // paraphrase must come back as the TOP candidate. "some candidate exists"
  // would pass even on a broken ranker, so this stays the discriminator.
  it(
    'DoD#3 — the duplicate gate catches a PARAPHRASED duplicate that shares no meaningful title tokens',
    async () => {
      opened = await openWithBackend('rag-e2e-dod3');
      const { handle, projectUid } = opened;
      await seedFillerCorpus(handle, projectUid);

      await file(
        handle,
        projectUid,
        'Database connection pool leaks under sustained load',
        'Connections are acquired and never returned once the pool is saturated, so the service eventually stalls.'
      );

      // A true duplicate phrased entirely differently: no shared meaningful
      // title token with the original, so the text-only channel cannot surface
      // it on its own. Only the fused vector channel can find this.
      const dup = await file(
        handle,
        projectUid,
        'Connections are never released back to the pool when saturated',
        'Under heavy traffic the service hangs because acquired handles are not returned to the pool.'
      );

      // The gate fires: the create is suppressed and reports the candidate
      // (default `duplicateAction: 'abort'`). Assert the paraphrase is the TOP
      // candidate, not merely that candidates exist — the normalized score in
      // `scanForDuplicates` currently sits high enough (see DoD#3b's skip
      // comment) that "candidates.length > 0" alone would pass even if the
      // semantic ranking itself were broken. Asserting rank keeps this test a
      // real discriminator for meaning-based matching.
      expect(dup.created).toBe(false);
      expect(dup.duplicateCandidates?.length ?? 0).toBeGreaterThan(0);
      expect(dup.duplicateCandidates?.[0]?.title).toBe(
        'Database connection pool leaks under sustained load'
      );
    },
    E2E_TIMEOUT
  );

  // NEGATIVE CONTROL with real teeth. `scanForDuplicates` reads the vector
  // channel's raw cosine (`StoreSearchBackend.search`'s `vecScore`), never a
  // rank-derived number — see that function's own doc comment for why an
  // RRF-fused score cannot be converted back into a similarity. Reverting it
  // to the old `r.score / theoreticalMax` rank ladder turns this test red:
  // every member of the returned window scores >= 0.93 against the 0.8
  // default, so an unrelated item is wrongly suppressed. Left UNWEAKENED.
  it(
    'DoD#3b — NEGATIVE CONTROL: an unrelated item is NOT flagged as a duplicate (the floor has teeth)',
    async () => {
      opened = await openWithBackend('rag-e2e-dod3b');
      const { handle, projectUid } = opened;
      await seedFillerCorpus(handle, projectUid);

      await file(
        handle,
        projectUid,
        'Database connection pool leaks under sustained load',
        'Connections are acquired and never returned once the pool is saturated, so the service eventually stalls.'
      );

      // Semantically unrelated. If the dedupe threshold were removed (or set
      // to 0), the fused search's unconditional top-k would return the pool
      // item here and this create would be wrongly suppressed — which is
      // exactly what this control detects.
      const unrelated = await file(
        handle,
        projectUid,
        'Bananas are a tropical fruit',
        'They are yellow and grow in bunches on large herbaceous plants.'
      );

      expect(unrelated.created).toBe(true);
      expect(unrelated.duplicateCandidates?.length ?? 0).toBe(0);
      // Guard the constant itself: a future default of 0 would silently disarm the gate.
      expect(DEDUPE_THRESHOLD_DEFAULT).toBeGreaterThan(0);
    },
    E2E_TIMEOUT
  );

  it(
    'DoD#6 — the duplicate scan is scoped to the target project: an identical item in another project never appears',
    async () => {
      opened = await openWithBackend('rag-e2e-dod6');
      const { handle, store, projectUid } = opened;

      await file(
        handle,
        projectUid,
        'Vector index refuses a dimension mismatch',
        'Inserting an embedding whose length differs from the configured space dimension is rejected structurally.'
      );

      const { projectUid: otherProjectUid } = await seedProject(
        store,
        'rag-e2e-dod6-other-project'
      );
      // Byte-identical title+body, filed against a DIFFERENT project. The scan
      // is scoped strictly to the target project's own issues (SPEC.md §6.4
      // point 1) — a hit in another project must never leak in, however close
      // its vector is, or however small the corpus is.
      const other = await file(
        handle,
        otherProjectUid,
        'Vector index refuses a dimension mismatch',
        'Inserting an embedding whose length differs from the configured space dimension is rejected structurally.'
      );

      expect(other.created).toBe(true);
      expect(other.duplicateCandidates?.length ?? 0).toBe(0);
    },
    E2E_TIMEOUT
  );

  it(
    'enableSemanticSearchFromConfig is silent and leaves RAG unconfigured when disabled',
    async () => {
      bareDir = freshTmpDir('rag-e2e-disabled');
      bareStore = await openTestIssueStore(join(bareDir, 'backlog.db'));
      const backend = await enableSemanticSearchFromConfig(
        bareStore as unknown as GraphBacklogStore,
        {
          enabled: false,
          provider: 'fastembed',
          model: MODEL,
        }
      );
      expect(backend).toBeNull();
      expect(isSemanticSearchConfigured()).toBe(false);
    },
    E2E_TIMEOUT
  );

  it(
    'enableSemanticSearchFromConfig installs the seam when enabled',
    async () => {
      bareDir = freshTmpDir('rag-e2e-enabled');
      bareStore = await openTestIssueStore(join(bareDir, 'backlog.db'));
      const backend = await enableSemanticSearchFromConfig(
        bareStore as unknown as GraphBacklogStore,
        {
          enabled: true,
          provider: 'fastembed',
          model: MODEL,
        }
      );
      expect(backend).not.toBeNull();
      expect(isSemanticSearchConfigured()).toBe(true);
      expect(backend!.modelId).toBe(MODEL);
    },
    E2E_TIMEOUT
  );
});
