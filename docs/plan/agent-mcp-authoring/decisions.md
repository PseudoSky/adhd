# agent-mcp-authoring — binding design decisions

> Authored by the planner. The `authoring-design` state CONFIRMS these against the
> real tree and records the agent-mcp **modification manifest** (the baseline ref
> is filled at execution time from the actual pre-plan HEAD). Each decision carries
> a `def:` marker the architecture-phase audit greps for. Where a decision is
> genuinely blocked on a Plan-6 detail, the executor records the assumption +
> escalates (planner amendment) — it does not invent registry internals.

---

## D1. Embedding source — consume `@adhd/sox-embedding-provider` `[def:embedding-source]`

**Decision: consume `@adhd/sox-embedding-provider` for embedding and
`@adhd/sox-vector-store` for vector persistence; build only a thin registry
wrapper + seed anchors. Do NOT couple to the memory-server embedding path.**

Rationale (grounded against the real tree):

- **The sox-ecosystem (FEAT-008) now provides what D1 originally proposed
  building from scratch.** `@adhd/sox-embedding-provider` ships a deterministic
  hash provider (SHA-256 seeded Box-Muller, config `type:'hash'`), a real ONNX
  provider (`type:'fastembed'` in a worker thread), and a remote API adapter
  (`type:'remote'`). `@adhd/sox-vector-store` provides sqlite-vec-backed kNN
  cosine search with multi-space isolation. Both are MIT-licensed, tested, and
  built.
- **Publishing prerequisite.** At time of writing (2026-06-29) these packages are
  built but NOT published to npm — see `[def:sox-publish]`. The plan execution
  must either publish them, link them, or reference by local path.
- **The memory-server is still NOT coupled** (`~/.memory`), satisfying the same
  determinism and `platform:shared` constraints. The sox packages are pure TS data
  libraries, not a runtime MCP server.
- **`sqlite-vec` is a transitive dep** through `@adhd/sox-vector-store`. This is
  acceptable — the registry already depends on `better-sqlite3`, and `sqlite-vec`
  is a compatible extension. No `onnxruntime-node` or worker thread runs on the
  main thread unless `type:'fastembed'` is explicitly configured (default stays
  `type:'hash'` during Plan 8 execution).

**Seam for future upgrade (kept open):** the `EmbeddingProvider` interface is
deterministic default. A later plan MAY swap in a model-backed embedder behind the
same interface without touching `enrichComponent` or the discovery tools. This is a
generalization seam, not scope here.

**What this requires (SPEC §10.1/§10.2):** `@adhd/sox-embedding-provider` as a dep,
`@adhd/sox-vector-store` as a dep, `enrich/embedding.ts` (registry wrapper +
cosine), `enrich/usecase-anchors.ts` (embed each seeded use-case's name+description
into an anchor vector at seed time), and the `enrichment-pipeline` write path.

---

## D2. `name↔slug` translation seam `[def:name-slug-seam]`

**Decision: the seam lives in a new agent-mcp tool-boundary module
(`packages/ai/agent-mcp/src/registry/name-slug.ts` + `registry-bridge.ts`); the
registry stores keep `slug` internally unchanged.**

- The wire speaks **`name`**; `slug = name.toLowerCase().replace(/\s+/g, '-')`
  (identity if already slug-form), computed at the tool boundary
  (`[inv:no-slug-on-wire]`).
- The registry stores' public types **legitimately** expose `slug`
  (`PromptComponent.slug`, `ComponentCreateInput.slug`,
  `UseCaseStore.linkComponent(componentSlug, …)`, `componentsFor(useCaseSlug)`,
  `AgentStore.read(slug)`, `TaxonomyStore` category slugs — verified in
  `packages/ai/agent-registry/src/store/*.ts`). We do **NOT** refactor the stores'
  slug vocabulary (that would risk Plans 1–5's green audits and is out of scope).
  Instead the **bridge** translates `name → slug` inbound and **strips `slug`**
  (re-keys to `name`) outbound, so no `slug` field appears in any MCP tool schema,
  any tool output, or `guide` text.
- **Proof (dod.4):** a recursive scan of every authoring/discovery tool response
  asserts no `slug` key anywhere; a human "Display Name" resolves to the same row
  as its slug form.

This is a real refactor at the boundary (SPEC §3), not an alias comment — but it
is **additive** to the stores (a new module), preserving the stores byte-for-byte.

---

## D3. agent-mcp modification manifest — the opt-in reversible gate `[def:agent-mcp-modification-manifest]`

**The owner retains the right to back out agent-mcp/agent-mcp-types. This plan is
the FIRST sanctioned modifier. Every agent-mcp{,-types} src file this plan may
touch is enumerated here; nothing outside this list may change.**

```text
baseline-ref: <FILLED AT EXECUTION: the git rev of agent-mcp HEAD immediately
               before the first agent-mcp src commit of this plan — record the
               actual SHA here in the authoring-design state>

# agent-mcp src files this plan is allowed to ADD (new modules — additive):
packages/ai/agent-mcp/src/registry/name-slug.ts
packages/ai/agent-mcp/src/registry/registry-bridge.ts
packages/ai/agent-mcp/src/registry/composition-writer.ts
packages/ai/agent-mcp/src/tools/discovery.ts
packages/ai/agent-mcp/src/tools/authoring.ts

# agent-mcp src files this plan is allowed to MODIFY (registration + compat shim):
packages/ai/agent-mcp/src/server.ts                 # register discovery+authoring tools (NOT in delegation surface)
packages/ai/agent-mcp/src/tools/agent-crud.ts       # agent_create systemPrompt -> inline-component compat shim
packages/ai/agent-mcp/src/validation/agent.ts       # systemPrompt+components mutual-exclusion (VALIDATION_ERROR)
packages/ai/agent-mcp/src/tools/guide.ts            # add authoring section; mark systemPrompt deprecated/optional
packages/ai/agent-mcp/package.json                  # 2.0.0
packages/ai/agent-mcp/CHANGELOG.md

# agent-mcp test files this plan ADDS (proofs):
packages/ai/agent-mcp/src/__tests__/name-slug-seam.test.ts
packages/ai/agent-mcp/src/__tests__/discovery-tools.test.ts
packages/ai/agent-mcp/src/__tests__/discovery-bounded-output.test.ts
packages/ai/agent-mcp/src/__tests__/component-define.test.ts
packages/ai/agent-mcp/src/__tests__/agent-define.test.ts
packages/ai/agent-mcp/src/__tests__/systemprompt-compat.test.ts
packages/ai/agent-mcp/src/__tests__/composition-journey-e2e.test.ts
packages/ai/agent-mcp/src/__tests__/authoring-live-e2e.test.ts

# agent-mcp-types: NONE expected. If a shared type is genuinely required, it must
# be ADDED here by amendment BEFORE the change, never silently.
```

**Non-regression guard (runs at every state touching agent-mcp src):**
`npx --yes nx test agent-mcp` — the full pre-existing suite (sessions, tasks, DAG,
HITL, streaming, usage) stays green. **Reversibility:** reverting this plan's
commits restores agent-mcp to `baseline-ref` byte-for-byte; `check_manifest.py`
fails if any agent-mcp src file outside this manifest is changed (dod.8).

> **Most of the new surface lives in `@adhd/agent-registry`** (enrichment pipeline,
> embedding, discovery query helpers) precisely to keep the agent-mcp footprint
> minimal and the back-out small. agent-mcp gets thin tool wrappers + the bridge +
> the compat shim only.

---

## D4. `agent_define` transaction + Plan-6 sequencing `[def:agent-define-transaction]`

- **`agent_define` is a single transactional upsert** across the registry agent +
  composition + tool-grant + policy-attach stores, returning a compiled preview via
  Plan 6's `compileAgent` + `composed_prompts` cache. It is **create-or-replace**
  (full replace of `components`/`tools`/`policy`, not a merge), **version-bumped**
  on a changed resolved composition (content-hash compare), **idempotent** on
  no-change. Grants/binds are declarative **by reference inside the spec** — there
  is no standalone `tool_grant`/`model_bind`/`policy_attach` MCP verb (SPEC §5.2,
  Decision C). The write either fully commits or rolls back; a partial compose must
  never leave the registry inconsistent.
- **Sequencing: AFTER Plan 6 (`agent-mcp-refactor`).** This plan consumes Plan 6's
  registry-backed session-start path (`resolveComposedPrompt` + the
  `composed_prompts` cache keyed by `(agent, context_hash)`) for `agent_define`'s
  compiled preview and for `agent_compile`. `dag.json` declares
  `depends_on_plans: ["agent-mcp-refactor"]`. It **overlaps Plan 7** (corpus import)
  but does not depend on it — Plan 8 can be proven against the demo fixture agents;
  Plan 7 backfills the real corpus the discovery lane then searches over.
- **Errors:** `COMPONENT_NOT_FOUND`, `TOOL_NOT_FOUND`, `POLICY_NOT_FOUND`,
  `MODEL_NOT_FOUND` are raised by resolving each referenced name through the
  discovery stores before the transaction commits.

---

## D5. sox-ecosystem dependency (FEAT-008 consumable) `[def:sox-publish]`

**Decision: consume `@adhd/sox-embedding-provider`, `@adhd/sox-vector-store`,
`@adhd/sox-ingest`, and `@adhd/sox-analysis` as workspace dependencies instead
of building embedding/enrichment infrastructure from scratch.**

Rationale:

- The sox-ecosystem's `libs/data/` already ships the exact primitives this plan
  needs (deterministic hash embedding, real fastembed ONNX provider, sqlite-vec
  vector store with kNN/cosine search, extractive summary, near-dup detection).
- Building a redundant in-package implementation would duplicate code and bypass
  the FEAT-008 seam that was intentionally left open for this exact consumption.
- The `@adhd/sox-*` packages are MIT-licensed, non-private (except `@adhd/sox-ingest`),
  built to `dist/` with proper `exports`, and tested.

**Publish/link prerequisite (must be resolved before `embedding-substrate` starts):**

| Package | Published? | Action |
|---------|-----------|--------|
| `@adhd/sox-embedding-provider@0.1.0` | No (404), `private: false` | Publish to npm or link |
| `@adhd/sox-vector-store@0.1.0` | No (404), `private: false` | Publish to npm or link |
| `@adhd/sox-ingest@0.1.0` | No, `private: true` | Either make public + publish, or use local path |
| `@adhd/sox-analysis@0.1.0` | No (404), `private: false` | Publish to npm or link |
| `@adhd/sox-memory-core@0.2.1` | **Yes** (published) | Direct npm dep |
| `@adhd/sox-hybrid-search@0.1.0` | No (404), `private: false` | Optional — for discovery-tools |

**Option A — Publish:**
```bash
cd /Users/nix/dev/ai/sox-ecosystem
# Add changeset entries for affected packages
npx changeset add --type minor    # for each un-published package
npx changeset version
npx changeset publish
```

**Option B — Link (development-only):**
```bash
cd /Users/nix/dev/ai/sox-ecosystem/libs/data/embed/embedding-provider && npm link
cd /Users/nix/dev/ai/sox-ecosystem/libs/data/vectors/vector-store && npm link
cd /Users/nix/dev/ai/sox-ecosystem/libs/data/ingest/ingest && npm link
cd /Users/nix/dev/ai/sox-ecosystem/libs/data/analysis/analysis && npm link
cd /Users/nix/dev/node/adhd && npm link @adhd/sox-embedding-provider @adhd/sox-vector-store @adhd/sox-ingest @adhd/sox-analysis
```

**Option C — Local path (simplest, no npm registry):**
```json
// add to /Users/nix/dev/node/adhd/package.json
"@adhd/sox-embedding-provider": "file:../sox-ecosystem/libs/data/embed/embedding-provider",
"@adhd/sox-vector-store": "file:../sox-ecosystem/libs/data/vectors/vector-store",
"@adhd/sox-ingest": "file:../sox-ecosystem/libs/data/ingest/ingest",
"@adhd/sox-analysis": "file:../sox-ecosystem/libs/data/analysis/analysis"
```

**Note:** `@adhd/sox-ingest` is `private: true` — Option C (local path) works for
development but it cannot be resolved from npm. If publish is the chosen path,
it must first be made `"private": false` and the sox-ecosystem owners must approve
making it public. If local-only suffices (the `extractiveSummary` function is small
and stable), Option C avoids the governance question entirely.
