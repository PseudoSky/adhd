# Shared context — agent-mcp Authoring & Discovery (Plan 8)

Definitions, invariants, the caller map, and source-of-truth pointers shared by
every state in this plan. Read this before any state context.

> **Package identity (2026-07-08 correction, AMA-014).** The registry package was
> renamed and relocated by commit `b7183a3` (`refactor(agent): rename
> agent-registry → agent-store-prompts`). Everywhere this plan says "the registry"
> it means **`@adhd/agent-store-prompts`** at **`packages/agent/agent-store-prompts/`**
> (nx project `agent-store-prompts`). The old identity `@adhd/agent-registry` /
> `packages/ai/agent-registry/` **no longer exists** (`packages/ai/` is gone). The
> MCP server package is **`@adhd/agent-mcp`** at **`entrypoint/agent-mcp/`** (nx
> project name still `agent-mcp`; only the path moved from the deleted
> `packages/ai/agent-mcp/`). The store vocabulary the plan describes maps 1:1:
> `packages/agent/agent-store-prompts/src/store/{agent-store,component-store,composed-prompt-store,composition-store,usecase-store}.ts`.

## Source of truth

- **Spec (authoritative):** `docs/plan/agent-registry/SPEC_AGENT_MCP_TOOL_INTERFACE.md`
  — the ratified target surface. Where it disagrees with the api-designer stab
  (`AGENT_MCP_TOOL_INTERFACE.md`), the SPEC wins (its §13). (This `docs/plan/agent-registry/`
  *documentation* directory keeps its name — it is the initiative doc set, not the
  renamed code package.)
- **Goal:** `docs/plan/agent-registry/GOAL.md` — every behavioral DoD clause traces
  here (single authorship, runtime composition, discovery, onboarding).
- **Decisions:** `decisions.md` (this plan) — D1 embedding source, D2 name↔slug
  seam, D3 the agent-mcp modification manifest, D4 agent_define transaction, D5
  sox-ecosystem consumption/publish, D6 component_search retrieval backend.
- **Plan 6 contract (consumed):** `docs/plan/agent-mcp-refactor/` —
  `resolveComposedPrompt`, the `composed_prompts` cache keyed by
  `(agent, context_hash)`, the registry-backed session-start path. `assumed_baseline`.

## sox-ecosystem dependency (FEAT-008 consumable)

This plan consumes a **minimal** set of sox-ecosystem data-layer packages from
`/Users/nix/dev/ai/sox-ecosystem` (HEAD) instead of building embedding/enrichment
infrastructure from scratch. **Verified against source, not `sox.concerns`
metadata (which is stale — see BACKLOG SOX-DOC-001/002).**

**Required (the publish set — exactly 5). The first 3 are dependency-free leaves;
`@adhd/sox-graph-store` + `@adhd/sox-hybrid-search` were ADDED 2026-07-10 when D6
flipped `component_search` to real FTS5+vector fusion (was 3):**

| Package | Ver | Location (`/Users/nix/dev/ai/sox-ecosystem/…`) | Real API consumed | Native deps it brings |
|---------|-----|------------------------------------------------|-------------------|-----------------------|
| `@adhd/sox-embedding-provider` | 0.1.0 (public) | `libs/data/embed/embedding-provider` | `createEmbeddingProvider(config): Promise<EmbeddingProvider>` — **async**; switches on `'fastembed'` \| `'remote'` ONLY (no `'hash'`). Factory **eagerly warms up** (downloads the ONNX model) before resolving. Model cache is a **`cacheDir` string** (`options.cacheDir` → `SOX_EMBED_CACHE_DIR` → `~/.cache/sox/models`); `FileSystemModelCache` is exported but **never wired in**. `metadata.isDeterministic === false`; `warmUp()` is a no-op; `role` is ignored; vectors are L2-normalised; text over ~2048 chars is chunk-then-mean-pooled. | `@huggingface/transformers`, `fastembed` |
| `@adhd/sox-vector-store` | 0.1.0 (public) | `libs/data/vectors/vector-store` | `openVectorStore(path,{dim,modelId})→SqliteVectorBackend` (calls `ensureSpace` internally); `knn`/`upsert`/`ensureSpace`/`iter`/`get`/`delete` are **methods**; `reembed(backend,provider,opts)` is a **top-level async export**. | `@lancedb/lancedb`, `apache-arrow`, `better-sqlite3`, `sqlite-vec`, `synckit` |
| `@adhd/sox-ingest` (use the **`/core`** subpath) | 0.1.0 (**public**; `private:false` since sox-ecosystem commit `f4897aa`) | `libs/data/ingest/ingest` | **Import from `@adhd/sox-ingest/core`**: `ingest(content,{summaryMaxSentences})→{contentHash,summary,tags,chunks?}`; `hexSha256`; `splitIntoChunksSentence` (+ `IngestResult`/`IngestOpts`/`IngestChunk` types). `extractiveSummary` is **module-private (NOT exported)**. Summariser is lead-N (`sentences.slice(0,n)`); `<100 chars → content.trim()`. | **`/core` = `node:crypto` only at RUNTIME.** It is NOT install-free: `tree-sitter-wasms` (49 MB) + `web-tree-sitter` (5.7 MB) are hard `dependencies` of the package, so `npm install @adhd/sox-ingest` pulls ~55 MB whichever entrypoint you import (BACKLOG SOX-DEP-001). The root barrel `.` additionally re-exports `AstChunker`, which pulls `web-tree-sitter` + `tree-sitter-wasms`; the `/core` subpath avoids both. CAVEAT: `./core` export + `src/core.ts` are currently **uncommitted** (untracked) in sox-ecosystem — `sox-package-publish` re-verifies `@adhd/sox-ingest/core` resolves before enrichment-pipeline starts. |
| `@adhd/sox-hybrid-search` | 0.1.0 (public) | `libs/data/search/hybrid-search` | **Consume the pure fusion (D6 Option B):** `fuse(candidates,opts)` / `normalize(scores,method)` / `fuseWithBreakdown(...)` — each takes `{id:number, textScore?, vecScore?}[]`; `normalize` ∈ `min_max\|L2\|z_score`; both normalize-BEFORE-combine and degrade to a single signal when a channel is absent (never errors). Also exports the `SearchBackend` interface, `SqliteSearchBackend`, and `search(backend,query,opts)` — **NOT** used under Option B (that path needs a `GraphBackend`). The registry implements `SearchBackend` over its own FTS5 (`textScore` via BM25 `MATCH`) + `@adhd/sox-vector-store` `knn` (`vecScore`), keyed on the `version_id` surrogate, and calls `fuse()`. | none of its own (pure TS); pulls `@adhd/sox-graph-store` + `@adhd/sox-vector-store` + `@adhd/sox-embedding-provider` transitively |
| `@adhd/sox-graph-store` | 0.1.0 (public) | `libs/data/graph/graph-store` | **Transitive only** — a hard dep of `@adhd/sox-hybrid-search`, so it must be PUBLISHED for hybrid-search to resolve. Under **Option B its runtime is NEVER loaded** (we call only hybrid-search's pure `fuse()`/`normalize()`), so its `drizzle-orm@^0.42.0` pin (which the registry's `drizzle-orm@0.45.2` does not satisfy → a nested install) stays a pure install-tree fact, never a runtime one. | `better-sqlite3`, `drizzle-orm@^0.42.0` (nested; isolated from the registry's 0.45.2) |

**Publish set is now 5.** `@adhd/sox-embedding-provider`, `@adhd/sox-vector-store`,
`@adhd/sox-ingest` are already published `0.1.0` (2026-07-09, sox-ecosystem commit
`5e3351d`). `@adhd/sox-graph-store` and `@adhd/sox-hybrid-search` are **NOT yet
published** and are the outstanding half of the `sox-package-publish` blocker.

**Not consumed by this plan (do not add as deps):**
- `@adhd/sox-analysis@0.1.0` — owns the near-dup/importance/clustering **algorithms**
  (`detectNearDupPairs`, `scoreImportance`, `cluster`) + DB-integrated variants. The
  enrichment pipeline (D-summary) files components via `ingest()` + `knn()` and does
  **not** call analysis, so it is intentionally excluded (pulling it in would drag
  `@adhd/sox-graph-store` along). Adopt only if a future state actually calls it.
- `@adhd/sox-memory-core@0.3.0` (public; npm has only `0.2.1`, a **different**
  architecture) — DB-wiring + determinism glue that imports the above. Not needed:
  we call `ingest()` directly, not memory-core's `extractiveSummary` wrapper. Note
  memory-core@0.3.0 hard-pins `@adhd/sox-ingest@0.1.0`, so while ingest stays
  private a published memory-core is uninstallable (BACKLOG SOX-PKG-001).
- `@adhd/sox-hybrid-search@0.1.0` (FTS5+vector fusion), `@adhd/sox-graph-store@0.1.0`,
  and (newly discovered) `@adhd/sox-task-queue`, `@adhd/sox-blob-store`,
  `@adhd/sox-claim-verification` also exist in the corpus. Hybrid-search was
  evaluated for `component_search` and **deferred** — see decisions.md §D6.

**Supply status (2026-07-08, verified):** only `@adhd/sox-memory-core@0.2.1` is on
npm; the three required packages 404. **`workspace:*` is not consumer-resolvable**
via `file:`/`npm link` (`EUNSUPPORTEDPROTOCOL`), but **`pnpm pack`/`changeset
publish` rewrites `workspace:*` → concrete versions in the tarball** (proven), so a
*published* package is clean. The chosen path is publish-via-changesets (D5). The
`sox-package-publish` human-blocker gates `embedding-substrate`/`enrichment-pipeline`
on those 3 packages resolving (its probe now also imports the `@adhd/sox-ingest/core`
subpath). The former `@adhd/sox-ingest` governance block is **RESOLVED**: sox-ecosystem
commit `f4897aa` (`P1(ingest-public): expose @adhd/sox-ingest public surface`) sets
`private:false` and **deletes** the "PRIVATE — only the memory domain composer may call
this" header invariant, so the `@adhd/agent-store-prompts` consumer is sanctioned. The
`sox-ingest-publishable` human-blocker is now recorded as `verified` (not deleted).
**Re-verify before executing** — this landed via concurrent work during the planning
session, and the `./core` export is still uncommitted in sox-ecosystem's working tree.

## Cross-cutting invariants

- **[inv:no-slug-on-wire]** — no `slug` field in any MCP tool schema, tool output,
  or `guide` text. `slug = toSlug(name)` at the boundary only (D2).
- **[inv:11-tool-hot-path]** — the runtime delegation surface a sub-agent sees stays
  exactly the 11 runtime tools (`agent`, `task`, `result`, `task_list`,
  `task_cancel`, `task_resume`, `session_list`, `session_close`, `session_clear`,
  `usage_query`, `guide`). Authoring/discovery tools are NEVER in the delegation
  set. `agent({name})` keeps required-arg count 1.
- **[inv:enrichment-deterministic]** — `component_define` enrichment (embed →
  use-case links → summary) is deterministic and idempotent; re-defining identical
  content does NOT churn the index (D1). **Determinism rests on content-hash
  gating**, not on a deterministic embedder: identical content short-circuits
  BEFORE any embed/insert/delete, so a real (non-deterministic-per-run) embedder is
  fine. The idempotence proof asserts byte-stable link rows + summary across two
  runs with a store reopen.
- **[inv:declarative-upsert]** — `agent_define`/`component_define` are name-keyed
  create-or-replace upserts: full replace (not merge), version-bumped on change,
  idempotent on no-change (content-hash compare). No create/patch dance, no
  standalone grant/bind/attach verbs (D4).
- **[inv:agent-mcp-back-out]** — agent-mcp{,-base-types} src is touched ONLY per the
  D3 modification manifest; the full pre-existing agent-mcp suite stays green at
  every state; the change set reverts to `baseline-ref` byte-for-byte (dod.8).
- **[inv:additive-registry]** — the enrichment pipeline, embedding, and discovery
  query helpers live in `@adhd/agent-store-prompts` (additive — does not disturb
  Plans 1–5 audits); agent-mcp gets only thin tool wrappers + the bridge + the
  compat shim.

## Caller map (confirm against the real tree in authoring-design)

| symbol / surface | file (real) | role in this plan |
|---|---|---|
| `UseCaseStore.linkComponent / componentsFor` | `packages/agent/agent-store-prompts/src/store/usecase-store.ts` | manual weighted insert TODAY → the enrichment pipeline writes these automatically |
| `ComponentStore.create / list / readType` | `packages/agent/agent-store-prompts/src/store/component-store.ts` | consumed by `component_define` + `component_search` (speaks `slug`) |
| `AgentStore.read / update / list` | `packages/agent/agent-store-prompts/src/store/agent-store.ts` | consumed by `agent_define`/`agent_read` (speaks `slug`) |
| `CompositionStore.attach / resolveComposition` | `packages/agent/agent-store-prompts/src/store/composition-store.ts` | consumed by `agent_define` (junction writes) |
| `compileAgent` + `composed_prompts` cache | Plan 6 (`@adhd/agent-engine-compiler` + agent-mcp runtime sink) | the compiled preview returned by `agent_define`/`agent_compile` |
| `server.ts` tool registry | `entrypoint/agent-mcp/src/server.ts` | registers discovery+authoring tools OUTSIDE the delegation surface |
| `agent-crud.ts` `agentCreate` | `entrypoint/agent-mcp/src/tools/agent-crud.ts` | the `systemPrompt → inline component` compat shim |
| `validation/agent.ts` | `entrypoint/agent-mcp/src/validation/agent.ts` | systemPrompt+components mutual-exclusion |

## The three lanes (SPEC §2)

| lane | tools | in delegation surface? |
|---|---|---|
| runtime (hot path) | the 11 above | **yes** |
| discovery (read) | `component_search`, `component_read`, `component_consumers`, `prompt_types_list`, `tool_list`, `model_list`, `policy_list`, `usecase_list`, `agent_read`, `agent_list`, `agent_compile` | no |
| authoring (write upsert) | `agent_define`, `component_define` | no |

`agent_create`/`agent_update` survive as deprecated compat shims (SPEC §9).

## Initiative state

- Plans 1–6 of this initiative are complete and merged to `main`; `main` carries the
  registry packages (now `@adhd/agent-store-prompts` after the `b7183a3` rename) +
  `@adhd/agent-mcp@2.0.0` registry refactor and is the integration target for plans
  7–9. Plans 7/8/9 are unbuilt.
- The hardening pass is applied across plans 7/8/9: **F-P6-6** (release back-out gate =
  union of guarded `…/src` mutate_set across all initiative plans from
  `plan-index.json`, fail-closed), **F-P6-10** (`test -f <file> &&` prepended to every
  `nx test --testFile=` audit check), **F-P6-13** (publish replaces `@adhd/*` `"*"`
  deps with real versions + a runtime-resolution smoke test), **F-P6-11** (the
  import-script writes the corpus to `~/.adhd/agent-mcp/registry.db`), **BUG-003**
  (`agent_list`/`*_list` default-limit + summary projection), and `component_delete`.
- `main` must not be pushed to `origin` until the LM Studio API key is rotated.

## Environment (verified 2026-07-08)

- **`$SKILL`** = `~/.claude/plugins/cache/sox-subagents/workflow/0.8.25/skills/plan-state-machine/scripts`
  (installed cache; latest is 0.8.25). `state.json.schema_version = 2` is current for
  0.8.25.
- **`.mcp.json`** points the `agent-mcp` server at the built artifact
  `dist/entrypoint/agent-mcp/src/index.js` (the old
  `/Users/nix/dev/node/adhd-agent-registry/…` worktree no longer exists — only `main`
  and `.claude/worktrees/impl-ephemeral` are live worktrees).
- **agent-mcp** source lives at `entrypoint/agent-mcp/`; `node_modules/@adhd/*` are
  symlinked to their dist builds; `~/.adhd/agent-mcp/agents.db` is the registry
  server's default store; the live MCP-stdio test harness is
  `docs/plan/agent-registry/demo/live-test-mcp.mjs`.
