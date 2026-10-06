# SPEC — D-G: provider resolution, session-held binding, soft swap, ordered fallback

> **Provenance.** Source: architect D-G design. Status: **LOCKED** after review/revise.
> Dispatch: `dispatch-2026-10-04-9c4e`. Locked: 2026-10-04; written: 2026-10-05.
>
> This document is the lock. The interface definitions and acceptance criteria below are
> reproduced verbatim and must not be reworded.

## SUMMARY

one canonical DATA registry (`agent-core-provider` owns `ProviderRegistry{list,get,resolveModelRef,toolFormatLookup}`) + one selection/construction layer (`agent-engine-orchestrator` owns `resolveSelection` + `createProvider`). `AgentDefinition.provider` becomes optional `PartialBinding`; the chain `task ?? session ?? agent ?? global` resolves once into `ProviderSelection` on `ExecutionContext` (every orchestrator deref reads it). Session persists the live binding; `session_update` swaps it; missing selection fails closed `NO_PROVIDER_SELECTED`.

## OWNERSHIP/DEP DIRECTION

`agent-base-types` (types) ← `agent-core-provider` (data registry) ← `agent-engine-orchestrator` (resolveSelection+createProvider) ← `entrypoint/agent-mcp`. `dispatch-base-spec` gains a one-way edge → `agent-base-types`. Module-boundary lint is DEAD (`DEBT-WORKSPACE-LINT-BOUNDARIES-001`) → verify dep direction with `npx nx graph`/`rg`.

## INTERFACES

- `agent-base-types/src/provider-binding.ts` (new): `type ModelSlug = string`; `ProviderType='anthropic'|'openai'|'claudecli'`; `interface PartialBinding { providerType?; modelRef?; models?; timeoutMs?; maxTokens?; temperature?; retryConfig?; env?; baseURL? }`; `interface ProviderSelection extends PartialBinding { providerType; modelRef }` (resolved non-null).
- `domain.ts`: `AgentDefinition.provider?: PartialBinding` (was required); `ExecutionContext.selection: ProviderSelection`; re-export the four types.
- `agent-core-provider/src/registry.ts` (new): `ProviderRegistry{list,get,resolveModelRef(ref,platform):string,toolFormatLookup(providerId,canonicalTool)}` — DATA only, no createProvider/selection. Backed by existing ProviderStore/ModelStore/ToolFormatStore.
- `agent-engine-orchestrator/src/providers/resolve-selection.ts` (new): `resolveSelection({task?,session?,agent?,global?}): ProviderSelection|null` first-wins; null ⇒ `NO_PROVIDER_SELECTED`. `factory.ts createProvider(selection: ProviderSelection, mcpServers?, engineConfig?, engineLogger?)`.
- `agent-store-runtime/src/db/schema.ts`: `sessions` += `providerType TEXT NULL, modelRef TEXT NULL, models TEXT NULL` (models=JSON ModelSlug[]); `SessionStore.updateSelection(sessionId, PartialBinding)`; `create() accepts binding?`.
- `entrypoint/agent-mcp/src/server.ts`: register `session_update {session_id, provider?, model?, models?}` (descriptors ~L433 + handler ~L513 + schema + barrel + docs README/AGENTS/USAGE_GUIDE).

## BEHAVIORAL (F2 edit set)

orchestrator's 5 `agentDefinition.provider` deref sites → `executionContext.selection.*` (advertisement ~292, model ~319-322, timeout ~397, server-side tools ~461, timeout msg ~499) — CONFIRM with `rg -n "agentDefinition\.provider" packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts` (line drift). Add `selection` to `executionContextSchema`; make `agentDefinitionSchema.provider`/`agentDefinitionStoredSchema.provider` optional. `tools/task.ts` + `tools/session.ts` resolve BEFORE constructing ExecutionContext. F3 fail-closed `NO_PROVIDER_SELECTED` (add to error union); 3 silent-claudecli sites to change (dispatch `agent-runner.ts:293` + create payload, factory `default:` throw, orchestrator:291-294). Session writes via `BEGIN IMMEDIATE` (ADR-0001 D3).

## SEGMENTS/OWNERSHIP

(A→B→C→D; E after A; F disjoint (may parallel); G after C+E): A types+registry; B selection; C context+sessions; D host+swap; E dispatch seam; F seed tool-formats; G ordered fallback.

## BINARY ACs

- **D-G(1)** `resolveModelRef('claude_sonnet_4_6','claude_api')==='claude-sonnet-4-6'` + `toolFormatLookup('anthropic','web_search')===server_side` via real seeded store (+ NC: remove platform filter) + snake_case-gone/dag migration AC.
- **D-G(2)** agent with no provider → `session_update` via the LOADED mcp tool → task; assert WIRE string `claude-sonnet-4-6`; NC: drop session tier → `NO_PROVIDER_SELECTED` not claudecli; reopen-persistence AC; global-tier AC.
- **D-G(3)** after `seed()`, `emitToolsForProvider([web_search],'anthropic',lookup)` returns the type-tagged entry; NC: empty tool_formats → `custom` → RED.
- **D-G(4)** `models=['claude_sonnet_4_6','claude_opus_4_8']`, first 429s, retries second, both attempts in task_events; NC remove loop → RED; absence-of-sort AC.

## RESOLVED

ADR-0001 adapter migration belongs to ADR-0001 program (not D-G(1)). ADR-0003 re-emit deferred (D-G edits no `"type"`). session.model = canonical id, wire-string resolved at construction. fail-closed NO_PROVIDER_SELECTED.
