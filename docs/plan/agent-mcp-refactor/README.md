# agent-mcp Refactor — Consume @adhd/agent-compiler + @adhd/agent-registry

Refactors the EXISTING `@adhd/agent-mcp` so it consumes `@adhd/agent-compiler`
and `@adhd/agent-registry` for agent definition + system-prompt resolution,
instead of owning a flat `systemPrompt: string` blob in its `AgentStore`. After
this plan, starting a session resolves the agent's system prompt from compiler
output (cached in a new `composed_prompts` table, keyed by agent + context), the
`agents` table transitions from source-of-truth to a compiled cache, and the
already-shipped `claudecli` tool-permission features are reconciled with the
registry's tool model — all while every existing agent-mcp behavior (sessions,
tasks, DAG, HITL, streaming, usage) stays green.

> **Plan set & ordering.** This is plan 6 of 7 for the Agent Registry initiative
> (source spec: `docs/plan/agent-registry/`). Ordering:
> `agent-registry-schema` → `agent-tool-registry`, `agent-provider`,
> `agent-policy` (parallel) → `agent-compiler` (plan 5) → **`agent-mcp-refactor`
> (this plan)** → `agent-registry-migration` (plan 7, final removal). See
> `docs/plan/plan-index.json`.
>
> **Cross-plan dependency.** This plan DEPENDS ON plan 5 (`agent-compiler`),
> which delivers `compileAgent({ agentSlug, platform, context }) → { content,
> tools, id, componentVersions }` (`docs/plan/agent-registry/USAGE.md` §"Runtime
> Integration via agent-mcp"). `compileAgent` is the contract this plan consumes;
> it is `assumed_baseline` here and must be present (package built + tsconfig
> path) before `compiler-integration` can go green.

## Consumer

An LLM host (or a delegating agent) that starts a session against an agent
through the agent-mcp MCP server, and the agent-mcp maintainer who owns the
runtime sink. Today the host authors a flat `systemPrompt` string per agent and
agent-mcp stores it verbatim as the source of truth. After this plan, the host
defines an agent in the registry, and agent-mcp resolves the system prompt from
the compiler at session start — the host's session-start interface is unchanged;
only where the prompt comes from changes.

## Value delta

- **Before:** an agent's system prompt is an opaque, user-authored
  `AgentDefinition.systemPrompt` blob persisted in `AgentStore`; there is no
  record of which components/versions produced it, no cache, and `claudecli`'s
  `allowedBuiltinTools` / `systemPromptIsAgentSpec` are a parallel tool-permission
  model with no relationship to a registry.
- **After:** starting a session resolves the system prompt from
  `compileAgent(...)` output, caches it in `composed_prompts` (a second start
  with the same agent + context reuses the cached row — no recompile), records
  `sessions.composed_prompt_id` for audit/experiment correlation, and the
  `claudecli` tool-permission features are reconciled with the registry's tool
  model rather than competing with it. The flat-`systemPrompt` authoring path is
  gone; the field, if retained, is a computed compat shim populated from compiler
  output.

## Glossary

> These names are consumer-owned vocabulary for THIS plan (the agent-mcp runtime
> surface and its compiler contract). They appear in DoD outcome text deliberately.

- **systemPrompt** — the flat system-prompt string agent-mcp sends to the LLM as
  the `system` message. The subject of the refactor: it moves from user-authored
  source-of-truth to a value populated from compiler output.
- **compileAgent** — the `@adhd/agent-compiler` entrypoint
  (`compileAgent({ agentSlug, platform, context })`) that returns the composed
  prompt (`.content`), resolved tools (`.tools`), cache id (`.id`), and
  `.componentVersions`. The contract agent-mcp consumes at session start.
- **composed_prompt** — a cached compiler-output row (agent + context hash →
  content + component versions); referenced by `sessions.composed_prompt_id`.

## Execution model

- **Parallel execution:** No — states are a mostly-linear brownfield refactor of
  live agent-mcp code with two audit hold points. `db/schema.ts`, `index.ts`, and
  `validation/agent.ts` are shared mutable files touched in sequence, so
  serialization is required.
- **Implementer:** one `typescript-pro` / `backend-developer`-class executor with
  Nx + better-sqlite3 + Drizzle and the plan-5 `@adhd/agent-compiler` package
  available in the workspace.
- **Review:** `architect-reviewer` reviews `refactor-design` output (the caller
  map + AgentStore removal-vs-cache + cache-flow decisions) before any live code
  changes; the final audit is the acceptance gate.
- **Automatic dispatch:** No — authored by the planner, executed by a separate
  executor agent across sessions.

## Definition of Done

> Behavioral clauses (dod.1–dod.3) are proven by vitest entrypoints that DRIVE the
> REAL agent-mcp session-start path against a REAL on-disk SQLite DB, mocking ONLY
> the LLM provider boundary, and assert persistence/cache by REOPENING the store.
> Every gate keys on the runner's EXIT CODE, never a stdout `grep -q passed`
> (better-sqlite3 can segfault on teardown). Each names a `negative-control:` that
> turns the clause red — perturbing the clause's OWN agent-mcp primitive — if the
> guarantee regresses.

- `[dod.1]` Starting a session against an agent makes agent-mcp send the LLM the
  compiler's composed prompt — not a stored user-authored blob — proven through
  the real agent-mcp session-start path against a real on-disk DB. (behavioral)
  - given: a registry agent exists and `@adhd/agent-compiler`'s `compileAgent` is wired in; an on-disk SQLite DB with migrations applied.
  - when: a consumer starts a session via the agent-mcp `agent` tool (LLM provider boundary mocked).
  - then: the system prompt agent-mcp resolves for that session deep-equals `compileAgent({agentSlug,platform,context}).content`, and `sessions.composed_prompt_id` references the cached row.
  - entrypoint: `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/session-compiler-e2e.test.ts`
  - observable: `session-compiler-e2e.test.ts` exits 0 and its case `session systemPrompt equals compileAgent output` passes — it wires the REAL SessionStore + prompt-resolver + composed-prompt-store against an on-disk SQLite file, starts a session, and the test asserts the resolved system prompt deep-equals the compiler content.
  - negative-control: in `prompt-resolver.ts` replace the `compileAgent` call with a stub returning a different fixed string → the deep-equal in `session-compiler-e2e.test.ts` fails → `npx --yes nx test agent-mcp --testFile=...session-compiler-e2e.test.ts` goes red. (Perturbs THIS clause's own resolver primitive on its own entrypoint.)
  - delivered-by: `refactor-design, runtime-sink-schema, compiler-integration, session-e2e`

- `[dod.2]` Starting a second session for the same agent + context reuses the
  cached composed prompt — the compiler is not re-invoked — proven by reopening
  the DB. (behavioral)
  - given: a session was already started for agent A in context C (one cached `composed_prompts` row).
  - when: a consumer starts a second session for the same agent A + context C.
  - then: `compileAgent` is invoked exactly once across both starts; reopening the DB shows both sessions' `composed_prompt_id` reference the same `composed_prompts` row.
  - entrypoint: `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/cache-reuse.test.ts`
  - observable: vitest exits 0 and case `second session reuses cached composed_prompt without recompile` passes — it counts `compileAgent` invocations (asserts 1 across two starts), reopens the DB from the same file path, and `expect` both `composed_prompt_id` values equal.
  - negative-control: make `prompt-resolver` skip the cache lookup and always call `compileAgent` → the invocation-count assertion in `cache-reuse.test.ts` becomes 2 → `npx --yes nx test agent-mcp --testFile=...cache-reuse.test.ts` goes red. (Perturbs THIS clause's own cache-lookup primitive on its own entrypoint.)
  - delivered-by: `refactor-design, runtime-sink-schema, compiler-integration, session-e2e`

- `[dod.3]` Every existing agent-mcp behavior (sessions, tasks, DAG, HITL,
  streaming, usage) still works after the refactor — the full unit suite passes.
  (behavioral)
  - given: the refactor (schema + resolver + retire + policy-bridge) is applied to live agent-mcp code.
  - when: the maintainer runs the full agent-mcp unit suite.
  - then: vitest exits 0 across the whole suite, with no pre-existing test deleted to force green.
  - entrypoint: `npx --yes nx test agent-mcp`
  - observable: `npx --yes nx test agent-mcp` exits 0 for the entire suite (gate on exit code, never stdout grep — better-sqlite3 can segfault on teardown).
  - negative-control: revert the `compiler-integration` resolver wiring in agent-mcp so `task.ts` reads a now-absent flat systemPrompt → the existing session/task tests throw → `npx --yes nx test agent-mcp` exits non-zero. (Perturbs THIS clause's own integration primitive on its own full-suite entrypoint.)
  - delivered-by: `compiler-integration, agent-store-retire, policy-engine-bridge, session-e2e`

- `[dod.4]` The flat-`systemPrompt` authoring / source-of-truth path is removed:
  `AgentDefinition` no longer requires a user-authored `systemPrompt` string; if
  retained, it is a documented computed compat shim populated from compiler
  output. (structural)
  - Proven by `[agent-store-retire.1]` (grep_absent of the required
    `systemPrompt: z.string()` authoring field in `validation/agent.ts`) and
    `[agent-store-retire.2]` (the compat-shim documentation is present).
  - delivered-by: `refactor-design, agent-store-retire`

- `[dod.5]` The runtime sink schema gains `sessions.composed_prompt_id` (plus the
  `composed_prompts` and `experiment_assignments` tables and a migration), and
  agent-mcp declares a dependency on `@adhd/agent-compiler`. (structural)
  - Proven by `[runtime-sink-schema.1..4]` (tables + FK column + migration file)
    and `[compiler-integration.4..5]` (package.json + tsconfig path).
  - delivered-by: `refactor-design, runtime-sink-schema, compiler-integration`

- `[dod.6]` The already-shipped `claudecli` `allowedBuiltinTools` +
  `systemPromptIsAgentSpec` features are reconciled with the registry
  `AGENT_TOOL` / compiled-tools model rather than left as a competing third
  tool-permission model. (structural)
  - Proven by `[policy-engine-bridge.1..2]` (PolicyEngine reads limits from
    agent-policy templates; claudecli references the compiled-tools/AGENT_TOOL
    model).
  - delivered-by: `refactor-design, policy-engine-bridge`

---

## State graph

`refactor-design` → `runtime-sink-schema` → `compiler-integration` →
`agent-store-retire` → `policy-engine-bridge` → `audit-integration` →
`session-e2e` → `audit-final` → done. See `state-machine.md` and `dag.json`.

## Open design questions handed to `refactor-design`

Resolved (recorded in `decisions.md`) before any live code changes:

1. **AgentStore: remove or thin cache?** SCOPE.md / REFERENCES.md allow either —
   "removed or retained as a thin cache layer that stores compiler output". Decide
   and cite; it constrains `agent-store-retire`.
2. **Who owns `composed_prompts`?** DATA_MODEL.md Domain 5 places the composed-
   prompt cache + `experiment_assignments` + `sessions.composed_prompt_id` in
   agent-mcp's runtime sink, but the registry also defines a `composed_prompts`
   table (Domain 1). Decide whether agent-mcp owns its own runtime cache table or
   references the registry's, and cite.
3. **`systemPrompt` compat-shim policy.** SCOPE.md permits retaining
   `AgentDefinition.systemPrompt` as a computed compat shim. Decide retain-vs-
   replace-with-`composedPromptId`; if retained, it MUST be populated from
   compiler output, never user-authored.
4. **claudecli reconciliation.** RUNTIME_GAPS.md "Relationship to Already-Shipped
   agent-mcp Features" — reconcile `allowedBuiltinTools` /
   `systemPromptIsAgentSpec` with `AGENT_TOOL` + `TOOL_PLATFORM_BINDING` so there
   is no competing third tool-permission model.
