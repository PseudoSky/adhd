# Backlog Interface v2 — Dispatch Plan (READY corpus → work orders)

**Plan slug:** `backlog-interface-v2-dispatch`
**Status:** READY TO DISPATCH (design corpus is READY-WITH-FIXES, all review fixes applied)
**Work orders:** 45 across 7 epics (4 F + 7 G1 + 10 A + 4 B + 5 G2 + 13 C + 2 D) — every order requires a code review before acceptance (§4.5).
**Corpus (source of truth — do NOT re-design):**
- `docs/spec/backlog/INTERFACE_v2.md` (6-tool contract, §7 contracts, §10 AC-0..AC-31)
- `docs/spec/backlog/GRAPH_MODEL_v2.md` (dimensional model, BUG-1/BUG-2, migration)
- `docs/spec/backlog/PLUGIN_ARCHITECTURE.md` (plugin host, embedding-remote, sox bundle)
- `entrypoint/backlog/RAG-SPEC.md` (v0.3: semanticSearch, embed pipeline, plan-graph ops, phasing)

**Established sequencing (verified, do not re-litigate):**
`EPIC-F (sox substrate) → [G-part-1 ∥ A] → B → G-part-2 → C → D (continuous after every epic)`

**Verified codebase facts (2026-08-08 spot-check):**
- `entrypoint/backlog/src/store/graph-backlog-store.ts` opens `better-sqlite3` raw handle + `createGraphBackend(db)` (sync, `^0.3.0`). EPIC-F replaces with `createStoreAdapter({dbPath})` + `createGraphBackend(adapter)` (0.6.0 async).
- `entrypoint/backlog/src/store/query.ts` (403 lines) owns `nodeFilterFromBacklogFilter`, `queryItemNodes`, `listItems`, `findItemNode`, `topoOrder`, `staleClaims`. **Owned by A first, B second — never parallel edits.**
- `entrypoint/backlog/src/model.ts:309` `BacklogFilter` — field ownership per INTERFACE §2.1 "lands with" table.
- `entrypoint/backlog/src/store/ids.ts:25` `computeNextHumanId` — live-only scan today; BUG-2 makes it bi-temporal.
- `entrypoint/backlog/src/store/crud.ts:112` `dedupeScan`; `structure.ts:70` `supersedeItemNode` (skips dedupe), `structure.ts:138` `splitItemNode` (discards `created` flag) — the BUG-1 guard targets these.
- `entrypoint/backlog/src/server.ts` `buildBacklogApigenPackage` + `startBacklogServer`; `src/cli.ts` `runBacklogCli`; `src/serve.ts` `runServeCommand` (host carve-out: install/install-skill/serve).
- Upstream: `@adhd/sox-graph-store@^0.3.0` in `package.json`; the 0.6.0/0.2.0 targets live in the **sox-ecosystem repo** (`/Users/nix/dev/ai/sox-ecosystem/`, libs under `libs/data/graph/graph-store`, `libs/data/embed/embedding-provider`, `libs/service-proxy`, bundles under `extensions/bundles/`).

---

## 0. Ownership rules (from the review — every implementer must respect these)

1. **`store/query.ts` is A-owned first, B-owned second.** A-04 routes dimensional filters through `dimensional.ts`; B-02/B-03 build on A's output. No work order may edit `query.ts` while another is in flight (waves separate them).
2. **`model.ts` `BacklogFilter` — the epic that ADDS a field owns the type.** A adds `author/reporter/project/packagePath` (GRAPH_MODEL §6). B adds `dateRange` (INTERFACE §2.1 lands-with "query layer"). C adds `semantic/anchor/dupeHitsMin/hasAcceptanceCriteria/missingAcceptanceCriteria/missingCitation` (INTERFACE §2.1 lands-with table). Consuming epics extend, never restructure.
3. **`graph-backlog-store.ts` is F-owned first.** F-01 converts to adapter+async; G1-05 extends `openGraphBacklogStore` with `opts.embedding` only after F lands.
4. **`client.ts` is A-extended, C-consolidated.** A-09 adds `queryItems/aggregateBy/reconcileRepos/migrateGraphModelV2`; C-01 restructures exports to exactly six verbs.
5. **EPIC-C is LAST; C-01 is the re-issued TASK-003** — it must be drafted against the post-A model (dimensional filters, canonical repo resolution), never against the pre-A flat surface.
6. **`by` is explicit on all mutations** (INTERFACE §7.5); CLI resolves from env → `git config user.name` → `invalid_argument` (AC-26). Evidence gate default ON, per-repo opt-out (INTERFACE §5a.2 — continuation of v1 `requiresCitation`, model.ts:75).
7. **EVERY work order gets a code review before it is accepted — no exceptions.** The reviewer (`dispatch-project-reviewer-flash`) audits the diff against the work order's spec section + ACs and gates acceptance. Review scope per work order (all mandatory):
   - **Spec conformance** — the implementation matches the cited spec section + AC exactly; no silent deviation (a deviation is a planning blocker, flagged to the orchestrator, never absorbed).
   - **Platform isolation** — `platform:node` code never imports browser code; `platform:shared` stays pure TS (AGENTS.md §3).
   - **Test teeth** — the work order's named acceptance test FAILS when the fix is reverted (negative control proven red); `nx test <project>` + `nx affected -t test` green for dependents.
   - **Lint** — `npx nx lint <project>` clean on every touched file (AGENTS.md §6); a disabled rule is stated in code + logged, never silent.
   - **Dependency purity** — no upward/circular deps; `@adhd/` scoped imports exactly match package.json names (AGENTS.md §9).
   - **Blast radius** — `gitnexus_impact` on every edited symbol was run BEFORE the edit (AGENTS.md GitNexus rules); HIGH/CRITICAL risk was surfaced, not ignored.
   - **Working-tree hygiene** — the tree is left as found (AGENTS.md): `git status --porcelain` accounted for, no residue, tests restore their own artifacts.
8. **Every work order runs `gitnexus_impact` before editing any symbol and `gitnexus_detect_changes` before commit** — the repo's mandatory code-intelligence gates; a work order that edits without them fails review (rule 7, blast-radius check).

---

## 1. Work-order decomposition

### EPIC-F — sox substrate (graph-store 0.6.0 adapter + async)

#### F-01: adapter construction swap in graph-backlog-store.ts
- **Files:** `entrypoint/backlog/src/store/graph-backlog-store.ts`, `entrypoint/backlog/package.json`
- **Implement:** Replace `new Database(dbPath)` + `createGraphBackend(db)` with `createStoreAdapter({ dbPath })` (defaults `turso`) + `createGraphBackend(adapter, { typePolicy })`; `GraphBacklogStore.db: Database` becomes `adapter: StoreAdapter`; the CAS primitive becomes `adapter.transaction(fn, { mode: 'immediate' })` (replacing `db.transaction(...).immediate()`); `closeGraphBacklogStore` becomes `async` (GRPH_MODEL §6 "db becomes adapter"; RAG-SPEC §0; PLUGIN_ARCH §4). Bump `@adhd/sox-graph-store` to `^0.6.0`, add `@adhd/sox-store-adapter`. **Satisfies:** GRAPH_MODEL §6; RAG-SPEC §0.1.
- **Acceptance:** `nx build backlog` + `nx test backlog` green with adapter construction; all `store.graph.*` calls unchanged; **negative control:** a reverted sync `store.db.` call is a type error (adapter has no raw `.transaction().immediate()`).
- **Tier:** **deepseek** — touches every store module's transaction shape; mechanical but broad.
- **Depends on:** upstream graph-store 0.6.0 + sox-store-adapter published (F-03 PR is the carrier; see risk R1).
- **Budget:** read ~1200 / output ~600.

#### F-02: async conversion across all store modules
- **Files:** `store/crud.ts`, `store/ids.ts`, `store/query.ts`, `store/structure.ts`, `store/lifecycle.ts`, `store/claim.ts`, `store/audit-log.ts`, `store/mutate-metadata.ts`, `store/immediate-retry.ts`, `client.ts`, `server.ts`, `serve.ts` (call sites), `migration-admin.ts`
- **Implement:** Make every store function `async` (the 0.6.0 API is fully async — RAG-SPEC §0). `withImmediateRetry` becomes async-await over `adapter.transaction(..., { mode: 'immediate' })`. All call sites `await`. **Satisfies:** RAG-SPEC §0; GRAPH_MODEL §6 ("all store functions become async (EPIC-F mechanical conversion)").
- **Acceptance:** `nx test backlog` full suite green (concurrency-scale.spec.ts, claim.spec.ts, humanid-collision.spec.ts included). **Negative control:** any un-awaited store call fails type-check (`@typescript-eslint/no-floating-promises` / `tsc` via `nx build`).
- **Tier:** **deepseek** — cross-file signature churn; collision with F-01 same wave (same files) so F-02 depends on F-01.
- **Depends on:** F-01.
- **Budget:** read ~4000 / output ~1500.

#### F-03 (UPSTREAM, sox-ecosystem): NodeFilter.tUpdatedAfter/tUpdatedBefore + R3 searchNodes-offset/countNodes-FTS
- **Files (sox-ecosystem):** `libs/data/graph/graph-store/src/index.ts` (NodeFilter predicate on `t_updated`; `searchNodes` gains `offset`; `countNodes` gains an FTS-query form)
- **Implement:** Add the upstream `NodeFilter.tUpdatedAfter/tUpdatedBefore` predicate the `updated` axis of `BacklogFilter.dateRange` needs (INTERFACE §2.1 mechanism, "added in EPIC-F co-located with the R3 searchNodes-offset change"), plus `searchNodes` offset and FTS-aware `countNodes` (INTERFACE §2.1 R3 / §7.4). **Owner:** sox-ecosystem team; backlog liaison supplies the pinned contract (INTERFACE §2.1, §7.4).
- **Acceptance:** sox-ecosystem's own graph-store suite green; a downstream smoke test from this repo calls `searchNodes(q, { offset })` and `countNodesFts(q, filter)` against a real Turso adapter. **Fallback if unmerged:** B-03 and C's `dateRange.updated` use the already-sanctioned raw-SQL range predicate over `t_updated` (index.ts:87,1127 — INTERFACE §2.1 "the spec names the mechanism") and documented full-fetch-then-slice with performance budget (INTERFACE §9 Q1). No blocking.
- **Tier:** **deepseek** (upstream; separate repo dispatch).
- **Depends on:** sox graph-store 0.6.0 branch.
- **Budget:** read ~1500 / output ~800.

#### F-04: adapter-aware store specs + verify-dist-load
- **Files:** `src/store/graph-backlog-store.spec.ts`, `src/store/concurrency-scale.spec.ts`, `src/test/helpers/tmp-store.ts`
- **Implement:** Rewrite store specs to construct via `createStoreAdapter` on real Turso files under `tmp/backlog/<test-name>/` (removed on teardown — RAG-SPEC §8 conventions); assert CAS semantics via `adapter.transaction(..., {mode:'immediate'})`.
- **Acceptance:** `nx run backlog:verify-dist-load` green (native deps load); `nx test backlog` green on the real adapter. **Negative control:** a spec that opens `:memory:` via the raw handle fails to compile.
- **Tier:** **flash** (well-specified test rewrite after F-01/F-02).
- **Depends on:** F-01, F-02.
- **Budget:** read ~1200 / output ~700.

---

### EPIC-G-part-1 — plugin host + embedding-remote + sox embedding bundle (∥ A)

#### G1-01: plugin seam types
- **Files:** `src/plugins/types.ts` (create)
- **Implement:** `BacklogPluginContext`, `EmbeddingCapability<Opts>`, `BacklogPlugin<Opts>` exactly per PLUGIN_ARCH §2.1. No general hook registry.
- **Acceptance:** type-only module compiles; used by G1-02/G1-03.
- **Tier:** **flash** — isolated new file, contract already pinned in spec.
- **Depends on:** F-02 (async ctx).
- **Budget:** read ~200 / output ~150.

#### G1-02: plugin registry + loader
- **Files:** `src/plugins/registry.ts` (create)
- **Implement:** Static builtin registry keyed by id; dynamic discovery via `import()` of a package specifier/local path; a module with no plugin export throws; host validates `options` against `optionsSchema` before any capability call (PLUGIN_ARCH §2.2).
- **Acceptance:** PLUGIN_ARCH §9.1: builtin resolves by slug; fixture plugin loads via dynamic import; no-export module throws.
- **Tier:** **flash** — single file, spec-pinned behavior.
- **Depends on:** G1-01.
- **Budget:** read ~300 / output ~250.

#### G1-03: RemoteEmbeddingProvider
- **Files:** `src/plugins/embedding-remote/provider.ts` (create)
- **Implement:** `createRemoteEmbeddingProvider(cfg, ctx)` implementing `@adhd/sox-embedding-provider`'s `EmbeddingProvider` (`embedSingle/embedBatch/warmUp/health/metadata`) via `ensureBackend` (O_EXCL singleton spawn-lock) + `dialBackend`; `ResolutionError` when the backend cannot resolve; `TransientEmbeddingError` on backend-down; `PermanentEmbeddingError` on dimension mismatch; `metadata` from `modelInfo` RPC, never config; `health()` truthful (never `real` with `active:null`) (PLUGIN_ARCH §3.1).
- **Acceptance:** PLUGIN_ARCH §9.2/9.4: real backend process → `embedSingle` → `Float32Array` length 768 non-zero; 384-dim config → `PermanentEmbeddingError` (negative control); health never lies (negative control: backend reporting `real` with `active:null` rejected).
- **Tier:** **deepseek** — real UDS/RPC protocol work.
- **Depends on:** G1-01; sox-embedding-provider 0.2.0 + sox-service-proxy published (upstream, see risk R2).
- **Budget:** read ~800 / output ~600.

#### G1-04: embedding-remote plugin object
- **Files:** `src/plugins/embedding-remote/index.ts` (create)
- **Implement:** `BacklogPlugin` with `id: 'embedding-remote'`, `optionsSchema`, `capabilities.embedding = { createProvider, health }` (PLUGIN_ARCH §3.2).
- **Acceptance:** registry resolves it; `createProvider` validates options then constructs.
- **Tier:** **flash** — trivial composition over G1-03.
- **Depends on:** G1-02, G1-03.
- **Budget:** read ~150 / output ~100.

#### G1-05: store wiring — openGraphBacklogStore opts.embedding, embed pipeline, durability
- **Files:** `src/store/graph-backlog-store.ts`, `src/store/embed-pipeline.ts` (create), `src/store/query.ts` (add-only exports: `semanticSearch`, `relatedItems` — **A-04 must have landed first**), `src/model.ts` (`RagNotConfiguredError`, `awaitEmbed` on Create/Update input — see ownership rule 2: G adds these fields), `src/client.ts` (thread `awaitEmbed`)
- **Implement:** `openGraphBacklogStore(dbPath, opts?: { embedding?: { plugin, options? } })` resolves the plugin, validates options, calls `createProvider`; absent `opts.embedding` → `store.embedding` stays undefined and semantic ops throw `RagNotConfiguredError` while `listItems({grep})` stays FTS-only (RAG-SPEC §3.1, §1.6; PLUGIN_ARCH §4). Embed pipeline: `scheduleEmbed` (never inside the CAS transaction — Phase A/Phase B, RAG-SPEC §2.1), per-store in-flight set, `flushEmbeds()`, async `closeGraphBacklogStore` drains (RAG-SPEC §2.2). `awaitEmbed` durability (RAG-SPEC §2.2). Vector table via `createVectorDialect(adapter.config.type)` → `TursoVectorDialect`, `F32_BLOB(dim)`, `vecToBlob/blobToFloat32` (RAG-SPEC §0.3). `embed_model` stamp from `provider.metadata.modelId` in the same transaction as the vector upsert (RAG-SPEC §2.4). Re-embed on title/body change (RAG-SPEC §2.3). `semanticSearch`/`relatedItems` store primitives (RAG-SPEC §3.1/§3.2) with `buildNodeFilterClause` push-down.
- **Acceptance:** PLUGIN_ARCH §9.3/9.5 + RAG-SPEC §8.7/8.9: no-embedding store → `semanticSearch` throws `RagNotConfiguredError` while `listItems({grep})` returns FTS hits; `createItem({awaitEmbed:true})` → reopen → vector non-null AND `embed_model` == resolved `modelInfo` modelId; **negative control:** bypass the drain (bare close) → reopened vector is null (RAG-SPEC §8.9).
- **Tier:** **deepseek** — new pipeline + store extension; interacts with F-owned file (must land after F-01/F-02).
- **Depends on:** F-01, F-02, G1-03, G1-04, A-04 (query.ts owned by A first — G1-05's query.ts additions are additive exports only, still ordered after A-04).
- **Budget:** read ~2500 / output ~1200.

#### G1-06 (UPSTREAM, sox-ecosystem): sox embedding bundle
- **Files (sox-ecosystem):** `extensions/bundles/sox-embedding-bundle/members/embedding-server/` (manifest `extension.json`, backend `serveBackend` wrapping `createEmbeddingProvider({type:'fastembed', model})`), `libs/data/embed/embedding-provider` (fastembed provider + `modelInfo`), `libs/data/vectors/vector-store` / Turso vector backend
- **Implement:** The embedding service bundle exactly per PLUGIN_ARCH §6 (service manifest, singleton key `(embedding-server, model)`, JSON-RPC contract: `embed/embedBatch/health/modelInfo/warmup` published to `dist/schema.json`, compact blob vectors). **Owner:** sox-ecosystem.
- **Acceptance:** PLUGIN_ARCH §9.2/§9.6: `serveBackend` + real fastembed → `embedSingle` returns 768-dim; semantic recall: paraphrased query ranks the match top-3 (negative control: zero vector weight → match drops out). Fallback if unmerged: G1-03's `TransientEmbeddingError` + `health:error` degrade path keeps backlog green (PLUGIN_ARCH §9.3); v1 `view:"similar"` ships FTS-overlap (INTERFACE §9 Q2).
- **Tier:** **deepseek** (upstream, separate repo).
- **Depends on:** sox-embedding-provider 0.2.0 base.
- **Budget:** read ~2000 / output ~1000.

#### G1-07: G-part-1 tests (plugin + provider + durability + semantic recall)
- **Files:** `src/plugins/registry.spec.ts`, `src/plugins/embedding-remote/provider.spec.ts`, `src/store/embed-pipeline.spec.ts` (create)
- **Implement:** PLUGIN_ARCH §9 test cases 1-6 + RAG-SPEC §8.9, all on real Turso + real fastembed under `tmp/backlog/<test>/`, default-running (no env gates — real embeddings are in-repo sox-owned; the only allowed gate is a paid external service, which this is not).
- **Acceptance:** the negative controls in G1-03/G1-05 go red when the guards are stripped.
- **Tier:** **test** (dispatched via test agent per AGENTS §7).
- **Depends on:** G1-02..G1-06.
- **Budget:** read ~1500 / output ~900.

---

### EPIC-A — graph model v2 (∥ G-part-1)

#### A-01: model.ts dimensional fields + result types
- **Files:** `src/model.ts`
- **Implement:** Add `author?`, `reporter?`, `project?`, `packagePath?` to `BacklogFilter`; `author?`, `reporter?` to `CreateItemInput`; `reason?` to `CreateItemResult`; new `SplitItemResult`, `SupersedeResult`, `RollupResult`, `MigrateModelV2Result` (GRAPH_MODEL §5.1, §6). **A owns these fields** (ownership rule 2).
- **Acceptance:** GRAPH_MODEL §6 interface list compiles; consuming work orders (A-03/A-04/C) extend, not restructure.
- **Tier:** **flash** — additive type changes, spec-pinned.
- **Depends on:** F-02 (async result plumbing).
- **Budget:** read ~400 / output ~250.

#### A-02: canonicalRepoKey / canonicalIdentityKey + alias resolution
- **Files:** `src/store/identity.ts` (create; or add to `mapping.ts` — prefer new file, avoids colliding with F-02's mapping edits)
- **Implement:** `canonicalRepoKey(raw)` (trim, strip `.git`, bare-name wins iff unambiguous), `canonicalIdentityKey(raw)` (strip `:instanceId`, resolve aliases, `claimOnly` flag), `canonicalRepoKeyFor(store, raw)` = alias-map lookup → deterministic normalization → (create if absent) → canonical repo node; ambiguity surfaces as envelope `warnings` on query, soft warning on create (GRAPH_MODEL §2.1.1, §3).
- **Acceptance:** GRAPH_MODEL §8.2: items under `adhd` and `PseudoSky/adhd` reconcile to one node; query via either key returns the full set. **Negative control:** bare-name ambiguity never silently narrows — it emits a `warnings` entry (AC-24 / GRAPH_MODEL §3).
- **Tier:** **deepseek** — canonicalization semantics + alias map + repo-node minting.
- **Depends on:** A-01.
- **Budget:** read ~600 / output ~500.

#### A-03: store/dimensional.ts — queryDimensionalItems + aggregateByDimension
- **Files:** `src/store/dimensional.ts` (create)
- **Implement:** `queryDimensionalItems(store, filter)` — `buildNodeFilterClause(liveOnly=true)` AND one `EXISTS (SELECT 1 FROM edge WHERE src=n.rowid AND rel=? AND dst=?)` per dimension present (repo/author/reporter/project/package/plan/assignee), limit/offset pushed down (GRAPH_MODEL §4). `aggregateByDimension(store, dimension, filter)` — `SELECT e.dst, COUNT(*) … GROUP BY e.dst` (edge-backed) or `countByKey` (metadata-backed). Author/reporter filters resolve via `canonicalIdentityKey`. Register the five new rels in `backlogTypePolicy` extending `DEFAULT_EDGE_RELS` (GRAPH_MODEL §2.2 — policy object, not schema migration; legacy rel-CHECK reopen lives in A-07).
- **Acceptance:** GRAPH_MODEL §8.1: 2 repos × 2 authors, `{repo:X, author:Z}` returns exactly the intersecting subset (one SQL statement — assert via timing/no-post-filter is a proxy; assert the *result*). §8.6: `aggregateBy('reporter')` matches a manual count.
- **Tier:** **deepseek** — the query core; SQL + canonicalization.
- **Depends on:** A-01, A-02; F-01/F-02 (adapter + async).
- **Budget:** read ~800 / output ~600.

#### A-04: query.ts dimensional routing (A owns the file first)
- **Files:** `src/store/query.ts`
- **Implement:** Route `repo/projectPath/author/reporter/project/packagePath` filters through `dimensional.ts` in `queryItemNodes`/`listItems`/`spotlight`/`readyItems`/`staleClaims`/`dependencyGraph`; keep the v1 filter surface API-compatible (GRAPH_MODEL §4 last para). `BacklogFilter` repo/projectPath now resolve canonically.
- **Acceptance:** GRAPH_MODEL §8.7 (cross-repo: repo A item `DEPENDS_ON` repo B item; project-level "which projects depend on repo B" returns project of A) + AC-7/AC-8 preconditions met at the store layer. **Negative control:** a repo-scoped query returns no foreign-repo item.
- **Tier:** **deepseek** — collision-critical file; only A (this order) then B may touch it.
- **Depends on:** A-03.
- **Budget:** read ~1000 / output ~700.

#### A-05: BUG-1 — silent-dedup-drop contract + OP-layer interception
- **Files:** `src/store/structure.ts`, `src/store/crud.ts`, `src/model.ts` (already has `reason?` via A-01), `src/client.ts`
- **Implement:** `splitItemNode` returns `{ created: BacklogItem[], suppressed: Array<{item, reason}> }` and writes `PART_OF` only for actually-created children; `supersedeItemNode` runs the dedupe scan **before** minting and returns `{ ok, created, item?, humanId?, duplicateCandidates?, reason? }` — never mints on suppression; create variants return `{ ok, created, humanId?, duplicateCandidates?, reason? }` (GRAPH_MODEL §5.1; INTERFACE §3 silent-drop guard).
- **Acceptance:** GRAPH_MODEL §8.3: split/supersede with a duplicate returns `{created:false, reason}` — never a silent drop. **Negative control:** strip the guard → the created-flag loss makes the test go red.
- **Tier:** **deepseek** — result-contract change ripples to client ops.
- **Depends on:** A-01.
- **Budget:** read ~900 / output ~600.

#### A-06: BUG-2 — humanId bi-temporal scan
- **Files:** `src/store/ids.ts`
- **Implement:** `computeNextHumanId` derives the next id from full bi-temporal history — live nodes AND `t_invalid` rows — via `buildNodeFilterClause(liveOnly=false)` over `(canonicalRepo, family)`, max trailing `-NNN` (GRAPH_MODEL §5.2).
- **Acceptance:** GRAPH_MODEL §8.4: superseding the max-id item never re-mints it. **Negative control:** revert to live-only scan → the re-mint reproduces.
- **Tier:** **flash** — single function, spec-pinned scan change.
- **Depends on:** A-02 (canonicalRepo), F-02.
- **Budget:** read ~400 / output ~200.

#### A-07: migrateGraphModelV2 (incl. legacy rel-CHECK reopen)
- **Files:** `src/store/migrate-model-v2.ts` (create), `src/migration-admin.ts` (wire `migrate-model-v2` admin surface), `src/model.ts` (`MigrateModelV2Result`)
- **Implement:** The 7-step migration (GRAPH_MODEL §7): `adapter.backupTo`; legacy edge-schema reopen for pre-0.6.0 stores (rel CHECK rejects the five new rels at DDL — rebuild the edge table, sequenced with EPIC-F's schema work); dry-run parity on a temp copy (item count, per-item humanId/repo/status/plan, edge count by rel); build dimension nodes + role edges + metadata stamps; repo reconciliation with collision report; verify zero drift; commit. **Re-embed-on-content-change sweep** ships with it (any item whose `content_hash` changed gets its embedding regenerated — reuses backfill batching; the sweep is a hook that G2-04/backfill provides — see dependency).
- **Acceptance:** GRAPH_MODEL §8.5: legacy-shape store → migrate → zero drift, reopen verifies; §8.8: RAG join key resolves, `DERIVED_FROM` audit links intact, evidence-gated terminal transitions still throw without a citation. **Negative control:** a store that skipped the rel-CHECK reopen rejects `IN_REPO` writes at DDL (proving the reopen is load-bearing).
- **Tier:** **deepseek** — data migration with backup/parity/reopen.
- **Depends on:** A-02, A-03, F-01/F-02; G2-04 for the re-embed sweep hook (may land as a no-op callback before G2).
- **Budget:** read ~2000 / output ~1200.

#### A-08: repo reconciliation + projection-manifest reconcile
- **Files:** `src/store/reconcile.ts` (create), `src/client.ts` (`reconcileRepos`), `src/cli.ts` (admin surface for `reconcile-repo` — minimal; full C-07 later), `docs/plan/backlog-adoption/projection-manifest.json` (reconcile filters referencing pre-canonical repo strings)
- **Implement:** Reconcile re-points item edges to the winner repo node, folds loser aliases, invalidates losers with `reason:'repo reconciliation'`, re-stamps `metadata.repo`/`name`/content-marker/`content_hash`/`namespace`; item rowids never change (raw-SQL escape hatch; RAG vector join key untouched — GRAPH_MODEL §3). Update the projection-manifest filters that reference pre-canonical repo strings (GRAPH_MODEL §7 last para).
- **Acceptance:** GRAPH_MODEL §3 invariants: after reconcile, `adhd` and `PseudoSky/adhd` resolve to one node, loser repo node invalidated, content_hash re-stamped; the projection manifest renders with expected-diff documented (parity gate D runs with the allowance).
- **Tier:** **deepseek** — data rewrite + manifest.
- **Depends on:** A-02, A-07 (ordering: after migration's reconciliation step, but implementable in the same wave).
- **Budget:** read ~1200 / output ~800.

#### A-09: client ops — queryItems, aggregateBy, reconcileRepos, migrateGraphModelV2
- **Files:** `src/client.ts`, `src/index.ts` (re-export)
- **Implement:** New client operations wrapping A-03/A-07/A-08 (GRAPH_MODEL §6 "New client operations"), JSDoc'd async functions only (client.ts's apigen extraction contract — server.ts doc).
- **Acceptance:** `nx build backlog` extracts the new ops (they appear in `operations`); smoke through `buildBacklogApigenPackage`.
- **Tier:** **flash** — thin client wrappers over store functions.
- **Depends on:** A-03, A-07, A-08.
- **Budget:** read ~400 / output ~300.

#### A-10: EPIC-A DoD tests
- **Files:** `src/store/dimensional.spec.ts`, `src/store/migrate-model-v2.spec.ts`, `src/store/ids.spec.ts` (extend), `src/client.spec.ts` (extend)
- **Implement:** GRAPH_MODEL §8 test cases 1-8 on a real Turso adapter (default-running): motivating query, fork-key, BUG-1/BUG-2 negative controls, migration parity, aggregateBy manual count, cross-repo, invariants survive migration.
- **Acceptance:** all eight pass; the two negative controls go red when the guards are stripped.
- **Tier:** **test** (test agent).
- **Depends on:** A-02..A-09.
- **Budget:** read ~1500 / output ~1000.

---

### EPIC-B — query correctness (builds on A's output)

#### B-01: BacklogFilter.dateRange + filter schema validation groundwork
- **Files:** `src/model.ts`
- **Implement:** Add `dateRange?: { created?: { since?, until? }, updated?: { since?, until? } }` to `BacklogFilter` (**B owns this field** — INTERFACE §2.1 "lands with query layer"); the mechanism uses `NodeFilter.tCreatedAfter/tCreatedBefore` (existing) and `tUpdatedAfter/tUpdatedBefore` (F-03) or the raw-SQL `t_updated` fallback.
- **Acceptance:** field compiles; C's filter validation (C-03) treats it as a nested schema.
- **Tier:** **flash** — additive type.
- **Depends on:** F-03 (or fallback), A-04 (query.ts available post-A).
- **Budget:** read ~200 / output ~150.

#### B-02: limit × post-filter push-down (open/closed, rootLevel, excludeArchived)
- **Files:** `src/store/query.ts`, `src/store/dimensional.ts` (where dimensional predicates already push down)
- **Implement:** Move `open/closed`, `rootLevel`, `excludeArchived` from JS post-filters (query.ts:39-43,53-71,100) into the store query — status via the store predicate, rootLevel/excludeArchived via pushable predicates where the 0.6.0 API allows, else documented raw-SQL (INTERFACE §2.1 BUG-003 fix 1). Filters apply **before** limit — never after.
- **Acceptance:** INTERFACE §2.1: `{status:"open", limit:145}` returns 145 open items when 145 exist; `{grep, status:"open", limit:10}` returns 10 open items when open matches exist. **Negative control:** revert to post-filter → the truncation defect reproduces (fewer than limit returned).
- **Tier:** **deepseek** — correctness-critical on the collision file; only after A-04.
- **Depends on:** A-04, B-01.
- **Budget:** read ~1000 / output ~600.

#### B-03: offset-after-rank fix + {total, returned} + MAX_LIMIT
- **Files:** `src/store/query.ts`, `src/model.ts` (query result envelope types — additive)
- **Implement:** In the grep path, `offset` applies to the same ordering the results come from (remove the post-hoc `slice()` on the bm25-ranked list — query.ts:83,87; with F-03's upstream `searchNodes` offset, push it down; else documented full-fetch-then-slice with a performance budget, INTERFACE §2.1 fix 2 + §9 Q1). Return `{ total, returned }` in the response envelope for list queries; `MAX_LIMIT` (1000) is a `validation` error, never a silent cap (INTERFACE §2.1 last bullet, §7.4).
- **Acceptance:** AC-25: `--limit 5` on 100+ open items returns `{total: <all open>, returned: 5}`. **Negative control:** `offset:145 → open-item #80` defect is gone (offset applies to the ranked order).
- **Tier:** **deepseek** — ordering correctness on the collision file; after A-04.
- **Depends on:** A-04, F-03 (for the push-down path).
- **Budget:** read ~900 / output ~500.

#### B-04: EPIC-B DoD tests
- **Files:** `src/store/query.spec.ts` (extend)
- **Implement:** The BUG-003 behavior tests with teeth: limit×post-filter composition, offset-after-rank, total/returned, MAX_LIMIT validation error (exit 2 at the C seam later; at B, a thrown `ValidationError`).
- **Acceptance:** each negative control (revert push-down / revert offset ordering) goes red.
- **Tier:** **test**.
- **Depends on:** B-02, B-03.
- **Budget:** read ~800 / output ~600.

---

### EPIC-G-part-2 — RAG ops absorbed into views/actions (building blocks; C wires the surface)

#### G2-01: semantic dedup — dedupeScan semantic source + listNearDuplicates + runDedupSweep
- **Files:** `src/store/crud.ts` (dedupeScan extension), `src/store/dedup-ops.ts` (create: `listNearDuplicates`, `runDedupSweep`)
- **Implement:** `dedupeScan` gains a semantic candidate source (embed `${title}\n\n${body}`, KNN within repo scope, near-dup threshold band → `duplicateCandidates`); suppression contract unchanged `{ok, created, reason}` (RAG-SPEC §4; INTERFACE §3). `runDedupSweep` writes `SAME_AS` edges for confirmed pairs (soft, non-blocking, review-then-merge — never auto-merge); `listNearDuplicates` reads candidates.
- **Acceptance:** RAG-SPEC §8.3: two items with no shared words beyond one — the second surfaces via the vector channel; the FTS-only path does not catch the pair. **Negative control:** zero the vector weight → the semantic pair drops out (the semantic addition is load-bearing).
- **Tier:** **deepseek** — KNN + sweep + edge writes.
- **Depends on:** G1-05 (store.embedding, semanticSearch), A-03 (repo-scoped predicate).
- **Budget:** read ~1000 / output ~600.

#### G2-02: plan-graph ops — criticalPath, blockerImpact, planReadiness, recommendNextWork
- **Files:** `src/store/plan-graph.ts` (create)
- **Implement:** Pure traversal over `DEPENDS_ON` (no embedding dependency — RAG-SPEC §5; INTERFACE §5a.8): `criticalPath` (weighted longest path, `weightFn:"count"|"priority"`), `blockerImpact` (backward-reachable cone), `planReadiness` (total/done/ready/blocked + cycle + percent + nextRecommended), `recommendNextWork` (ready set, impact-ranked). Output shapes pinned per INTERFACE §5a.8 table.
- **Acceptance:** RAG-SPEC §8.2/8.5 + AC-30: A→B→C plus independent D — `criticalPath` end length strictly greater than D's; `blockerImpact('D')` = 3. **Negative controls:** break weight accumulation → all paths length 1; cap depth at 1 → count drops to 1.
- **Tier:** **deepseek** — graph algorithms + pinned output shapes.
- **Depends on:** A-03 (edge access via graph), F-02.
- **Budget:** read ~800 / output ~700.

#### G2-03: clusterIntoPlans / promoteClusterToPlan
- **Files:** `src/store/cluster-ops.ts` (create)
- **Implement:** DBSCAN over item embeddings groups semantically similar open items into candidate plan nodes (never auto-created plans — a human/planner promotes); `promoteClusterToPlan` materializes a plan node + `MEMBER_OF` edges (RAG-SPEC §5 `clusterIntoPlans`).
- **Acceptance:** RAG-SPEC §8.6: 4 semantically close OAuth items cluster together; 2 unrelated stay out (real DBSCAN output).
- **Tier:** **deepseek** — clustering algorithm.
- **Depends on:** G1-05, G2-01 (vector access).
- **Budget:** read ~600 / output ~500.

#### G2-04: backfillEmbeddings + re-embed-on-content-change sweep
- **Files:** `src/store/backfill.ts` (create), `src/store/migrate-model-v2.ts` (hook the sweep)
- **Implement:** `backfillEmbeddings` iterates every live item lacking a vector, batches embeds (bounded concurrency via task-queue substrate), `dryRun` reports count without calling the provider; the **re-embed-on-content-change sweep** regenerates embeddings for any item whose `content_hash` changed (canonical repo re-stamp) — the "only if null" predicate alone never repairs stale vectors (RAG-SPEC §7).
- **Acceptance:** RAG-SPEC §8.9 variant: after a migration that re-stamps content, the sweep re-embeds changed items; `dryRun` reports the count without provider calls. **Negative control:** without the sweep, a re-stamped item's vector stays stale (correctness defect proven).
- **Tier:** **deepseek** — batching + sweep + migration hook.
- **Depends on:** G1-05, A-07 (migration hook).
- **Budget:** read ~800 / output ~500.

#### G2-05: G-part-2 DoD tests
- **Files:** `src/store/dedup-ops.spec.ts`, `src/store/plan-graph.spec.ts`, `src/store/cluster-ops.spec.ts`, `src/store/backfill.spec.ts` (create)
- **Implement:** RAG-SPEC §8.1-8.6, 8.9, 8.10 (provenance) on real Turso + real fastembed; negative controls named above.
- **Acceptance:** all green; negative controls go red when stripped.
- **Tier:** **test**.
- **Depends on:** G2-01..G2-04.
- **Budget:** read ~1500 / output ~1000.

---

### EPIC-C — the 6-tool surface (LAST; C-01 is the re-issued TASK-003)

#### C-01: six-verb client consolidation (get/query/create/update/relate/admin)
- **Files:** `src/client.ts` (restructure exports to exactly 6 async functions), `src/server.ts` (`buildBacklogApigenPackage` unchanged mechanism — ops now derive from the 6), `src/cli.ts` (verb table), `src/index.ts` (re-exports)
- **Implement:** Consolidate all flat ops into the six verbs with the exact signatures of INTERFACE §1-§6 (`backlog_get`, `backlog_query`, `backlog_create`, `backlog_update`, `backlog_relate`, `backlog_admin`), composing the store ops built in A/B/G. **This is TASK-003 re-issued against the post-A model** (dimensional filters, canonical repo, BUG-1 contract). Host carve-out preserved: `install`/`install-skill`/`serve` stay host commands, NOT among the six (INTERFACE §6 carve-out; cli.ts:243-265 precedent).
- **Acceptance:** AC-0: one `buildBacklogApigenPackage` call produces the 6 verbs; CLI/MCP `tools/list`/Fastify routes all expose the same six; **negative control (AC-0): `install`/`serve` are NOT among the six** — a future accidental absorption fails the assertion.
- **Tier:** **deepseek** — the flagship consolidation; touches the collision-critical client.ts after A-09.
- **Depends on:** A-09, B-03, G2-05 (all building blocks), F-02.
- **Budget:** read ~2500 / output ~1800.

#### C-02: query view engine — 10 views + sort + groupBy + pagination + projection
- **Files:** `src/query-views.ts` (create; orchestrates store ops), `src/client.ts` (`backlog_query` body)
- **Implement:** `view: list|ready|order|graph|stale|summary|grouped|similar|plan|overlap` (INTERFACE §2.2), `sort: priority|updated|created|demand|relevance` (PRIORITY_RANK from query.ts:14; demand = FEAT-013 dupe counter; relevance = G1/G2 vector channel), `groupBy` classic + dimensional axes (INTERFACE §2; AC-31), `{total, returned}` (B-03), projection via the shared `fields` vocabulary (§7.3), `view:"similar"` two anchors (`filter.semantic`/`filter.anchor` — G1), `view:"plan"` resume surface with rollup + ready/blocked/needs-human/`myClaims` + `asOf` token (INTERFACE §2.2/§5a.6; AC-16), `view:"overlap"` with `overlapBy` (INTERFACE §5a.3; AC-28), plan-graph compositions per §5a.8 (G2-02).
- **Acceptance:** AC-16 (asOf provenance: first call's token as second call's `since` → delta shrinks), AC-25, AC-28, AC-31; **negative control AC-16:** a hand-persisted ISO timestamp (not the token) does not resume correctly.
- **Tier:** **deepseek** — the design center; view composition + token mechanics.
- **Depends on:** C-01, G2-02, G1-05 (similar view anchors).
- **Budget:** read ~2500 / output ~1600.

#### C-03: filter surface — schema validation, flag sugar, NL query planner
- **Files:** `src/filter.ts` (create: `BacklogFilter` schema `additionalProperties:false`, flag-sugar compiler, NL planner), `src/client.ts` (`backlog_query` filter parsing)
- **Implement:** Schema-validate `BacklogFilter` with `additionalProperties:false` — unknown key → `validation` error (exit 2); top-level params nested inside `--filter` (`view`/`sort`/`groupBy`) → targeted `invalid_argument` naming stray keys (INTERFACE §7.8; AC-23). Flag sugar compiles into `filter` (`--repo X --author Z --status open --kind BUG`, `--since yesterday` → `dateRange.updated.since` with NL dates resolved server-side — INTERFACE §2.1a; AC-22). NL query (`text`/positional): **semantic-first** — the entire string routes to the embedding matcher (G1), falls back to FTS without embeddings; dimensional extraction = ranking boosts + surfaced suggestions (`data.query: {semantic, filter, boosts, extracted}`, `applied:"boost"`), never implicit filters; time expressions → `dateRange`; unscoped by default (INTERFACE §2.1b; AC-27). Acceptance-criteria presence filters (`hasAcceptanceCriteria`/`missingAcceptanceCriteria`/`missingCitation` — body-section convention, never clause parsing — INTERFACE §5a.7; AC-29). `dupeHitsMin`, `semantic`, `anchor` filter fields (INTERFACE §2.1).
- **Acceptance:** AC-22, AC-23, AC-27 (all five sub-parts a-e: paraphrase ranking, cross-repo recall, explicit scoping drops foreign items, refined-result reproducibility, FTS fallback), AC-29; **negative control AC-27(d):** the refined `data.query` re-run as explicit `view:list`+filter+semantic must return the same items (parity).
- **Tier:** **deepseek** — planner + validation + NL parsing.
- **Depends on:** C-01, C-02, G1-05, A-04 (dimensional extraction vocabulary).
- **Budget:** read ~2000 / output ~1400.

#### C-04: create — filing-time interception + duplicateAction
- **Files:** `src/client.ts` (`backlog_create`), `src/store/crud.ts`/`structure.ts` (reuse A-05 contract)
- **Implement:** Before creating, run the dedupe scan (A-05/G2-01 sources); candidates → return `{duplicateCandidates, canonical}` and do NOT create unless `duplicateAction` says so; `abort` (default) / `file` (confirmed re-file, idempotent under CAS, counts once) / `comment` (append-note + dupe counter increment); interception active on batch/import with per-item `duplicateAction` (INTERFACE §3). `splitFrom`/`children`/`supersedes` are create-variants with the same interception (A-05 OP-layer guard).
- **Acceptance:** INTERFACE §3 + AC-17 (dupe counter demand: `sort:demand` ranks re-filed above once-filed — negative control: recency-heavy weight perturbation keeps once-filed below); a duplicate create with default `abort` returns candidates and creates nothing.
- **Tier:** **deepseek** — interception semantics + dupe counter.
- **Depends on:** C-01, A-05, G2-01.
- **Budget:** read ~1200 / output ~700.

#### C-05: update — outcome contract, by/identity chain, evidence gate, repo mutation
- **Files:** `src/client.ts` (`backlog_update`), `src/store/lifecycle.ts` (evidence-gate validation), `src/cli.ts` (identity chain resolution)
- **Implement:** Outcome contract `{ok, humanId, changed:[...fields], newStatus?, claimState?, noteId?, edge?}` on every mutation — never void success (INTERFACE §4; DEBT-API-RETURN-VALUES). `by` explicit and required on mutations; CLI resolves from env → `git config user.name` → `invalid_argument` (`currentActor()` precedent — INTERFACE §7.5; AC-26); MCP/REST reject absent `by`. Evidence gate: terminal transitions (`RESOLVED/DONE/FIXED/SHIPPED/VERIFIED`) require ≥1 citation, **default ON**, per-repo opt-out explicit (INTERFACE §5a.2 — continuation of v1 `requiresCitation`; typed error, not a silent drop). `patch.repo` now legal (repo is a graph node post-A — INTERFACE §4).
- **Acceptance:** AC-26 (CLI without `--by` succeeds when identity resolves; MCP without `by` → `invalid_argument`); GRAPH_MODEL §8.8: evidence-gated terminal transition throws without a citation.
- **Tier:** **deepseek** — mutation contract + identity + gate.
- **Depends on:** C-01, A-05 (repo mutation legality), G2-05.
- **Budget:** read ~1500 / output ~900.

#### C-06: relate — edge ops with outcome
- **Files:** `src/client.ts` (`backlog_relate`)
- **Implement:** `relation: dependency|related|plan`, `action: add|remove`; returns the written/removed edge `{from, to, rel, action}` (INTERFACE §5 — fixes backlog-001); with A's model, relation widens to repo/project edges (repo→project, repo→repo deps).
- **Acceptance:** INTERFACE §5 outcome shape asserted through the real seam (edge visible in `view:graph` after `add`; gone after `remove`).
- **Tier:** **flash** — thin consolidation over existing structure.ts ops.
- **Depends on:** C-01, A-03.
- **Budget:** read ~400 / output ~250.

#### C-07: admin — action union
- **Files:** `src/client.ts` (`backlog_admin`), `src/admin-actions/` (create: per-action adapters for archive/export/import/render/merge/migration_status/set_migration_phase/version/skill/batch/doctor/prune + RAG ops run_dedup_sweep/cluster_into_plans/promote_cluster_to_plan/embedding_backfill/embedding_health/list_near_duplicates), `src/serve.ts`/`src/cli.ts` (host carve-out untouched)
- **Implement:** One `backlog_admin({action, params})` covering maintenance + system ops (INTERFACE §6); `stats`/`stale-claims` are NOT admin actions (reads — `view:summary`/`view:stale`); `batch` is the apigen-plugin-batch mount with documented params (BUG-BACKLOG-BATCH-CLI-001); `doctor`/`prune` land as actions; RAG ops per RAG-SPEC §6 (snake_case union). Versioned/documented action union (~25 → split `backlog_system` governance).
- **Acceptance:** AC-0 continued: `batch` discoverable via `backlog_admin`; `embedding_health` surfaces truthful provider state (PLUGIN_ARCH §2.1 health).
- **Tier:** **deepseek** — broad action surface.
- **Depends on:** C-01, G2-01/G2-03/G2-04 (RAG actions).
- **Budget:** read ~2000 / output ~1200.

#### C-08: envelope + exit codes
- **Files:** `src/envelope.ts` (create), `src/server.ts`, `src/cli.ts` (CLI_EXIT_CODE mapping)
- **Implement:** Every tool returns `{ok, data?, error?: {code, message, details?}}`; error codes per INTERFACE §7.1 including `item_not_found` (distinct from `not_found`), `rag_not_configured`, `duplicate_candidate`, `dedupe_suppressed`, `store_busy` (with `retryable`/`retryAfterMs`); `warnings?: string[]` on successful reads (ambiguity — GRAPH_MODEL §3). Exit codes: 0 success, **1 `item_not_found`** (NOT generic not_found=4, NOT internal=1), 2 bad flag, 4 unknown command (INTERFACE §7.2; apigen-base-errors precedent). Empty list = `ok:true, data:[]`, exit 0.
- **Acceptance:** AC-6: drive the built binary across success/not-found/empty-list/bad-flag/unknown-command; assert code + exit per case. **Negative control:** `item_not_found` must never alias `internal` (1) or `not_found` (4).
- **Tier:** **flash** — mechanical envelope wrapper, spec-pinned mapping.
- **Depends on:** C-01.
- **Budget:** read ~800 / output ~500.

#### C-09: projection discipline
- **Files:** `src/projection.ts` (create: fields vocabulary incl. pseudo-fields `body`/`audit_trail`/`blockers`/`citations`/`rollup`/`_score`/`_vector`), `src/client.ts` (get/query projection)
- **Implement:** Default card `humanId, kind, title, status, priority` everywhere; everything else opt-in via the one `fields` grammar shared by `backlog_get` and `backlog_query` (INTERFACE §2.4, §7.3); unknown field → `validation` error (exit 2); embedding blobs never in default projection; `--format table` renders summary/grouped/plan for humans.
- **Acceptance:** AC-18 (default card), AC-19 (opt-in exact fields + unknown-field validation), AC-20 (blob opt-in only; summary/grouped never return bodies/blobs).
- **Tier:** **flash** — vocabulary + projection plumbing.
- **Depends on:** C-01, C-02.
- **Budget:** read ~600 / output ~400.

#### C-10: surface migration — SKILL.md first, specs, AGENTS.md, shell completion
- **Files:** `entrypoint/backlog/skill/…` (SKILL.md — the documented surface), `src/cli.spec.ts`, `src/server.mcp.spec.ts`, `src/install.e2e.spec.ts`, `AGENTS.md` (Disclosure section flat names), shell completion for enum flags (`--view/--sort/--group-by/--status`, filter keys — generated from the same operation descriptors AC-0 requires)
- **Implement:** **Migration order: SKILL.md ships the 6-tool surface FIRST** (INTERFACE §7.9) — it is the only documented surface and leaving it last strands agents mid-window on stale flat names. Update the three spec suites + AGENTS.md Disclosure flat names (`backlog_create_item`/`backlog_list_items`/`mcp__backlog__*`) to the six verbs; enumerate the breakage surface (§9 Q4: flat names + CLI stdout envelope shape change). Shell completion generated from operation descriptors.
- **Acceptance:** every stale flat-name reference in SKILL.md/specs/AGENTS.md is gone or aliased with a documented deprecation path; completion emits the six verbs + enum flags.
- **Tier:** **flash** (docs/specs/completion — well-specified mechanical updates).
- **Depends on:** C-01..C-09 (surface must exist before docs/specs describe it).
- **Budget:** read ~2500 / output ~1500.

#### C-11: serve HTTP + OpenAPI + both transports
- **Files:** `src/serve.ts`, `src/server.ts` (transport wiring — largely already present via apigen-plugin-api-fastify/openapi/batch; verify + test), `src/serve.http.spec.ts` (create)
- **Implement:** `backlog serve --transport http|both` serves the 6-tool surface as Fastify REST with the envelope; OpenAPI 3.1 at `_meta/openapi` via apigen-plugin-openapi derived from the operation descriptors (no hand-written spec); `--transport both` runs HTTP + MCP simultaneously; `mcp` default unchanged (INTERFACE §10.1; AC-1..AC-4).
- **Acceptance:** AC-1 (`curl GET /` lists the six; one representative route per verb over real HTTP), AC-2 (real OpenAPI validator passes; every served operation present), AC-3 (both surfaces work independently), AC-4 (MCP unchanged — spawnable via `.mcp.json`).
- **Tier:** **deepseek** — real HTTP/REST seam + OpenAPI validation.
- **Depends on:** C-01, C-08, C-09.
- **Budget:** read ~1200 / output ~700.

#### C-12: EPIC-C AC suite through real seams
- **Files:** `src/cli.spec.ts`, `src/server.mcp.spec.ts`, `src/install.e2e.spec.ts`, `src/serve.http.spec.ts` (extend/create), `docs/spec/backlog/INTERFACE_v2.md` §10 usage table as the checklist
- **Implement:** Every AC-0..AC-31 that names a CLI/HTTP/MCP invocation driven through its real seam (built binary, live Fastify, MCP host call) — the AC table is the checklist; each AC asserts the consumer-visible outcome, not implementation shape (AGENTS §7.6).
- **Acceptance:** all 32 ACs pass through real seams; AC-21 (`nx run backlog:verify-dist-load` green; the three named spec suites + `serve.http.spec.ts` drive real built artifacts).
- **Tier:** **test** (test agent; coordinates with C-10 doc migration).
- **Depends on:** C-01..C-11.
- **Budget:** read ~3000 / output ~2500.

#### C-13: target-state demo (DEMO.md + README)
- **Files:** `docs/demo/backlog/DEMO.md` (create), `docs/demo/backlog/README.md` (create)
- **Implement:** The demo-creator-format walkthrough of the *shipped* surface — persona-narrated (product manager / agent operator), exact commands from the AC grammar, exact expected JSON envelopes + exit codes, binary pass/fail assertions per step, happy/edge/recovery coverage, and the requirement→capability traceability matrix mapping each demo section to its ACs (AC-0..AC-31). Sections: onboarding (6 verbs, serve → `/meta/openapi`), dimensional queries (`--repo/--author`), NL query (`backlog query "nx bugs and apigen"` — semantic-first, cross-repo), user tracking (aggregate-by-reporter), rollup + plan analysis (summary/overlap/acceptance-criteria/plan-resume), filing interception (duplicateAction), projection discipline, error/edge honesty. Every command in the demo must use the exact AC grammar (e.g. `--overlap-by`, `--since`, `--group-by`) — the demo is also a QA walkthrough, so a step that fails is a real bug.
- **Acceptance:** every demo step's command parses against the shipped CLI; every assertion maps to a real AC; the demo runs end-to-end against the built artifact (or explicitly marks target-state steps with the gating AC where a capability is env-gated, e.g. embeddings behind the service). **Negative control:** a demo step using a pre-v2 flat name (`list-items`) must fail — proving the demo documents the shipped surface, not the old one.
- **Tier:** **product agent** (demo-creator skill; coordinates with C-12's AC suite — the ACs are the demo's assertions).
- **Depends on:** C-12 (the shipped surface the demo drives).
- **Budget:** read ~2000 / output ~3000.

---

### EPIC-D — parity gate (continuous after every epic)

#### D-01: continuous parity-gate target (build once)
- **Files:** `tools/nx-plugins/build/lib/parity-gate.js` (or extend `docs/plan/backlog-adoption/parity-check.mjs` into an nx target `nx run backlog:parity-gate`), `docs/plan/backlog-adoption/projection-manifest.json` (expected-diff allowance for the migration re-stamp)
- **Implement:** A parity gate that (a) renders every `{sourcePath, filter}` projection through the **real built CLI** (subprocess convention from parity-check.mjs — never an in-process import) and diffs against the hand-edited markdown, normalized through the canonical status vocabulary; (b) accepts a documented `expectedDiff` allowance (canonical repo-string re-stamp from A-07/A-08) and fails on anything else. Wired as an nx target so it runs after every epic.
- **Acceptance:** gate green pre-migration; green post-migration with the allowance documented; a deliberately-wrong projection renders red (negative control).
- **Tier:** **flash** — single tooling file, existing script as the base.
- **Depends on:** F-02 (async CLI load); usable from Wave 0.
- **Budget:** read ~600 / output ~400.

#### D-02: parity gate RUNS (after every epic, then final full run)
- **Implement:** Not a code change — the orchestrator runs `nx run backlog:parity-gate` after each epic's gate wave and records the result; the final run after C-12 must be green with only the documented allowance.
- **Acceptance:** the parity check output is green (or green-minus-allowance) at every checkpoint; any unexpected divergence fails the wave.
- **Tier:** **orchestrator** (gate execution, not an implementer).
- **Depends on:** D-01 + each epic.
- **Budget:** n/a (gate run).

---

## 2. Wave ordering with verification gates

**Every wave has BOTH a test gate and a mandatory review gate.** The test gate proves behavior (real seam, negative controls); the review gate (`dispatch-project-reviewer-flash`) audits each work order's diff against its spec section + AC before acceptance — per ownership rule 7. A work order is NOT done until its review passes. The table's "Review focus" column names the per-wave emphasis; it does not limit review to those files.

| Wave | Work orders | Test gate (verify BEFORE advancing) | Review gate (MANDATORY) | Review focus |
|---|---|---|---|---|
| **W0 — Substrate (EPIC-F + D-01)** | F-01, F-02, F-03(upstream), F-04, D-01 | `nx build backlog` + `nx test backlog` green on adapter+async; `nx run backlog:verify-dist-load`; **D-01 parity gate green** (pre-migration baseline) | Every F-01/F-02 diff reviewed before the wave advances | adapter surface (no raw `store.db` leaks), async signature churn (no missed `await`), F-03 upstream contract (SQL predicate + FTS offset — security), D-01 parity target correctness |
| **W1 — Parallel tracks (G-part-1 ∥ A)** | G1-01..G1-07, A-01..A-10 | G1: PLUGIN_ARCH §9 tests green on real fastembed; A: GRAPH_MODEL §8 tests green; `nx test backlog`; D-01 parity gate green (A-08's manifest reconcile may introduce the documented allowance) | Every G1/A diff reviewed before acceptance | G1: UDS/RPC protocol (no path traversal on socket paths, singleton lock hygiene), plugin registry (dynamic `import()` safety); A: the migration (A-07/A-08 data rewrite + backup/reopen — HIGH blast radius), dimensional.ts SQL (predicate injection via `buildNodeFilterClause` reuse), BUG-1/BUG-2 fixes (negative controls proven red) |
| **W2 — Query correctness (EPIC-B)** | B-01..B-04 | `nx test backlog` green incl. query.spec.ts negative controls; D-01 green | Every B diff reviewed | pagination composition (limit×post-filter push-down correctness), offset-after-rank ordering, `{total, returned}` semantics (incl. the raw-SQL fallback path), dateRange.updated predicate |
| **W3 — RAG ops (EPIC-G-part-2)** | G2-01..G2-05 | RAG-SPEC §8 tests green; negative controls proven red-when-stripped; D-01 green | Every G2 diff reviewed | `SAME_AS` edge writes (soft, non-blocking invariant — never auto-merge), suggestDependencies confirm-gate (no write path), plan-graph traversal correctness (criticalPath/blockerImpact transitivity), backfill concurrency bounds |
| **W4 — 6-tool surface (EPIC-C)** | C-01..C-13 (C-10 last-but-one; C-12 closes the implementation wave; C-13 the demo, ordered after C-12) | AC-0..AC-31 through real seams (cli.spec.ts, server.mcp.spec.ts, install.e2e.spec.ts, serve.http.spec.ts); `nx run backlog:verify-dist-load`; SKILL.md ships 6-tool surface FIRST (C-10 ordering); C-13 demo steps all pass against the built artifact | Every C diff reviewed (the largest surface — review in batches per sub-group, C-01..C-05, C-06..C-09, C-10..C-12, each gated; C-13 reviewed for AC-grammar accuracy) | envelope/exit-code semantics (C-08 — `item_not_found` never aliases `internal`/`not_found`), filter validation (C-03 — no silent unknown-key pass), NL planner transparency (`data.query` never omits a filter), admin authz question (§9 Q6 — surfaced, not silently decided), CLI stdout breakage enumeration (C-10) |
| **W5 — Final parity + release** | D-02 | `nx run backlog:parity-gate` green (only documented allowance); `nx affected -t test` across dependents; `nx run backlog:verify-dist-load`; `gitnexus_detect_changes` clean | Full-corpus review pass (orchestrator + review): every AC-0..AC-31 traceable to a green real-seam test; all review findings closed; CHANGELOG + AGENTS.md doc updates reviewed | release-readiness: parity, docs, changelog, dependency cleanliness, no residual review findings |

**Resumability (per resumable-plan workflow):** each wave's completion state is checkable — before re-dispatching any work order, the orchestrator verifies the wave's gate from state, not from subagent reports. Rollup semantics: a wave is **done** when all its work orders report `childrenClosed` (their sub-tasks, if any) AND every order's review is clean (§4.5) AND the wave's gate is verified. If a wave gate is false (all work orders closed + review-clean but the gate failed), **verify, don't re-dispatch** — the gate failure is the signal; find the failing AC and re-issue only that order.

---

## 3. AC → work-order traceability matrix

| AC | Satisfied by | Spans epics? | Gate verified at |
|---|---|---|---|
| AC-0 (one package → 4 mounts, 6 verbs, install/serve NOT six) | C-01, C-08, C-11, C-12 | C | W4 |
| AC-1 (serve http) | C-11 | C | W4 |
| AC-2 (openapi doc) | C-11 | C | W4 |
| AC-3 (both transports) | C-11 | C | W4 |
| AC-4 (mcp unchanged) | C-11 | C | W4 |
| AC-5 (verb collapse; view:order/stale == topo/stale-claims) | C-02, C-12 | C | W4 |
| AC-6 (envelope + exit codes) | C-08, C-12 | C | W4 |
| AC-7 (single-repo filter + fork-key) | A-02, A-04, C-03 | **A + C** | W1 (store), W4 (surface) |
| AC-8 (cross-repo) | A-03, A-04, C-06 | **A + C** | W1 (store), W4 (surface) |
| AC-9 (semantic filter scoped) | G1-05, G1-07, C-02, C-12 | **G1 + C** | W1 (recall), W4 (surface) |
| AC-10 (similar view, two anchors) | G1-05, C-02, C-12 | **G1 + C** | W4 |
| AC-11 (grep stays distinct) | G1-05, C-03, C-12 | **G1 + C** | W4 |
| AC-12 (degrade rag_not_configured) | G1-05, C-08, C-12 | **G1 + C** | W1 (store), W4 (surface) |
| AC-13 (filter by author/reporter) | A-01, A-04, C-03 | **A + C** | W1 (store), W4 (surface) |
| AC-14 (aggregate-by-reporter stable) | A-01, A-02, A-03, C-02 | **A + C** | W1 (aggregate), W4 (grouped view) |
| AC-15 (windowed summary + coverage) | B-01, C-02, C-12 | **B + C** | W2 (dateRange), W4 (view) |
| AC-16 (plan resume + asOf) | C-02, C-12 | C (rollup/ready/blocked built on A edges) | W4 |
| AC-17 (dupe-counter demand) | C-03, C-04 | C (counter), G2-01 (semantic source) | W4 |
| AC-18 (default card) | C-09 | C | W4 |
| AC-19 (opt-in fields + unknown-field validation) | C-09, C-08 | C | W4 |
| AC-20 (blob opt-in) | C-09 | C | W4 |
| AC-21 (real-seam AC suite + verify-dist-load) | C-12, D-01, D-02 | **C + D** | W4/W5 |
| AC-22 (flag sugar) | C-03, C-12 | C | W4 |
| AC-23 (filter validation) | C-03, C-08 | C | W4 |
| AC-24 (ambiguity never silent) | A-02, C-08 | **A + C** | W1 (warnings at store), W4 (envelope) |
| AC-25 ({total, returned}) | B-03, C-02 | **B + C** | W2 (store), W4 (surface) |
| AC-26 (CLI identity chain) | C-05, C-12 | C | W4 |
| AC-27 (NL query semantic-first, cross-repo) | G1-05, C-03, C-12 | **G1 + C** | W1 (semantic channel), W4 (planner) |
| AC-28 (overlap by project vs file) | A-03, C-02 | **A + C** | W1 (project edges), W4 (view) |
| AC-29 (acceptance-criteria presence) | C-03 | C | W4 |
| AC-30 (plan-graph ops pinned contract) | G2-02, C-02 | **G2 + C** | W3 (traversal), W4 (view composition) |
| AC-31 (ready view + groupBy axes) | A-03, C-02 | **A + C** | W1 (aggregateBy), W4 (ready view) |

**Coverage: all 32 ACs (AC-0..AC-31) traced.** 14 ACs span multiple epics — their store-level half is gate-verified at the earlier epic's wave, the surface half at W4.

---

## 4. Epic-level DoD with real-seam tests

Per AGENTS.md §7: real components, teeth, negative controls, default-running (no env gates — real Turso + real fastembed are in-repo/sox-owned, not paid external services).

| Epic | DoD test files | Drives (real seam) | Negative control |
|---|---|---|---|
| **F** | `graph-backlog-store.spec.ts`, `concurrency-scale.spec.ts` (rewritten), `verify-dist-load` | real Turso adapter; CAS via `adapter.transaction({mode:'immediate'})`; async store | a sync `store.db.` call is a type error (adapter surface) |
| **G1** | `plugins/registry.spec.ts`, `plugins/embedding-remote/provider.spec.ts`, `store/embed-pipeline.spec.ts` | real UDS backend (`serveBackend` + real fastembed); real store open with `opts.embedding`; reopen for durability | 384-dim → `PermanentEmbeddingError`; bypass drain → reopened vector null; zero vector weight → match drops out |
| **A** | `store/dimensional.spec.ts`, `store/migrate-model-v2.spec.ts`, `ids.spec.ts`, `client.spec.ts` (extend) | real Turso adapter; real legacy-shape store → migrate → reopen | strip BUG-1 guard → created-flag loss red; live-only scan → BUG-2 re-mint red; skip rel-CHECK reopen → IN_REPO rejected at DDL |
| **B** | `store/query.spec.ts` (extend) | real store; limit×post-filter composition; offset-after-rank; total/returned | revert push-down → truncation defect red; revert offset ordering → `offset:145 → item #80` red |
| **G2** | `store/dedup-ops.spec.ts`, `store/plan-graph.spec.ts`, `store/cluster-ops.spec.ts`, `store/backfill.spec.ts` | real embeddings; real DEPENDS_ON chains; real DBSCAN | zero vector weight → semantic pair drops; depth-1 cap → impact count 1; suggestDependencies never writes an edge (edge table unchanged) |
| **C** | `cli.spec.ts`, `server.mcp.spec.ts`, `install.e2e.spec.ts`, `serve.http.spec.ts` (new) | built binary; live Fastify; MCP host call; real OpenAPI validator | AC-0: install/serve NOT in six; AC-6: item_not_found never aliases internal/not_found; AC-16: hand-persisted ISO timestamp (not asOf token) fails resume |
| **D** | `nx run backlog:parity-gate` | built CLI subprocess rendering every manifest projection, diffed against hand-edited markdown | deliberately-wrong projection renders red |

**EPIC-D parity gate — how it runs:** built once (D-01, an nx target), then **run after every epic** at each wave gate (W0..W5). Continuous CI-style is not required — a manual/nx-run gate per wave is sufficient and cheaper; the final W5 run is the release gate. It never runs inside an implementer's unit tests.

### 4.5 Code-review gate — the mandatory per-work-order contract

A work order is **DONE only when its review passes** — "tests green" alone is not acceptance. The reviewer is `dispatch-project-reviewer-flash` (read-only audit against the spec); the orchestrator routes the diff + work order to it after the implementer reports and before the work order's AC is marked satisfied.

**Review flow (per work order):**
1. Implementer completes the order + its named acceptance test, reports the diff and test output.
2. Orchestrator dispatches `dispatch-project-reviewer-flash` with: the work order text (spec section + AC), the diff, the test output. Reviewer checks the seven rule-7 axes: spec conformance, platform isolation, test teeth (negative control proven red-when-stripped), lint, dependency purity, gitnexus blast radius, working-tree hygiene.
3. Reviewer returns PASS or findings. **Findings are NOT optional:** each finding goes back to the implementer as a follow-up on the same work order (not a new order); the order re-reviews until clean. A finding that disputes the spec (not the implementation) is escalated to the orchestrator as a planning blocker — the corpus is READY and is not re-designed by review.
4. Only a clean review + green test gate marks the work order done; the wave advances only when all its orders are review-clean (wave gate table §2).

**Epic-boundary review (additional, at each wave end):** beyond per-order review, the wave's last order triggers a cross-order review pass — the epic's ACs as a set, checked that no order's implementation undermined another's (e.g. A-04's dimensional routing not broken by B-02's pagination rework, per the §0 ownership rules). This is the review half of the wave gate, named in §2's "Review focus" column.

---

## 5. Risk register

| # | Risk | Mitigation |
|---|---|---|
| **R1** | **`dateRange.updated` upstream dependency (NodeFilter.tUpdatedAfter/tUpdatedBefore)** — is EPIC-F the only home? **Yes.** F-03 owns the upstream predicate (INTERFACE §2.1 explicitly co-locates it with the R3 change "added in EPIC-F"), and B-01 consumes it. If F-03 slips, B-01/B-02 and C's `--since` fall back to the spec-sanctioned raw-SQL range predicate over `t_updated` (index.ts:87,1127) — the spec names the mechanism, not an implicit gap. **Fallback is non-blocking.** | F-03 dispatched to sox-ecosystem first in W0; B/C carry the raw-SQL fallback in their acceptance |
| **R2** | **Legacy rel-CHECK migration (data risk).** A-07 reopens the edge schema for pre-0.6.0 stores; a v1 store's rel CHECK rejects the five new rels at DDL. Failure modes: data loss in the edge rebuild, drift after parity. | A-07 is gated by `adapter.backupTo` before any write; dry-run parity on a temp copy; per-item verify + old-vs-new parallel diff; re-open verifies; D-01 parity gate with the documented re-stamp allowance; A-08 keeps item rowids and RAG join keys untouched |
| **R3** | **TASK-003 re-issue dependency.** C-01 is the re-issued TASK-003 against the post-A model. If an implementer drafts C-01 against the pre-A flat surface (or lands it early), the consolidation is wrong and the collision matrix breaks. | Sequencing is enforced by waves (C is W4, after A/B/G2); C-01's work order text pins "post-A model" + cites GRAPH_MODEL §6; the AC-0..AC-31 suite at C-12 will fail on pre-A shapes |
| **R4** | **Subagent-depth/restart infra caveat.** Implementer dispatches may still be depth-limited until opencode restart; a depth-limited flash implementer cannot dispatch subagents. | Every work order is **self-contained** (files + spec section + AC + acceptance cited inline; no sub-dispatch required). Flash-tier orders are single-file/well-specified; deepseek-tier orders list exact files and the exact functions to touch. Orchestrator dispatches each order as one bounded task |
| **R5** | **sox-ecosystem upstream PRs (vector backend ownership, NodeFilter extension).** F-03 (NodeFilter + searchNodes offset) and G1-06 (embedding bundle + Turso vector backend) are owned by the sox-ecosystem team, not this repo. Who owns: sox-ecosystem repo owner (upstream maintainers); backlog's liaison pins the contract and sequence (DEBT-SOX-001 / EPIC-F per INTERFACE §2.1/§7.4). Fallback: F-03 → raw-SQL range + full-fetch-then-slice; G1-06 → `view:"similar"` ships FTS-overlap (INTERFACE §9 Q2), `health:error` degrade keeps backlog green. **No work order hard-blocks on an unmerged upstream PR.** | upstream PRs are W0/W1 parallel work orders with explicit fallbacks; backlog-side acceptance tests carry both paths |
| **R6** | **File-collision matrix drift** (query.ts/model.ts/graph-backlog-store.ts/client.ts/cli.ts/server.ts are multi-epic). | Ownership rules §0 are enforced by wave separation; the only same-wave same-file pairs are F-01/F-02 (intentional, sequential) and A/G1 both touching query.ts additively (G1-05 ordered after A-04) |
| **R7** | **Evidence gate regression.** The gate must stay ON by default (v1 `requiresCitation` at model.ts:75/lifecycle.ts:65 is unconditional today — loosening it silently is a design violation). | C-05's acceptance asserts terminal transition without citation still throws (GRAPH_MODEL §8.8 invariant, re-tested after C); per-repo opt-out must be explicit + documented |
| **R8** | **Parity-gate flakiness at migration.** A-07/A-08 legitimately change item content (canonical repo string in marker) → projection diffs. | D-01 encodes the expected-diff allowance (projection-manifest reconcile from A-08); any divergence beyond the allowance fails the wave |
| **R9** | **Mandatory review gate adds dispatch volume and serializes waves.** Every work order now requires a `dispatch-project-reviewer-flash` pass before acceptance (§4.5) — on W4's 13 orders this is 13+ review dispatches, and findings loop back to the same order (re-review). Worst case: review becomes the critical path. | Review dispatches run in parallel with the next order's implementation when the orders are independent (only same-file pairs serialize: F-01→F-02, A-04→B-02, C dependencies); the reviewer is cheap-tier (flash) and read-only; findings loop is bounded (a finding that repeats 3× escalates to the orchestrator as an implementer-quality issue, not an infinite loop). Orchestrator budgets review time per wave in the dispatch schedule |
| **R10** | **C-13 demo depends on the full shipped surface (C-12) and on the demo-creator dispatch path.** The demo is the LAST C order; if the surface slips, the demo slips with it. (Note: an earlier demo-creator dispatch attempt in this session returned empty — the dispatch path itself is a known operational risk to re-check when C-13 dispatches.) | C-13 is ordered strictly after C-12; the demo's assertions ARE the ACs (reuse, don't re-derive); if the product-agent dispatch path is still failing at C-13's wave, fall back to authoring the demo in-session from the C-12 AC suite |

---

## 6. What NOT to include

- **No design changes.** The corpus is READY; if an implementer finds a contradiction while building, they flag it as a **planning blocker** (cite spec file + section) to the orchestrator — they do not redesign. Known open questions that are deliberately *surfaced, not decided*: INTERFACE §9 Q6 (admin authorization gate), §9 Q1 (cursor vs offset — deferred to F-03's outcome), §9 Q4 (backward-compat window length — an operator call).
- **No scope creep beyond the corpus.** memory-server's embedding adoption (§7 of PLUGIN_ARCH) is a separate sox-ecosystem item; BUG-APIGEN-058 (IR cache) is out of scope; the embedding substrate itself is EPIC-G, not this plan's redesign.
- **These work orders are NOT literal backlog-tool ticket bodies.** This is a dispatch-plan document; the operator materializes it (tickets, dag.json, or direct dispatch) as they choose. When materializing as backlog items, file per work order with the citations listed here.
