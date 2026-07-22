# agent-mcp-refactor — Binding Decisions

> Produced by the `refactor-design` state and reviewed by `architect-reviewer`
> BEFORE any live agent-mcp code change. Every later state treats this as binding.
> Each decision cites its source in `docs/plan/agent-registry/`. The planner has
> recorded the recommended resolution for each open question; the `refactor-design`
> executor confirms or amends (with a planner amendment) — it does not silently
> diverge.
>
> **⚠️ POST-EXECUTION ADDENDA.** Decision 6 (runtime store extraction) was added
> after the original plan states executed. It reflects architectural decisions
> discovered during implementation — specifically the need for public client
> interfaces (`UsageClient`, `RuntimeClient`) and the extraction of
> `@adhd/agent-runtime`. This decision was NOT part of the original plan review.

## Decision 1 — AgentStore: thin cache (not removed)

**Decision:** `AgentStore` is RETAINED as a **thin compiled-agent cache**, not
deleted. `agent_create` / `agent_read` / `agent_update` / `agent_delete` /
`agent_list` keep their tool surface, but the persisted `agents.data` blob is a
compiled-agent cache populated from compiler/registry output, not a user-authored
source of truth.

**Rationale & source:** `REFERENCES.md` "What Changes in agent-mcp" — "The
`AgentStore` is either removed or retained as a thin cache layer that stores
compiler output." Retaining keeps the existing CRUD tools + their tests working
(non-regression, `[dod.3]`) and matches `DATA_MODEL.md` Domain 5 ("the `agents`
table transitions from source-of-truth to a compiled-agent cache"). Removal would
break every `agent_*` tool caller for no benefit during the transition window.

**Constrains:** `agent-store-retire` (resign `AgentStore` → thin cache;
`[def:thin-cache]`).

## Decision 2 — `composed_prompts` lives in agent-mcp's runtime sink

**Decision:** agent-mcp OWNS its own `composed_prompts` cache table (plus
`experiment_assignments` and the `sessions.composed_prompt_id` FK) in its
`agents.db` runtime sink. The cache key is `(agent_slug, context_hash)`; the
context hash is derived once, in `runtime-sink-schema`, and reused by
`compiler-integration` and `session-e2e`.

**Rationale & source:** `DATA_MODEL.md` Domain 5 — "The runtime sink receives
compiled prompts from the compiler... Two tables are added: Composed prompt cache
[and] Experiment assignments. The `sessions` table gains a `composed_prompt_id`
foreign key." The runtime sink is explicitly agent-mcp's domain; the registry's
own `composed_prompts` (Domain 1) is the design-layer audit trail. agent-mcp
references its runtime copy so a session start never has to ATTACH the registry DB
on the hot path.

**Constrains:** `runtime-sink-schema` (the tables/column), `compiler-integration`
(lookup-then-compile flow).

## Decision 3 — `systemPrompt` retained as a computed compat shim

**Decision:** `AgentDefinition.systemPrompt` is RETAINED but RESIGNED from a
required user-authored `z.string()` to a **computed compat shim** populated from
`compileAgent(...).content` at session start. The required `systemPrompt:
z.string()` authoring field is REMOVED from `validation/agent.ts` (made
`.optional()` with a compat note, or replaced by `composedPromptId`); it is never
authored by a user again.

**Rationale & source:** `SCOPE.md` "Flat `systemPrompt` in `AgentDefinition`" —
"The field may be retained as a computed compatibility shim during the transition
window." `REFERENCES.md` — "`AgentDefinition.systemPrompt: string`... is populated
from compiler output rather than user-provided input." Retaining the field (as
computed) keeps the three `tools/task.ts` reads + `anthropic.ts`/`claudecli.ts`
system-message assembly working unchanged (`[dod.3]`), while the `grep_absent` of
the required `z.string()` proves the AUTHORING path is gone (`[dod.4]`).

**Constrains:** `compiler-integration` (populate from `content`),
`agent-store-retire` (remove the required authoring field).

## Decision 4 — claudecli tactical features reconcile onto the compiled-tools model

**Decision:** `claudecli`'s `allowedBuiltinTools` and `systemPromptIsAgentSpec`
are reconciled onto the compiled `composed.tools` / `AGENT_TOOL` model: the
permitted built-in set DERIVES from the compiled tool list rather than being an
independent third permission scheme. `PolicyEngine.check()` reads rate/permission
limits from agent-policy templates, with the existing `PolicyConfig` env-var
defaults as the fallback.

**Rationale & source:** `RUNTIME_GAPS.md` "Relationship to Already-Shipped
agent-mcp Features" — the two claudecli features "are not wasted by the registry —
but the registry's `AGENT_TOOL` + `TOOL_PLATFORM_BINDING` is the strategic
replacement for the *declaration* half, and these should be reconciled (not left
as a competing third tool-permission model)." `REFERENCES.md` "PolicyEngine" —
"these invariants are expressed as `rate` and `permission` policy templates... the
existing `PolicyEngine.check()` interface... can be extended to read limits from
the policy store rather than from hardcoded `PolicyConfig` values." `[inv:no-third-tool-model]`.

**Constrains:** `policy-engine-bridge`.

## Caller map confirmation

The `AgentStore` / `systemPrompt` caller map in `contexts/_shared.md` was confirmed
against the working tree (`packages/ai/agent-mcp/src`). Every caller site is owned
by exactly one state's `mutates` / `read_only` set. `providers/anthropic.ts` and
`server.ts` USAGE_GUIDE are intentionally NOT mutated: anthropic.ts assembles the
system message from already-resolved system messages (it never reads the authoring
blob), and the `server.ts` doc string is non-functional text whose only structural
assertion (`[dod.4]`) targets `validation/agent.ts`. Any needed `server.ts` doc
refresh is additive and tracked in `packages/ai/agent-mcp/BACKLOG.md`, not a
blocker for this plan.

## Cross-plan dependency

This plan consumes `compileAgent` from `@adhd/agent-compiler` (plan 5,
`docs/plan/agent-registry/USAGE.md` §"Runtime Integration via agent-mcp"). It is an
`assumed_baseline`: `compiler-integration` cannot go green until the package is in
the workspace (built + tsconfig path). `[inv:compiler-is-baseline]`.

## Decision 5 — Live server wiring via @adhd/agent-compiler (reversal of prior deferral)

**Decision (2026-06-26, owner call relayed via orchestrator):** The live agent-mcp
MCP server is NOW wired to resolve system prompts via `@adhd/agent-compiler` at
session start.  The seam added in earlier waves (`promptResolver?: PromptResolverDeps`
in `SessionDeps`, `resolveComposedPrompt` in `prompt-resolver.ts`) was dormant —
`index.ts` and both `agentTool` callsites in `server.ts` did NOT pass a
`promptResolver`. This decision reverses the prior deferral and wires the live path.

**Prior deferral:** The original `compiler-integration` state left the server-side
wiring deferred (decisions.md was silent on live wiring; the seam was declared
"dormant" in the opus review of the open gate). The deferral was a pragmatic choice
during the multi-wave execution — the seam existed but the composition root did not
yet pass a live resolver.

**What changed (2026-06-26):**

1. `packages/ai/agent-mcp/src/index.ts` — reads `AGENT_MCP_REGISTRY_DB_PATH`
   env var; when set, opens a read-write SQLite handle to the registry DB and
   constructs a real `promptResolver` (`ComposedPromptStore` + `compileAgent`
   from `@adhd/agent-compiler`).  Passes it to `startServer` via `ServerDeps`.

2. `packages/ai/agent-mcp/src/server.ts` — `ServerDeps` gains
   `promptResolver?: PromptResolverDeps`; both `agentTool` callsites (in-process
   handler + `CallToolRequestSchema` dispatcher) now forward `promptResolver`.

3. `packages/ai/agent-mcp/src/engine/prompt-resolver.ts` — `resolveComposedPrompt`
   return type widened to `ResolveResult | null`.  When `compileAgentFn` throws
   (e.g. `AgentError: AGENT_NOT_FOUND` for a flat/legacy agent), the function
   returns `null` instead of propagating.  `agentTool` then falls back to the
   stored `agentDefinition.systemPrompt` unchanged.

4. `packages/ai/agent-mcp/src/tools/session.ts` — `agentTool` checks `resolved !== null`
   before using the compiled content, preserving the flat-`systemPrompt` compat path.

**Non-regression guarantee:** All 241 pre-existing tests still pass.  When
`AGENT_MCP_REGISTRY_DB_PATH` is absent (the default in CI and in all existing tests),
`promptResolver` is `undefined` and the server runs exactly as before.  The
flat-`systemPrompt` fallback fires within the resolver even when a registry DB IS
wired: a legacy agent with no registry composition gets its stored systemPrompt with
`composed_prompt_id = NULL`.

**Proof:** `packages/ai/agent-mcp/src/__tests__/live-wiring.test.ts` (3 tests):
- `[F-P6-8.registry-agent]` — registry-backed agent gets compiled systemPrompt.
- `[F-P6-8.flat-fallback]` — flat-only agent falls back to stored systemPrompt.
- `[F-P6-8.negative-control]` — WITHOUT promptResolver, registry agent keeps original
  authored prompt (proves the positive test would fail if the wiring were removed).

**Constrains:** `session-e2e` (composed_prompt_id FK proof), `compiler-integration`
(live server wiring now ACTIVE for registry-backed agents).

---

## Decision 6 — Runtime store extraction: public client interfaces for usage queries

**Decision (addendum 2026-06-30).** The runtime stores (`task_usage`, `tasks`, `sessions`,
`messages`, `task_events`) are extracted into a new `@adhd/agent-runtime` package at
`packages/shared/agent-runtime/` (`layer:data`, `platform:shared`). This package exports:

| Export | Responsibility |
|---|---|
| `RuntimeClient` | Session/task lifecycle: create, read, list, cancel |
| `UsageClient` | Token-usage queries: per-task, per-session, per-agent, rolling 24h window |
| `schema` | Drizzle table definitions for the runtime DB |
| `migrations` | Drizzle migration files |

**Dependency graph:**

```
@adhd/agent-mcp          → @adhd/agent-runtime (thin MCP transport)
@adhd/agent-mcp-budget   → @adhd/agent-runtime (UsageClient, no raw SQL)
@adhd/agent-compiler     → @adhd/agent-runtime (reads composed_prompts cache)
@adhd/agent-registry     — no dependency on agent-runtime
```

**What moves from `@adhd/agent-mcp/src/` into the new package:**

```
  store/
    agent-store.ts       → stays in agent-mcp (runtime cache, Plan 6 Decision 1)
    session-store.ts     → agent-runtime session-store.ts
    task-store.ts        → agent-runtime task-store.ts
  db/
    schema.ts            → agent-runtime schema.ts (agents table stays in agent-mcp)
  plugins/
    usage-plugin.ts      → agent-runtime usage-client.ts (UsageClient class)
```

**What stays in `@adhd/agent-mcp`:**
- MCP tool handlers (`server.ts`, `tools/`)
- Orchestrator and policy engine (delegated to by tools)
- Provider implementations (delegated to by orchestrator)
- `agents` table (runtime cache, per Plan 6 Decision 1)

**Non-goal (deferred):** Moving provider implementations into `@adhd/agent-provider` and
making agent-mcp a pure MCP shell. That extraction is a larger refactor gated on the
FK removal in `agent-registry-schema/decisions.md` Decision 1 §5.

**Constrains:** `runtime-client-publish` (the extraction state), `budget-plugin-migration`
(switch from raw SQL to UsageClient).
