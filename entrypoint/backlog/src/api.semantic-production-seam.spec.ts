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
 * embedding MODEL faked. The only real-model spec that existed
 * (`store/rag-e2e.spec.ts`, since deleted with the legacy seam) drove the
 * LEGACY module-level seam (`bootstrapSemanticBackend` +
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
 *
 * ## The duplicate gate, proven against the real model
 *
 * The second `describe` block restores the real-model duplicate-gate proof
 * that lived in the deleted `store/rag-e2e.spec.ts` (its DoD#3/DoD#3b): a
 * PARAPHRASE that shares no *meaningful* token with the original is caught by
 * `createIssue`'s gate (`create` suppressed, the original ranked FIRST — a
 * RANK assertion, not mere presence), while an UNRELATED item is not (created,
 * no candidates). It lives in THIS file, not a new one, deliberately: this
 * file already owns the process-wide fastembed child-process singleton
 * (BL-331), so a second real-model spec would spawn a second host and contend
 * for it.
 *
 * Two red-controls guard it, both carried over from the deleted suite:
 *
 *  - **Drop the `{kind:'vec'}` signal** from `create-issue.ts`'s
 *    `scanForDuplicates` and **Test A goes RED**: a text-only hit carries no
 *    `vecScore`, so the gate surfaces no candidate and the paraphrase is
 *    written instead of suppressed.
 *  - **Reintroduce the rank-ladder score** (`r.score / theoreticalMax`, the
 *    RRF-derived value `searchRanked` used to produce) **OR drop the
 *    `score >= policy.dedupeThreshold` check** and **Test B goes RED**: every
 *    member of the returned window scores ≥ 0.93 against the 0.8 default, so
 *    the unrelated "Bananas…" item is wrongly suppressed.
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
import type {
  ICreateIssueInput,
  ICreateIssueResult,
} from './write/create-issue.js';
import { bootstrapSemanticStoreMembers } from './write/bootstrap.js';
import { freshTmpDir } from './test/helpers/tmp-store.js';
import { isOutcomeOk } from './envelope.js';

const ENV_VAR = 'ADHD_BACKLOG_EMBEDDING_ENABLED';
/** Real cold ONNX model init is the slow part; a cold-download/load budget, not a hang. */
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

// ---------------------------------------------------------------------------
// api.ts create duplicate gate — real fastembed paraphrase proof
// ---------------------------------------------------------------------------

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
 *
 * Carried VERBATIM from the deleted `store/rag-e2e.spec.ts` (recovered via
 * `git show 111c19bd^:entrypoint/backlog/src/store/rag-e2e.spec.ts`).
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

const ORIGINAL_TITLE = 'Database connection pool leaks under sustained load';
const ORIGINAL_BODY =
  'Connections are acquired and never returned once the pool is saturated, so the service eventually stalls.';

describe('api.ts create duplicate gate — real fastembed paraphrase proof', () => {
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

  /**
   * Files one issue through the production `create` verb, waiting for its
   * embed/vector-upsert round-trip (`awaitEmbed:true`) so later scans/queries
   * in the same test see it in the real vector space. Fails loudly on a
   * non-ok envelope — a silently-dropped write would otherwise turn a
   * downstream assertion into a false pass.
   */
  async function file(
    ctx: BacklogCtx,
    project: string,
    title: string,
    body: string,
    extra?: Partial<ICreateIssueInput>
  ): Promise<ICreateIssueResult> {
    const res = await create(ctx, {
      project,
      title,
      body,
      by: 'filer',
      awaitEmbed: true,
      ...extra,
    });
    if (!isOutcomeOk(res)) {
      throw new Error(`create failed: ${JSON.stringify(res)}`);
    }
    return res.data;
  }

  /**
   * Seeds the realistic unrelated corpus (see {@link FILLER_ISSUES}) with
   * `duplicateAction:'force'`: corpus construction is setup, not the
   * behaviour under test, and a mid-corpus false-positive between two filler
   * topics must never abort seeding.
   */
  async function seedFillerCorpus(
    ctx: BacklogCtx,
    project: string
  ): Promise<void> {
    for (const [title, body] of FILLER_ISSUES) {
      const result = await file(ctx, project, title, body, {
        duplicateAction: 'force',
      });
      if (!result.created) {
        throw new Error(
          `seedFillerCorpus: filler issue "${title}" unexpectedly failed to write: ${JSON.stringify(
            result
          )}`
        );
      }
    }
  }

  /** Opens the production seam and fails LOUDLY (never skips) if the real backend is unavailable. */
  async function openReadyCtx(name: string): Promise<Harness> {
    const opened = await openCtx(name);
    const members = await bootstrapSemanticStoreMembers(
      opened.store.adapter,
      opened.store.graph,
      opened.ctx.env.config.embedding
    );
    if (!members.search || !members.embedding) {
      throw new Error(
        'real semantic backend unavailable: bootstrapSemanticStoreMembers returned no search/embedding members — is fastembed + the bge-base-en-v1.5 model available?'
      );
    }
    return opened;
  }

  it(
    'the gate CATCHES a paraphrase that shares no meaningful token — suppressed, original ranked FIRST',
    async () => {
      h = await openReadyCtx('api-dup-gate-paraphrase');
      const { ctx } = h;

      const proj = await upsertProject(ctx, { name: 'P', by: 't' });
      expect(isOutcomeOk(proj), JSON.stringify(proj)).toBe(true);

      await seedFillerCorpus(ctx, 'P');

      const original = await file(ctx, 'P', ORIGINAL_TITLE, ORIGINAL_BODY);
      if (!original.created || original.uid === undefined) {
        throw new Error(
          `expected the original to be created, got ${JSON.stringify(original)}`
        );
      }
      const originalUid = original.uid;

      // A true duplicate phrased entirely differently: no shared meaningful
      // token with the original, so the text-only channel cannot surface it on
      // its own. Only the fused vector channel can find this. Default
      // `duplicateAction:'abort'`.
      const paraphraseTitle =
        'Connections are never released back to the pool when saturated';
      const paraphraseBody =
        'Under heavy traffic the service hangs because acquired handles are not returned to the pool.';
      const dup = await file(ctx, 'P', paraphraseTitle, paraphraseBody);

      // The gate fires: the create is suppressed and reports the candidate.
      expect(dup.created).toBe(false);
      expect(dup.reason).toBe('duplicate-suppressed');
      expect(dup.uid).toBeUndefined();
      expect(dup.duplicateCandidates?.length ?? 0).toBeGreaterThan(0);
      // RANK, not mere presence: the ORIGINAL must be the TOP candidate.
      // "candidates.length > 0" alone would pass even if the semantic ranking
      // itself were broken.
      expect(dup.duplicateCandidates?.[0]?.title).toBe(ORIGINAL_TITLE);

      // In-test negative control. The gate's catch must not be a lexical
      // artifact.
      //
      // NOTE (deliberate, empirically-verified deviation from the original
      // plan's phrasing): a grep over the FULL paraphrase text DOES surface
      // the original — the two fixtures share surface tokens ("connections",
      // "pool", "saturated", "returned") and `searchNodes` normalizes a
      // multi-term query to `"tok" OR "tok"` (BL-367). That overlap is exactly
      // why the vec-channel requirement is load-bearing: a text-only hit
      // carries no `vecScore`, and `scanForDuplicates` skips it. The genuine
      // negative control is therefore a grep over the paraphrase's
      // NON-overlapping vocabulary alone — if a purely lexical query cannot
      // surface the original, the gate's catch came from MEANING, not shared
      // words. (Both facts are asserted: the overlap below, then the control.)
      const overlapRes = await query(ctx, {
        filter: { grep: `${paraphraseTitle} ${paraphraseBody}` },
      });
      expect(isOutcomeOk(overlapRes), JSON.stringify(overlapRes)).toBe(true);
      if (
        isOutcomeOk(overlapRes) &&
        overlapRes.data.view === 'list' &&
        'items' in overlapRes.data
      ) {
        // Documents the lexical overlap honestly — the fixtures DO share
        // surface vocabulary, so a text match is not evidence of meaning.
        expect(overlapRes.data.items.map((i) => i.uid)).toContain(originalUid);
      }

      const lexicalOnly = 'released back heavy traffic hangs handles';
      const grepRes = await query(ctx, { filter: { grep: lexicalOnly } });
      expect(isOutcomeOk(grepRes), JSON.stringify(grepRes)).toBe(true);
      if (
        isOutcomeOk(grepRes) &&
        grepRes.data.view === 'list' &&
        'items' in grepRes.data
      ) {
        expect(grepRes.data.items.map((i) => i.uid)).not.toContain(originalUid);
      }
    },
    E2E_TIMEOUT
  );

  it(
    'NEGATIVE CONTROL: an unrelated item is NOT flagged as a duplicate (the threshold has teeth)',
    async () => {
      h = await openReadyCtx('api-dup-gate-unrelated');
      const { ctx } = h;

      const proj = await upsertProject(ctx, { name: 'P', by: 't' });
      expect(isOutcomeOk(proj), JSON.stringify(proj)).toBe(true);

      await seedFillerCorpus(ctx, 'P');

      await file(ctx, 'P', ORIGINAL_TITLE, ORIGINAL_BODY);

      // Semantically unrelated. If the dedupe threshold were removed (or set
      // to 0), the fused search's unconditional top-k would return the pool
      // item here and this create would be wrongly suppressed — exactly what
      // this control detects. Reintroducing the old rank-ladder score does the
      // same (every window member scores ≥ 0.93 against the 0.8 default).
      const unrelated = await file(
        ctx,
        'P',
        'Bananas are a tropical fruit',
        'They are yellow and grow in bunches on large herbaceous plants.'
      );

      expect(unrelated.created).toBe(true);
      expect(unrelated.duplicateCandidates ?? []).toHaveLength(0);
    },
    E2E_TIMEOUT
  );
});
