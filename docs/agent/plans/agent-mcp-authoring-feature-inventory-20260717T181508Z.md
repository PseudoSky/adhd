# Feature Inventory: agent-mcp Authoring & Discovery (Plan 8 of 9)

**Generated:** 2026-07-17T18:15:08Z  
**Source:** `docs/plan/agent-final/superseded/agent-mcp-authoring/` (all 28 files)  
**Plan context:** Agent Registry initiative, Plan 8 — builds on Plan 6 (`agent-mcp-refactor`), overlaps Plan 7 (`agent-registry-migration`).  
**Focus:** Features, capabilities, data models, and architectural decisions NOT present in `packages/agent/*` code today.

---

## 1. Agent Runtime Execution & Orchestration (what runs the model)

### 1.1 Provider Matrix — three real LLM providers for live-model e2e

The plan introduces a **provider matrix** for live-model integration tests, each exercising the full composition journey (`component_search → agent_define → agent → task`):

- **`anthropic`** — Uses `useClaudeOauth: true` (macOS keychain OAuth token, no API key). Config: `{ type:"anthropic", model, useClaudeOauth:true }`. Verified live 2026-06-26.  
  *Sources: `README.md`, `contexts/live-model-e2e.md`, `human-blockers.json`*

- **`claudecli`** — Drives the local `claude` CLI via stream-json. Config: `{ type:"claudecli", claudePath?, model }`. Default real provider for `dod.5` composition-journey run step.  
  *Sources: `README.md`, `contexts/live-model-e2e.md`, `human-blockers.json`*

- **`lmstudio`** — OpenAI-compatible local server. Config: `{ type:"lmstudio", model, baseURL: process.env.LMSTUDIO_BASE_URL }`.  
  *Sources: `README.md`, `contexts/live-model-e2e.md`, `human-blockers.json`*

### 1.2 Provider prerequisites (human-blockers)

All three documented as environment/credential requirements in `human-blockers.json`, each with a `verification` command, `status` (verified/needed), and `blocks_at` (per-state / state-start):

| Blocker | Provider | Verification |
|---------|----------|-------------|
| `live-provider-anthropic-oauth` | anthropic | `security find-generic-password -s 'Claude Code'` or `ANTHROPIC_API_KEY` |
| `live-provider-claudecli` | claudecli | `command -v claude` |
| `live-provider-lmstudio` | lmstudio | `curl -sf "$LMSTUDIO_BASE_URL/models"` |

*Sources: `human-blockers.json`, `contexts/live-model-e2e.md`*

### 1.3 11-tool runtime hot path (unchanged, guarded)

The runtime delegation surface a sub-agent sees remains exactly **11 tools**: `agent`, `task`, `result`, `task_list`, `task_cancel`, `task_resume`, `session_list`, `session_close`, `session_clear`, `usage_query`, `guide`. Discovery and authoring tools are NEVER added to this set. `agent({name})` keeps required-arg count 1. This is a load-bearing invariant (`inv:11-tool-hot-path`) enforced by negative-control tests.  
*Sources: `README.md`, `contexts/_shared.md`, `contexts/compat-shim.md`, `README.md` §dod.7/DoD*

### 1.4 Compiler dependency (Plan 6 consumption)

`agent_define` consumes Plan 6's `compileAgent` + `composed_prompts` cache (keyed by `(agent, context_hash)`) for the `compiled_preview` and `composed_prompt_id` returned on upsert. Cache is busted when composition changes. `agent_compile` also reports `cache: HIT|MISS`.  
*Sources: `contexts/_shared.md`, `contexts/discovery-tools.md`, `contexts/agent-define.md`, `decisions.md` §D4*

---

## 2. Registry & Component Data Model

### 2.1 Component — the fundamental typed prompt unit

A **component** is a typed, named, versioned unit of prompt content in the registry. Types include: `role`, `rule`, `capability`, `process`. Content is authored by the agent; summary, use-cases, and weights are auto-derived via the enrichment pipeline.  

Wire identity: `name` (human display name).  
Store identity: `slug` (derived as `name.toLowerCase().replace(/\s+/g, '-')`).  

The component version table (`registry_component_versions`) uses a **`version_id` integer surrogate PK** — the natural numeric key for vector-store spaces and FTS5 virtual tables.  
*Sources: `README.md` (glossary), `README.md` §dod.1, `decisions.md` §D2, `contexts/name-slug-seam.md`, `contexts/_shared.md`*

### 2.2 Store vocabulary (existing, not refactored)

| Store | Key file | Used by |
|-------|----------|---------|
| `ComponentStore` | `packages/agent/agent-store-prompts/src/store/component-store.ts` | `component_define`, `component_search` (speaks `slug`) |
| `AgentStore` | `packages/agent/agent-store-prompts/src/store/agent-store.ts` | `agent_define`, `agent_read` (speaks `slug`) |
| `CompositionStore` | `packages/agent/agent-store-prompts/src/store/composition-store.ts` | `agent_define` (junction writes) |
| `UseCaseStore` | `packages/agent/agent-store-prompts/src/store/usecase-store.ts` | enrichment pipeline writes use-case links automatically |
| `ComposedPromptStore` | inferred from store directory | Plan 6 cache |

All stores keep `slug` internally — **NO store refactoring** is done. Translation happens at the bridge.  
*Sources: `contexts/_shared.md` (caller map), `decisions.md` §D2*

### 2.3 Use-case anchors (seeded + corpus-derived)

A fixed SEED set of ~10-20 use-case anchors is shipped in `usecase-anchors.ts` so discovery/composition proofs run on fixtures. Each anchor embeds `name + " — " + description` once at seed time.  

**Plan 7** (`agent-registry-migration`) backfills the real corpus-derived anchors through the same substrate — the seed set is clearly marked as seed so the backfill is additive, not conflicting.  
*Sources: `contexts/embedding-substrate.md`, `README.md` (cross-plan linkage)*

### 2.4 Enrichment data: `ComponentUsageRow`

Enrichment links use-cases to components via `UseCaseStore.linkComponent` with a `weight = cosineSimilarity` score. Weights are auto-derived, never hand-assigned.  
*Sources: `README.md` (glossary), `contexts/enrichment-pipeline.md`*

---

## 3. MCP Tool Surface — the Three Lanes

The plan defines three MCP tool lanes (SPEC §2):

### 3.1 Runtime Lane (hot path, unchanged)
11 tools as above (section 1.3). Always in delegation surface.

### 3.2 Discovery Lane (read-only, 11 tools)
`component_search`, `component_read`, `component_consumers`, `prompt_types_list`, `tool_list`, `model_list`, `policy_list`, `usecase_list`, `agent_read`, `agent_list`, `agent_compile`.  

NOT in delegation surface. Every list/search tool is bounded by default (BUG-003): default result-limit + summary projection (`name + type + summary + score`), never full body inline. Full body only via explicit single-item read (`agent_read`/`component_read`) or `full:true` opt-in.  

*Sources: `contexts/discovery-tools.md`, `contexts/_shared.md`*

### 3.3 Authoring Lane (write, 2 tools)
`agent_define`, `component_define`. Both are declarative, idempotent, name-keyed upserts. NOT in delegation surface. `agent_create`/`agent_update` survive as deprecated permanent compat shims.  

`component_delete` is also added as a symmetric authoring op (paired with `component_define`).  
*Sources: `contexts/_shared.md`, `contexts/component-define.md`*

---

## 4. Embedding & Vector Infrastructure

### 4.1 sox-ecosystem embedding (5-package dependency set)

The plan consumes **5 published npm packages** from the sox-ecosystem. Three are already published (`@0.1.0`); two are not yet published:

| Package | Version | What it provides | Native deps |
|---------|---------|-----------------|-------------|
| `@adhd/sox-embedding-provider` | 0.1.0 | `createEmbeddingProvider(config): Promise<EmbeddingProvider>` — async factory. Switches on `'fastembed'` \| `'remote'` ONLY | `@huggingface/transformers`, `fastembed` |
| `@adhd/sox-vector-store` | 0.1.0 | `openVectorStore(path,{dim,modelId})→SqliteVectorBackend`; `knn`/`upsert`/`ensureSpace`/`iter`/`get`/`delete` are methods; `reembed(...)` top-level | `@lancedb/lancedb`, `apache-arrow`, `better-sqlite3`, `sqlite-vec`, `synckit` |
| `@adhd/sox-ingest` (use `/core` subpath) | 0.1.0 | `ingest(content,{summaryMaxSentences})→{contentHash,summary,tags,chunks?}`; `hexSha256`; `splitIntoChunksSentence` | `/core` = `node:crypto` only runtime; install pulls ~55 MB (tree-sitter) |
| `@adhd/sox-hybrid-search` | 0.1.0 | `fuse(candidates,opts)` / `normalize(scores,method)` / `fuseWithBreakdown(...)` — normalize-before-fuse, degrade-to-single-signal | none of its own; transitive deps on graph-store + vector-store + embedding-provider |
| `@adhd/sox-graph-store` | 0.1.0 | **Transitive only** — hard dep of hybrid-search; runtime NOT loaded under Option B | `better-sqlite3`, `drizzle-orm@^0.42.0` (nested) |

**NOT consumed:** `@adhd/sox-analysis`, `@adhd/sox-memory-core`, `@adhd/sox-task-queue`, `@adhd/sox-blob-store`, `@adhd/sox-claim-verification`.  
*Sources: `contexts/_shared.md` (sox-ecosystem table), `decisions.md` §D5*

### 4.2 Real-provider behaviour table (fastembed specifics)

Critical implementation details verified against source (not `sox.concerns` metadata):

| Behaviour | Fact |
|-----------|------|
| Not deterministic | `FastembedProvider.metadata.isDeterministic = false`, hard-coded |
| Eager warmup | Factory `await`s `provider.embedSingle('warmup')` before returning — constructing downloads ONNX model |
| Single warmup timeout | One `SOX_EMBED_WARMUP_TIMEOUT_MS` budget, default 180 s; inner 60 s limit deleted upstream |
| `warmUp()` is a no-op | Body is `void texts;` — spec-pinned (asserted in `embedding-provider.spec.ts:86`) |
| `role` is ignored | `embedSingle(text, _role?)` parameter unused — no asymmetric document/query encoding |
| Vectors L2-normalised | `toFloat32Normalised()` on every path; `cosine(a,b)` ≡ dot product |
| Chunk-then-mean-pool | Text over ~2048 chars split on whitespace, per-chunk embed, mean-pool, re-normalise |
| ONNX in worker thread | `new Worker(workerPath, …)` + `worker.unref()` — isolates `onnxruntime-node` from `better-sqlite3`/`sqlite-vec` |
| Default model | `bge-base-en-v1.5` → 768 dims. Other models: `bge-small-en-v1.5` (384), `multilingual-e5-large` (1024), `bge-m3` (1024), `codexembed-400m` (1024) |
| cacheDir resolution | `config.options.cacheDir` → `SOX_EMBED_CACHE_DIR` → `$XDG_CACHE_HOME/sox/models` → `~/.cache/sox/models` |

*Sources: `contexts/embedding-substrate.md` (real-provider behaviour table)*

### 4.3 `@adhd/sox-embedding-provider` API surface consumed

```ts
createEmbeddingProvider(config): Promise<EmbeddingProvider>
  embedSingle(text, role?) → Promise<Float32Array>   // role IGNORED by fastembed
  embedBatch(texts, {batchSize}) → AsyncIterable<…>   // DEFAULT_BATCH_SIZE = 256
  warmUp(texts) → Promise<void>                        // NO-OP on fastembed
  health() → {configured, active, state, dimensions, …}
  metadata: { modelId, dimensions, maxTokens, isRemote, isDeterministic }
```

`type:'hash'` DOES NOT EXIST — throws `ResolutionError`. Only `'fastembed'` and `'remote'` are valid.  
*Sources: `contexts/embedding-substrate.md`, `decisions.md` §D1*

### 4.4 Registry embedder wrapper

```ts
// src/enrich/embedding.ts
export async function createRegistryEmbedder(
  config?: Partial<EmbeddingProviderConfig>,
): Promise<EmbeddingProvider>;
```

Default config: `{ type: 'fastembed', model: 'bge-base-en-v1.5' }` → 768-dim. Optional override via env `ADHD_EMBED_PROVIDER`.  

```ts
// src/enrich/cosine.ts
export function cosine(a: Float32Array, b: Float32Array): number;
```

Pure function, exported for enrichment pipeline and discovery tools.  
*Sources: `contexts/embedding-substrate.md`*

### 4.5 Vector storage model

**Single** `VectorSpace`: `{ modelId: 'bge-base-en-v1.5', dim: 768 }`. The old two-space story (hash-768 + bge) is deleted. `openVectorStore` calls `ensureSpace` internally. `reembed(backend, provider, opts)` is a top-level async export for future cross-model migrations.  
*Sources: `contexts/embedding-substrate.md`*

---

## 5. Enrichment Pipeline

### 5.1 `enrichComponent` — the single write-path enrichment function

```ts
// src/enrich/enrich-component.ts
export interface EnrichComponentParams {
  rowid: number;
  content: string;
  name: string;
  type: string;
}

export interface EnrichComponentResult {
  summary: string | null;
  useCaseLinks: Array<{ name: string; weight: number }>;
  changed: boolean;
}

export function enrichComponent(
  embedder: EmbeddingProvider,
  vecDb: VectorBackend,
  params: EnrichComponentParams,
): Promise<EnrichComponentResult>;
```

**Pipeline steps:**
1. `ingest(content)` → `{ contentHash, summary, tags }` (from `@adhd/sox-ingest/core`)
2. Content-hash check — skip on identical hash (idempotent gate before any embed/insert/delete)
3. `embedder.embedSingle(content)` → `Float32Array`
4. `vecDb.knn(embedding, anchorSpace, k=topK)` → nearest use-case anchors with cosine scores
5. `UseCaseStore.linkComponent` above threshold (writes `ComponentUsageRow` automatically)
6. Write summary + contentHash + provenance to component row

**Determinism rests on content-hash gating**, NOT on the embedder (which is explicitly non-deterministic).  
**Summary** = lead-N sentences from `ingest()`, zero LLM, deterministic. For content ≥100 chars it is the first `summaryMaxSentences` sentences; for <100 chars it is `content.trim()`.  
**weight** = the cosine similarity score, not hand-tuned.  
**Errors:** wrap embedding failures as typed errors; never silently degrade.  
*Sources: `contexts/enrichment-pipeline.md`, `decisions.md` §D1*

### 5.2 `summarize` (thin wrapper)

```ts
// src/enrich/summarize.ts
export function summarize(content: string): string {
  return ingest(content, { summaryMaxSentences: 2 }).summary;
}
```

**`extractiveSummary` is NOT exported** by `@adhd/sox-ingest` (AMA-002, confirmed by reading source). The plan previously `import { extractiveSummary }` — that does not compile.  
*Sources: `contexts/enrichment-pipeline.md`, `BACKLOG.md` §AMA-002*

### 5.3 Use-case anchors seed

```ts
// src/enrich/usecase-anchors.ts
export interface UseCaseAnchor {
  name: string;
  description: string;
  embedding: Float32Array;
}

export function seedAnchors(embedder: EmbeddingProvider): Promise<UseCaseAnchor[]>;
```

Ships a small fixed SEED set (~10-20 use-cases). Each anchor embeds `name + " — " + description` once. Idempotent: re-running on an already-seeded store is a no-op (additive insert, skip on name collision).  
*Sources: `contexts/embedding-substrate.md`*

---

## 6. Name↔Slug Translation Seam

### 6.1 `toSlug` and `registry-bridge`

```ts
// entrypoint/agent-mcp/src/registry/name-slug.ts
toSlug(name: string): string;  // name.toLowerCase().replace(/\s+/g, '-')
```

The seam lives in two new modules:
- `name-slug.ts` — pure `toSlug(name)`
- `registry-bridge.ts` — wraps registry stores: translates `name → slug` inbound, **strips `slug`** (re-keys rows to `name`) outbound

**Key decisions:**
- Wire speaks `name`; stores keep `slug` internally unchanged — NO store refactoring
- `toSlug` is idempotent on already-slug input (round-trip safety)
- Every discovery/authoring tool routes through the bridge
- Outbound strip is recursive — raw store objects with `.slug` in nested arrays must also be re-keyed
- Proof (`dod.4`): recursive scan of every authoring/discovery tool response asserts no `slug` key anywhere

**Store types that legitimately expose `slug` (not refactored):**
`PromptComponent.slug`, `ComponentCreateInput.slug`, `UseCaseStore.linkComponent(componentSlug, …)`, `componentsFor(useCaseSlug)`, `AgentStore.read(slug)`.  
*Sources: `contexts/name-slug-seam.md`, `decisions.md` §D2, `README.md` §dod.4*

---

## 7. Discovery & Hybrid Search

### 7.1 `component_search` — hybrid FTS5 + vector retrieval

Uses **real hybrid retrieval** (D6, Option A after FLIP 2026-07-11):

- **Text channel:** FTS5 BM25 `MATCH` over component content (via `@adhd/sox-graph-store` FTS5 triggers on `kind:'component'` nodes)
- **Vector channel:** `@adhd/sox-vector-store` `knn()` over the enrichment embedding (same embedding that filed each component)
- **Fusion:** `@adhd/sox-hybrid-search`'s `normalize()` + `fuse()` (normalize-before-combine, degrades to single signal when one channel absent)
- **Key:** both channels key on the `registry_component_versions.version_id` integer surrogate

**Quality bar (load-bearing):** Golden-set **nDCG@5 ≥ 0.70** over a corpus salted with hard negatives (distractors that share query vocabulary but are not the answer). ~15-30 graded-relevance tasks over N≫k corpus. MRR reported alongside. Negative control with teeth: swapping to a shuffled/insertion-order ranker drops nDCG below the floor.

**Output:** returns `name + type + summary + score` (summary projection, never full bodies), fused top-`limit` items.  

**D6 FLIP history (2026-07-11):** Originally deferred hybrid search in favor of pure cosine `knn()`. An owner directive ("We should not be designing around things.") flipped Option B → Option A (consume `@adhd/sox-graph-store` + `SqliteSearchBackend` directly). This required sox-side fixes: BL-295 (extensible `node.kind`), BL-293 (schema apply), BL-294 (degrade signal), BL-303 (prune unused drizzle dep).  
*Sources: `README.md` §dod.2, `contexts/discovery-tools.md`, `decisions.md` §D6, `BACKLOG.md` §AMA-D6-FLIP*

### 7.2 Bounded output (BUG-003 remediation)

All list/search tools (`agent_list`, `component_search`, `tool_list`, `model_list`, `policy_list`, `usecase_list`, `prompt_types_list`) MUST apply:
- Default result limit (e.g. 20)
- Summary projection only (`name + type + one-line summary + score`)
- NEVER full `systemPrompt`/body inline
- Full body only via explicit single-item read (`agent_read`/`component_read`) or `full:true`/over-limit opt-in

This is a hard requirement: an unbounded `agent_list` against the live 46-agent store returned 464,821 chars / 692 lines — blew the host's tool-output token ceiling, making the entire discovery lane unusable.  
*Sources: `contexts/discovery-tools.md`, `BACKLOG.md` §BUG-003*

---

## 8. Authoring Tools

### 8.1 `component_define` — content-only upsert

```ts
component_define({name, type, content, shared?})
```

- Name-keyed create-or-replace upsert (`inv:declarative-upsert`)
- Runs `enrichComponent` on write → response carries auto-derived `summary` and weighted `use_cases`
- Version bumps only when content actually changes (content-hash compare)
- Re-defining byte-identical content → `changed:false`, no index churn
- `type` not in `prompt_types_list` → `INVALID_TYPE` (validated against live rows, not hardcoded enum)
- Route name→slug through the `registry-bridge`; response is slug-free
- Editing a `shared:true` component recompiles every consumer (noted in tool behavior)

**Files:** `entrypoint/agent-mcp/src/tools/authoring.ts` (registered in `server.ts`)  
*Sources: `contexts/component-define.md`, `README.md` §dod.1*

### 8.2 `component_delete` — symmetric delete operation

```ts
component_delete({name})
```

- Removes a component AND its enrichment links (define→delete round-trip leaves no trace, reopen-proven)
- Unknown name → `COMPONENT_NOT_FOUND`
- `shared:true` component with consumers → refused (or surfaces consumer list) — no orphan
- Registered in the authoring lane, OUTSIDE the 11-tool delegation surface
- Gives every authoring test a clean teardown path: create in test, delete in teardown

**Files:** `entrypoint/agent-mcp/src/tools/authoring.ts` (registered in `server.ts`)  
*Sources: `contexts/component-define.md`*

### 8.3 `agent_define` — transactional declarative composition upsert

```ts
agent_define({name, model, components[], tools?, policy?})
```

- Single transactional upsert across agent + composition + tool-grant + policy-attach stores
- **Create-or-replace** — full replace of `components`/`tools`/`policy`, NOT a merge
- Version-bumped only when resolved composition changes (content-hash compare)
- Idempotent: `changed:false` on no-change
- Returns `compiled_preview` (each component's content in `position` order) + `composed_prompt_id` via Plan 6's `compileAgent` + `composed_prompts` cache
- Busts cache when composition changes
- Referenced names resolved before commit → typed `*_NOT_FOUND` errors: `COMPONENT_NOT_FOUND`, `TOOL_NOT_FOUND`, `POLICY_NOT_FOUND`, `MODEL_NOT_FOUND`
- **No standalone** `tool_grant`/`model_bind`/`policy_attach` verbs — grants are by-reference inside the spec (Decision C)
- Transactional: all commit or all roll back; a bad reference leaves registry byte-identical to before call

**Files:** `entrypoint/agent-mcp/src/tools/authoring.ts`, `entrypoint/agent-mcp/src/registry/composition-writer.ts`  
*Sources: `contexts/agent-define.md`, `decisions.md` §D4*

---

## 9. Compat Shim & Backward Compatibility

### 9.1 Flat `systemPrompt` → permanent compat shim

`agent_create({name, provider, systemPrompt})` wraps the flat prompt as one private inline component (`<name>-inline-<n>`) and composes it — runs identically to agent-mcp 1.0.1.  

- `systemPrompt` and a `components` list are mutually exclusive → `VALIDATION_ERROR`
- `no-components` / `no-systemPrompt` case surfaces `COMPILE_NO_COMPONENTS` later at session start
- `guide` text (`tools/guide.ts`) marks `systemPrompt` as deprecated/optional, adds new authoring section

**The shim is permanent, not sunset** — explicitly supported across the entire 2.x line.  

**Files:** `entrypoint/agent-mcp/src/tools/agent-crud.ts`, `entrypoint/agent-mcp/src/validation/agent.ts`, `entrypoint/agent-mcp/src/tools/guide.ts`  
*Sources: `contexts/compat-shim.md`, `contexts/versioning.md`, `README.md` §dod.7*

### 9.2 Version: agent-mcp@2.0.0

- Already on `main` (`package.json` is `2.0.0`)
- Breaking change: `agent_create.systemPrompt` went `required→optional` (breaking for strict-schema callers)
- Behavioral: additive — new discovery + authoring lanes, no new required args on 11-tool hot path
- CHANGELOG records: definition lane (discovery + authoring tools, auto-enrichment, `name`-on-wire), permanent compat-shim promise, drop-in upgrade for runtime callers

**Files:** `entrypoint/agent-mcp/package.json`, `entrypoint/agent-mcp/CHANGELOG.md`  
*Sources: `contexts/versioning.md`*

---

## 10. Back-out Guarantee & Modification Manifest

### 10.1 Agent-mcp modification manifest (D3)

The plan's first sanctioned modification to agent-mcp source. Every touchable file is enumerated in `decisions.md` `def:agent-mcp-modification-manifest`:

**Additive files (new modules):**
- `entrypoint/agent-mcp/src/registry/name-slug.ts`
- `entrypoint/agent-mcp/src/registry/registry-bridge.ts`
- `entrypoint/agent-mcp/src/registry/composition-writer.ts`
- `entrypoint/agent-mcp/src/tools/discovery.ts`
- `entrypoint/agent-mcp/src/tools/authoring.ts`

**Modifiable files:**
- `entrypoint/agent-mcp/src/server.ts` — register discovery+authoring tools (NOT in delegation surface)
- `entrypoint/agent-mcp/src/tools/agent-crud.ts` — `systemPrompt`→inline-component compat shim
- `entrypoint/agent-mcp/src/validation/agent.ts` — `systemPrompt`+components mutual-exclusion
- `entrypoint/agent-mcp/src/tools/guide.ts` — authoring section; deprecated/optional `systemPrompt`
- `entrypoint/agent-mcp/package.json` — 2.0.0
- `entrypoint/agent-mcp/CHANGELOG.md`

**Test files (additive):**
- 8 test files: `name-slug-seam.test.ts`, `discovery-tools.test.ts`, `discovery-bounded-output.test.ts`, `component-define.test.ts`, `agent-define.test.ts`, `systemprompt-compat.test.ts`, `composition-journey-e2e.test.ts`, `authoring-live-e2e.test.ts`

**agent-base-types (packages/agent/agent-base-types/src):** NONE expected.  
*Sources: `decisions.md` §D3*

### 10.2 Back-out guarantee mechanics

- `check_manifest.py` enforces that every changed `entrypoint/agent-mcp/src` or `packages/agent/agent-base-types/src` file is in the manifest
- Pre-plan baseline ref recorded at execution time (filled from actual HEAD before first agent-mcp src commit)
- Non-regression: full pre-existing agent-mcp test suite stays green (`nx test agent-mcp`) at every state
- Reverting this plan's commits restores agent-mcp to `baseline-ref` byte-for-byte
- Guarded by `dod.8` checks: manifest exists, non-regression, build clean, manifest-diff subset check

**`check_manifest.py`** parses the fenced block in `decisions.md`, diffs guarded prefixes against `baseline-ref`, and passes iff change set is a subset of the manifest.  
*Sources: `README.md`, `decisions.md` §D3, `scripts/check_manifest.py`*

---

## 11. Audit & Verification Infrastructure

### 11.1 `audit_authoring.py` — phase-scoped audit oracle

Python script in plan's `scripts/` directory. Two phases:

- **`--phase architecture`** — checks `decisions.md` has all four `def:` markers + baseline-ref. Runs before any code change.
- **`--phase final`** — drives every `[dod.N]` (1-8) + all work-state criteria + back-out guarantee checks. Each check drives the real test entrypoint (not grep proxies), then additional `.tooth`/`.tool` grep checks for structural integrity.

Pattern: for each state, runs `npx --yes nx test <project> --testFile=<test>` with F-P6-10 hardening (`test -f <file> &&` prepended to prevent ghost passes for missing test files).

Every check is env-pinned (`npx --yes nx`, `python3 ...`).  
*Sources: `scripts/audit_authoring.py`*

### 11.2 `criteria.json` — declarative audit criteria

Declares 27 criteria across all phases, each with `kind` (`command`/`present`/`absent`/`exists`), `expect` (`exit0`), and paired `.tooth`/`.tool` discriminator criteria (AMA-017 remediation). Both `run-audit.js` and `audit_authoring.py` read from the same tooth patterns so the two runners agree.  
*Sources: `scripts/criteria.json`*

### 11.3 `run-audit.js` — vendored declarative-criteria runner

Self-contained Node.js script (vendored & no lib imports). Supports kinds: `absent`/`present`/`exists`/`command`/`negative-control`/`custom`. Emits `[id] PASS/FAIL` markers on stdout. Fail-closed: zero criteria → non-zero exit. BL-96(1) supports per-criterion `cwd` resolution opt-in (`"cwd": "repo-root"`).  
*Sources: `scripts/run-audit.js`*

### 11.4 `review_gate.py` — code-review gate

Parses `review.md` for `VERDICT: APPROVED` line + no unresolved `BLOCKING:` findings. Default verdict is NEEDS-WORK. Architect-reviewer (opus tier) reads the full diff against CLAUDE.md, decisions.md, SPEC contracts.  
*Sources: `scripts/review_gate.py`, `contexts/code-review.md`*

### 11.5 `skill-version.json`

Vendor stamp: `workflow@0.8.28+6e17cc7c7603`. Used by `run-audit.js` to self-report identity. `gap-check` compares against installed skill to catch silent vendoring drift.  
*Sources: `scripts/skill-version.json`*

---

## 12. Cross-Cutting Invariants

Recorded in `contexts/_shared.md`:

| Invariant | Meaning |
|-----------|---------|
| `[inv:no-slug-on-wire]` | No `slug` field in any MCP tool schema, output, or `guide` text |
| `[inv:11-tool-hot-path]` | Delegation surface = exactly 11 runtime tools; authoring/discovery tools NEVER in it |
| `[inv:enrichment-deterministic]` | Enrichment is deterministic and idempotent; re-define of identical content does NOT churn index |
| `[inv:declarative-upsert]` | `agent_define`/`component_define` are name-keyed create-or-replace upserts |
| `[inv:agent-mcp-back-out]` | agent-mcp src touched ONLY per D3 manifest; full pre-existing suite stays green |
| `[inv:additive-registry]` | Enrichment/embedding/discovery live in `@adhd/agent-store-prompts` (additive); agent-mcp gets only thin wrappers |

*Sources: `contexts/_shared.md`*

---

## 13. Security Remediation (found in audit)

### 13.1 ENV-SEC-001 — FontAwesome Pro npm `_authToken` hardcoded

**Severity:** CRITICAL. A live FontAwesome Pro npm `_authToken` literal was committed to `.github/scripts/setup-npmrc.sh`, reached `origin/main` of a PUBLIC repo. Remediation: rotate/revoke at FontAwesome (human action), token now read from env behind `: "${FONTAWESOME_TOKEN:?...}"` guard. Prevention: gitleaks rule + pre-commit hook + CI secret-scan job. History rewrite: deferred (not required post-rotation).  
*Sources: `BACKLOG.md` §ENV-SEC-001 / SEC-001*

### 13.2 ENV-SEC-002 — Nx Cloud access token committed to `nx.json`

**Severity:** CRITICAL. Read-write `nxCloudAccessToken` in `nx.json` from repo's first commit (2024-05-04), removed 765 days later (2026-06-08). Write-scoped token could poison remote-cache artifacts. Remediation: rotate at nx.app (human action). Nx Cloud now fully disabled per removal commit (`ce425400`). Prevention: pre-commit hook rule + CI secret-scan.  
*Sources: `BACKLOG.md` §ENV-SEC-002 / SEC-002*

---

## 14. Supply & Publishing Mechanics

### 14.1 sox-ecosystem publish plan (D5, Option A)

```bash
cd /Users/nix/dev/ai/sox-ecosystem
pnpm changeset            # for embedding-provider, vector-store, ingest, graph-store, hybrid-search
pnpm changeset version
pnpm publish -r           # pnpm rewrites workspace:* in the tarball
```

**Rejected options:**
- `npm link` — REJECTED (`EUNSUPPORTEDPROTOCOL` on `workspace:*`)
- `file:` path — REJECTED (npm symlinks without recursing → `MODULE_NOT_FOUND`)

**Proven:** `pnpm pack` rewrites `workspace:*` → concrete versions in the tarball.  
*Sources: `decisions.md` §D5, `contexts/_shared.md`*

### 14.2 `workspace:*` resolution rule

`workspace:*` is NOT resolvable by the consumer via `file:`/`npm link`. Only `pnpm pack`/`changeset publish` rewrites it. This was empirically verified.  
*Sources: `BACKLOG.md` §AMA-004*

### 14.3 `@adhd/sox-ingest` publish governance

Was `private:true` with header invariant "PRIVATE — never published to npm; only the memory domain composer may call this package." Resolved by sox-ecosystem commit `f4897aa` (sets `private:false`, deletes invariant). The `./core` export subpath is currently uncommitted in sox-ecosystem working tree — must be verified before `enrichment-pipeline` executes.  
*Sources: `decisions.md` §D5, `human-blockers.json` `sox-ingest-publishable`, `contexts/_shared.md`*

---

## 15. Plan State Machine & Execution Model

### 15.1 State machine phases and ordering

13 states across 8 phases:

| Phase | States | Guard model |
|-------|--------|-------------|
| architecture | `authoring-design` | opus, hard |
| enrichment | `embedding-substrate`, `enrichment-pipeline` | sonnet, medium |
| seam | `name-slug-seam` | sonnet, medium |
| discovery | `discovery-tools` | sonnet, medium |
| authoring | `component-define`, `agent-define` | sonnet, medium |
| compat | `compat-shim`, `versioning` | sonnet, medium + haiku, easy |
| e2e | `composition-journey-e2e`, `live-model-e2e` | sonnet, medium |
| audit | `code-review`, `audit-final` | opus, hard |

Each state has: guard (exit-code-gated), artifacts list, context file reference, notes for executor.  
*Sources: `dag.json`, `README.md` (state machine table)*

### 15.2 Plan dependencies

- `depends_on_plans: ["agent-mcp-refactor"]` — consumes Plan 6's registry-backed session-start path, `compileAgent`, `composed_prompts` cache
- Overlaps Plan 7 (`agent-registry-migration`) but does NOT depend on it — seed vs corpus anchors are additive
- Plans 1-6 of this initiative are complete and merged to `main`

*Sources: `dag.json`, `README.md`*

### 15.3 State execution hardening

- F-P6-6: release back-out gate = union of guarded `…/src` mutate_set across all initiative plans
- F-P6-10: `test -f <file> &&` prepended to every `nx test --testFile=` audit check
- F-P6-13: publish replaces `@adhd/*` `"*"` deps with real versions + runtime-resolution smoke test
- F-P6-11: import-script writes corpus to `~/.adhd/agent-mcp/registry.db`

*Sources: `contexts/_shared.md`*

---

## 16. e2e Test Architecture

### 16.1 `composition-journey-e2e.test.ts` — Cumulative Usability Gate

- Drives SPEC §7 journey over public MCP surface only: `prompt_types_list → component_search → component_read → tool_list/model_list/policy_list → component_define → agent_define → agent → task → result`
- Real registry + agent-mcp server over the MCP wire (starts server bin, connects MCP client)
- **Static import-scan assertion:** imports NO `packages/agent/**/src/**` or `entrypoint/**/src/**` paths — only MCP wire client + compiler CLI bin at `dist/`
- Agent RUN step uses REAL provider (default `claudecli`); not available → skip-not-fail for run step only
- Wiring assertions always run (deterministic: composed prompt contains discovered components in `position` order)
- Seed/ingest uses store API in a separate fixture file (the e2e test does NOT import it)

**Files:** `entrypoint/agent-mcp/src/__tests__/composition-journey-e2e.test.ts`, `docs/plan/agent-registry/demo/compose-via-mcp.mjs`  
*Sources: `contexts/composition-journey-e2e.md`, `README.md` §dod.5*

### 16.2 `authoring-live-e2e.test.ts` — Live Model Matrix

- Gated on `AGENT_MCP_LIVE=1`; skips entirely when unset (CI stays offline)
- Runs composition journey once per available provider: `anthropic` (OAuth keychain), `claudecli`, `lmstudio` (baseURL)
- Per-provider availability gates each case (skip-not-fail when absent)
- Asserts model-independent invariants: model issues real `agent_define` tool call + `stopReason: completed`
- **Empty-registry negative control** per provider: seed zero components → `agent_define` must raise `COMPONENT_NOT_FOUND`
- Never scripted/mock provider on the live path

**Files:** `entrypoint/agent-mcp/src/__tests__/authoring-live-e2e.test.ts`  
*Sources: `contexts/live-model-e2e.md`, `README.md` §dod.6*

---

## 17. Backlog Defects Discovered (significant findings)

### AMA-001 — Embedding provider `type:'hash'` does not exist
`createEmbeddingProvider` handles `'fastembed'` and `'remote'` only; `default:` throws `ResolutionError`. Plan was written against stale `sox.concerns` metadata. **Fixed:** plan now uses `type:'fastembed'` (bge-base-en-v1.5).  
*Sources: `BACKLOG.md` §AMA-001, `decisions.md` §D1*

### AMA-002 — `extractiveSummary` not exported by `@adhd/sox-ingest`
Function declared without `export` at `libs/data/ingest/ingest/src/index.ts:78`. Plan's `import { extractiveSummary }` does not compile. **Fixed:** use `ingest()` public API and read `.summary`.  
*Sources: `BACKLOG.md` §AMA-002, `contexts/enrichment-pipeline.md`*

### AMA-003 — `createEmbeddingProvider` is async; plan declared sync wrapper
Source: `embedding-provider/src/index.ts:128` — `export async function createEmbeddingProvider(config): Promise<EmbeddingProvider>`. **Fixed:** all signatures corrected to `Promise<EmbeddingProvider>`.  
*Sources: `BACKLOG.md` §AMA-003, `contexts/embedding-substrate.md`*

### AMA-004 — No npm path exists for required sox packages
Only `@adhd/sox-memory-core@0.2.1` published. The three required packages all 404. `workspace:*` is not consumer-resolvable via `file:`/`npm link`. **Status resolved:** first 3 published 2026-07-09; graph-store + hybrid-search still pending.  
*Sources: `BACKLOG.md` §AMA-004, `human-blockers.json`*

### AMA-016 — `versioning` state had a no-op guard (already green)
`package.json` already `2.0.0` on `main`, `nx build agent-mcp` already green. Guard was proxy-only. **Fixed:** compound guard AND-chains CHANGELOG existence + 2.0.0 heading + systemPrompt mention.  
*Sources: `BACKLOG.md` §AMA-016, `contexts/versioning.md`, `decisions.md` §D-repair*

### AMA-017 — `criteria.json` teeth did not discriminate
Three criteria per state had byte-identical commands. **Fixed:** each `.2`/`.3` criterion now has a paired `.tooth`/`.tool` grep-based discriminator with matching patterns in both `criteria.json` and `audit_authoring.py`.  
*Sources: `BACKLOG.md` §AMA-017, `decisions.md` §D-repair*

### AMA-D6-FLIP — Option B → A reconciliation (7 artifacts still encode Option B)
`decisions.md §D6` flipped (2026-07-11) from Option B (own FTS5, consume pure fusion) to Option A (`SqliteSearchBackend` via graph-store). Six artifacts still describe Option B and require reconciliation: `contexts/discovery-tools.md`, `scripts/criteria.json`, `scripts/audit_authoring.py`, `human-blockers.json` (graph-store fixes), `contexts/_shared.md`, `README.md`.  
*Sources: `BACKLOG.md` §AMA-D6-FLIP*

### SOX-BUG-001 — Nested warmup timeouts disagree
Outer 180 s, inner 60 s, both reading `SOX_EMBED_WARMUP_TIMEOUT_MS`. Inner was the effective limit. **Fixed upstream:** single exported `warmupTimeoutMs()`.  
*Sources: `BACKLOG.md` §SOX-BUG-001*

### SOX-BUG-002 — `ModelCache`/`FileSystemModelCache` is dead API
Exported but never wired into any factory or provider. **Fixed upstream:** marked `@deprecated`.  
*Sources: `BACKLOG.md` §SOX-BUG-002*

---

## 18. Platform & Environment

### 18.1 Platform isolation

`@adhd/agent-store-prompts` is already `platform:node` (`project.json` → `tags: ["layer:ai","platform:node"]`). Adding sox packages introduces **six new native transitive deps**: `@huggingface/transformers`, `fastembed`, `@lancedb/lancedb`, `apache-arrow`, `synckit`, `sqlite-vec`. Consistent with existing `platform:node` tag — no purity violation. Rejected alternative: isolating embed behind its own package (premature).  
*Sources: `decisions.md` §D-platform, `contexts/embedding-substrate.md`*

### 18.2 Environment invariants (verified 2026-07-08)

- `$SKILL` = `~/.claude/plugins/cache/sox-subagents/workflow/0.8.25/skills/plan-state-machine/scripts`
- `.mcp.json` points agent-mcp server at `dist/entrypoint/agent-mcp/src/index.js`
- `~/.adhd/agent-mcp/agents.db` is the registry server's default store
- Live MCP-stdio test harness: `docs/plan/agent-registry/demo/live-test-mcp.mjs`

*Sources: `contexts/_shared.md`*

---

## Appendix: All Source Files Read (28)

| File | Type |
|------|------|
| `README.md` (223 lines) | Plan overview, DoD, state machine |
| `dag.json` (249 lines) | State machine with artifacts, guards, dependency |
| `decisions.md` (471 lines) | 6 binding design decisions + 2 repairs + 1 flip |
| `interfaces.json` (1 line) | Empty stub |
| `state.json` (121 lines) | Plan execution state (all pending) |
| `final-review.md` (7 lines) | Stub |
| `human-blockers.json` (66 lines) | 5 blockers with verification, status, ownership |
| `references.json` (1 line) | Empty stub |
| `BACKLOG.md` (310 lines) | 21 AMA findings + 4 SOX-* defects + 2 security specs |
| `events.ndjson` (18 lines) | Consistency check failures (dead definition invariants) |
| `contexts/_shared.md` (166 lines) | Shared definitions, invariants, caller map, sox table |
| `contexts/authoring-design.md` (57 lines) | Design gate acceptance criteria |
| `contexts/embedding-substrate.md` (267 lines) | Embedding architecture + real-provider behaviour table |
| `contexts/enrichment-pipeline.md` (189 lines) | EnrichComponent design + ingest() consumption |
| `contexts/name-slug-seam.md` (61 lines) | Name↔slug bridge design |
| `contexts/discovery-tools.md` (123 lines) | 11 discovery tools + hybrid search + bounded output |
| `contexts/component-define.md` (84 lines) | component_define + component_delete design |
| `contexts/agent-define.md` (68 lines) | agent_define transactional upsert design |
| `contexts/compat-shim.md` (63 lines) | systemPrompt permanent compat shim design |
| `contexts/versioning.md` (70 lines) | 2.0.0 version + CHANGELOG design |
| `contexts/composition-journey-e2e.md` (89 lines) | Cumulative Usability Gate design |
| `contexts/live-model-e2e.md` (120 lines) | Live provider matrix design |
| `contexts/code-review.md` (58 lines) | Architect-review gate design |
| `contexts/audit-final.md` (56 lines) | Final audit DoD gate design |
| `scripts/audit_authoring.py` (336 lines) | Phase-scoped audit oracle (Python) |
| `scripts/check_manifest.py` (103 lines) | Back-out guarantee checker (Python) |
| `scripts/criteria.json` (276 lines) | 27 declarative audit criteria |
| `scripts/review_gate.py` (99 lines) | Code-review gate (Python) |
| `scripts/run-audit.js` (431 lines) | Vendored declarative-criteria audit runner (Node) |
| `scripts/skill-version.json` (7 lines) | Workflow skill vendor stamp |

---

*This inventory captures features, decisions, data models, and architecture described in the plan but NOT yet present in `packages/agent/*` code. It is organized by concept area (not source file), with each claim citing its origin file(s).*
