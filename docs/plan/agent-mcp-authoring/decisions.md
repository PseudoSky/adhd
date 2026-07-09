# agent-mcp-authoring — binding design decisions

> Authored by the planner. The `authoring-design` state CONFIRMS these against the
> real tree and records the agent-mcp **modification manifest** (the baseline ref
> is filled at execution time from the actual pre-plan HEAD). Each decision carries
> a `def:` marker the architecture-phase audit greps for. Where a decision is
> genuinely blocked on a Plan-6 detail, the executor records the assumption +
> escalates (planner amendment) — it does not invent registry internals.
>
> **2026-07-08 reconciliation (BACKLOG AMA-001..015).** The original D1/D5 were
> authored against sox-ecosystem `package.json` `sox.concerns` metadata, not source;
> and the whole plan predates the `b7183a3` rename `agent-registry →
> agent-store-prompts`. This revision records the owner decisions D-hash, D-supply,
> D-summary, D-platform and re-targets every path. The registry package is
> **`@adhd/agent-store-prompts`** at **`packages/agent/agent-store-prompts/`**;
> agent-mcp is at **`entrypoint/agent-mcp/`**.

---

## D1. Embedding source — consume `@adhd/sox-embedding-provider` `[def:embedding-source]`

**Decision: consume `@adhd/sox-embedding-provider` for embedding and
`@adhd/sox-vector-store` for vector persistence; build only a thin registry wrapper
+ seed anchors. Use REAL embeddings — there is no deterministic hash provider.**

**D-hash (2026-07-08):** `type:'hash'` was **removed** from
`@adhd/sox-embedding-provider` deliberately. `createEmbeddingProvider`'s
`switch (config.type)` (`index.ts:155`) handles `'fastembed'` | `'remote'` ONLY and its
`default:` branch throws `ResolutionError` ("Unknown embedding provider type",
`index.ts:162`, verified). So:

- **Default the registry embedder to `{ type: 'fastembed', model: 'bge-base-en-v1.5' }`
  → dim 768.** A single `VectorSpace { modelId: 'bge-base-en-v1.5', dim: 768 }`.
  Every `type:'hash'`, `hash-768`, "deterministic hash provider", and two-space
  (hash-768 + bge) reference is deleted from the plan.
- **Determinism / idempotence (`inv:enrichment-deterministic`) rests on content-hash
  gating, NOT on a deterministic embedder.** Identical content short-circuits BEFORE
  any embed/insert/delete (gate on `ingest().contentHash`); the proof asserts
  byte-stable link rows + summary across two runs with a store reopen. A real ONNX
  embedder — whose raw output need not be bit-identical run to run — is therefore
  fine, because unchanged content never reaches it.
- **CI cost is addressed explicitly:** the model id is pinned, and the ONNX binary
  is fetched once into a **`cacheDir` string** — resolved by `createEmbeddingProvider`
  as `config.options.cacheDir` → `SOX_EMBED_CACHE_DIR` → `$XDG_CACHE_HOME/sox/models` →
  `~/.cache/sox/models` (cacheDir resolution at `index.ts:184`). There is **no
  `ModelCache` parameter**: `ModelCache` (`index.ts:125`) / `FileSystemModelCache`
  (`index.ts:144`) are exported but **never referenced by `createEmbeddingProvider` or
  `FastembedProvider`** — now marked `@deprecated` upstream (was SOX-BUG-002), with the
  real `cacheDir` order documented in-source. Do not pass a cache object. Pre-warm
  `SOX_EMBED_CACHE_DIR` in CI.
- **The factory is eager, with a SINGLE warmup budget.** `createFastembedProvider`
  awaits `embedSingle('warmup')` before resolving (the warmup wrapper at
  `index.ts:189-190`), so *constructing* the embedder downloads the model. A **single**
  `SOX_EMBED_WARMUP_TIMEOUT_MS` budget (default **180 000 ms**) now governs both the
  factory's warmup wrapper and the worker-init bound: `warmupTimeoutMs()` is defined
  once and exported from `index.ts:235` and imported by `fastembed.ts`. (The former
  hidden inner 60 s worker-init limit at `fastembed.ts:102-105` was SOX-BUG-001 and is
  **deleted upstream** — there is no longer a lower effective ceiling.) Pre-warm the
  cache; a cold ONNX download must finish inside that single 180 s budget.
- **`isDeterministic` is `false`, by the provider's own contract**
  (`fastembed.ts:135`), and `warmUp()` is an **intentional, spec-pinned no-op**
  (`fastembed.ts:224`; asserted by `embedding-provider.spec.ts:86`) — a contract, not a
  bug. Both reinforce the content-hash gating decision above.
- **Upstream-fix provenance (verify before executing).** The fixes above
  (SOX-BUG-001/002 and the `sox.concerns` doc corrections SOX-DOC-001..004: no phantom
  hash provider / asymmetric role / warmUp cache, `batchSizes` default now documented as
  256) are currently **uncommitted** in sox-ecosystem's working tree. The
  `sox-package-publish` human-blocker must re-verify against the actual published/resolved
  package before `embedding-substrate` starts; prefer symbol names over the line numbers
  cited here, which drift under concurrent upstream development.
- **The memory-server (`~/.memory`) is still NOT coupled.** The sox packages are pure
  TS data libraries, not a runtime MCP server.

**Seam for future upgrade (kept open):** a later plan MAY swap the model (or a
`type:'remote'` provider) behind the same `EmbeddingProvider` interface without
touching `enrichComponent` or the discovery tools.

**What this requires (SPEC §10.1/§10.2):** `@adhd/sox-embedding-provider` +
`@adhd/sox-vector-store` as deps, `enrich/embedding.ts` (async wrapper + cosine),
`enrich/usecase-anchors.ts` (embed each seeded use-case's name+description at seed
time), and the `enrichment-pipeline` write path. `createRegistryEmbedder` is
**async** (`Promise<EmbeddingProvider>`) because the factory is async (AMA-003).

---

## D2. `name↔slug` translation seam `[def:name-slug-seam]`

**Decision: the seam lives in a new agent-mcp tool-boundary module
(`entrypoint/agent-mcp/src/registry/name-slug.ts` + `registry-bridge.ts`); the
registry stores keep `slug` internally unchanged.**

- The wire speaks **`name`**; `slug = name.toLowerCase().replace(/\s+/g, '-')`
  (identity if already slug-form), computed at the tool boundary
  (`[inv:no-slug-on-wire]`).
- The registry stores' public types **legitimately** expose `slug`
  (`PromptComponent.slug`, `ComponentCreateInput.slug`,
  `UseCaseStore.linkComponent(componentSlug, …)`, `componentsFor(useCaseSlug)`,
  `AgentStore.read(slug)`, category slugs — verified in
  `packages/agent/agent-store-prompts/src/store/*.ts`). We do **NOT** refactor the
  stores' slug vocabulary (that would risk Plans 1–5's green audits and is out of
  scope). Instead the **bridge** translates `name → slug` inbound and **strips
  `slug`** (re-keys to `name`) outbound, so no `slug` field appears in any MCP tool
  schema, any tool output, or `guide` text.
- **Proof (dod.4):** a recursive scan of every authoring/discovery tool response
  asserts no `slug` key anywhere; a human "Display Name" resolves to the same row as
  its slug form.

This is a real refactor at the boundary (SPEC §3), not an alias comment — but it is
**additive** to the stores (a new module), preserving the stores byte-for-byte.

---

## D3. agent-mcp modification manifest — the opt-in reversible gate `[def:agent-mcp-modification-manifest]`

**The owner retains the right to back out agent-mcp/agent-base-types. This plan is
the FIRST sanctioned modifier. Every agent-mcp{,-base-types} src file this plan may
touch is enumerated here; nothing outside this list may change.**

```text
baseline-ref: <FILLED AT EXECUTION: the git rev of agent-mcp HEAD immediately
               before the first agent-mcp src commit of this plan — record the
               actual SHA here in the authoring-design state>

# agent-mcp src files this plan is allowed to ADD (new modules — additive):
entrypoint/agent-mcp/src/registry/name-slug.ts
entrypoint/agent-mcp/src/registry/registry-bridge.ts
entrypoint/agent-mcp/src/registry/composition-writer.ts
entrypoint/agent-mcp/src/tools/discovery.ts
entrypoint/agent-mcp/src/tools/authoring.ts

# agent-mcp src files this plan is allowed to MODIFY (registration + compat shim):
entrypoint/agent-mcp/src/server.ts                 # register discovery+authoring tools (NOT in delegation surface)
entrypoint/agent-mcp/src/tools/agent-crud.ts       # agent_create systemPrompt -> inline-component compat shim
entrypoint/agent-mcp/src/validation/agent.ts       # systemPrompt+components mutual-exclusion (VALIDATION_ERROR)
entrypoint/agent-mcp/src/tools/guide.ts            # add authoring section; mark systemPrompt deprecated/optional
entrypoint/agent-mcp/package.json                  # 2.0.0 (already at 2.0.0 on main)
entrypoint/agent-mcp/CHANGELOG.md

# agent-mcp test files this plan ADDS (proofs):
entrypoint/agent-mcp/src/__tests__/name-slug-seam.test.ts
entrypoint/agent-mcp/src/__tests__/discovery-tools.test.ts
entrypoint/agent-mcp/src/__tests__/discovery-bounded-output.test.ts
entrypoint/agent-mcp/src/__tests__/component-define.test.ts
entrypoint/agent-mcp/src/__tests__/agent-define.test.ts
entrypoint/agent-mcp/src/__tests__/systemprompt-compat.test.ts
entrypoint/agent-mcp/src/__tests__/composition-journey-e2e.test.ts
entrypoint/agent-mcp/src/__tests__/authoring-live-e2e.test.ts

# agent-base-types (packages/agent/agent-base-types/src): NONE expected. If a shared
# type is genuinely required, it must be ADDED here by amendment BEFORE the change.
```

**Non-regression guard (runs at every state touching agent-mcp src):**
`npx --yes nx test agent-mcp` — the full pre-existing suite (sessions, tasks, DAG,
HITL, streaming, usage) stays green. **Reversibility:** reverting this plan's commits
restores agent-mcp to `baseline-ref` byte-for-byte; `check_manifest.py` fails if any
agent-mcp src file outside this manifest is changed (dod.8). `check_manifest.py`
guards the prefixes `entrypoint/agent-mcp/src` and `packages/agent/agent-base-types/src`.

> **Most of the new surface lives in `@adhd/agent-store-prompts`** (enrichment
> pipeline, embedding, discovery query helpers) precisely to keep the agent-mcp
> footprint minimal and the back-out small. agent-mcp gets thin tool wrappers + the
> bridge + the compat shim only.

---

## D4. `agent_define` transaction + Plan-6 sequencing `[def:agent-define-transaction]`

- **`agent_define` is a single transactional upsert** across the registry agent +
  composition + tool-grant + policy-attach stores, returning a compiled preview via
  Plan 6's `compileAgent` + `composed_prompts` cache. It is **create-or-replace**
  (full replace of `components`/`tools`/`policy`, not a merge), **version-bumped** on
  a changed resolved composition (content-hash compare), **idempotent** on no-change.
  Grants/binds are declarative **by reference inside the spec** — there is no
  standalone `tool_grant`/`model_bind`/`policy_attach` MCP verb (SPEC §5.2, Decision
  C). The write either fully commits or rolls back; a partial compose must never
  leave the registry inconsistent.
- **Sequencing: AFTER Plan 6 (`agent-mcp-refactor`).** This plan consumes Plan 6's
  registry-backed session-start path (`resolveComposedPrompt` + the `composed_prompts`
  cache keyed by `(agent, context_hash)`) for `agent_define`'s compiled preview and
  for `agent_compile`. `dag.json` declares `depends_on_plans: ["agent-mcp-refactor"]`.
  It **overlaps Plan 7** (corpus import) but does not depend on it.
- **Errors:** `COMPONENT_NOT_FOUND`, `TOOL_NOT_FOUND`, `POLICY_NOT_FOUND`,
  `MODEL_NOT_FOUND` are raised by resolving each referenced name through the
  discovery stores before the transaction commits.

---

## D5. sox-ecosystem dependency + supply `[def:sox-publish]`

**Decision (D-supply): consume `@adhd/sox-embedding-provider`,
`@adhd/sox-vector-store`, and `@adhd/sox-ingest` — a minimal set of exactly 3
packages — and supply them by publishing from sox-ecosystem via pnpm/changesets.**

Rationale + proven supply mechanics (2026-07-08):

- The three packages are the **minimal** set for this plan and are **dependency-free
  leaves** (zero `@adhd/*` deps), so there is no topological publish ordering and no
  transitive publish risk:
  - `@adhd/sox-embedding-provider@0.1.0` (deps: `@huggingface/transformers`, `fastembed`)
  - `@adhd/sox-vector-store@0.1.0` (deps: `@lancedb/lancedb`, `apache-arrow`, `better-sqlite3`, `sqlite-vec`, `synckit`)
  - `@adhd/sox-ingest@0.1.0` — consume the **`/core`** subpath (`node:crypto` only, dependency-free); the root barrel `.` pulls `web-tree-sitter`+`tree-sitter-wasms` via `AstChunker`, which `/core` avoids. Now `private:false` + owner-sanctioned as of commit `f4897aa` (was the ONLY one gated on sign-off; that gate is cleared).
- **`@adhd/sox-analysis` and `@adhd/sox-memory-core` are NOT required** and are
  deliberately excluded (D-summary calls `ingest()` directly; analysis would drag
  `@adhd/sox-graph-store` along). See `_shared.md` and BACKLOG SOX-PKG-001.
- **`pnpm` rewrites `workspace:*` → concrete versions at pack/publish time (PROVEN):**
  `pnpm pack` on `libs/data/analysis/analysis` produced a tarball whose manifest read
  `"@adhd/sox-vector-store": "0.1.0"` — the `workspace:*` strings were gone. So a
  *published* tarball is clean. The `EUNSUPPORTEDPROTOCOL` failure only affects
  consuming the *unpublished source* via `file:`/`npm link`.

**Supply option chosen — Option A (publish via changesets):**
```bash
cd /Users/nix/dev/ai/sox-ecosystem
# @adhd/sox-ingest is already publishable (private:false + invariant removed, commit f4897aa)
pnpm changeset            # for embedding-provider, vector-store, ingest
pnpm changeset version
pnpm publish -r           # (or `changeset publish`) — pnpm rewrites workspace:* in the tarball
```
Then in adhd, add the three as `^0.1.0` deps to `packages/agent/agent-store-prompts/package.json`.

**Rejected options (recorded with reason — do NOT use):**
- **Option B — `npm link`:** REJECTED. `npm` cannot resolve the producers' `workspace:*`
  manifests; `npm install`/`npm link` inside such a package errors
  `EUNSUPPORTEDPROTOCOL: Unsupported URL Type "workspace:"`. Empirically verified.
- **Option C — `file:` path** (e.g. `"file:../../ai/sox-ecosystem/libs/data/embed/embedding-provider"`):
  REJECTED. Top-level `npm install` misleadingly exits 0 (npm symlinks without
  recursing) but the module is never materialised — `require.resolve('@adhd/sox-…')`
  → `MODULE_NOT_FOUND`; `npm ls --all` reports `UNMET DEPENDENCY … workspace:*`.
  (Also the original `file:../sox-ecosystem/…` path was wrong: from
  `/Users/nix/dev/node/adhd`, the correct prefix is `../../ai/sox-ecosystem/`, since
  sox-ecosystem is at `/Users/nix/dev/ai/sox-ecosystem`, not `/Users/nix/dev/node/`.)

**`@adhd/sox-ingest` publishability — RESOLVED (commit `f4897aa`).**
`@adhd/sox-ingest` previously carried `package.json private:true` + a source header
invariant *"PRIVATE — never published to npm; only the memory domain composer may call
this package."* Since this plan has `@adhd/agent-store-prompts` (not the memory domain
composer) calling `ingest()` directly, that was a hard governance block. sox-ecosystem
commit `f4897aa` (`P1(ingest-public): expose @adhd/sox-ingest public surface`) sets
`private:false` and **deletes** the header invariant (verified: `git show HEAD` +
`grep` of `src/` finds it gone), sanctioning the consumer. The `sox-ingest-publishable`
human-blocker is now `verified`. **Honesty caveat:** this landed via concurrent work
*during* this planning session — the package read `private:true` when first inspected —
so re-verify before `enrichment-pipeline` executes. Additionally, the dependency-free
`@adhd/sox-ingest/core` export used by `enrichment-pipeline` is currently **uncommitted**
(untracked `src/core.ts`) in sox-ecosystem's working tree; `sox-package-publish` must
confirm `@adhd/sox-ingest/core` resolves before that state starts.

---

## D6. `component_search` retrieval backend — defer `@adhd/sox-hybrid-search` `[def:component-search-backend]`

**Decision: `component_search` uses raw `@adhd/sox-vector-store` `knn()` joined back
to the registry component row for renderable fields; `@adhd/sox-hybrid-search` is
DEFERRED (BACKLOG), not adopted now.**

Rationale:

- The DoD (`dod.2`) requires only that a semantically-matching component ranks above
  an unrelated one — **pure cosine `knn()` satisfies that**. `knn()` returns bare
  `{ id, score }`, but the registry already owns the component row keyed by that same
  rowid (`ComponentStore`), so a `rowid → row` join yields `name + type + summary +
  score` for the bounded summary projection (`discovery-tools.2` / BUG-003) **without**
  importing hybrid-search or mirroring the corpus into a sox `NodeRecord`/FTS5 schema.
- **Adopting `@adhd/sox-hybrid-search` now costs more than it returns here:** it would
  add exactly ONE extra package to the publish set (`@adhd/sox-graph-store`, since
  hybrid-search deps = embedding-provider + graph-store + vector-store), turning the
  3-package blocker into 4, AND `@adhd/sox-graph-store` pins `drizzle-orm@^0.42.0`
  while `@adhd/agent-store-prompts` is on `drizzle-orm@0.45.2` — a version skew to
  reconcile. Its benefit (an FTS5 keyword channel + `normalize`-before-`fuse`
  ranking over native `NodeRecord` fields) is real but not DoD-required, and would
  require filing components into hybrid-search's own node schema.
- **Deferred, with a written home:** the FTS5 keyword channel is a genuine future
  enhancement for `component_search` and is logged in BACKLOG for a later plan. If a
  future requirement needs keyword+vector fusion, revisit this decision and accept
  the 3→4 publish cost + the drizzle reconciliation.

---

## D-platform. Registry stays `platform:node` (no tag change) `[def:registry-platform]`

`@adhd/agent-store-prompts` is **already `platform:node`**
(`packages/agent/agent-store-prompts/project.json` → `tags: ["layer:ai","platform:node"]`).
The original plan's claim that the package "remains `platform:shared`" was doubly
false (it is not shared, and `sqlite-vec` was said to be an existing dep — it is not).
So **no `project.json` change belongs in any state's reservations.** The native deps
the sox packages bring (`@huggingface/transformers`, `fastembed`, `@lancedb/lancedb`,
`apache-arrow`, `synckit`, `sqlite-vec`) are consistent with the existing
`platform:node` tag — this is a dependency-weight/build-time concern, not a
platform-purity violation. **Rejected alternative (recorded):** isolating the embed
substrate behind its own dedicated package to keep `@adhd/agent-store-prompts` at its
current two deps — rejected for this plan as premature (the substrate is only
consumed here and by Plan 7, both `platform:node`); revisit if a `platform:shared` or
browser consumer ever needs the registry without the ONNX/lancedb weight.

---

## D-repair. Second-pass gate hardening (AMA-016, AMA-017) `[def:gate-hardening]`

Two proxy-evidence defects survived the first repair; both are now closed. No state has
executed (`state.json` untouched), so this is a quality repair, not a migration —
`schema_version` stays 2.

### AMA-016 — `versioning` is no longer a no-op guard state

The 2.0.0 version bump **already landed on `main`** (`entrypoint/agent-mcp/package.json`
is `2.0.0`) and `nx build agent-mcp` is already green, so the old guard
(`npx --yes nx build agent-mcp`) and criterion `versioning.1` (`present "version": "2\.`)
were both green **before the state did any work** — the identical failure mode logged as
`ENV-PLAN-001`, violating "never mark a task complete on proxy evidence." The state's only
real remaining deliverable is `entrypoint/agent-mcp/CHANGELOG.md`, which **does not exist**.
Fix: the `versioning` guard is now compound and RED at plan start —
`npx --yes nx build agent-mcp && test -f …/CHANGELOG.md && grep -qE '^#+ *\[?2\.0\.0' … &&
grep -qi 'systemPrompt' …` (verified exit 1 today). A `versioning.1.tooth` check
(in both `audit_authoring.py` and `criteria.json`) additionally asserts the substantive
**permanent compat-shim promise** the guard does not check. `package.json`/`versioning.1`
are kept — they are a true requirement — but are now flagged proxy-only in their notes.

### AMA-017 — `criteria.json` teeth now discriminate

`embedding-substrate.1/.2/.3`, `enrichment-pipeline.1/.2/.3`, and
`component-define.1/.2` each carried a byte-identical `cmd` (`gap-check` only verifies an
ID exists, not that it discriminates). The real discriminating teeth existed **only** in
`audit_authoring.py` (`*.tooth` / `*.tool` grep checks), producing a declaration/
implementation asymmetry: `run-audit.js` reads `criteria.json`, which lacked them. Fix:
the five teeth (`embedding-substrate.2.tooth`, `embedding-substrate.3.tooth`,
`enrichment-pipeline.2.tooth`, `enrichment-pipeline.3.tooth`, `component-define.2.tool`)
are now declared in `criteria.json` as `present` kinds with the SAME pattern + paths the
`.py` uses, so both runners agree. The shared per-criterion `cmd`s are retained (each
criterion legitimately drives the same test FILE; the tooth is the discriminator), each
now carrying a `note` recording that intent.

**Residual risk (write it down):** the `.tooth` checks are **grep-based** — they assert the
test file *mentions* `reopen`/`idempotent`/`trim`/etc., NOT that its assertions bite. A
vacuous test that names the tokens but asserts nothing passes both the command check and the
grep. **Per repo rule §6.2 the executor MUST prove each behavioural assertion FAILS when the
fix is reverted (negative control) and must not treat a green grep as proof.** This is an
explicit executor instruction in `contexts/embedding-substrate.md` and
`contexts/enrichment-pipeline.md`, not a footnote.
