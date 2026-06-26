# agent-mcp-authoring — binding design decisions

> Authored by the planner. The `authoring-design` state CONFIRMS these against the
> real tree and records the agent-mcp **modification manifest** (the baseline ref
> is filled at execution time from the actual pre-plan HEAD). Each decision carries
> a `def:` marker the architecture-phase audit greps for. Where a decision is
> genuinely blocked on a Plan-6 detail, the executor records the assumption +
> escalates (planner amendment) — it does not invent registry internals.

---

## D1. Embedding source — deterministic in-package embedding `[def:embedding-source]`

**Decision: stand up a deterministic, dependency-free in-package embedding in
`@adhd/agent-registry`; do NOT couple to the memory-server embedding path.**

Rationale (grounded against the real tree):

- **No embedding infrastructure exists anywhere in the workspace today.** There is
  no `sqlite-vec`, `@xenova/transformers`, `fastembed`, `onnxruntime`, or any
  embedding dependency in any `packages/ai/*/package.json` or the root
  `package.json`. `UseCaseStore.linkComponent(componentSlug, useCaseSlug, weight?)`
  is a **manual** weighted insert — there is no auto-resolution. SCOPE.md §"Out of
  Scope" explicitly excluded "Embedding-based similarity search for component
  deduplication" from Plans 1–7, which is exactly why this is net-new (SPEC §10.1).
- **The memory-server is not a local importable workspace path** (`~/.memory`), and
  coupling the registry's enrichment to an external MCP server would (a) make
  `component_define` non-deterministic and network-bound, violating SPEC §5.3's
  "cached/deterministic, idempotent re-define must NOT churn the index," and (b)
  break the `platform:shared` purity rule for `@adhd/agent-registry`.
- A **deterministic lexical/hashing embedding** (e.g. a fixed-dimension hashed
  bag-of-character-n-grams with L2 normalization, or a small deterministic
  token-hash projection) is pure TypeScript, has zero external deps, is identical
  across Node/CI, and makes idempotent re-define trivially provable (same input →
  identical vector → identical use-case links → no index churn). Cosine similarity
  over these vectors is sufficient for the SPEC §7 "rank a matching component above
  an unrelated one" bar — the enrichment only needs *relative* ordering, not SOTA
  semantic recall.

**Seam for future upgrade (kept open, not built):** the embedding function is a
single injectable interface `EmbedFn = (text: string) => Float32Array` with a
deterministic default. A later plan MAY swap in a model-backed embedder behind the
same interface without touching `enrichComponent` or the discovery tools. This is a
generalization seam, not scope here.

**What this requires (SPEC §10.1/§10.2):** `enrich/embedding.ts` (the `EmbedFn` +
deterministic default + cosine), `enrich/usecase-anchors.ts` (embed each seeded
use-case's name+description into an anchor vector at seed time), and the
`enrichment-pipeline` write path.

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
