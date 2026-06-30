# Shared context — agent-mcp Authoring & Discovery (Plan 8)

Definitions, invariants, the caller map, and source-of-truth pointers shared by
every state in this plan. Read this before any state context.

## Source of truth

- **Spec (authoritative):** `docs/plan/agent-registry/SPEC_AGENT_MCP_TOOL_INTERFACE.md`
  — the ratified target surface. Where it disagrees with the api-designer stab
  (`AGENT_MCP_TOOL_INTERFACE.md`), the SPEC wins (its §13).
- **Goal:** `docs/plan/agent-registry/GOAL.md` — every behavioral DoD clause traces
  here (single authorship, runtime composition, discovery, onboarding).
- **Decisions:** `decisions.md` (this plan) — D1 embedding source, D2 name↔slug
  seam, D3 the agent-mcp modification manifest, D4 agent_define transaction.
- **Plan 6 contract (consumed):** `docs/plan/agent-mcp-refactor/` —
  `resolveComposedPrompt`, the `composed_prompts` cache keyed by
  `(agent, context_hash)`, the registry-backed session-start path. `assumed_baseline`.

## sox-ecosystem dependency (FEAT-008 consumable)

This plan consumes the following **published (or locally-linked) sox-ecosystem packages** instead of building embedding infrastructure from scratch:

| Package | Version | Purpose | Required by |
|---------|---------|---------|-------------|
| `@adhd/sox-embedding-provider` | `0.1.0` | Text→vector embedding: `type:'hash'` for deterministic (seeded SHA-256 Box-Muller, dim=N), `type:'fastembed'` for real ONNX (bge-base-en-v1.5 768d), `type:'remote'` for API. Pluggable via `createEmbeddingProvider(config)`. | `embedding-substrate` |
| `@adhd/sox-vector-store` | `0.1.0` | Multi-space vector persistence (sqlite-vec vec0) + kNN/cosine search. `openVectorStore()`, `knn()`, `upsert()`, `reembed()`. | `embedding-substrate`, `enrichment-pipeline`, `discovery-tools` |
| `@adhd/sox-ingest` | `0.1.0` | Private ingest helpers: `extractiveSummary()` (lead-N sentence extraction, zero LLM), content hashing. | `enrichment-pipeline` |
| `@adhd/sox-analysis` | `0.1.0` | Batch analysis: near-dup detection, importance scoring, clustering. Used by `enrichment-pipeline` batch pass. | `enrichment-pipeline` |

**Publish/link status (2026-06-29):** Only `@adhd/sox-memory-core@0.2.1` is published to npm. The data-layer packages above are `"private": false` and built in `dist/` but **never published** (no changeset run). Before this plan executes, one of:
- **Publish**: run `npx changeset publish` from `sox-ecosystem` to ship `@adhd/sox-embedding-provider`, `@adhd/sox-vector-store`, `@adhd/sox-ingest`, `@adhd/sox-analysis` to npm
- **Link**: `npm link` each package into adhd's `node_modules` so workspace resolution works
- **Local path**: add `"@adhd/sox-embedding-provider": "file:../sox-ecosystem/libs/data/embed/embedding-provider"` to adhd's `package.json`

Recorded as `[debt:sox-publish]` — see `docs/plan/agent-mcp-authoring/decisions.md`.

## Cross-cutting invariants

- **[inv:no-slug-on-wire]** — no `slug` field in any MCP tool schema, tool output,
  or `guide` text. `slug = toSlug(name)` at the boundary only (D2).
- **[inv:11-tool-hot-path]** — the runtime delegation surface a sub-agent sees stays
  exactly the 11 runtime tools (`agent`, `task`, `result`, `task_list`,
  `task_cancel`, `task_resume`, `session_list`, `session_close`, `session_clear`,
  `usage_query`, `guide`). Authoring/discovery tools are NEVER in the delegation
  set. `agent({name})` keeps required-arg count 1.
- **[inv:enrichment-deterministic]** — `component_define` enrichment (embed →
  use-case links → summary) is deterministic and cached; re-defining identical
  content does NOT churn the index (D1).
- **[inv:declarative-upsert]** — `agent_define`/`component_define` are name-keyed
  create-or-replace upserts: full replace (not merge), version-bumped on change,
  idempotent on no-change (content-hash compare). No create/patch dance, no
  standalone grant/bind/attach verbs (D4).
- **[inv:agent-mcp-back-out]** — agent-mcp{,-types} src is touched ONLY per the D3
  modification manifest; the full pre-existing agent-mcp suite stays green at every
  state; the change set reverts to `baseline-ref` byte-for-byte (dod.8).
- **[inv:additive-registry]** — the enrichment pipeline, embedding, and discovery
  query helpers live in `@adhd/agent-registry` (additive — does not disturb Plans
  1–5 audits); agent-mcp gets only thin tool wrappers + the bridge + the compat shim.

## Caller map (confirm against the real tree in authoring-design)

| symbol / surface | file (real) | role in this plan |
|---|---|---|
| `UseCaseStore.linkComponent / componentsFor` | `packages/ai/agent-registry/src/store/usecase-store.ts` | manual weighted insert TODAY → the enrichment pipeline writes these automatically |
| `ComponentStore.create / list / readType` | `packages/ai/agent-registry/src/store/component-store.ts` | consumed by `component_define` + `component_search` (speaks `slug`) |
| `AgentStore.read / update / list` | `packages/ai/agent-registry/src/store/agent-store.ts` | consumed by `agent_define`/`agent_read` (speaks `slug`) |
| `CompositionStore.attach / resolveComposition` | `packages/ai/agent-registry/src/store/composition-store.ts` | consumed by `agent_define` (junction writes) |
| `compileAgent` + `composed_prompts` cache | Plan 6 (`@adhd/agent-compiler` + agent-mcp runtime sink) | the compiled preview returned by `agent_define`/`agent_compile` |
| `server.ts` tool registry | `packages/ai/agent-mcp/src/server.ts` | registers discovery+authoring tools OUTSIDE the delegation surface |
| `agent-crud.ts` `agentCreate` | `packages/ai/agent-mcp/src/tools/agent-crud.ts` | the `systemPrompt → inline component` compat shim |
| `validation/agent.ts` | `packages/ai/agent-mcp/src/validation/agent.ts` | systemPrompt+components mutual-exclusion |

## The three lanes (SPEC §2)

| lane | tools | in delegation surface? |
|---|---|---|
| runtime (hot path) | the 11 above | **yes** |
| discovery (read) | `component_search`, `component_read`, `component_consumers`, `prompt_types_list`, `tool_list`, `model_list`, `policy_list`, `usecase_list`, `agent_read`, `agent_list`, `agent_compile` | no |
| authoring (write upsert) | `agent_define`, `component_define` | no |

`agent_create`/`agent_update` survive as deprecated compat shims (SPEC §9).

## Initiative state

- Plans 1–6 of this initiative are complete and merged to `main` at commit `fd99b84`; `main` carries the five registry packages + `@adhd/agent-mcp@2.0.0` registry refactor and is the integration target for plans 7–9. Plans 7/8/9 are unbuilt.
- The hardening pass is applied across plans 7/8/9: **F-P6-6** (release back-out gate = union of guarded `…/src` mutate_set across all initiative plans from `plan-index.json`, fail-closed), **F-P6-10** (`test -f <file> &&` prepended to every `nx test --testFile=` audit check), **F-P6-13** (publish replaces `@adhd/*` `"*"` deps with real versions + a runtime-resolution smoke test), **F-P6-11** (the import-script writes the corpus to `~/.adhd/agent-mcp/registry.db`), **BUG-003** (`agent_list`/`*_list` default-limit + summary projection), and **`component_delete`**.
- `main` must not be pushed to `origin` until the LM Studio API key is rotated.
- Environment: `$SKILL` = `~/.claude/plugins/cache/sox-subagents/workflow/0.8.23/skills/plan-state-machine/scripts` (installed cache); `.mcp.json` points the `agent-mcp` server at the worktree dist `/Users/nix/dev/node/adhd-agent-registry/dist/packages/ai/agent-mcp/src/index.js`; `node_modules/@adhd/*` are symlinked to their dist builds; `~/.adhd/agent-mcp/agents.db` is migrated and is the registry server's default store; the live MCP-stdio test harness is `docs/plan/agent-registry/demo/live-test-mcp.mjs`.
