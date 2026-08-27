/**
 * embed-write-path.spec.ts — proves RAG-SPEC.md §2's embedding write path:
 * `scheduleEmbed` (embed-queue.ts), the `awaitEmbed`/`flushEmbeds`/async-close
 * durability trio (§2.2), re-embed-on-edit (§2.3), provenance stamping (§2.4),
 * and never-throws failure handling (§2.5) — wired through `crud.ts`'s real
 * `createItemNode`/`updateItemNode`/`softDeleteItemNode` against a REAL Turso
 * store (`openTmpStore`/`openGraphBacklogStore`), never a mock of the store
 * itself (AGENTS.md §7.1).
 *
 * The `SemanticBackend` is a FAKE (deterministic, no model download, no
 * network) injected via `configureSemanticBackend` — that keeps this suite
 * fast and immune to flakiness; the real-fastembed end-to-end proofs are a
 * separate workstream's job (RAG-SPEC.md §8's real-model suite). Determinism
 * for the concurrency-shaped assertions (§8 DoD #9) comes from an explicit
 * `deferred()` gate, never `sleep`/wall-clock (AGENTS.md §7.3): a promise can
 * never settle before every promise it `await`s has settled, so blocking
 * `embedDocument` behind an unresolved gate lets a test prove "this call is
 * DEFINITELY still pending" with zero timing risk.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createItemNode, softDeleteItemNode, updateItemNode } from './crud.js';
import { closeGraphBacklogStore, openGraphBacklogStore } from './graph-backlog-store.js';
import { configureSemanticBackend, PermanentEmbeddingDimensionError, type SemanticBackend } from './semantic-search.js';
import { freshTmpDir, openTmpStore } from '../test/helpers/tmp-store.js';

/** A controllable deferred promise — the deterministic gate used by the §8 DoD #9 tests. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface FakeBackendHandle {
  backend: SemanticBackend;
  /** In-memory vector store — a stand-in for the real Turso vector table (real persistence is proven separately via `embedModel` node-metadata, which DOES live in the real db file). */
  vectors: Map<number, Float32Array>;
  /** Ticks up SYNCHRONOUSLY the instant `embedDocument` is invoked (before any internal `await`) — safe to assert on immediately after a fire-and-forget `scheduleEmbed` call with no race (see file header). */
  embedDocumentCalls: () => number;
}

/**
 * @param opts.gate  When present, `embedDocument` awaits this before
 *   resolving/rejecting — the deterministic "hold this embed open" knob for
 *   the durability tests.
 * @param opts.rejectWith  When present, `embedDocument` throws this instead
 *   of returning a vector — proves §2.5's "never throws into the caller".
 * @param opts.wrongDim  When true, `embedDocument` returns a vector one
 *   element longer than `dim` — mirrors the REAL backend's `checkDim`
 *   behaviour (semantic-search.ts) by having `upsertVector` throw
 *   `PermanentEmbeddingDimensionError` on the mismatch, since a directly
 *   injected fake bypasses `bootstrapSemanticBackend`'s own wrapper.
 */
function makeFakeBackend(
  opts: { modelId?: string; dim?: number; gate?: Promise<void>; rejectWith?: Error; wrongDim?: boolean } = {}
): FakeBackendHandle {
  const dim = opts.dim ?? 4;
  const modelId = opts.modelId ?? 'fake-embed-v1';
  const vectors = new Map<number, Float32Array>();
  let calls = 0;

  const backend: SemanticBackend = {
    modelId,
    dim,
    async embedQuery(): Promise<Float32Array> {
      return new Float32Array(dim).fill(1);
    },
    async embedDocument(text: string): Promise<Float32Array> {
      calls++;
      if (opts.gate) await opts.gate;
      if (opts.rejectWith) throw opts.rejectWith;
      if (opts.wrongDim) return new Float32Array(dim + 1);
      const v = new Float32Array(dim);
      for (let i = 0; i < dim; i++) v[i] = (text.length + i) / 97;
      return v;
    },
    async vectorFor(nodeId: number): Promise<Float32Array | null> {
      return vectors.get(nodeId) ?? null;
    },
    async upsertVector(nodeId: number, vec: Float32Array): Promise<void> {
      if (vec.length !== dim) throw new PermanentEmbeddingDimensionError('upsertVector', modelId, dim, vec.length);
      vectors.set(nodeId, vec);
    },
    async deleteVector(nodeId: number): Promise<void> {
      vectors.delete(nodeId);
    },
    async knn(): Promise<Array<{ nodeId: number; score: number }>> {
      return [];
    },
    async *iterVectors(): AsyncIterable<{ nodeId: number; vec: Float32Array }> {
      for (const [nodeId, vec] of vectors) yield { nodeId, vec };
    },
    async health() {
      return { configured: modelId, active: modelId, state: 'real' as const, dimensions: dim, last_error: null };
    },
  };

  const handle: FakeBackendHandle = { backend, vectors, embedDocumentCalls: () => calls };
  fakeHandles.set(backend, handle);
  return handle;
}

/** Reads `node.metadata.embedModel` back through the REAL store — the §2.4 provenance stamp. */
async function embedModelOf(store: Awaited<ReturnType<typeof openGraphBacklogStore>>, nodeId: number): Promise<string | undefined> {
  const node = await store.graph.getNode(nodeId);
  return (node?.metadata as { embedModel?: string } | null)?.embedModel;
}

describe('embed write path (RAG-SPEC.md §2)', () => {
  afterEach(() => {
    configureSemanticBackend(null); // never leak a configured backend into another suite
  });

  it('awaitEmbed:true on create makes the vector present immediately after createItem returns', async () => {
    const tmp = await openTmpStore('embed-await-create');
    try {
      const { backend, vectors } = makeFakeBackend();
      configureSemanticBackend(backend);

      const outcome = await createItemNode(tmp.store, {
        family: 'BUG-EMBED',
        title: 'await embed on create',
        body: 'the vector must be present the instant createItem resolves',
        repo: 'test/embed-write-path',
        awaitEmbed: true,
      });

      expect(outcome.created).toBe(true);
      expect(vectors.has(outcome.item.nodeId)).toBe(true);
      expect(await embedModelOf(tmp.store, outcome.item.nodeId)).toBe(backend.modelId);
    } finally {
      await tmp.cleanup();
    }
  });

  it('§8 DoD #9: an embed scheduled WITHOUT awaitEmbed survives closeGraphBacklogStore — the drain is load-bearing', async () => {
    const dir = freshTmpDir('embed-durability-positive');
    const dbPath = join(dir, 'backlog.db');
    const gate = deferred();
    const { backend, vectors } = makeFakeBackend({ gate: gate.promise });
    configureSemanticBackend(backend);

    try {
      const store = await openGraphBacklogStore(dbPath);
      const outcome = await createItemNode(store, {
        family: 'BUG-EMBED',
        title: 'durability check',
        body: 'proves the drain is load-bearing, not a fluke of timing',
        repo: 'test/embed-durability-positive',
        // awaitEmbed deliberately OMITTED — this is the fire-and-forget path.
      });
      expect(outcome.created).toBe(true);
      const nodeId = outcome.item.nodeId;

      // Start the drain WITHOUT releasing the gate.
      let closed = false;
      const closePromise = closeGraphBacklogStore(store).then(() => {
        closed = true;
      });

      // Flush several microtask turns. `closed` MUST still be false: this is
      // not a timing race — `flushEmbeds` is awaiting a promise chain rooted
      // in `gate`, and nothing here has resolved `gate` yet. A promise can
      // never settle before every promise it `await`s has settled, so this
      // assertion cannot flake regardless of how many turns are flushed.
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(closed).toBe(false);
      expect(vectors.has(nodeId)).toBe(false);

      // Release the gate — NOW the embed can complete, and the already-in-
      // progress drain can finally finish.
      gate.resolve();
      await closePromise;
      expect(closed).toBe(true);
      expect(vectors.has(nodeId)).toBe(true);

      // Reopen a FRESH store on the SAME file. `embedModel` is real
      // persistence (a `mutateMetadata` transaction against this exact db
      // file) — independent of the fake backend's in-memory `vectors` map —
      // so this is a genuine "did it survive process exit" proof, not an
      // artifact of the backend being a process-wide singleton.
      const store2 = await openGraphBacklogStore(dbPath);
      try {
        expect(await embedModelOf(store2, nodeId)).toBe(backend.modelId);
      } finally {
        await closeGraphBacklogStore(store2);
      }
    } finally {
      configureSemanticBackend(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('§8 DoD #9 negative control: bypassing the drain (raw adapter.close()) loses the embed — reopened store sees no provenance/vector', async () => {
    const dir = freshTmpDir('embed-durability-negative');
    const dbPath = join(dir, 'backlog.db');
    const gate = deferred(); // deliberately NEVER released in this branch
    const { backend, vectors } = makeFakeBackend({ gate: gate.promise });
    configureSemanticBackend(backend);

    try {
      const store = await openGraphBacklogStore(dbPath);
      const outcome = await createItemNode(store, {
        family: 'BUG-EMBED',
        title: 'negative control',
        body: 'bypassing the drain must lose this vector',
        repo: 'test/embed-durability-negative',
      });
      const nodeId = outcome.item.nodeId;

      // BYPASS the drain entirely: close the adapter directly, never going
      // through `closeGraphBacklogStore`/`flushEmbeds`.
      await store.adapter.close();

      // Deterministic (not racy): the scheduled embed is still stuck behind
      // `gate`, which nothing here ever resolves — it never got the chance
      // the drain would have given it.
      expect(vectors.has(nodeId)).toBe(false);

      const store2 = await openGraphBacklogStore(dbPath);
      try {
        expect(await embedModelOf(store2, nodeId)).toBeUndefined();
      } finally {
        await closeGraphBacklogStore(store2);
      }
    } finally {
      configureSemanticBackend(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flushEmbeds() alone (without closing) drains pending embeds', async () => {
    const tmp = await openTmpStore('embed-flush-alone');
    try {
      const gate = deferred();
      const { backend, vectors } = makeFakeBackend({ gate: gate.promise });
      configureSemanticBackend(backend);

      const outcome = await createItemNode(tmp.store, {
        family: 'BUG-EMBED',
        title: 'flush alone',
        body: 'flushEmbeds must drain without needing a close',
        repo: 'test/embed-flush-alone',
      });
      const nodeId = outcome.item.nodeId;

      let flushed = false;
      const flushPromise = tmp.store.flushEmbeds().then(() => {
        flushed = true;
      });
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(flushed).toBe(false); // still gated — deterministic, see above

      gate.resolve();
      await flushPromise;
      expect(flushed).toBe(true);
      expect(vectors.has(nodeId)).toBe(true);
      expect(await embedModelOf(tmp.store, nodeId)).toBe(backend.modelId);
    } finally {
      await tmp.cleanup();
    }
  });

  it('updating title re-embeds; updating an unrelated field does not', async () => {
    const tmp = await openTmpStore('embed-reembed-on-edit');
    try {
      const { backend } = makeFakeBackend();
      configureSemanticBackend(backend);

      const outcome = await createItemNode(tmp.store, {
        family: 'BUG-EMBED',
        title: 'original title',
        body: 'original body',
        repo: 'test/embed-reembed-on-edit',
        awaitEmbed: true,
      });
      // `embedDocumentCalls` ticks up SYNCHRONOUSLY the instant
      // `embedDocument` is invoked (see `makeFakeBackend`'s doc comment) — no
      // race, safe to read immediately after the (possibly fire-and-forget)
      // call that triggers it returns.
      const handle = fakeHandleFor(backend);
      const callsBeforeUpdate = handle.embedDocumentCalls();

      // Updating an UNRELATED field (projectPath) — `status`/`priority`/etc
      // are rejected outright by `updateItemNode` (they must go through
      // `transitionStatus`/`setPriority`; see `IUpdatePatch`'s doc comment),
      // so `projectPath` is the field that is both (a) legally patchable
      // through `updateItemNode` and (b) never part of the embedded text
      // (`${title}\n\n${body}`).
      await updateItemNode(tmp.store, 'test/embed-reembed-on-edit', outcome.item.humanId, { projectPath: 'packages/foo' });
      expect(handle.embedDocumentCalls()).toBe(callsBeforeUpdate); // no re-embed

      await updateItemNode(tmp.store, 'test/embed-reembed-on-edit', outcome.item.humanId, { title: 'a brand new title' });
      expect(handle.embedDocumentCalls()).toBe(callsBeforeUpdate + 1); // re-embedded
    } finally {
      await tmp.cleanup();
    }
  });

  it('a backend whose embedDocument REJECTS does not fail the create — the item is still created and readable', async () => {
    const tmp = await openTmpStore('embed-reject');
    try {
      const { backend, vectors } = makeFakeBackend({ rejectWith: new Error('fake embedding backend is down') });
      configureSemanticBackend(backend);

      const outcome = await createItemNode(tmp.store, {
        family: 'BUG-EMBED',
        title: 'embed backend down',
        body: 'the create must still succeed',
        repo: 'test/embed-reject',
        awaitEmbed: true, // deterministic: wait for the (swallowed) failure to settle
      });

      expect(outcome.created).toBe(true);
      const reread = await tmp.store.graph.getNode(outcome.item.nodeId);
      expect(reread).not.toBeNull();
      expect(vectors.has(outcome.item.nodeId)).toBe(false); // embed never landed
      expect(await embedModelOf(tmp.store, outcome.item.nodeId)).toBeUndefined(); // honest: no stamp on failure
    } finally {
      await tmp.cleanup();
    }
  });

  it('a backend returning a wrong-dimension vector does not corrupt state — PermanentEmbeddingDimensionError is swallowed', async () => {
    const tmp = await openTmpStore('embed-wrong-dim');
    try {
      const { backend, vectors } = makeFakeBackend({ wrongDim: true });
      configureSemanticBackend(backend);

      const outcome = await createItemNode(tmp.store, {
        family: 'BUG-EMBED',
        title: 'wrong dimension',
        body: 'a structural dimension mismatch must never corrupt state',
        repo: 'test/embed-wrong-dim',
        awaitEmbed: true,
      });

      expect(outcome.created).toBe(true);
      const reread = await tmp.store.graph.getNode(outcome.item.nodeId);
      expect(reread).not.toBeNull();
      expect(vectors.has(outcome.item.nodeId)).toBe(false);
      expect(await embedModelOf(tmp.store, outcome.item.nodeId)).toBeUndefined();
    } finally {
      await tmp.cleanup();
    }
  });

  it('soft-delete drops the vector', async () => {
    const tmp = await openTmpStore('embed-soft-delete');
    try {
      const { backend, vectors } = makeFakeBackend();
      configureSemanticBackend(backend);

      const outcome = await createItemNode(tmp.store, {
        family: 'BUG-EMBED',
        title: 'to be deleted',
        body: 'the vector must be dropped on soft-delete',
        repo: 'test/embed-soft-delete',
        awaitEmbed: true,
      });
      expect(vectors.has(outcome.item.nodeId)).toBe(true);

      await softDeleteItemNode(tmp.store, 'test/embed-soft-delete', outcome.item.humanId, 'no longer needed');
      expect(vectors.has(outcome.item.nodeId)).toBe(false);
    } finally {
      await tmp.cleanup();
    }
  });

  it('with NO backend configured, create/update work exactly as before and schedule nothing', async () => {
    const tmp = await openTmpStore('embed-unconfigured');
    try {
      configureSemanticBackend(null);

      const outcome = await createItemNode(tmp.store, {
        family: 'BUG-EMBED',
        title: 'no rag here',
        body: 'must work exactly as before RAG existed',
        repo: 'test/embed-unconfigured',
        awaitEmbed: true, // even the "await" knob must be a harmless no-op
      });
      expect(outcome.created).toBe(true);

      const updated = await updateItemNode(tmp.store, 'test/embed-unconfigured', outcome.item.humanId, {
        title: 'still no rag',
        awaitEmbed: true,
      });
      expect(updated.title).toBe('still no rag');

      // flushEmbeds must be a harmless, immediately-resolving no-op — never
      // an error — when nothing was ever scheduled.
      await expect(tmp.store.flushEmbeds()).resolves.toBeUndefined();
    } finally {
      await tmp.cleanup();
    }
  });

  it('provenance: after an embed, the stored embed_model equals the backend modelId', async () => {
    const tmp = await openTmpStore('embed-provenance');
    try {
      const { backend } = makeFakeBackend({ modelId: 'fake-provenance-v7', dim: 3 });
      configureSemanticBackend(backend);

      const outcome = await createItemNode(tmp.store, {
        family: 'BUG-EMBED',
        title: 'provenance check',
        body: 'embed_model must equal the RESOLVED model id',
        repo: 'test/embed-provenance',
        awaitEmbed: true,
      });

      expect(await embedModelOf(tmp.store, outcome.item.nodeId)).toBe('fake-provenance-v7');
    } finally {
      await tmp.cleanup();
    }
  });
});

/**
 * Test-only escape hatch: `makeFakeBackend`'s `embedDocumentCalls` counter
 * lives on the `FakeBackendHandle`, not the bare `SemanticBackend` the
 * production code sees. The "re-embed on edit" test above needs the counter
 * without threading the handle through every call site, so this recovers it
 * via the closure `makeFakeBackend` already captured — simplest fix: keep a
 * side-table keyed by the returned `backend` object.
 */
const fakeHandles = new WeakMap<SemanticBackend, FakeBackendHandle>();
function fakeHandleFor(backend: SemanticBackend): FakeBackendHandle {
  const handle = fakeHandles.get(backend);
  if (!handle) throw new Error('embed-write-path.spec.ts: backend was not created via makeFakeBackend()');
  return handle;
}
