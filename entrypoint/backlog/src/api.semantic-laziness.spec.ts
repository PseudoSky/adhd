/**
 * api.semantic-laziness.spec.ts — the gate for the "empty vector space at
 * startup ⇒ grep-only for the whole process lifetime" defect the removal-pass
 * wave fixes.
 *
 * ## The defect
 *
 * `resolveTextInput` (`query/query.ts`) decides whether `input.text` routes to
 * `filter.semantic` or `filter.grep` by consulting `isSemanticSearchReadable()`
 * — a PROCESS-GLOBAL singleton flag (`store/semantic-search.ts`) that a host
 * sets once at startup from a single space probe. A host that boots against a
 * store whose vector space is empty at that instant latches `false` for the
 * entire process lifetime, so every `text:` search degrades to grep even after
 * `create`'s own on-write embed has populated the space moments later. The
 * fix replaces the startup latch with a per-query probe of the live space.
 *
 * ## Real components, one faked seam
 *
 * Every store here is genuine: a real `GraphBacklogStore` opened through the
 * production `openGraphBacklogStore` factory, a real `BacklogCtx`, a real
 * Turso vector space (`@adhd/sox-vector-store`), a real `StoreSearchBackend`,
 * and the real `api.ts` verb surface driven exactly as a host drives it
 * (`create`/`query`/`claim`/`transition`/…). The ONE mocked seam is the
 * embedding MODEL itself (`@adhd/sox-embedding-provider`), replaced with a
 * deterministic fake — Embeddings mocked here, explicit scoped authorization
 * (see entrypoint/backlog/STATE.md), covers embedding cost only. The fake
 * counts every provider call, so "did this verb touch the model?" is directly
 * observable.
 *
 * ## How to read the two controls
 *
 * `searchRanked` is called by the SEMANTIC channel only — grep routes through
 * `graph.searchNodes` (`queryList`'s grep branch). So a `searchRanked` spy is
 * an exact discriminator between the two routes.
 *
 * - EMPTY-SPACE CONTROL asserts the SEMANTIC route is NOT taken while the
 *   store's vector space is still empty: a bare `text:` must fall back to grep
 *   (`searchRanked` count 0) rather than route semantic and return an empty
 *   page. It guards against over-eager routing that keys on "a semantic
 *   backend exists" instead of "the space actually holds vectors".
 * - POSITIVE CONTROL asserts the SEMANTIC route IS taken once an on-write embed
 *   has populated that same space, with no process restart. It is RED pre-fix
 *   and MUST GO GREEN after the fix.
 *
 * Together they are the permanent guard: empty space ⇒ grep, populated space ⇒
 * semantic. The pre-fix defect — a startup latch that pinned grep for the whole
 * process once it booted against an empty space — is recorded in the wave's
 * evidence; these two controls are what stays behind to catch a regression.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreSearchBackend } from '@adhd/sox-hybrid-search';
import {
  openGraphBacklogStore,
  type GraphBacklogStore,
} from './store/graph-backlog-store.js';
import { buildBacklogEnv } from './env.js';
import {
  claim,
  create,
  delete as deleteIssue,
  move,
  query,
  relate,
  rmLocation,
  transition,
  upsertComponent,
  upsertLocation,
  upsertProject,
  type BacklogCtx,
} from './api.js';
import { freshTmpDir } from './test/helpers/tmp-store.js';
import { isOutcomeOk, type IOutcomeEnvelope } from './envelope.js';

/** Precisely-typed spy factory — `ReturnType<typeof vi.spyOn>` widens to `unknown[]`, which will not accept the real mock. */
const spyOnSearchRanked = () =>
  vi.spyOn(StoreSearchBackend.prototype, 'searchRanked');

/**
 * Provider-call counters, hoisted so the `vi.mock` factory (which vitest lifts
 * above every import) can close over them. `embedSingle` counts ACTUAL model
 * invocations (the laziness signal); `createProvider` counts model
 * CONSTRUCTION (the double-bootstrap signal — a memoized per-adapter bootstrap
 * constructs the provider exactly once no matter how many verbs run).
 */
const providerSpy = vi.hoisted(() => ({
  embedSingle: 0,
  createProvider: 0,
  fail: false,
}));

vi.mock('@adhd/sox-embedding-provider', async () => {
  const { createFakeEmbeddingModule } = await import(
    './test/helpers/fake-embedding-provider.js'
  );
  const fake = createFakeEmbeddingModule();
  return {
    async createEmbeddingProvider(config: {
      type: string;
      model: string;
      options?: Record<string, unknown>;
    }) {
      providerSpy.createProvider += 1;
      const provider = await fake.createEmbeddingProvider(config);
      const original = provider.embedSingle.bind(provider);
      return {
        ...provider,
        async embedSingle(text: string, role?: 'document' | 'query') {
          providerSpy.embedSingle += 1;
          if (providerSpy.fail) {
            throw new Error('provider unavailable (test-injected failure)');
          }
          return original(text, role);
        },
      };
    },
  };
});

const ENV_VAR = 'ADHD_BACKLOG_EMBEDDING_ENABLED';
const TIMEOUT = 30_000;

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

async function closeHarness(h: Harness): Promise<void> {
  await h.store.adapter.close();
  rmSync(h.dir, { recursive: true, force: true });
}

/** A created issue whose vector is durably in the space (`awaitEmbed:true`). */
async function createEmbeddedIssue(
  ctx: BacklogCtx,
  project: string,
  title: string
): Promise<string> {
  const created = await create(ctx, {
    title,
    body: `${title} body`,
    project,
    by: 't',
    awaitEmbed: true,
  });
  expect(isOutcomeOk(created), JSON.stringify(created)).toBe(true);
  if (!isOutcomeOk(created) || created.data.uid === undefined) {
    throw new Error(`create did not mint an issue: ${JSON.stringify(created)}`);
  }
  return created.data.uid;
}

describe('api.ts semantic laziness — routing flips to semantic once the space is non-empty', () => {
  let searchRankedSpy: ReturnType<typeof spyOnSearchRanked>;
  let prevEnvVar: string | undefined;

  beforeEach(() => {
    prevEnvVar = process.env[ENV_VAR];
    process.env[ENV_VAR] = 'true';
    providerSpy.embedSingle = 0;
    providerSpy.createProvider = 0;
    providerSpy.fail = false;
    searchRankedSpy = spyOnSearchRanked();
  });

  afterEach(() => {
    searchRankedSpy.mockRestore();
    if (prevEnvVar === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prevEnvVar;
  });

  it(
    'EMPTY-SPACE CONTROL — text: falls back to grep while the vector space is empty (no semantic routing)',
    async () => {
      const h = await openCtx('api-lazy-empty-space');
      try {
        // A real, usable store with a real project — but ZERO vectors in the
        // space. `upsertProject` derives the write handle (and so constructs
        // the provider) without embedding, so the space stays empty here.
        const proj = await upsertProject(h.ctx, { name: 'P', by: 't' });
        expect(isOutcomeOk(proj), JSON.stringify(proj)).toBe(true);

        searchRankedSpy.mockClear();
        const res = await query(h.ctx, {
          text: 'the embedding length does not match the configured dimension',
        });
        expect(isOutcomeOk(res), JSON.stringify(res)).toBe(true);
        // Routing keys on the live space being POPULATED, not merely on a
        // backend existing: an empty space has nothing to rank, so text: stays
        // on grep and the semantic channel is never entered (count 0). A
        // regression that routes on "backend present" alone goes RED here.
        expect(searchRankedSpy).toHaveBeenCalledTimes(0);
      } finally {
        await closeHarness(h);
      }
    },
    TIMEOUT
  );

  it(
    'POSITIVE CONTROL — text: IS routed to the semantic backend after an on-write embed, with no restart',
    async () => {
      const h = await openCtx('api-lazy-positive');
      try {
        const proj = await upsertProject(h.ctx, { name: 'P', by: 't' });
        expect(isOutcomeOk(proj), JSON.stringify(proj)).toBe(true);
        await createEmbeddedIssue(
          h.ctx,
          'P',
          'Vector index refuses a dimension mismatch'
        );

        searchRankedSpy.mockClear();
        const res = await query(h.ctx, {
          text: 'the embedding length does not match the configured dimension',
        });
        expect(isOutcomeOk(res), JSON.stringify(res)).toBe(true);
        expect(searchRankedSpy).toHaveBeenCalledTimes(1);
      } finally {
        await closeHarness(h);
      }
    },
    TIMEOUT
  );

  it(
    'query({filter:{semantic}}) reaches searchRanked exactly once; query({filter:{status}}) never does',
    async () => {
      const h = await openCtx('api-lazy-filter');
      try {
        await upsertProject(h.ctx, { name: 'P', by: 't' });
        await createEmbeddedIssue(h.ctx, 'P', 'semantic filter target');

        searchRankedSpy.mockClear();
        const plain = await query(h.ctx, { filter: { status: 'open' } });
        expect(isOutcomeOk(plain), JSON.stringify(plain)).toBe(true);
        expect(searchRankedSpy).toHaveBeenCalledTimes(0);

        searchRankedSpy.mockClear();
        const semantic = await query(h.ctx, {
          filter: { semantic: 'semantic filter target' },
        });
        expect(isOutcomeOk(semantic), JSON.stringify(semantic)).toBe(true);
        expect(searchRankedSpy).toHaveBeenCalledTimes(1);
      } finally {
        await closeHarness(h);
      }
    },
    TIMEOUT
  );
});

describe('api.ts semantic laziness — the laziness matrix', () => {
  let prevEnvVar: string | undefined;

  beforeEach(() => {
    prevEnvVar = process.env[ENV_VAR];
    process.env[ENV_VAR] = 'true';
    providerSpy.embedSingle = 0;
    providerSpy.createProvider = 0;
    providerSpy.fail = false;
  });

  afterEach(() => {
    if (prevEnvVar === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prevEnvVar;
  });

  it(
    'create embeds exactly once (first issue in its project) and constructs the provider exactly once across every verb — the double-bootstrap is dead',
    async () => {
      const h = await openCtx('api-lazy-create');
      try {
        await upsertProject(h.ctx, { name: 'P', by: 't' });
        await upsertProject(h.ctx, { name: 'Q', by: 't' });

        // `upsertProject` is the first verb to derive a write handle, so it is
        // where the (memoized) provider is constructed. Reset only the EMBED
        // counter — `createProvider` must stay counted from process/store start.
        providerSpy.embedSingle = 0;

        // First issue in P: the duplicate gate short-circuits on a project with
        // no prior issues, so exactly ONE provider call is made — the on-write
        // document embed. (A second issue in the same project would add a
        // duplicate-scan query embed; that is why this asserts on the first.)
        const a = await createEmbeddedIssue(h.ctx, 'P', 'first issue');
        expect(providerSpy.embedSingle).toBe(1);

        const b = await createEmbeddedIssue(h.ctx, 'Q', 'second issue');
        expect(providerSpy.embedSingle).toBe(2);

        // A spread of verbs that each derive a fresh write/query handle from the
        // SAME adapter: a memoized bootstrap must construct the provider exactly
        // once, never once per verb and never twice (the old double-bootstrap).
        const comp = await upsertComponent(h.ctx, {
          project: 'P',
          name: 'comp',
          by: 't',
        });
        expect(isOutcomeOk(comp), JSON.stringify(comp)).toBe(true);
        const loc = await upsertLocation(h.ctx, {
          component: isOutcomeOk(comp) ? comp.data.uid : 'comp',
          locType: 'path',
          value: 'src/x.ts',
          by: 't',
        });
        expect(isOutcomeOk(loc), JSON.stringify(loc)).toBe(true);
        const rel = await relate(h.ctx, {
          sourceUid: a,
          targetUid: b,
          rel: 'relates_to',
          action: 'add',
          by: 't',
        });
        expect(isOutcomeOk(rel), JSON.stringify(rel)).toBe(true);
        await query(h.ctx, { filter: { status: 'open' } });
        await query(h.ctx, { filter: { semantic: 'first issue' } });

        expect(providerSpy.createProvider).toBe(1);
      } finally {
        await closeHarness(h);
      }
    },
    TIMEOUT
  );

  it(
    'claim / transition / move / relate / delete / upsert* / rmLocation / non-semantic query never invoke the provider',
    async () => {
      const h = await openCtx('api-lazy-nonembedding');
      try {
        await upsertProject(h.ctx, { name: 'P', by: 't' });
        await upsertProject(h.ctx, { name: 'Q', by: 't' });
        const a = await createEmbeddedIssue(h.ctx, 'P', 'issue a');
        const b = await createEmbeddedIssue(h.ctx, 'Q', 'issue b');

        const comp = await upsertComponent(h.ctx, {
          project: 'P',
          name: 'comp',
          by: 't',
        });
        if (!isOutcomeOk(comp)) throw new Error(JSON.stringify(comp));
        const loc = await upsertLocation(h.ctx, {
          component: comp.data.uid,
          locType: 'path',
          value: 'src/y.ts',
          by: 't',
        });
        if (!isOutcomeOk(loc)) throw new Error(JSON.stringify(loc));

        // Everything above is setup; the provider has already been constructed.
        // Each row below must be a ZERO-embed operation.
        const rows: Array<{
          name: string;
          run: () => Promise<IOutcomeEnvelope<unknown>>;
        }> = [
          {
            name: 'claim',
            run: () =>
              claim(h.ctx, { uid: a, by: 't', action: 'claim' }),
          },
          {
            name: 'transition',
            run: () =>
              transition(h.ctx, {
                uid: a,
                by: 't',
                toStatus: 'in-progress',
                note: 'starting work',
              }),
          },
          { name: 'move', run: () => move(h.ctx, { uid: a, by: 't' }) },
          {
            name: 'relate',
            run: () =>
              relate(h.ctx, {
                sourceUid: a,
                targetUid: b,
                rel: 'relates_to',
                action: 'add',
                by: 't',
              }),
          },
          {
            name: 'upsertProject',
            run: () => upsertProject(h.ctx, { name: 'P', by: 't' }),
          },
          {
            name: 'upsertComponent',
            run: () =>
              upsertComponent(h.ctx, { project: 'P', name: 'comp2', by: 't' }),
          },
          {
            name: 'upsertLocation',
            run: () =>
              upsertLocation(h.ctx, {
                component: comp.data.uid,
                locType: 'path',
                value: 'src/z.ts',
                by: 't',
              }),
          },
          {
            name: 'rmLocation',
            run: () => rmLocation(h.ctx, { uid: loc.data.uid, by: 't' }),
          },
          {
            name: 'query({filter:{status}})',
            run: () => query(h.ctx, { filter: { status: 'open' } }),
          },
          {
            name: 'delete',
            run: () =>
              deleteIssue(h.ctx, {
                uid: b,
                by: 't',
                reason: 'done',
                // Deterministic teardown: await the (vector-delete) round-trip
                // rather than letting its audit write race `closeHarness`.
                awaitEmbed: true,
              }),
          },
        ];

        for (const row of rows) {
          const before = providerSpy.embedSingle;
          const outcome = await row.run();
          expect(isOutcomeOk(outcome), `${row.name}: ${JSON.stringify(outcome)}`).toBe(
            true
          );
          expect(
            providerSpy.embedSingle - before,
            `${row.name} must not invoke the embedding provider`
          ).toBe(0);
        }
      } finally {
        await closeHarness(h);
      }
    },
    TIMEOUT
  );

  it(
    'a throwing provider does not fail non-semantic writes and is never touched by them',
    async () => {
      const h = await openCtx('api-lazy-throwing');
      try {
        await upsertProject(h.ctx, { name: 'P', by: 't' });

        providerSpy.fail = true;
        providerSpy.embedSingle = 0;

        // First issue in an empty project → no duplicate-scan query embed, so the
        // only provider call is the (failing) on-write document embed. The write
        // still commits; the embed failure is audited and swallowed.
        const created = await create(h.ctx, {
          title: 'write survives a dead provider',
          body: 'the model is down but the issue is filed',
          project: 'P',
          by: 't',
          awaitEmbed: true,
        });
        expect(isOutcomeOk(created), JSON.stringify(created)).toBe(true);
        if (!isOutcomeOk(created)) throw new Error('unreachable');
        expect(created.data.created).toBe(true);
        expect(providerSpy.embedSingle).toBe(1); // attempted exactly once, then failed

        const uid = created.data.uid!;
        const before = providerSpy.embedSingle;
        const claimed = await claim(h.ctx, { uid, by: 't', action: 'claim' });
        expect(isOutcomeOk(claimed), JSON.stringify(claimed)).toBe(true);
        const transitioned = await transition(h.ctx, {
          uid,
          by: 't',
          toStatus: 'in-progress',
          note: 'moving',
        });
        expect(isOutcomeOk(transitioned), JSON.stringify(transitioned)).toBe(
          true
        );
        const listed = await query(h.ctx, { filter: { status: 'open' } });
        expect(isOutcomeOk(listed), JSON.stringify(listed)).toBe(true);

        // None of those verbs embeds, so a throwing provider never even sees them.
        expect(providerSpy.embedSingle - before).toBe(0);
      } finally {
        await closeHarness(h);
      }
    },
    TIMEOUT
  );
});

describe('api.ts semantic laziness — cross-process readiness', () => {
  let prevEnvVar: string | undefined;
  let searchRankedSpy: ReturnType<typeof spyOnSearchRanked>;

  beforeEach(() => {
    prevEnvVar = process.env[ENV_VAR];
    process.env[ENV_VAR] = 'true';
    providerSpy.embedSingle = 0;
    providerSpy.createProvider = 0;
    providerSpy.fail = false;
    searchRankedSpy = spyOnSearchRanked();
  });

  afterEach(() => {
    searchRankedSpy.mockRestore();
    if (prevEnvVar === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prevEnvVar;
  });

  it(
    'a vector written by one adapter is visible to a text: query issued through a second adapter on the same file',
    async () => {
      const dir = freshTmpDir('api-lazy-cross-process');
      const dbPath = join(dir, 'backlog.db');
      // Two genuine connections to ONE file — the shape a second process has.
      const storeA = await openGraphBacklogStore(dbPath);
      const storeB = await openGraphBacklogStore(dbPath);
      const ctxA: BacklogCtx = {
        store: storeA,
        env: buildBacklogEnv({ adhdRoot: dir }),
      };
      const ctxB: BacklogCtx = {
        store: storeB,
        env: buildBacklogEnv({ adhdRoot: dir }),
      };
      try {
        await upsertProject(ctxA, { name: 'P', by: 't' });
        await createEmbeddedIssue(
          ctxA,
          'P',
          'Vector index refuses a dimension mismatch'
        );

        // A's own write is the ONLY thing that populated the space. B booted
        // against an empty space; its text: query must still upgrade to semantic.
        searchRankedSpy.mockClear();
        const res = await query(ctxB, {
          text: 'the embedding length does not match the configured dimension',
        });
        expect(isOutcomeOk(res), JSON.stringify(res)).toBe(true);
        expect(searchRankedSpy).toHaveBeenCalledTimes(1);
      } finally {
        await storeA.adapter.close();
        await storeB.adapter.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    TIMEOUT
  );
});
