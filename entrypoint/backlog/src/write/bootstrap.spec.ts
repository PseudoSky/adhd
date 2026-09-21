/**
 * bootstrap.spec.ts — proves `write/bootstrap.ts` actually wires `search`/
 * `embedding` through the REAL `api.ts` surface in production shape, not a
 * hand-built handle.
 *
 * Every component here is real EXCEPT the embedding model itself: a real
 * store opened through the same `openGraphBacklogStore` factory production
 * uses, `api.ts`'s own `create`/`query`/`upsertProject` verbs (never the
 * write-layer internals called directly), a real `@adhd/sox-vector-store`
 * Turso vector space, and real duplicate-gate/on-write-embed wiring via
 * `write/bootstrap.ts`'s `bootstrapSemanticStoreMembers` — the exact
 * production code path. Embeddings mocked here — explicit, scoped user
 * authorization (see entrypoint/backlog/STATE.md), covers embedding cost
 * only: this file's assertions ((a) a BYTE-IDENTICAL second `create` is
 * caught by the duplicate gate, (b) the SAME title text used to create an
 * issue also finds it via `filter.semantic`) never require genuine
 * cross-vocabulary semantic similarity — a deterministic fake that maps
 * identical text to an identical vector is sufficient and has full teeth
 * for both. `text-routing.spec.ts` (paraphrase-with-zero-shared-tokens) and
 * `rag-e2e.spec.ts` are the files that actually need the real model, and
 * neither is touched by this change.
 *
 * **Why `ADHD_BACKLOG_EMBEDDING_ENABLED` is set explicitly.** `env.ts`
 * declares `embedding.enabled`'s CODE default as `false`, but `cli.spec.ts`'s
 * own `NO_EMBED` fixture notes the machine-wide GLOBAL-scope config on this
 * box already flips it to `true` — so relying on either the code default or
 * ambient machine state would make this test's embedding-on precondition
 * non-deterministic across machines. This test pins it explicitly, the same
 * way `cli.spec.ts` pins it OFF for its own determinism.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import {
  openGraphBacklogStore,
  type GraphBacklogStore,
} from '../store/graph-backlog-store.js';
import { buildBacklogEnv } from '../env.js';
import { create, query, upsertProject, type BacklogCtx } from '../api.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { isOutcomeOk } from '../envelope.js';
import { createFakeEmbeddingModule } from '../test/helpers/fake-embedding-provider.js';

// Embeddings mocked here — explicit, scoped user authorization (see
// entrypoint/backlog/STATE.md), covers embedding cost only. Intercepts the
// exact `import('@adhd/sox-embedding-provider')` specifier both
// `write/bootstrap.ts`'s and `store/semantic-search.ts`'s own local
// `loadOptional` seams resolve at runtime (a non-literal dynamic import,
// deliberately decoupled from this package's type graph) — this file never
// installs `@adhd/sox-embedding-provider` at all.
vi.mock('@adhd/sox-embedding-provider', () => createFakeEmbeddingModule());

/** No cold ONNX model init anymore — the fake never touches disk/network — but the real Turso vector-store round-trip still needs headroom. */
const EMBED_TIMEOUT = 30_000;

const ENV_VAR = 'ADHD_BACKLOG_EMBEDDING_ENABLED';

/** Opens a real `GraphBacklogStore` through the production factory plus a real `BacklogCtx.env` with embeddings pinned on. */
async function openBootstrapTestCtx(
  name: string
): Promise<{ ctx: BacklogCtx; dir: string; store: GraphBacklogStore }> {
  const dir = freshTmpDir(name);
  const dbPath = join(dir, 'backlog.db');
  const store = await openGraphBacklogStore(dbPath);
  const env = buildBacklogEnv({ adhdRoot: dir });
  return { ctx: { store, env }, dir, store };
}

describe('write/bootstrap.ts — search/embedding wired through the real api.ts surface', () => {
  let dir: string | undefined;
  let adapter: StoreAdapter | undefined;
  let prevEnvVar: string | undefined;

  afterEach(async () => {
    if (adapter) await adapter.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (prevEnvVar === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prevEnvVar;
    dir = undefined;
    adapter = undefined;
    prevEnvVar = undefined;
  });

  it(
    '(a) a near-duplicate `create` is intercepted by the real duplicate gate, and ' +
      '(b) an issue created through `create` is findable via a `semantic` filter through `query` with NO manual indexing step',
    async () => {
      prevEnvVar = process.env[ENV_VAR];
      process.env[ENV_VAR] = 'true';

      const opened = await openBootstrapTestCtx('bootstrap-spec');
      dir = opened.dir;
      adapter = opened.store.adapter;
      const ctx = opened.ctx;

      const projectResult = await upsertProject(ctx, {
        name: 'BOOTSTRAP-WIRING-TEST',
        by: 'bootstrap.spec',
      });
      expect(isOutcomeOk(projectResult), JSON.stringify(projectResult)).toBe(
        true
      );

      const title = 'Publish gate trips intermittently under machine load';
      const body =
        'The release publish gate reports a spurious failure with no code change to explain it.';

      // First create: `awaitEmbed:true` so its on-write vector is durably
      // indexed before the second create's duplicate scan runs — otherwise
      // the fire-and-forget default would make the scan's outcome racy.
      const first = await create(ctx, {
        title,
        body,
        project: 'BOOTSTRAP-WIRING-TEST',
        by: 'bootstrap.spec',
        awaitEmbed: true,
      });
      expect(isOutcomeOk(first), JSON.stringify(first)).toBe(true);
      if (!isOutcomeOk(first)) throw new Error('unreachable');
      expect(first.data.created).toBe(true);
      const firstUid = first.data.uid;
      expect(firstUid).toBeDefined();

      // (a) — a byte-identical second create must be caught by the duplicate
      // gate (default `duplicateAction:'abort'`): this ONLY happens if
      // `writeHandle(ctx)` handed `createIssue` a real, wired `search`.
      // Before this module existed, `scanForDuplicates` always saw
      // `handle.search === undefined` and returned `[]` unconditionally.
      const second = await create(ctx, {
        title,
        body,
        project: 'BOOTSTRAP-WIRING-TEST',
        by: 'bootstrap.spec',
      });
      expect(isOutcomeOk(second), JSON.stringify(second)).toBe(true);
      if (!isOutcomeOk(second)) throw new Error('unreachable');
      expect(second.data.created).toBe(false);
      expect(second.data.reason).toBe('duplicate-suppressed');
      expect(second.data.duplicateCandidates?.length ?? 0).toBeGreaterThan(0);
      expect(second.data.duplicateCandidates?.[0]?.uid).toBe(firstUid);

      // (b) — the FIRST issue must be findable via `filter.semantic` through
      // `query`, with no separate indexing step run by this test: the only
      // thing that populated the vector space was `create`'s own on-write
      // embed (`embedding-observer.ts`'s `scheduleIssueEmbedding`), which
      // ONLY runs when `writeHandle(ctx)` hands `createIssue` a real, wired
      // `embedding` member.
      const found = await query(ctx, { filter: { semantic: title } });
      expect(isOutcomeOk(found), JSON.stringify(found)).toBe(true);
      if (!isOutcomeOk(found)) throw new Error('unreachable');
      if (found.data.view !== 'list')
        throw new Error(`expected view:'list', got view:'${found.data.view}'`);
      expect(found.data.items.map((i) => i.uid)).toContain(firstUid);
    },
    EMBED_TIMEOUT
  );
});
