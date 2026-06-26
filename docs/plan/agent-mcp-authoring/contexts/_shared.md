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
