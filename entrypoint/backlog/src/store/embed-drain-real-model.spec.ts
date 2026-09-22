/**
 * embed-drain-real-model.spec.ts — the close-time embed drain proven
 * end-to-end against the REAL embedding stack: real
 * `@adhd/sox-embedding-provider` (fastembed, bge-base-en-v1.5, 768-dim ONNX),
 * real `@adhd/sox-vector-store` Turso vector backend, a real store opened
 * through the production `openGraphBacklogStore` factory, and — for the
 * strongest form — the REAL BUILT `dist/index.js` bin as a genuine child
 * process.
 *
 * ## What this proves that the fake-backed suite cannot
 *
 * `embed-drain.spec.ts` proves the drain's *mechanics* with a deterministic
 * fake backend. It cannot prove the one-shot production path actually works:
 * a fake can fake a vector the real model would never produce. These tests
 * drive the real consumer seam — `create` WITHOUT `awaitEmbed` through
 * `api.ts`'s production handle, and a spawned `backlog create` — then close
 * through the real drain and assert the item is semantically reachable from a
 * fresh store. That is the outcome a one-shot host depends on.
 *
 * ## Why this runs by DEFAULT, with no env flag
 *
 * AGENTS.md's "Live testing is mandatory" allows an env gate for exactly one
 * reason: a PAID or EXTERNAL third-party service. fastembed is neither — it is
 * local ONNX inference over a model already cached on disk. So these run
 * unflagged, and if the model or the optional packages are missing they FAIL
 * LOUDLY (the explicit `bootstrapSemanticStoreMembers` precondition below)
 * rather than skipping.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openGraphBacklogStore,
  closeGraphBacklogStore,
  type GraphBacklogStore,
} from './graph-backlog-store.js';
import { buildBacklogEnv } from '../env.js';
import { create, query, upsertProject, type BacklogCtx } from '../api.js';
import { bootstrapSemanticStoreMembers } from '../write/bootstrap.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { seedProject } from '../test/helpers/open-test-issue-store.js';
import {
  mintBacklogSandbox,
  runInBacklogSandbox,
} from '../test/helpers/spawn-backlog-bin.js';
import { isOutcomeOk } from '../envelope.js';

const ENV_VAR = 'ADHD_BACKLOG_EMBEDDING_ENABLED';
/** Real cold ONNX model init is the slow part; a cold-load budget, not a hang. */
const E2E_TIMEOUT = 180_000;

/** The text shares NO meaningful token with the created item — only the semantic route can surface it. */
const QUERY_TEXT =
  'manufacturing robot pauses because its turning measurement misbehaves';

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
});
