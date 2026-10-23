/**
 * guards: a semantic query finds an item only when its vector is durably written by the production write path
 * tier: P
 * cites: 4256bc8b AC1, AC4 (item 4256bc8b-3162-4bab-85de-8fe454724b2c)
 * gap: This cannot be observed at tier S because it loads the real fastembed bge-base-en-v1.5 ONNX model, opens the real Turso vector store, and spawns the built bin as a child process.
 *
 * embed-drain-real-model.e2e.ts — the close-time embed drain and the semantic
 * query route proven end-to-end against the REAL embedding stack: real
 * `@adhd/sox-embedding-provider` (fastembed, bge-base-en-v1.5, 768-dim ONNX),
 * real `@adhd/sox-vector-store` Turso vector backend, a real store opened
 * through the production `openGraphBacklogStore` factory, and the REAL BUILT
 * `dist/index.js` bin as a genuine child process.
 *
 * ## Lane and command
 *
 * This suite runs in the e2e lane, which is CI-only. CI runs it on every
 * presubmit via `npx nx affected -t e2e --parallel=1` (the gate targets in
 * `tools/gate/lane-gate.mjs`) and before publish. It is not part of `nx test`,
 * and the local pre-push hook does not run it. To run it on demand:
 * `npx nx run backlog:e2e`. Lane policy: docs/decisions/0009-test-lanes-unit-vs-e2e.md.
 *
 * red: pending (user hold) — no run is recorded. Command: `npx nx run backlog:e2e`. Expected
 * failing assertions against a base where embedding is disabled or the drain loses the vector:
 * the `toContain(uid)` / `toContain(created.data.uid)` / `toContain(withVectorUid)` checks on
 * the semantic query result (AC4: the item is not found through the semantic route), and in
 * the third case `not.toContain(withoutVectorUid)` guards the reverse (an item whose vector
 * was never written must not surface).
 *
 * ## Budget deviation (G3, G7)
 *
 * Tier P budgets 10 s per test (`docs/standards/testing.md`). Each case here carries a
 * 180 s timeout (`E2E_TIMEOUT`). Justification: cold ONNX model load and first inference
 * of the real bge-base-en-v1.5 model dominate; the model is warmed outside the drain's
 * bound, but the first load on a clean CI runner still exceeds 10 s. The spawned-bin case
 * pays a second cold model init in the child process, and the third (ensureSemanticReady
 * seam) case embeds two items plus the query on a real store. The ceiling is a cold-load
 * bound, not a hang allowance; assertions are unchanged and no case sleeps.
 *
 * No env flag gates these cases. The embedding model is local ONNX inference over
 * a model cached on disk, not a paid or external service. If the model or the
 * optional packages are missing, the cases fail loudly (the explicit
 * `bootstrapSemanticStoreMembers` precondition below) and never skip.
 *
 * ## What this proves that the fake-backed suite cannot
 *
 * `embed-drain.spec.ts` proves the drain's mechanics with a deterministic fake
 * backend. It cannot prove the one-shot production path actually works: a fake
 * can fake a vector the real model would never produce. These tests drive the
 * real consumer seams:
 *
 * - `create` WITHOUT `awaitEmbed` through `api.ts`'s production handle, then a
 *   close through the real drain, and a semantic query from a fresh store;
 * - a spawned `backlog create`;
 * - the `ensureSemanticReady` seam. It is module-private in `api.ts`, so this
 *   suite reaches it through the public `create` and `query` verbs, both of
 *   which call it. The query carries no token shared with the item.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openGraphBacklogStore,
  closeGraphBacklogStore,
  type GraphBacklogStore,
} from '../../../src/store/graph-backlog-store.js';
import { buildBacklogEnv } from '../../../src/env.js';
import { create, query, upsertProject, type BacklogCtx } from '../../../src/api.js';
import { bootstrapSemanticStoreMembers } from '../../../src/write/bootstrap.js';
import { freshTmpDir } from '../../../src/test/helpers/tmp-store.js';
import { seedProject } from '../../../src/test/helpers/open-test-issue-store.js';
import {
  mintBacklogSandbox,
  runInBacklogSandbox,
} from '../../../src/test/helpers/spawn-backlog-bin.js';
import { isOutcomeOk } from '../../../src/envelope.js';

const ENV_VAR = 'ADHD_BACKLOG_EMBEDDING_ENABLED';
/** Real cold ONNX model init is the slow part; a cold-load budget, not a hang. */
const E2E_TIMEOUT = 180_000;

/** The text shares NO meaningful token with the created item — only the semantic route can surface it. */
const QUERY_TEXT =
  'manufacturing robot pauses because its turning measurement misbehaves';

/**
 * Builds a ctx env with the embedding switch forced to `value` for this one
 * build only. `buildBacklogEnv` resolves the cascade at construction, so the
 * override is captured in the returned env and the prior value is restored.
 */
function buildEnvWithEmbedding(adhdRoot: string, value: string) {
  const prev = process.env[ENV_VAR];
  process.env[ENV_VAR] = value;
  try {
    return buildBacklogEnv({ adhdRoot });
  } finally {
    if (prev === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prev;
  }
}

describe('close-time embed drain — real fastembed + spawned bin', () => {
  let prevEnvVar: string | undefined;

  beforeEach(() => {
    prevEnvVar = process.env[ENV_VAR];
    process.env[ENV_VAR] = 'true';
  });

  afterEach(() => {
    if (prevEnvVar === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prevEnvVar;
  });

  it(
    'a fire-and-forget create() through the production seam lands its vector when the store is closed by the drain',
    async () => {
      const dir = freshTmpDir('embed-drain-real-model');
      let store: GraphBacklogStore | undefined;
      try {
        store = await openGraphBacklogStore(join(dir, 'backlog.db'));
        const env = buildBacklogEnv({ adhdRoot: dir });
        const ctx: BacklogCtx = { store, env };

        // Fail LOUDLY (never skip) if the real backend is unavailable.
        const members = await bootstrapSemanticStoreMembers(
          store.adapter,
          store.graph,
          env.config.embedding
        );
        if (!members.search || !members.embedding) {
          throw new Error(
            'real semantic backend unavailable: bootstrapSemanticStoreMembers returned no search/embedding members — is fastembed + the bge-base-v1.5 model available?'
          );
        }
        // Warm the model OUTSIDE the drain's bound: a cold ONNX load inside
        // the timed `create`→close window could otherwise push the embed past
        // the bound. This also leaves the model cached on disk for the spawned
        // bin below.
        await members.embedding.embedDocument('warmup');

        const proj = await upsertProject(ctx, { name: 'P', by: 't' });
        expect(isOutcomeOk(proj), JSON.stringify(proj)).toBe(true);

        // awaitEmbed deliberately OMITTED — the fire-and-forget default.
        const created = await create(ctx, {
          title: 'Widget conveyor halts on torque sensor drift',
          body: 'The assembly line stops when the rotational gauge reading wanders beyond tolerance.',
          project: 'P',
          by: 't',
        });
        expect(isOutcomeOk(created), JSON.stringify(created)).toBe(true);
        if (!isOutcomeOk(created) || created.data.uid === undefined) {
          throw new Error(`create did not mint an issue: ${JSON.stringify(created)}`);
        }
        const uid = created.data.uid;

        // Close through the REAL drain. The embed is settled or recorded; in
        // no case is it lost unrecorded.
        const result = await closeGraphBacklogStore(store);
        expect(result.unrecorded).toHaveLength(0);
        store = undefined; // closed

        // Reopen a fresh store on the SAME file and prove the vector is
        // durable + semantically reachable — the consumer-visible outcome.
        store = await openGraphBacklogStore(join(dir, 'backlog.db'));
        const ctx2: BacklogCtx = { store, env };
        const res = await query(ctx2, { text: QUERY_TEXT });
        expect(isOutcomeOk(res), JSON.stringify(res)).toBe(true);
        if (!isOutcomeOk(res) || res.data.view !== 'list' || !('items' in res.data)) {
          throw new Error(`expected view 'list', got ${JSON.stringify(res)}`);
        }
        expect(res.data.items.map((i) => i.uid)).toContain(uid);
      } finally {
        if (store) await closeGraphBacklogStore(store).catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    E2E_TIMEOUT
  );

  it(
    'a spawned `create` (fire-and-forget) exits 0 with no "unrecorded" on stderr, and a fresh store finds the vector',
    async () => {
      const sandbox = mintBacklogSandbox();
      let store: GraphBacklogStore | undefined;
      try {
        // Seed the project the CLI `create` links against, directly against
        // the sandbox store (never through the CLI), then close it so the
        // spawned process owns the file cleanly.
        const seedStore = await openGraphBacklogStore(sandbox.dbPath);
        await seedProject(seedStore, 'P');
        await closeGraphBacklogStore(seedStore);

        const createRes = runInBacklogSandbox(
          sandbox,
          [
            'create',
            '--input',
            JSON.stringify({
              title: 'Widget conveyor halts on torque sensor drift',
              body: 'The assembly line stops when the rotational gauge reading wanders beyond tolerance.',
              project: 'P',
              by: 'embed-drain-real-model.spec',
            }),
          ],
          // The sandbox's own config forces embedding off; the env override
          // turns it on for this one invocation (the env layer wins).
          { [ENV_VAR]: 'true' }
        );

        expect(
          createRes.status,
          `stderr:\n${createRes.stderr}\nstdout:\n${createRes.stdout}`
        ).toBe(0);
        // The drain must not have reported an unrecorded death (nor a
        // still-pending settle, which on a warm local model should not happen).
        expect(createRes.stderr).not.toContain('UNRECORDED');
        expect(createRes.stderr).not.toContain('unrecorded');
        expect(createRes.stderr).not.toContain('did not settle');

        const created = JSON.parse(createRes.stdout.trim()) as {
          ok: boolean;
          data: { uid: string };
        };
        expect(created.ok).toBe(true);
        expect(created.data.uid).toBeTruthy();

        // Reopen the sandbox store and prove the vector is durable +
        // semantically reachable.
        store = await openGraphBacklogStore(sandbox.dbPath);
        const env = buildBacklogEnv({
          adhdRoot: sandbox.adhdRoot,
          namespace: 'sandbox',
        });
        const ctx: BacklogCtx = { store, env };
        const res = await query(ctx, { text: QUERY_TEXT });
        expect(isOutcomeOk(res), JSON.stringify(res)).toBe(true);
        if (!isOutcomeOk(res) || res.data.view !== 'list' || !('items' in res.data)) {
          throw new Error(`expected view 'list', got ${JSON.stringify(res)}`);
        }
        expect(res.data.items.map((i) => i.uid)).toContain(created.data.uid);
      } finally {
        if (store) await closeGraphBacklogStore(store).catch(() => undefined);
        rmSync(sandbox.adhdRoot, { recursive: true, force: true });
      }
    },
    E2E_TIMEOUT
  );

  it(
    'a query with no shared token finds the created item through the semantic route and not an item whose vector was never written',
    async () => {
      const dir = freshTmpDir('embed-drain-real-model-seam');
      let store: GraphBacklogStore | undefined;
      try {
        const dbPath = join(dir, 'backlog.db');
        const body =
          'The assembly line stops when the rotational gauge reading wanders beyond tolerance.';

        // Item B first, through its OWN store handle opened and closed with embedding OFF.
        // `bootstrapSemanticStoreMembers` memoizes per StoreAdapter and ignores the config on a
        // cache hit, so a vector-less write needs an adapter that never saw embedding on. The
        // store is empty, so the duplicate gate cannot suppress it.
        const offEnv = buildEnvWithEmbedding(dir, 'false');
        store = await openGraphBacklogStore(dbPath);
        const offCtx: BacklogCtx = { store, env: offEnv };
        const proj = await upsertProject(offCtx, { name: 'P', by: 't' });
        expect(isOutcomeOk(proj), JSON.stringify(proj)).toBe(true);
        const withoutVector = await create(offCtx, {
          title: 'Widget conveyor halts on torque sensor drift at line two',
          body,
          project: 'P',
          by: 't',
        });
        expect(isOutcomeOk(withoutVector), JSON.stringify(withoutVector)).toBe(true);
        if (!isOutcomeOk(withoutVector) || withoutVector.data.uid === undefined) {
          throw new Error(`create did not mint an issue: ${JSON.stringify(withoutVector)}`);
        }
        const withoutVectorUid = withoutVector.data.uid;
        const offClosed = await closeGraphBacklogStore(store);
        expect(offClosed.unrecorded).toHaveLength(0);
        store = undefined;

        // Item A: a fresh handle on the SAME file with embedding ON; written with its vector
        // (awaitEmbed) through the production `create`, which reaches `ensureSemanticReady`.
        store = await openGraphBacklogStore(dbPath);
        const env = buildBacklogEnv({ adhdRoot: dir });
        const ctx: BacklogCtx = { store, env };

        // Same fail-loud precondition as the drain case: never skip.
        const members = await bootstrapSemanticStoreMembers(
          store.adapter,
          store.graph,
          env.config.embedding
        );
        if (!members.search || !members.embedding) {
          throw new Error(
            'real semantic backend unavailable: bootstrapSemanticStoreMembers returned no search/embedding members — is fastembed + the bge-base-v1.5 model available?'
          );
        }
        await members.embedding.embedDocument('warmup');

        const withVector = await create(ctx, {
          title: 'Widget conveyor halts on torque sensor drift',
          body,
          project: 'P',
          by: 't',
          awaitEmbed: true,
        });
        expect(isOutcomeOk(withVector), JSON.stringify(withVector)).toBe(true);
        if (!isOutcomeOk(withVector) || withVector.data.uid === undefined) {
          throw new Error(`create did not mint an issue: ${JSON.stringify(withVector)}`);
        }
        const withVectorUid = withVector.data.uid;

        const closed = await closeGraphBacklogStore(store);
        expect(closed.unrecorded).toHaveLength(0);
        store = undefined;

        // Reopen on the SAME file with embedding on; the semantic route is the
        // only route a no-shared-token query can take to A.
        store = await openGraphBacklogStore(join(dir, 'backlog.db'));
        const ctx2: BacklogCtx = { store, env };
        const res = await query(ctx2, { text: QUERY_TEXT });
        expect(isOutcomeOk(res), JSON.stringify(res)).toBe(true);
        if (!isOutcomeOk(res) || res.data.view !== 'list' || !('items' in res.data)) {
          throw new Error(`expected view 'list', got ${JSON.stringify(res)}`);
        }
        const uids = res.data.items.map((i) => i.uid);
        expect(uids).toContain(withVectorUid);
        expect(uids).not.toContain(withoutVectorUid);
      } finally {
        if (store) await closeGraphBacklogStore(store).catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    E2E_TIMEOUT
  );
});
