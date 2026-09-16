/**
 * bootstrap.spec.ts — proves `write/bootstrap.ts` actually wires `search`/
 * `embedding` through the REAL `api.ts` surface in production shape, not a
 * hand-built handle.
 *
 * Every component here is real: a real Turso-backed `GraphBacklogStore`
 * (open-schema `TypePolicy` — see the header comment below for why),
 * `api.ts`'s own `create`/`query`/`upsertProject` verbs (never `createIssue`/
 * `queryIssues` called directly), and the real fastembed embedding stack
 * (`@adhd/sox-embedding-provider` + `@adhd/sox-vector-store`) via
 * `write/bootstrap.ts`'s `bootstrapSemanticStoreMembers`. Nothing here is
 * mocked. Per AGENTS.md's "Live testing is mandatory": fastembed is local
 * ONNX inference over a model already cached on disk
 * (`~/.cache/sox/models`), never a paid/external service, so this runs
 * unflagged like `rag-e2e.spec.ts` does — no env gate, no skip.
 *
 * **Why the store is NOT opened via `openGraphBacklogStore`/`openTmpStore`.**
 * Both install `DEFAULT_TYPE_POLICY` — `@adhd/sox-graph-store`'s CLOSED
 * six-kind/ten-rel vocabulary (`episode`/`entity`/`claim`/…), which does not
 * include backlog's OWN kinds/rels (`project`/`component`/`issue`/
 * `owns_project`/`has_kind`/…). `write/tx.ts`'s `writeEdgeTx` validates every
 * edge write against the injected `TypePolicy`, so a store opened that way
 * throws `ConstraintError` on the very first `owns_project`/`has_kind` edge
 * `createIssue`/`upsertProject` write — this is a genuine, already-documented
 * gap in `store/graph-backlog-store.ts` (its own doc comment: "Currently
 * `DEFAULT_TYPE_POLICY`... both flip to `OPEN_TYPE_POLICY` together when the
 * §7 wipe removes `repo-nodes.ts`"), tracked there and out of this file's
 * scope to fix. So — exactly like `test/helpers/open-test-issue-store.ts` —
 * this file builds its own `GraphBacklogStore`-shaped object with
 * `OPEN_TYPE_POLICY` injected, the same shape a real store-bootstrap module
 * for `openGraphBacklogStore` itself will eventually install.
 *
 * **Why `ADHD_BACKLOG_EMBEDDING_ENABLED` is set explicitly.** `env.ts`
 * declares `embedding.enabled`'s CODE default as `false`, but `cli.spec.ts`'s
 * own `NO_EMBED` fixture notes the machine-wide GLOBAL-scope config on this
 * box already flips it to `true` — so relying on either the code default or
 * ambient machine state would make this test's embedding-on precondition
 * non-deterministic across machines. This test pins it explicitly, the same
 * way `cli.spec.ts` pins it OFF for its own determinism.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createStoreAdapter, type StoreAdapter } from '@adhd/sox-store-adapter';
import { createGraphBackend, type GraphBackend } from '@adhd/sox-graph-store';
import { OPEN_TYPE_POLICY } from '../store/type-policy.js';
import { buildBacklogEnv } from '../env.js';
import type { GraphBacklogStore } from '../store/graph-backlog-store.js';
import { create, query, upsertProject, type BacklogCtx } from '../api.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { isOutcomeOk } from '../model.js';

/** Cold ONNX model init is the slow part — matches `rag-e2e.spec.ts`'s own shared budget. */
const EMBED_TIMEOUT = 180_000;

const ENV_VAR = 'ADHD_BACKLOG_EMBEDDING_ENABLED';

/** Opens a real `GraphBacklogStore` (OPEN_TYPE_POLICY — see file header) plus a real `BacklogCtx.env` with embeddings pinned on. */
async function openBootstrapTestCtx(name: string): Promise<{ ctx: BacklogCtx; dir: string; adapter: StoreAdapter; graph: GraphBackend }> {
  const dir = freshTmpDir(name);
  const dbPath = join(dir, 'backlog.db');
  const adapter = await createStoreAdapter({ dbPath });
  await adapter.pragmaSet('busy_timeout', 5000);
  const graph = createGraphBackend(adapter, { typePolicy: OPEN_TYPE_POLICY });
  await graph.applySchema();
  const store: GraphBacklogStore = {
    adapter,
    graph,
    typePolicy: OPEN_TYPE_POLICY,
    // No-op: this spec asserts the POST-COMMIT embed round-trip completed on
    // its own (bootstrap.ts awaits it when `awaitEmbed` is set), so a flush
    // here would mask a bootstrap that never scheduled the embed at all.
    flushEmbeds: async () => {
      return undefined;
    },
  };
  const env = buildBacklogEnv({ adhdRoot: dir });
  return { ctx: { store, env }, dir, adapter, graph };
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
      adapter = opened.adapter;
      const ctx = opened.ctx;

      const projectResult = await upsertProject(ctx, { name: 'BOOTSTRAP-WIRING-TEST', by: 'bootstrap.spec' });
      expect(isOutcomeOk(projectResult), JSON.stringify(projectResult)).toBe(true);

      const title = 'Publish gate trips intermittently under machine load';
      const body = 'The release publish gate reports a spurious failure with no code change to explain it.';

      // First create: `awaitEmbed:true` so its on-write vector is durably
      // indexed before the second create's duplicate scan runs — otherwise
      // the fire-and-forget default would make the scan's outcome racy.
      const first = await create(ctx, { title, body, project: 'BOOTSTRAP-WIRING-TEST', by: 'bootstrap.spec', awaitEmbed: true });
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
      const second = await create(ctx, { title, body, project: 'BOOTSTRAP-WIRING-TEST', by: 'bootstrap.spec' });
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
      if (found.data.view !== 'list') throw new Error(`expected view:'list', got view:'${found.data.view}'`);
      expect(found.data.items.map((i) => i.uid)).toContain(firstUid);
    },
    EMBED_TIMEOUT,
  );
});
