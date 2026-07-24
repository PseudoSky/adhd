### AMA-001 — agent-mcp-authoring: `type:'hash'` embedding provider does not exist in `@adhd/sox-embedding-provider`

**Status:** OPEN
**Plan:** agent-mcp-authoring

- **Where:** `docs/plan/agent-mcp-authoring/contexts/embedding-substrate.md`, `decisions.md` §D5, `contexts/_shared.md`
- **Description:** The plan's default embedder config `{type:'hash', model:'hash-768'}` is unimplementable. `sox-ecosystem/libs/data/embed/embedding-provider/src/index.ts:128-146` handles only `'fastembed'` and `'remote'`; anything else throws `ResolutionError`. The package's `sox.concerns` advertises a "deterministic hash provider" that exists nowhere in its source. The plan's CI-determinism strategy (`[embedding-substrate.1]`, `inv:enrichment-deterministic`) has no implementation.
- **Fix direction:** Choose one — (a) implement `type:'hash'` upstream in sox-ecosystem; (b) consume `DeterministicTestProvider`/`featureHashEmbed` from `@adhd/sox-memory-core` (marked TEST-ONLY, modelId `test-feature-hash-768`); (c) default to `type:'fastembed'` and inject a deterministic provider only in CI.
- **Status:** OPEN — blocks `embedding-substrate`, `enrichment-pipeline`, `discovery-tools`. Full teardown in `docs/plan/agent-mcp-authoring/BACKLOG.md`.

### AMA-002 — agent-mcp-authoring: `extractiveSummary` is not exported by `@adhd/sox-ingest`

**Status:** OPEN
**Plan:** agent-mcp-authoring

- **Where:** `docs/plan/agent-mcp-authoring/contexts/enrichment-pipeline.md`
- **Description:** Two declared modules `import { extractiveSummary } from '@adhd/sox-ingest'`. That function is module-private (`src/index.ts:78`, no `export`). Both modules fail to compile; `[enrichment-pipeline.2]` tests an unimportable symbol.
- **Fix direction:** Call `ingest(content, {summaryMaxSentences:N})` and read `.summary` (also yields the `contentHash` the idempotence check needs), or import `extractiveSummary` from `@adhd/sox-memory-core`.
- **Status:** OPEN

### AMA-004 — agent-mcp-authoring: no npm path exists for any required sox package (`workspace:*` unresolvable)

**Status:** OPEN
**Plan:** agent-mcp-authoring

- **Where:** `docs/plan/agent-mcp-authoring/decisions.md` §D5 Options A/B/C; `human-blockers.json:sox-package-publish`
- **Description:** Only `@adhd/sox-memory-core@0.2.1` is published (and its dist has zero `extractiveSummary`; it depends on `@adhd/sox-memory-enrich@1.1.0`, absent from the workspace). All nine other sox packages 404. HEAD `memory-core@0.3.0` declares six `workspace:*` deps incl. `private:true` `sox-ingest`. Verified empirically: npm cannot resolve `workspace:*` — `EUNSUPPORTEDPROTOCOL: Unsupported URL Type "workspace:"`; via `file:`, `npm install` exits 0 but the module is never materialised (`MODULE_NOT_FOUND`, `npm ls --all` → `ELSPROBLEMS`). `npm link` fails identically. **All three D5 options are broken as written.**
- **Fix direction:** Strip `workspace:*` from published manifests (changesets rewrites on publish), or vendor the four modules, or bundle deps into each `dist/`.
- **Status:** OPEN — hard blocker at `embedding-substrate` state-start.

### AMA-010 — agent-mcp-authoring: sox deps break `platform:shared` purity for `@adhd/agent-registry`

**Status:** OPEN
**Plan:** agent-mcp-authoring

- **Where:** `docs/plan/agent-mcp-authoring/contexts/embedding-substrate.md` (Notes)
- **Description:** The plan argues the registry stays `platform:shared` because `better-sqlite3`/`sqlite-vec` are already deps. It does not account for `@huggingface/transformers` + `fastembed` (via `sox-embedding-provider`) or `@lancedb/lancedb` + `apache-arrow` + `synckit` (via `sox-vector-store`) — all node-native. Per `CLAUDE.md` §2, `platform:shared` must be safe in a browser window. With `type:'hash'` gone (AMA-001) the ONNX path is no longer optional.
- **Fix direction:** Re-tag the registry `platform:node`, or isolate the embedding substrate behind a `platform:node` sub-package.
- **Update 2026-07-24:** `packages/agent/agent-store-prompts/project.json` → `tags: ["layer:ai","platform:node"]` — the registry (renamed `agent-registry` → `agent-store-prompts`, see AMA-014) is ALREADY `platform:node`; no re-tag is required. The defect was purely the plan's prose, which asserted the package "remains `platform:shared`" and reasoned about dependency purity from that false premise. The native deps listed above are consistent with the existing `platform:node` tag.
- **Status:** downgraded from "architecture decision required" to "prose fix" — the plan text at `contexts/embedding-substrate.md` needs correcting, no code/tag change needed.

### AMA-011 — agent-mcp-authoring: 4 acceptance criteria have no audit check (gap-check FAIL)

**Status:** OPEN
**Plan:** agent-mcp-authoring

- **Where:** `docs/plan/agent-mcp-authoring/scripts/criteria.json` / `audit_authoring.py`
- **Description:** `[embedding-substrate.2]`, `[embedding-substrate.3]`, `[enrichment-pipeline.2]`, `[enrichment-pipeline.3]` have no matching check ID in any audit script — exactly the four sox-consuming criteria are unenforced. `gap-check.js` exits FAIL with 5 gaps (the 5th is a stale vendored `run-audit.js`, stamp 0.8.23 vs installed 0.8.25).
- **Status:** OPEN

### SOX-DOC-001 — sox-ecosystem: `embedding-provider/package.json` documents a nonexistent hash provider

**Status:** OPEN
**Plan:** agent-mcp-authoring

- **Where:** `/Users/nix/dev/ai/sox-ecosystem/libs/data/embed/embedding-provider/package.json` → `sox.concerns`
- **Description:** Claims "deterministic hash provider as first-class alternative". No such branch, class, or file exists. Direct cause of AMA-001 — a downstream plan was authored against this doc.
- **Status:** OPEN (upstream repo)

### SOX-DOC-002 — sox-ecosystem: `ingest/package.json` mis-describes its summariser as "sentence-scoring"

**Status:** OPEN
**Plan:** agent-mcp-authoring

- **Where:** `/Users/nix/dev/ai/sox-ecosystem/libs/data/ingest/ingest/package.json` → `sox.concerns`
- **Description:** Implementation (`src/index.ts:78`) is `sentences.slice(0, maxSentences)` — plain lead-N, no scoring. `extractTags` is frequency-scored; the two appear conflated in the doc.
- **Status:** OPEN (upstream repo)

### SOX-PKG-001 — sox-ecosystem: `memory-core@0.3.0` is unpublishable as written

**Status:** OPEN
**Plan:** agent-mcp-authoring

- **Where:** `/Users/nix/dev/ai/sox-ecosystem/libs/memory-core/package.json`
- **Description:** Declares six `workspace:*` deps, one (`@adhd/sox-ingest`) `private: true` by design. Publishing yields a manifest with an unresolvable dependency. Published `0.2.1` still references `@adhd/sox-memory-enrich@1.1.0`, an architecture no longer in the workspace.
- **Status:** OPEN (upstream repo)

### AMA-016 — agent-mcp-authoring: `versioning` state has a no-op guard and an already-green criterion

**Status:** OPEN
**Plan:** agent-mcp-authoring

- **Where:** `docs/plan/agent-mcp-authoring/dag.json` → `nodes.versioning.guard` (`npx --yes nx build agent-mcp`); `scripts/criteria.json` → `versioning.1`
- **Description:** `entrypoint/agent-mcp/package.json` is already `2.0.0` on `main`, so criterion `versioning.1` (`present "version": "2\.`) matches before the state runs, and `nx build agent-mcp` is already green. The guard can never go red→green; `versioning` can be marked complete having done nothing. Same failure mode as `ENV-PLAN-001`. Violates "never mark a task complete on proxy evidence."
- **Fix direction:** retire the state, or re-point it at the real remaining deliverable (CHANGELOG + `nx release` dry-run asserting 2.0.0 breaking-change notes) and confirm RED at plan start.
- **Status:** OPEN

### AMA-017 — agent-mcp-authoring: `criteria.json` declares 3 criteria per state with one identical command

**Status:** OPEN
**Plan:** agent-mcp-authoring

- **Where:** `docs/plan/agent-mcp-authoring/scripts/criteria.json`
- **Description:** `embedding-substrate.1/.2/.3` share a byte-identical `cmd`+`expect:exit0`; same for `enrichment-pipeline.1/.2/.3` (and pre-existing `component-define.1/.2`). `gap-check` passes because it only checks that a criterion ID exists, not that it discriminates. The real teeth DO exist as `*.tooth` checks in `audit_authoring.py` (verified failing red today) and are enforced by the `audit-final` guard — but they are absent from `criteria.json`, which `run-audit.js` reads. Residual risk: the `.tooth` checks are grep-based (assert the test file *mentions* `reopen|idempotent|trim`), so a vacuous test passes both. Executor must prove negative controls by reverting.
- **Status:** OPEN

### SOX-BUG-001 — sox-ecosystem: `embedding-provider` nested warmup timeouts disagree (180 s outer vs 60 s inner)

**Status:** OPEN
**Plan:** agent-mcp-authoring

- `index.ts:204-207` defaults 180 000 ms; `fastembed.ts:102-105` defaults 60 000 ms; both read `SOX_EMBED_WARMUP_TIMEOUT_MS`. Worker init is bounded by the inner 60 s, so the outer limit is never effective for a cold model download.
- **Status:** OPEN (upstream repo)

### SOX-BUG-002 — sox-ecosystem: `ModelCache`/`FileSystemModelCache` is dead API surface

**Status:** OPEN
**Plan:** agent-mcp-authoring

- Exported from `@adhd/sox-embedding-provider` but referenced by no factory or provider. Callers who follow the type surface write code that has no effect. (This is exactly what happened to `agent-mcp-authoring`.)
- **Status:** OPEN (upstream repo)

### SOX-BUG-003 — sox-ecosystem: `warmUp()` is a no-op on every provider

**Status:** OPEN
**Plan:** agent-mcp-authoring

- Invariant: "warmUp() is a no-op when isDeterministic === false". Both `FastembedProvider` and `RemoteProvider` hard-code `isDeterministic: false`, and the deterministic `type:'hash'` provider was removed — so `warmUp()` is dead on all paths, while `sox.concerns` still advertises "warmUp cache for hot/topic texts".
- **Status:** OPEN (upstream repo)

### SOX-DOC-003 — sox-ecosystem: `embedding-provider` advertises asymmetric `role` encoding it does not implement

**Status:** OPEN
**Plan:** agent-mcp-authoring

- `sox.concerns`: "asymmetric encoding via role param (document | query)". `FastembedProvider.embedSingle(text, _role?)` ignores it.
- **Status:** OPEN (upstream repo)

### SOX-DOC-004 — sox-ecosystem: `FastEmbedPoolConfig.batchSizes` doc says "overrides the default 32"; actual `DEFAULT_BATCH_SIZE = 256`

**Status:** OPEN
**Plan:** agent-mcp-authoring

- **Status:** OPEN (upstream repo)

### AMA-003 — `createEmbeddingProvider` is async; plan declares a sync wrapper

**Status:** OPEN
**Plan:** agent-mcp-authoring

- **Where:** `contexts/embedding-substrate.md` — `export function createRegistryEmbedder(config?): EmbeddingProvider`.
- **Evidence:** `embedding-provider/src/index.ts:128` — `export async function createEmbeddingProvider(config): Promise<EmbeddingProvider>`.
- **Impact:** the declared wrapper signature is unimplementable; must be `Promise<EmbeddingProvider>`. Cascades into `seedAnchors` and every call site.
- **Status:** OPEN.

### AMA-005 — `_shared.md` asserts all four data packages are `"private": false` (false)

**Status:** OPEN
**Plan:** agent-mcp-authoring

- `@adhd/sox-ingest` is `private: true`, with the explicit invariant *"PRIVATE — never published to npm; **only the memory domain composer may call this package**."*
- `decisions.md` §D5 and `contexts/enrichment-pipeline.md` both state this **correctly**. `_shared.md` is the lone outlier — and it is the file compiled into **every** executor work-order.
- **Deeper architectural conflict:** the plan has `@adhd/agent-registry` (not the memory domain composer) importing `sox-ingest` directly, which violates that package's stated invariant. Needs a sox-ecosystem **owner decision**, not a plan edit.
- **Status:** OPEN.

### AMA-006 — `embedding-substrate.md` contradicts itself on publish status

**Status:** OPEN
**Plan:** agent-mcp-authoring

- Line ~152 (Notes): *"`@adhd/sox-embedding-provider` and `@adhd/sox-vector-store` are NOT on npm."* Line ~174: *"the vector store is already published and tested in the sox-ecosystem."* Both in the same file. The second is false.
- **Status:** OPEN.

### AMA-007 — wrong relative path in D5 Option C and `_shared.md`

**Status:** OPEN
**Plan:** agent-mcp-authoring

- Plan writes `file:../sox-ecosystem/libs/data/embed/embedding-provider`. From `/Users/nix/dev/node/adhd`, `../sox-ecosystem` resolves to `/Users/nix/dev/node/sox-ecosystem`, **which does not exist**. sox-ecosystem is at `/Users/nix/dev/ai/sox-ecosystem`; the correct prefix is `../../ai/sox-ecosystem/`. The sub-paths after the repo root are correct.
- **Status:** OPEN.

### AMA-008 — `human-blockers.json:sox-package-publish` verification is unsatisfiable and mis-scoped

**Status:** OPEN
**Plan:** agent-mcp-authoring

- Verification runs `require('@adhd/sox-embedding-provider')` etc. These packages are ESM (`"type":"module"`, `exports.import`); `require()` is the wrong probe. It also requires `@adhd/sox-ingest` to resolve — which, under D5 Option A, can never happen. It omits `@adhd/sox-analysis` from the probe despite listing it as required.
- **Status:** OPEN.

---

### AMA-009 — plan is unaware of packages that now carry its requirements

**Status:** OPEN
**Plan:** agent-mcp-authoring

- `@adhd/sox-hybrid-search@0.1.0` — listed in D5 as *"optional"* and **omitted entirely from the `_shared.md` table**. It fuses FTS5 text score + vector kNN with normalize-before-fuse (`min_max`/`L2`/`z_score`), degrades gracefully to a single signal, and returns `NodeRecord` fields. `discovery-tools`' `component_search` ("semantic, not substring") is a textbook hybrid-retrieval use case; raw `VectorBackend.knn()` returns only `{id, score}` — no fields to render a capability card, and no keyword channel.
- Entirely unknown to the plan: `@adhd/sox-graph-store`, `@adhd/sox-task-queue`, `@adhd/sox-blob-store`, `@adhd/sox-claim-verification`.
- `memory-core` HEAD is `0.3.0`; the plan records `0.2.1`.
- **Ownership correction:** `sox-analysis` owns the near-dup / importance / clustering **algorithms** (`detectNearDupPairs`, `scoreImportance`, `cluster`); `sox-ingest` owns summarisation/hashing/chunking. `memory-core` owns **none** of the core math — it is DB wiring + determinism glue that imports both.
- **Status:** OPEN.

### AMA-012 — vendored `run-audit.js` is stale

**Status:** OPEN
**Plan:** agent-mcp-authoring

- `scripts/run-audit.js` stamp `workflow@0.8.23+1e4130a84aed` ≠ installed `workflow@0.8.25+961c3053dfab`. Re-vendor so the audit runs current criteria semantics (`audit_at_wrong_ref`-class drift). Note `state.json.schema_version = 2` **is current** for 0.8.25 — this is a re-vendor, **not** a schema migration.
- **Status:** OPEN.

### AMA-013 — all 13 states unrated (no `model` / `effort`)

**Status:** OPEN
**Plan:** agent-mcp-authoring

- `dag.json` nodes carry no tier annotation; the orchestrator cannot honour a declared tier and would have to invent one (wrong-tier = token defect; over-tier = cost defect).
- **Status:** OPEN.

---

### AMA-018 — FIXED: plan told the executor to pass a `FileSystemModelCache`

**Status:** FIXED
**Plan:** agent-mcp-authoring

- `contexts/embedding-substrate.md`, `decisions.md`, `contexts/_shared.md` all instructed the executor to "pass a `FileSystemModelCache`" for CI model caching.
- **`FileSystemModelCache` is never used by `createEmbeddingProvider` or `FastembedProvider`.** It appears only as a re-export (`index.ts:124`); the `ModelCache` interface (`index.ts:111-120`) has no implementation wired into any code path. Verified by grep across `src/`.
- Reality: the factory resolves a **`cacheDir` string** — `config.options.cacheDir` → `SOX_EMBED_CACHE_DIR` → `$XDG_CACHE_HOME/sox/models` → `~/.cache/sox/models` (`index.ts:162-165`) — and the worker calls `FlagEmbedding.init({model, cacheDir, showDownloadProgress:false})` after `fs.mkdirSync` (`embedWorker.ts:138-160`).
- **Status:** FIXED in all three files.

**Citations:** [/Users/nix/dev/node/adhd/docs/plan/agent-mcp-authoring/BACKLOG.md]

### AMA-019 — FIXED: plan omitted that the factory eagerly downloads + warms the model

**Status:** FIXED
**Plan:** agent-mcp-authoring

- `createFastembedProvider` `await`s `provider.embedSingle('warmup')` **before returning** (`index.ts:167-174`). Constructing the embedder downloads a ~110M-param ONNX model and runs an inference.
- Consequence the plan never stated: a `beforeEach` that builds a provider re-runs warmup per test. Must build once (module scope / `beforeAll`).
- **Nested, conflicting timeouts:** the outer warmup wrapper defaults to **180 000 ms** (`index.ts:204-207`) but the worker-init promise is bounded at **60 000 ms** (`fastembed.ts:102-105`). Both read `SOX_EMBED_WARMUP_TIMEOUT_MS`. The **inner 60 s** is what a cold download must beat → `Fastembed worker init timed out after 60000ms`.
- **Status:** FIXED — documented in a new "Real-provider behaviour" table.

**Citations:** [/Users/nix/dev/node/adhd/docs/plan/agent-mcp-authoring/BACKLOG.md]

### AMA-020 — FIXED: `isDeterministic === false` was never stated as the provider's own contract

**Status:** FIXED
**Plan:** agent-mcp-authoring

- Empirically confirmed: `new FastembedProvider('bge-base-en-v1.5',768,…).metadata` → `{"isDeterministic":false,…}`. `RemoteProvider` likewise (`remote.ts:21`).
- The plan's content-hash gating decision was right, but justified as a hedge ("raw output need not be bit-identical") rather than as the provider's declared contract. A test asserting two `embedSingle` calls return identical vectors would be asserting something the provider explicitly does not promise.
- **Status:** FIXED.

**Citations:** [/Users/nix/dev/node/adhd/docs/plan/agent-mcp-authoring/BACKLOG.md]

### AMA-021 — FIXED: behaviours that change how the test must be written

**Status:** FIXED
**Plan:** agent-mcp-authoring

All now recorded in `embedding-substrate.md`:
- **`warmUp()` is a no-op** on both providers (`fastembed.ts:229-234`, `remote.ts:78-80`).
- **`role` is ignored** by `FastembedProvider.embedSingle(text, _role?)` (`fastembed.ts:163`) — no asymmetric document/query encoding.
- **Vectors are L2-normalised** on every path (`toFloat32Normalised`, `meanPool` re-normalises) → `cosine` ≡ dot product.
- **Chunk-then-mean-pool, no truncation:** `estimateTokens = ceil(len/4)`, `maxTokens = 512` → content over ~2048 chars is split on whitespace, embedded per chunk, mean-pooled, re-normalised. Real component bodies exceed this, so it is the **normal** path. `[embedding-substrate.1]`'s fixture must use realistic-length content.
- **ONNX runs in a worker thread** (`worker.unref()`), specifically so `onnxruntime-node` never shares a thread with `better-sqlite3` + `sqlite-vec` — which `@adhd/agent-store-prompts` uses. Gate the test on exit code, never stdout.
- **Network dependency:** the `embedding-substrate` guard now downloads a model on a cold cache. Per the repo's "live testing is mandatory" rule this does NOT qualify for an env-flag gate; it must fail loudly, never self-skip.
- **Status:** FIXED.

---

**Citations:** [/Users/nix/dev/node/adhd/docs/plan/agent-mcp-authoring/BACKLOG.md]

### AMA-D6-FLIP — remaining Option-A reconciliation (decision recorded in decisions.md §D6; artifacts still encode Option B) — Open (2026-07-11)

**Status:** UNKNOWN
**Plan:** agent-mcp-authoring

`decisions.md §D6` now carries the authoritative `⟲ FLIP` (Option B → A). The following artifacts still describe Option B and must be reconciled before the plan is gate-consistent. No `state.json` edits (no state executed; `schema_version` stays 2). Plan-builder made **no** edits (stopped in read phase) — working tree is clean except the D6 flip. Checklist (exact locations from the plan-builder read pass):

1. **`contexts/discovery-tools.md`** — invert retrieval-backend prose: goal para (~L12-20) and the two "Notes for executor" bullets (~L76-93; the bullet at ~L85-93 explicitly says "Do NOT wire SqliteSearchBackend / Option A rejected" and an "own FTS5 virtual table" bullet). Replace with: `component_define` writes a `kind:'component'` graph-store node keyed to `version_id`; `component_search` calls `SqliteSearchBackend(vec, graph).search(query)`; remove `component_fts`; add node↔version parity note. Preserve `[inv:no-slug-on-wire]`, bounded projection, nDCG@5 ≥ 0.70.
2. **`scripts/criteria.json`** — add two teeth mirrored to the .py: `discovery-tools.3.backend` (present `SqliteSearchBackend` in `component-search-ndcg.test.ts`) and `discovery-tools.3.parity` (present `parity` in same file); AND-chain `dod.2.tooth` with `grep -qE 'SqliteSearchBackend'` + `grep -qE 'parity'`.
3. **`scripts/audit_authoring.py`** — mirror the same two `grep_present` teeth (identical patterns/paths) and add the same conjuncts to `dod.2`/`dod.2.tooth` (AMA-017 symmetry: patterns/paths MUST match criteria.json exactly). Keep patterns simple (`SqliteSearchBackend`, `parity`) so JS RegExp (run-audit.js, whole-file) and `grep -rEq` (line-based) agree. gap-check Check 3 folds criteria.json IDs into auditIds — every new tooth ID must exist in criteria.json.
4. **`human-blockers.json:sox-package-publish`** — add graph-store enabling fixes as precondition: BL-295 (extensible `node.kind`), BL-293 (`createGraphBackend` applies schema/fails loudly), BL-294 (fusion degrade signal), BL-303 (drop drizzle), green across memory-core/analysis/hybrid-search. The 3 published packages (embedding-provider, vector-store, ingest) unchanged.
5. **`contexts/_shared.md`** — sox-package table D6 rows (~L49 hybrid-search "consume pure fusion (D6 Option B)"; ~L50 graph-store "transitive only / runtime NEVER loaded") → Option A (graph-store runtime IS loaded; SqliteSearchBackend used); update "deferred" line (~L71).
6. **`README.md`** — dod.2 (~L133-135): change "fused via hybrid-search's pure normalize()+fuse() / own channels" → Option-A `SqliteSearchBackend(vec, graph).search()`. Backend-agnostic parts (nDCG bar, golden set, negative control) stay.

**No change needed:** `contexts/live-model-e2e.md`, `contexts/composition-journey-e2e.md` (reference `component_search` at flow level only — verified).

**Gates to run after reconciliation:** `scripts/gap-check.js` (0 gaps), `scripts/env-pin-check.js --strict`, `scripts/integrity-check.js`, `scripts/run-audit.js` (+ `audit_authoring.py`), criteria.json validity. Fix artifacts (not gates) until green.
