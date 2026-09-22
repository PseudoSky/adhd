/**
 * api.semantic-production-seam.spec.ts — the PRODUCTION semantic seam
 * (`write/bootstrap.ts`'s `bootstrapSemanticStoreMembers`) proven end-to-end
 * against the REAL embedding stack: real `@adhd/sox-embedding-provider`
 * (fastembed, bge-base-en-v1.5, 768-dim ONNX), real `@adhd/sox-vector-store`
 * Turso vector backend, a real store opened through the production
 * `openGraphBacklogStore` factory, and the real `api.ts` verb surface
 * (`upsertProject`/`create`/`query`) driven exactly as a host drives it.
 *
 * ## Why this file exists
 *
 * `write/bootstrap.spec.ts` verifies this same production seam, but with the
 * embedding MODEL faked. The only real-model spec (`store/rag-e2e.spec.ts`)
 * drives the LEGACY module-level seam (`bootstrapSemanticBackend` +
 * `configureSemanticBackend` + a hand-built handle) that this wave made dead.
 * So the seam production actually runs on — `api.ts`'s `writeHandle`/
 * `queryHandle` deriving `search`/`embedding` from
 * `bootstrapSemanticStoreMembers` — had never once been exercised with a real
 * model. This file closes that gap.
 *
 * ## Why this runs by DEFAULT, with no env flag
 *
 * AGENTS.md's "Live testing is mandatory" allows an env gate for exactly one
 * reason: a PAID or EXTERNAL third-party service. fastembed is neither — it is
 * local ONNX inference over a model already cached on disk, costing nothing
 * per run and reachable with no network. "It's slow", "it loads a model",
 * "it needs a native module" are explicitly named in AGENTS.md as the
 * rationalizations that produce the blind spot this file exists to close. So
 * it runs unflagged, and if the model or the optional packages are missing it
 * FAILS LOUDLY (the explicit `bootstrapSemanticStoreMembers` precondition
 * below) rather than skipping.
 *
 * ## The outcome asserted
 *
 * One `create` with `awaitEmbed:true` through the production seam, then one
 * BARE `text:` query routed through the semantic path. The query text shares
 * no meaningful token with the created item, so the grep channel provably
 * cannot surface it (asserted as a negative control) — only the semantic
 * route can. `searchRanked` (called by the semantic channel ONLY) is the exact
 * route discriminator, and the created item is returned.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreSearchBackend } from '@adhd/sox-hybrid-search';
import {
  openGraphBacklogStore,
  closeGraphBacklogStore,
  type GraphBacklogStore,
} from './store/graph-backlog-store.js';
import { buildBacklogEnv } from './env.js';
import { create, query, upsertProject, type BacklogCtx } from './api.js';
import { bootstrapSemanticStoreMembers } from './write/bootstrap.js';
import { freshTmpDir } from './test/helpers/tmp-store.js';
import { isOutcomeOk } from './envelope.js';

const ENV_VAR = 'ADHD_BACKLOG_EMBEDDING_ENABLED';
/** Real cold ONNX model init is the slow part; mirrors rag-e2e.spec.ts's budget. */
const E2E_TIMEOUT = 180_000;

interface Harness {
  ctx: BacklogCtx;
  store: GraphBacklogStore;
  dir: string;
}

async function openCtx(name: string): Promise<Harness> {
  const dir = freshTmpDir(name);
  const store = await openGraphBacklogStore(join(dir, 'backlog.db'));
  const env = buildBacklogEnv({ adhdRoot: dir });
  return { ctx: { store, env }, store, dir };
}

describe('api.ts production semantic seam — real fastembed, no fake provider', () => {
  let h: Harness | undefined;
  let prevEnvVar: string | undefined;

  beforeEach(() => {
    prevEnvVar = process.env[ENV_VAR];
    process.env[ENV_VAR] = 'true';
  });

  afterEach(async () => {
    if (h) {
      await closeGraphBacklogStore(h.store);
      rmSync(h.dir, { recursive: true, force: true });
      h = undefined;
    }
    if (prevEnvVar === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prevEnvVar;
  });

  it(
    'a create() with awaitEmbed:true is then found by a bare text: query on the semantic route (grep cannot find it)',
    async () => {
      h = await openCtx('api-semantic-production-seam');
      const { ctx } = h;

      // Fail LOUDLY (never skip) if the real backend is unavailable — the
      // exact production bootstrap `create`/`query` derive their members from.
      const members = await bootstrapSemanticStoreMembers(
        h.store.adapter,
        h.store.graph,
        ctx.env.config.embedding
      );
      if (!members.search || !members.embedding) {
        throw new Error(
          'real semantic backend unavailable: bootstrapSemanticStoreMembers returned no search/embedding members — is fastembed + the bge-base-en-v1.5 model available?'
        );
      }

      const proj = await upsertProject(ctx, { name: 'P', by: 't' });
      expect(isOutcomeOk(proj), JSON.stringify(proj)).toBe(true);

      // The production seam's write path: `create` is `needsSemantic: true`
      // (api.ts:464), so this bootstraps the (memoized) provider and lands the
      // item's vector durably via `awaitEmbed:true`.
      const created = await create(ctx, {
        title: 'Widget conveyor halts on torque sensor drift',
        body: 'The assembly line stops when the rotational gauge reading wanders beyond tolerance.',
        project: 'P',
        by: 't',
        awaitEmbed: true,
      });
      expect(isOutcomeOk(created), JSON.stringify(created)).toBe(true);
      if (!isOutcomeOk(created) || created.data.uid === undefined) {
        throw new Error(
          `create did not mint an issue: ${JSON.stringify(created)}`
        );
      }
      const uid = created.data.uid;

      // Deliberately shares NO meaningful token with the item above
      // ("manufacturing"/"robot"/"turning"/"measurement" vs
      // "Widget"/"conveyor"/"torque"/"gauge"): a keyword/FTS query cannot rank
      // it. Only the semantic route can surface it.
      const queryText =
        'manufacturing robot pauses because its turning measurement misbehaves';

      // Negative control: an explicit grep filter over the SAME text finds no
      // trace of the item — proving the positive assertion below is the
      // SEMANTIC route doing the work, not a coincidental keyword match.
      const grepRes = await query(ctx, { filter: { grep: queryText } });
      expect(isOutcomeOk(grepRes), JSON.stringify(grepRes)).toBe(true);
      if (
        isOutcomeOk(grepRes) &&
        grepRes.data.view === 'list' &&
        'items' in grepRes.data
      ) {
        expect(grepRes.data.items.map((i) => i.uid)).not.toContain(uid);
      }

      // The bare `text:` positional routes through the semantic path: the
      // space now holds the created vector, so `resolveTextInput` picks
      // semantic, and `searchRanked` (the semantic channel ONLY) runs.
      const spy = vi.spyOn(StoreSearchBackend.prototype, 'searchRanked');
      try {
        const res = await query(ctx, { text: queryText });
        expect(isOutcomeOk(res), JSON.stringify(res)).toBe(true);
        if (
          !isOutcomeOk(res) ||
          res.data.view !== 'list' ||
          !('items' in res.data)
        ) {
          throw new Error(`expected view 'list', got ${JSON.stringify(res)}`);
        }
        // The semantic ranker was entered exactly once …
        expect(spy).toHaveBeenCalledTimes(1);
        // … and the consumer-visible outcome: the created item is found.
        expect(res.data.items.map((i) => i.uid)).toContain(uid);
      } finally {
        spy.mockRestore();
      }
    },
    E2E_TIMEOUT
  );
});
