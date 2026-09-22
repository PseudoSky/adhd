/**
 * bootstrap-cache.spec.ts — the per-adapter member cache must NOT latch a soft
 * failure for the adapter/process lifetime (finding efbb5c4b).
 *
 * ## The defect this pins
 *
 * `bootstrapSemanticStoreMembers` memoizes `deriveMembers` per `StoreAdapter`
 * in a `WeakMap`. `deriveMembers` never throws on a soft failure — it returns a
 * member-less `{}` from five paths (embedding disabled, non-Turso adapter,
 * optional packages unresolvable, provider throw, vector-store open throw) —
 * and the resolved promise was cached with no eviction. So one transient
 * failure (a provider briefly unreachable, a store-open that hit a lock) left
 * the adapter permanently member-less: every later `create`/`update`/`text:`
 * query degraded, with no recovery short of a process restart.
 *
 * ## The fix these tests pin
 *
 * A member-less result is evicted on resolution, and a rejected derive is
 * evicted on rejection; only a member-ful success is retained.
 *
 * ## Real components, one faked seam
 *
 * The store is genuine (`openTestIssueStore` — a real Turso adapter, real
 * vector space, real `StoreSearchBackend`). The ONE mocked seam is the
 * embedding MODEL (`@adhd/sox-embedding-provider`), replaced with a
 * deterministic fake whose `createEmbeddingProvider` is driven through a
 * per-call behavior switch (`ok` | `throw` | `no-metadata`) so a transient
 * failure is injected without any wall-clock or sleep.
 *
 * ## TEETH (verified by temporary revert)
 *
 * - `retries after a TRANSIENT provider-init throw` is RED if the member-less
 *   eviction is removed: the second call returns the cached `{}` (no `search`),
 *   and `createProvider` stays at 1.
 * - `evicts a REJECTED derive` is RED if the rejection eviction is removed: the
 *   second call replays the cached rejected promise instead of deriving.
 * - `still caches a SUCCESSFUL derive` is RED if the cache is over-eagerly
 *   evicted: `createProvider` would be 2 and the two results would not share
 *   one `search` object.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BacklogConfig } from '../env.js';
import {
  bootstrapSemanticStoreMembers,
  type SemanticStoreMembers,
} from './bootstrap.js';
import { openTestIssueStore } from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';

/**
 * Per-call behavior for the mocked `createEmbeddingProvider`, hoisted so the
 * `vi.mock` factory (lifted above every import) can close over it. `behavior`
 * applies to the NEXT call and resets to `ok`, so a test sets it once and the
 * following call recovers.
 */
const providerSpy = vi.hoisted(() => ({
  createProvider: 0,
  behavior: 'ok' as 'ok' | 'throw' | 'no-metadata',
}));

// Embeddings mocked here — explicit, scoped user authorization (see
// entrypoint/backlog/STATE.md), covers embedding cost only. Intercepts the
// exact `import('@adhd/sox-embedding-provider')` specifier `bootstrap.ts`'s own
// `loadOptional` seam resolves at runtime.
vi.mock('@adhd/sox-embedding-provider', async () => {
  const { createFakeEmbeddingModule } = await import(
    '../test/helpers/fake-embedding-provider.js'
  );
  const fake = createFakeEmbeddingModule();
  return {
    async createEmbeddingProvider(config: {
      type: string;
      model: string;
      options?: Record<string, unknown>;
    }) {
      providerSpy.createProvider += 1;
      const behavior = providerSpy.behavior;
      providerSpy.behavior = 'ok';
      if (behavior === 'throw') {
        // The soft-failure path: `deriveMembers` catches this and returns `{}`.
        throw new Error('transient provider init failure (test-injected)');
      }
      if (behavior === 'no-metadata') {
        // Resolves, but with no `metadata`. `deriveMembers` dereferences
        // `provider.metadata.modelId` OUTSIDE its try/catch, so this REJECTS the
        // derive promise — the eviction-on-rejection path.
        return {} as never;
      }
      return fake.createEmbeddingProvider(config);
    },
  };
});

const CFG: BacklogConfig['embedding'] = {
  enabled: true,
  provider: 'fastembed',
  model: 'fake-deterministic-embedding-model',
};

/** Swallows the soft-failure log lines these tests deliberately provoke. */
const silentLog = (): void => undefined;

const dirs: string[] = [];
function tmpDbPath(): string {
  const dir = freshTmpDir('bootstrap-cache-');
  dirs.push(dir);
  return join(dir, 'backlog.db');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Both members absent — the member-less `{}` shape `deriveMembers` returns on a soft failure. */
function isMemberless(m: SemanticStoreMembers): boolean {
  return m.search === undefined && m.embedding === undefined;
}

describe('bootstrapSemanticStoreMembers — a soft failure must not be latched', () => {
  it('retries after a TRANSIENT provider-init throw: the second call derives members', async () => {
    const store = await openTestIssueStore(tmpDbPath());
    try {
      providerSpy.createProvider = 0;
      providerSpy.behavior = 'throw';

      const first = await bootstrapSemanticStoreMembers(
        store.adapter,
        store.graph,
        CFG,
        silentLog
      );
      expect(isMemberless(first)).toBe(true);
      expect(providerSpy.createProvider).toBe(1);

      // Negative control: WITHOUT the member-less eviction this second call
      // returns the cached `{}` — `search` stays undefined and createProvider
      // stays 1. WITH the fix it re-derives and succeeds.
      const second = await bootstrapSemanticStoreMembers(
        store.adapter,
        store.graph,
        CFG,
        silentLog
      );
      expect(second.search).toBeDefined();
      expect(second.embedding).toBeDefined();
      expect(providerSpy.createProvider).toBe(2);
    } finally {
      await store.close();
    }
  });

  it('evicts a REJECTED derive: the next call retries instead of replaying the rejection', async () => {
    const store = await openTestIssueStore(tmpDbPath());
    try {
      providerSpy.createProvider = 0;
      providerSpy.behavior = 'no-metadata';

      await expect(
        bootstrapSemanticStoreMembers(store.adapter, store.graph, CFG, silentLog)
      ).rejects.toThrow();

      // Negative control: WITHOUT the rejection eviction this returns the SAME
      // rejected promise and rejects again instead of deriving.
      const second = await bootstrapSemanticStoreMembers(
        store.adapter,
        store.graph,
        CFG,
        silentLog
      );
      expect(second.search).toBeDefined();
      expect(second.embedding).toBeDefined();
      expect(providerSpy.createProvider).toBe(2);
    } finally {
      await store.close();
    }
  });

  it('still caches a SUCCESSFUL derive: repeated calls construct the provider once and share one result', async () => {
    const store = await openTestIssueStore(tmpDbPath());
    try {
      providerSpy.createProvider = 0;
      providerSpy.behavior = 'ok';

      const first = await bootstrapSemanticStoreMembers(
        store.adapter,
        store.graph,
        CFG,
        silentLog
      );
      const second = await bootstrapSemanticStoreMembers(
        store.adapter,
        store.graph,
        CFG,
        silentLog
      );
      expect(first.search).toBeDefined();
      // Same underlying members object — the cache returned the memoized value.
      expect(second.search).toBe(first.search);
      expect(second.embedding).toBe(first.embedding);
      expect(providerSpy.createProvider).toBe(1);
    } finally {
      await store.close();
    }
  });
});
