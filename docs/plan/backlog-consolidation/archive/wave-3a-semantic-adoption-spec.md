# Wave 3a — `@adhd/sox-semantic` adoption spec (`bootstrap.ts`)

> Status: SPEC (read-only on code; this file is the only write). Branch
> `feat/backlog-hard-replacement`, worktree `.worktrees/backlog-v2`.
> Prepared 2026-09-22 by architect. **No commit.** A concurrent executor is
> editing this worktree — package.json may move under you; re-read before edit.

## Inputs actually read (evidence)

- `entrypoint/backlog/src/write/bootstrap.ts` (477 lines, post-Wave-0).
- `entrypoint/backlog/src/write/{bootstrap.spec.ts, bootstrap-cache.spec.ts}`,
  `src/test/helpers/fake-embedding-provider.ts`, `src/api.ts:140-239`,
  `src/query/query.ts:62-101`, `src/write/tx.ts:59-104`.
- `entrypoint/backlog/node_modules/@adhd/sox-semantic` — **not installed
  (resolves root 0.1.3)**; contract pinned from the published artifact
  `unpkg.com/@adhd/sox-semantic@0.1.7/dist/index.d.ts` + `package.json`, and
  from sox HEAD `libs/data/search/semantic/src/index.ts`.
- `entrypoint/backlog/node_modules/@adhd/sox-vector-store` — **backlog resolves
  the nested 0.7.0** (`dist/turso.d.ts`, `dist/turso.js`, `dist/index.d.ts`);
  the root copy is 0.6.2 and is NOT what backlog compiles against.
- `entrypoint/backlog/tools/gate/embedding-usage-gate.mjs`.
- ADRs read in full from `/Users/nix/dev/ai/sox-ecosystem/docs/decisions/`:
  0006, 0012, 0013, 0016 (backlog-v2 has no `docs/decisions/`). No violation.
- npm registry (`/latest`): graph-store **0.11.0**, hybrid-search **0.4.8**,
  semantic **0.1.7** are published.

## Summary

`bootstrap.ts` keeps its public surface (`bootstrapSemanticStoreMembers`,
`SemanticStoreMembers`, `isVectorSpacePopulated`,
`PermanentEmbeddingDimensionError`) and its per-adapter cache/eviction exactly
as-is; only the body of `deriveMembers` changes to DI-wire the real embedding
stack through `createSemanticBackend` instead of hand-building the members.
Because the facade exposes **no** vector-backend handle, **no** space probe and
**no** ranker, backlog must inject **both** `embeddingProvider` and
`vectorBackend` (which it already constructs) and retain the injected
`vectorBackend` for `spacePopulated()` and `StoreSearchBackend`. The net code
elimination is **small (~10–40 lines), not the plan's ~184** — see §3.

## 1. Pinned contract (0.1.7, published)

```ts
createSemanticBackend(config: {
  adapter: StoreAdapter;
  embedding: { type: string; model: string; options?: Record<string, unknown> };
  space?: { modelId: string; dim: number };          // default: provider.metadata
  embeddingProvider?: EmbeddingProvider;             // inject ⇒ no load of the optional pkg
  vectorBackend?: VectorBackend | AsyncVectorBackend;// inject ⇒ no load of the optional pkg
}): Promise<SemanticBackendResult>;

type SemanticBackendResult =
  | { ok: true; backend: SemanticBackend }
  | { ok: false; failure: { reason: 'not_installed'|'provider_failed'
                            |'unsupported_adapter'|'vector_store_failed'; detail: string } };

interface SemanticBackend {
  readonly modelId: string; readonly dim: number;
  embedQuery(text): Promise<Float32Array>;
  embedDocuments(texts): AsyncIterable<{ index; vec?; error? }>;  // batch; uses provider.embedBatch
  upsertVector(nodeId, vec): Promise<void>;  upsertVectors(items): Promise<void>;
  deleteVector(nodeId): Promise<void>;
  semanticSearchNodes(query, opts?): Promise<Array<{ node: NodeRecord; score }>>;
  health(): EmbeddingHealth;
}
```

Published 0.1.7 manifest: hard deps `sox-graph-store ^0.11.0`,
`sox-hybrid-search ^0.4.8`, `sox-store-adapter ^0.9.2`; **optionalDeps**
`sox-vector-store ^0.7.0`, `sox-embedding-provider ^0.5.0`. The facade resolves
neither optional specifier on the fully-injected path (its own
`optional-loadability.spec.ts` proves this against `dist/`).

## 2. Findings that shape the design (all evidence-backed)

1. **The facade exposes no handle backlog needs.** `SemanticBackend` has no
   `vectorBackend`, no `spacePopulated`/`hasVectors`, and no
   `StoreSearchBackend`/`searchRanked`. `SemanticStoreMembers.search` requires
   `{ backend: StoreSearchBackend; embedQuery; spacePopulated }`
   (`query/query.ts:73-88`). Therefore backlog **must** construct and inject
   `vectorBackend` itself and keep it. A "facade loads everything" variant
   (inject neither) is **impossible** without an upstream change (§6).
2. **The facade has no singular document embed.** `IEmbeddingBackend.embedDocument`
   (`tx.ts:68`) needs `provider.embedSingle(content,'document')`; the facade
   only has batch `embedDocuments` (which calls `provider.embedBatch`). Backlog
   must retain the injected provider for the per-write single embed — matching
   the plan's own note ("per-write keeps the injected provider's `embedSingle`").
3. **Injecting the provider is mandatory for the test seam.** The existing
   specs intercept `vi.mock('@adhd/sox-embedding-provider')`
   (`bootstrap.spec.ts:56`, `bootstrap-cache.spec.ts:67`). Node_modules deps are
   externalized by vitest, so a `createEmbeddingProvider` call made *inside the
   facade's dist* would not be intercepted and would load real fastembed. The
   provider must therefore be created in backlog's own source and injected.
4. **The fake provider does not satisfy `EmbeddingProvider`.** It implements
   only `metadata`/`embedSingle`/`health`
   (`fake-embedding-provider.ts:108-118`). Injecting it as `embeddingProvider`
   is a type error (missing `embedBatch`/`warmUp`) — extend the fake (§7 A).
5. **`SpaceInvariantError` does NOT cover the query path.** In the copy backlog
   compiles against (vector-store 0.7.0), it is thrown **only** in
   `upsert`/`upsertVectors` (`turso.js:118-119,135-136`; `index.js:177,198`;
   `lancedb.js:71`). `knn` (`turso.js:218`) performs **no** length check. So
   `checkDim`'s three sites split: `upsertVector`/`embedDocument` are covered
   (the vector store rejects at upsert); `embedQuery` is **not** — a
   wrong-length query vec reaches `knn` and produces an untyped driver/SQL
   error, violating ADR-0012's "a raw driver exception reaching a caller is a
   bug". See §5 for the resulting decision.
6. **Adoption forces a version cascade.** semantic 0.1.7 hard-requires
   graph-store `^0.11.0` + hybrid-search `^0.4.8`; the worktree has 0.10.1 /
   0.4.6. Both are published. graph-store 0.11.0 additionally ships the
   tx-scoped `transaction(fn, {mode})`/`GraphTransaction` surface the plan
   called **G1** — so this cascade is not incidental, and its blast radius
   (backlog's `NodeFilter`/`countNodes` usage) must be verified, not assumed.

## 3. Assessment — the adoption is near-neutral in isolation (recommendation)

Injecting both objects means `loadOptional`, both `Opt*` structural mirrors, the
`createEmbeddingProvider`/`openTursoVectorStore`/`ensureSpace` calls, `errText`,
`checkDim` and `PermanentEmbeddingDimensionError` **all survive**. What the
facade actually replaces is: the explicit `embedding`/`search` method bodies
(~30 lines), the ad-hoc log strings (replaced by `failure.detail`), and the
explicit `ensureSpace` (the facade calls it). It adds a hard dependency and a
graph-store/hybrid-search bump. **In isolation this is net-neutral-to-negative.**

The facade's real value is `semanticSearchNodes` (the node-join RRF) replacing
`StoreSearchBackend.searchRanked` + `dropSupersededResults` — which is **Wave
3c**, blocked on G3+G6, not 3a.

**Recommendation (debt-averse):** either
- **(a) minimal 3a** — do §4 (thin adapter) *plus* the upstream knn fix (§6) so
  the drop in §5 is honest; or
- **(b) defer the swap to 3c** and in 3a only bump `@adhd/sox-semantic` to
  `^0.1.7` (or drop the dead dep) + apply the graph-store 0.11.0 /
  hybrid-search 0.4.8 bump.

The spec below is written for **(a)**; it is fully valid as the 3c foundation
either way. No env-var toggle is proposed anywhere (ADR-0013).

## 4. Interface & behavioral changes

### `src/write/bootstrap.ts` — `deriveMembers` (lines 313-477)

- **Change:** replace the hand-built `embedding`/`search` wiring with a
  `createSemanticBackend` call; keep `SemanticStoreMembers`,
  `bootstrapSemanticStoreMembers`, `isVectorSpacePopulated`,
  `PermanentEmbeddingDimensionError`, `checkDim`, `loadOptional`, `errText`, and
  both `Opt*` mirrors.
- **Add import:** `import { createSemanticBackend } from '@adhd/sox-semantic';`
  (value import; semantic becomes a live hard dependency).
- **Keep:** the `cfg?.enabled` guard, the `nativeVectors !== true` guard, the
  two `loadOptional` calls, the provider construction, the space derivation, and
  the `openTursoVectorStore(adapter, space)` call (it yields the retained
  `vectorBackend`).
- **After `vectorBackend` opens**, call:

```ts
const result = await createSemanticBackend({
  adapter,
  embedding: { type: cfg.provider, model: cfg.model },
  space,
  embeddingProvider: provider as unknown as EmbeddingProvider, // structural; see §7 A
  vectorBackend,
});
if (!result.ok) {
  log(`backlog: createSemanticBackend failed (${result.failure.reason}): ${result.failure.detail}. Continuing WITHOUT semantic search.`);
  return {};
}
const backend = result.backend;
```

- **`embedding` member** becomes a thin delegation (keep `checkDim` on
  `embedDocument` so the local typed error is raised at the embed site):

```ts
const embedding: IEmbeddingBackend = {
  modelId: backend.modelId,
  async embedDocument(content) {
    return checkDim(await provider.embedSingle(content, 'document'), 'embedDocument');
  },
  async upsertVector(nodeRowid, vec) { await backend.upsertVector(nodeRowid, vec); },
  async deleteVector(nodeRowid) { await backend.deleteVector(nodeRowid); },
};
```

- **`search` member** — `backend` and the probe stay hand-built (the facade
  exposes neither); only `embedQuery` delegates:

```ts
const search: SemanticStoreMembers['search'] = {
  backend: new StoreSearchBackend(vectorBackend, graph),
  async embedQuery(text) { return checkDim(await backend.embedQuery(text), 'embedQuery'); },
  async spacePopulated() { return isVectorSpacePopulated(vectorBackend, backend.modelId); },
};
```

- **Remove:** the explicit `await vectorBackend.ensureSpace(space)` (the facade
  now performs it — `index.ts:270`). `openTursoVectorStore` already ensures, so
  this is idempotent either way.
- **Never touch:** `bootstrapSemanticStoreMembers`'s cache/eviction logic
  (lines 285-311 — commit `d7343221`), `isVectorSpacePopulated` (182-204), the
  module header, `PermanentEmbeddingDimensionError` (104-117).

### No other interface changes

`SemanticStoreMembers`, `IEmbeddingBackend` (`tx.ts:64`), `IQueryStoreHandle.search`
(`query.ts:75`), and `bootstrapSemanticStoreMembers`'s 4-arg signature are all
**unchanged** — every existing caller (`api.ts:172`, ETL `embed-backfill-cli.ts`,
`embed-verify-sample.ts`, `query/meta.spec.ts:26`, `views/semantic.spec.ts:50`)
compiles untouched.

## 5. The drop decision — `checkDim` / `errText` / `PermanentEmbeddingDimensionError`

**Verdict: the drop is REJECTED as specified.** Evidence (§2.5):
`SpaceInvariantError` is thrown only by `upsert`/`upsertVectors`; `knn` does not
validate. So it covers `upsertVector` (and `embedDocument`, which is upserted
immediately after) but **not `embedQuery`**, whose vector flows
`search.embedQuery` → `StoreSearchBackend.searchRanked`/`search` → `vec.knn`
(`views/semantic.ts:580`, `create-issue.ts:485,523`). Dropping the query guard
would surface an untyped driver error — an ADR-0012 violation.

- **`PermanentEmbeddingDimensionError` + `checkDim`: RETAIN** (query path).
- **`errText`: RETAIN** (still used by `loadOptional`'s failure logging, which
  survives because backlog still loads both optional packages).
- **Partial drop is allowed** only for the upsert sites (their `checkDim` is
  redundant with the vector store's own check) — but keeping them is harmless
  and gives a clearer local message, so keep as-is.

**The red/green test that must gate any future drop** (new
`src/write/bootstrap-adapter.spec.ts`):

- **RED (the gap, must be observed):** a provider stub whose
  `embedSingle(text,'query')` returns a vector of length `space.dim + 1`; drive
  `search.embedQuery` then `search.backend.searchRanked({ vec, ... })` against a
  real vector store with a real vector present. Assert the rejection is **NOT**
  `SpaceInvariantError` (today it is a raw Turso/SQL error). If this test
  *passes* as `SpaceInvariantError`, the upstream fix (§6.1) has landed and the
  drop becomes reviewable.
- **GREEN (the covered path):** `embedding.upsertVector(1, wrongLenVec)`
  rejects with `SpaceInvariantError` (imported from
  `@adhd/sox-vector-store`) — proving the write path needs no local guard.
- Negative control: temporarily delete the `checkDim` wrapper on `embedQuery`
  and confirm the GREEN query-path test goes red (a raw, untyped error), so the
  guard has teeth.

## 6. Sox-side changes (each needs its own spec in this program — never hand-rolled here)

1. **REQUIRED for §5's drop:** `@adhd/sox-vector-store` — `knn` must validate
   `query.length === space.dim` before issuing SQL and reject with
   `SpaceInvariantError`, giving the query path the same guarantee `upsert`
   already has. Files: `src/turso.ts` (`TursoVectorBackend.knn`),
   `src/index.ts` (`SqliteVectorBackend.knn`), `src/lancedb.ts`
   (`LanceDbVectorBackend.knn`). API: no signature change; new rejection class
   only. Until this ships, §5's drop stays rejected.
2. **OPTIONAL (enables the full-adoption variant, §2.1):**
   `@adhd/sox-semantic` — expose `readonly vectorBackend` on `SemanticBackend`
   (or a `spacePopulated(modelId): Promise<boolean>` method), so a host need not
   retain its own handle. Larger; own spec.
3. **Note, no action:** `BUG-HYBRID-SEARCH-OPTIONAL-LOADABILITY-001` is live —
   hybrid-search 0.4.8 still hard-declares `sox-vector-store ^0.7.0` +
   `sox-embedding-provider ^0.5.0`, and backlog already hard-depends on
   hybrid-search, so backlog's `optionalDependencies` on those two are
   **cosmetic (always installed)**. The plan's "move semantic to
   optionalDependencies" step is therefore **moot** — a static value import
   requires semantic in `dependencies`; leave it there.

## 7. Files, segments, estimates

| Path | Change | Read tok | Out tok |
|---|---|---|---|
| `src/test/helpers/fake-embedding-provider.ts` | modify | 60 | 60 |
| `src/write/bootstrap.ts` | modify (313-477 only) | 250 | 350 |
| `package.json` | modify (deps) | 40 | 40 |
| `pnpm-lock.yaml` | modify (via `pnpm install`) | 0 | 0 |
| `src/write/bootstrap-adapter.spec.ts` | create | 0 | 250 |
| `RAG-SPEC.md` §2.5 / `DESIGN.md` §9 / `PLUGIN_ARCHITECTURE.md` | modify | 120 | 120 |

### Segment A — fake provider (deps: none)

1. Add `embedBatch(texts: string[], opts?: { role?; batchSize? }):
   AsyncIterable<Float32Array>` to `FakeEmbeddingProvider` — a loop yielding
   `embedTextDeterministic(t, dims)` per text; add `warmUp(): Promise<void>`
   (no-op). Export them from the returned object.
2. Do NOT change `embedTextDeterministic`, `FAKE_EMBEDDING_DIMENSIONS`, or
   `FAKE_EMBEDDING_MODEL_ID`.

### Segment B — bootstrap adapter (deps: A for types, C for the import to resolve)

1. Read `src/write/bootstrap.ts` lines 300-477 ONLY.
2. Add the `createSemanticBackend` import beside the existing `StoreSearchBackend`
   import (line 45).
3. Rewrite only the tail of `deriveMembers` per §4 (from the `checkDim` const
   through `return { search, embedding }`). Keep `loadOptional`, `errText`,
   `PermanentEmbeddingDimensionError`, `isVectorSpacePopulated`,
   `bootstrapSemanticStoreMembers`, and the module header.
4. NEVER restructure the cache, the guards, or the `Opt*` mirrors.
5. Type note: cast `provider` at the `embeddingProvider` boundary (structural
   mirror → real type). Add a one-line comment citing this spec.

### Segment C — dependencies (deps: none)

1. `dependencies`: `@adhd/sox-semantic` `^0.1.2` → `^0.1.7`;
   `@adhd/sox-graph-store` `^0.10.1` → `^0.11.0`;
   `@adhd/sox-hybrid-search` `^0.4.6` → `^0.4.8`.
2. `optionalDependencies`: leave `@adhd/sox-vector-store ^0.7.0` and
   `@adhd/sox-embedding-provider ^0.5.0` (already correct).
3. `pnpm install` (**not** `pnpm update`) in the worktree. Verify with
   `node -e "console.log(require('@adhd/sox-semantic/package.json').version)"`
   → `0.1.7`; and read the **nested**
   `entrypoint/backlog/node_modules/@adhd/sox-vector-store/package.json` → `0.7.0`.

### Segment D — adapter spec (deps: A, B)

1. Create `src/write/bootstrap-adapter.spec.ts` with the `Embeddings mocked here`
   marker **and** a `vi.mock('@adhd/sox-embedding-provider', ...)` call
   (mirror `bootstrap-cache.spec.ts:63-94`) so
   `tools/gate/embedding-usage-gate.mjs` stays CLEAN.
2. Implement T1–T4 (§8). Use a real store via `openTestIssueStore`, a real Turso
   vector space, and the fake provider; assert on classes/payloads, never on
   call counts alone.

### Segment E — docs (deps: B)

1. `RAG-SPEC.md` §2.5 and `DESIGN.md` §9: state that the embedding stack is now
   DI-wired through `createSemanticBackend`, that `vectorBackend`/`embeddingProvider`
   are injected, and that the query-side dim guard is retained pending the
   upstream `knn` check. `PLUGIN_ARCHITECTURE.md:60-66`: update the
   `PermanentEmbeddingDimensionError` description accordingly.

## 8. Test plan (targeted; no blanket `nx affected`)

**Keep green unchanged:** `src/write/bootstrap.spec.ts` (a+b),
`src/write/bootstrap-cache.spec.ts` (3 eviction cases),
`src/api.semantic-laziness.spec.ts`, `src/query/text-routing.spec.ts`,
`src/query/views/semantic.spec.ts`, `src/query/meta.spec.ts`,
`src/write/create-duplicate-gate.spec.ts`,
`src/query/search-ranked-zero-filter.spec.ts`.

**New `src/write/bootstrap-adapter.spec.ts`:**
- **T1 (teeth):** `embedding.upsertVector(1, wrongLenVec)` rejects with
  `SpaceInvariantError` — proves write-path coverage.
- **T2 (teeth, the §5 gate):** wrong-length `embedQuery` → `searchRanked`
  rejects with a NON-`SpaceInvariantError` today; and `search.embedQuery`
  itself rejects with `PermanentEmbeddingDimensionError`. Negative control:
  remove the `embedQuery` `checkDim` wrapper → T2 goes red.
- **T3:** `provider_failed` / `unsupported_adapter` from the facade map to a
  member-less `{}` (and are evicted, per `bootstrap-cache.spec.ts`).
- **T4 (optional-load proof):** spy on the facade call and assert it received
  **both** `embeddingProvider` and `vectorBackend` (so it resolves neither
  optional specifier). The authoritative resolve-hook proof remains upstream's
  `sox-semantic/src/optional-loadability.spec.ts`.

**Real-model proof (default-running, not gated):**
`src/api.semantic-production-seam.spec.ts` drives the real fastembed through
`bootstrapSemanticStoreMembers` end-to-end and must stay green — it is the
REAL_BY_DESIGN entry in `embedding-usage-gate.mjs`.

**Commands (targeted):**
`npx nx build backlog` (type-check) ·
`npx vitest run src/write/bootstrap-adapter.spec.ts src/write/bootstrap.spec.ts src/write/bootstrap-cache.spec.ts src/api.semantic-laziness.spec.ts src/query/text-routing.spec.ts src/query/views/semantic.spec.ts src/query/meta.spec.ts` ·
`node tools/gate/embedding-usage-gate.mjs` · `npx nx lint backlog`.
Because graph-store 0.11.0 is pulled in (§2.6), also run
`src/query/superseded-ranking.spec.ts`, `src/query/superseded-views.spec.ts`,
`src/query/superseded-listing.spec.ts` — the NodeFilter blast radius.

## 9. Open questions

1. **Adopt now or defer to 3c?** §3 recommends deferring the swap and doing only
   the dependency bump in 3a; the caller's directive says adopt. Confirm.
2. **graph-store 0.10.1 → 0.11.0 blast radius** — does any backlog call site
   (esp. `NodeFilter`/`countNodes`/`transaction`) change behavior? Verify before
   merging; the cascade is forced by semantic 0.1.7, not chosen.
3. **Upstream knn dim check (§6.1)** — schedule it? Without it, §5's drop stays
   rejected and `checkDim`/`PermanentEmbeddingDimensionError` remain permanently.
4. **The concurrent executor's package.json** may already carry different ranges
   than read here; re-read at execution time.
