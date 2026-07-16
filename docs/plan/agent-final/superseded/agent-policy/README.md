# Agent Policy — Types, Templates, Inheritance & Enforcement (@adhd/agent-policy)

Designs and builds `@adhd/agent-policy`: the database-backed policy layer of the
Agent Registry — a `policy_types` lookup, reusable `policy_templates` (each
carrying structured `rules` JSON plus a multi-valued `enforcement` array), the
`agent_policy` junction that attaches policies to agents (with override config,
mandatory flag, and inheritance provenance), category-level inheritance, and an
**agent-mcp enforcement plugin** that reuses the existing `createPlugin` /
`IHookRegistry` contract (mirroring `@adhd/agent-mcp-budget`) so a `rate` policy
throws on violation through the real registry. Schema details in `DATA_MODEL.md`
Domain 3 are a **requirements document, not a final schema** — this plan's first
state is an architecture pass that resolves the eager-vs-lazy inheritance and the
`EnforcementEvent` extension questions before any table is frozen.

> **Plan set & ordering.** This is plan 4 of 7 for the Agent Registry initiative
> (source spec: `docs/plan/agent-registry/`). Ordering:
> `agent-registry-schema` → `agent-tool-registry`, `agent-provider`,
> `agent-policy` (this plan — parallel, all depend on schema) → `agent-compiler`
> (depends on all four) → `agent-mcp-refactor` → `agent-registry-migration`.
> See `docs/plan/plan-index.json`.

## Consumer

A registry/compiler/governance engineer and the agent-mcp runtime. Today
governance is hardcoded: agent-mcp's `PolicyEngine` (`src/engine/policy.ts`)
enforces exactly three invariants (recursion depth, tool-loop limit,
allowedAgents) from env-pinned `PolicyConfig` values, and "policies" otherwise
live as prose scattered across agent `.md` files. After this plan the engineer
has a relational policy store they can `create` templates in, `attach` to agents
and taxonomy categories, and resolve inheritance against — and the runtime gains
a drop-in agent-mcp plugin that enforces a `rate` policy by throwing through the
real `IHookRegistry.enforce("pre:model_request")`, exactly as
`@adhd/agent-mcp-budget` does. Persistence is proven by reopening the DB;
enforcement is proven by driving the real registry, not a mock.

## Value delta

- **Before:** governance is three hardcoded `PolicyEngine` checks plus copy-pasted
  prose ("never commit credentials", "default to NEEDS_WORK", "max 3 reworks") in
  agent definitions. There is no record of which policy applies to which agent,
  no way to attach a policy to a whole taxonomy category, and the only code-level
  enforcement point is the budget plugin's `pre:model_request` hook.
- **After:** a policy is a typed, versioned `policy_templates` row with structured
  `rules` and a multi-value `enforcement` array (e.g. `["agent","ci"]`); it is
  attached to an agent — directly or **inherited from a taxonomy category** — through
  the `agent_policy` junction with `is_mandatory` + `inherited_from`; a new agent
  added to a category automatically inherits the category's mandatory policies;
  and a `rate` policy registered as an agent-mcp plugin enforces its limit by
  throwing through the real hook registry. Every row survives a process restart
  (round-trips after reopen).

## Execution model

- **Parallel execution:** No — states are a linear schema build with two audit
  hold points. The schema file (`db/schema.ts`) and barrel (`index.ts`) are
  shared mutable files written by every state in sequence, so serialization is
  required.
- **Implementer:** one `backend-developer` / `typescript-pro`-class executor with
  Nx + better-sqlite3 + Drizzle + `@adhd/agent-mcp-types` in the environment.
- **Review:** `architect-reviewer` reviews `policy-design` output (the
  eager-vs-lazy inheritance and `EnforcementEvent` decisions) before
  `scaffold-package`; the final audit is the acceptance gate.
- **Automatic dispatch:** No — authored by the planner, executed by a separate
  executor agent across sessions.

## Definition of Done

> Behavioral clauses are proven by vitest entrypoints that drive the REAL stores
> against a REAL on-disk SQLite DB (and, for enforcement, the REAL `HookRegistry`
> from `@adhd/agent-mcp-types`) and assert persistence by REOPENING the store.
> Each names a `negative-control:` that must turn the clause red if the guarantee
> regresses.

- `[dod.1]` A mandatory policy attached to a taxonomy category is inherited by a
  NEW agent added to that category — queryable through `AgentPolicyStore` with
  `inherited_from` set to the category slug — and the inheritance survives a DB
  reopen. This proves GOAL.md "Policy Inheritance". (behavioral)
  - entrypoint: `npx --yes nx test agent-policy --testFile=packages/ai/agent-policy/src/__tests__/inheritance.test.ts`
  - observable: vitest exits 0 and the `inheritance.test.ts` case "new category member inherits the mandatory policy after reopen" passes — it attaches a mandatory policy to a taxonomy category, adds a NEW agent to that category, closes and reopens the DB, then asserts `AgentPolicyStore.listForAgent(newAgent)` returns the policy with `inherited_from` = the category slug and `is_mandatory` true.
  - delivered-by: `policy-design, scaffold-package, policy-type-and-template-schema, agent-policy-junction, policy-inheritance, seed-and-roundtrip`
  - negative-control: in `inheritance.test.ts` (driven via `scripts/nc_break_inheritance.mjs`), make category resolution skip the fanout/join so `inherited_from` is never populated for the new agent → the reopened-row assertion fails → `npx --yes nx test agent-policy --testFile=...inheritance.test.ts` goes red.

- `[dod.2]` A `rate` policy registered as an agent-mcp plugin enforces its limit
  by THROWING an enforcement error through the real
  `IHookRegistry.enforce("pre:model_request")` when the limit is crossed — driven
  through the actual `HookRegistry` from `@adhd/agent-mcp-types`, not a mock.
  (behavioral)
  - entrypoint: `npx --yes nx test agent-policy --testFile=packages/ai/agent-policy/src/__tests__/enforcement-plugin.test.ts`
  - observable: vitest exits 0 and the `enforcement-plugin.test.ts` case "rate policy throws through real IHookRegistry.enforce(pre:model_request) when the limit is crossed" passes — it constructs a real `HookRegistry`, calls the plugin's `install(hooks)`, emits enough `post:model_response` turns to cross a `maxModelCalls`-style limit, and asserts `await hooks.enforce("pre:model_request", payload)` REJECTS with an `isEnforcementError` error; the call under the limit resolves without throwing.
  - delivered-by: `scaffold-package, policy-type-and-template-schema, enforcement-plugin`
  - negative-control: in the plugin's enforce handler (driven via `scripts/nc_break_enforcement.mjs`), replace the `throw` with a no-op `return` → the over-limit `enforce("pre:model_request")` resolves instead of rejecting → `npx --yes nx test agent-policy --testFile=...enforcement-plugin.test.ts` goes red.

- `[dod.3]` Seeding the policy templates from `SEED_DATA` (including templates
  with MULTI-VALUE `enforcement` JSON arrays such as `no-credentials`
  `["agent","ci"]`) populates a fresh DB, round-trips identically after reopen,
  and a second seed run is idempotent (no duplicate rows, versions unchanged).
  (behavioral)
  - entrypoint: `npx --yes nx test agent-policy --testFile=packages/ai/agent-policy/src/__tests__/roundtrip.test.ts`
  - observable: vitest exits 0 and the `roundtrip.test.ts` cases "policy template round-trips after reopen" (close handle, reopen from the same path, deep-equal the read-back `no-credentials` row including its `enforcement` array) and "seed is idempotent on re-run" (`policy_types` + `policy_templates` row counts and versions identical after a second `seed()`) pass.
  - delivered-by: `policy-type-and-template-schema, seed-and-roundtrip`
  - negative-control: in `seed()` (driven via `scripts/nc_break_seed.mjs`), use plain `INSERT` instead of upsert / `INSERT OR IGNORE` → the second run duplicates rows / bumps versions → `npx --yes nx test agent-policy --testFile=...roundtrip.test.ts` goes red.

- `[dod.4]` `@adhd/agent-policy` is a `platform:node` Nx library, registered in
  `tsconfig.base.json` paths, that builds clean and imports no browser code.
  (structural)
  - Proven by `[scaffold-package.1..5]` in the audit: `project.json` exists and is
    tagged `platform:node`, the tsconfig path is present, `nx build agent-policy`
    exits 0, and no `react`/`document.`/`window.` import appears in `src/`.
  - delivered-by: `policy-design, scaffold-package`

- `[dod.5]` The Drizzle schema contains a `policy_types` LOOKUP table (text PK,
  not a SQL enum — `[inv:lookup-not-enum]`), `policy_templates` (slug, type FK,
  `rules` JSON, multi-valued `enforcement` JSON array, `version`, `is_system`),
  and the `agent_policy` junction (`agent`, `policy`, `override_config`,
  `is_mandatory`, `inherited_from`); the enforcement plugin follows the
  `@adhd/agent-mcp-budget` contract — it exports `configSchema` (zod) and a named
  + default `createPlugin`. (structural)
  - Proven by the `present`/`absent` criteria across the schema and enforcement
    states (`[policy-type-and-template-schema.1..2]`, `[agent-policy-junction.1]`,
    `[enforcement-plugin.1..2]`) and the `dod.5` audit checks (lookup-not-enum
    grep_absent; `configSchema` + `createPlugin` grep_present).
  - delivered-by: `policy-type-and-template-schema, agent-policy-junction, enforcement-plugin`

---

## State graph

`policy-design` → `scaffold-package` → `policy-type-and-template-schema` →
`agent-policy-junction` → `policy-inheritance` → `enforcement-plugin` →
`audit-schema` → `seed-and-roundtrip` → `audit-final` → done. See
`state-machine.md` and `dag.json`.

## Cross-plan dependencies

- **Depends on `agent-registry-schema`** for the `agents` and `taxonomy_categories`
  rows that `agent_policy` attaches to (`agent_slug` FK, `inherited_from` =
  taxonomy category slug). This plan ships its own `policy_*` tables in the shared
  SQLite file under the topology decided by `agent-registry-schema`'s
  `decisions.md` (single file, table-name prefix per package). Until that plan
  lands, store tests stand up the minimal `agents` / `taxonomy_categories` rows
  they need locally; the cross-package FK is enforced once both schemas share the
  file.
- **`agent-compiler`** (plan 5) reads `agent_policy` rows when building the
  permissions block of a compiled header — the eager-vs-lazy inheritance decision
  made in `policy-design` constrains its join.

## Non-goals / known couplings

- **`EnforcementEvent` is `"pre:model_request"`-only.** `@adhd/agent-mcp-types`
  (`src/hooks.ts`) currently types `EnforcementEvent` as the single literal
  `"pre:model_request"`. So the enforcement plugin this plan ships can only
  enforce at `pre:model_request` (a `rate` / `permission` policy on model-call
  budget). Policies whose enforcement mechanism needs a different point —
  `pre:tool_call` (e.g. a `scope`/`read-only` permission policy gating tool use)
  or `post:tool_call` — are **out of scope for runtime `hook` enforcement here**
  and are deferred. **Forcing function:** the deferral is recorded in
  `decisions.md` with an explicit trigger — the first seeded policy whose
  `enforcement` array includes `hook` AND whose `rules.hook_event` is not
  `pre:model_request` (e.g. `sox-audit-trail`'s `TOOL_CALL`) must EITHER be seeded
  as observational-only OR block on a planner-class amendment to extend
  `EnforcementEvent` in `@adhd/agent-mcp-types` (a real cross-package change).
  `policy-design` resolves which, and `policy-design.3` greps `decisions.md` for
  the recorded limitation so the coupling cannot be silently dropped.
- **Rendering rule-component prompts** (the `agent` enforcement mechanism — turning
  a `safety` policy into a `rule` prompt component) is `@adhd/agent-compiler`'s
  job, not this plan's. This plan stores the template + attachment; the compiler
  reads them.
- **Extending agent-mcp's `PolicyEngine`** to read `rate`/`permission` limits from
  the policy store (instead of env-pinned `PolicyConfig`) is `agent-mcp-refactor`
  (plan 6), not here.

## Open design questions handed to `policy-design`

These come from `DATA_MODEL.md` "Cross-Domain Design Decisions (Open)" and must be
resolved (recorded in `decisions.md`) before the schema is frozen:

1. **Eager vs. lazy policy inheritance** — fan out `agent_policy` rows at category
   attachment time (eager: fast queries, write amplification, re-fanout on category
   move) vs. resolve the join at query time (lazy: always accurate, join cost). Pick
   one deterministically and record it; the `policy-inheritance` test asserts whichever
   is chosen, and `inherited_from` is set either way.
2. **`EnforcementEvent` extension** — whether any seeded policy needs an enforcement
   point beyond `pre:model_request`, and if so whether to extend `EnforcementEvent`
   in `@adhd/agent-mcp-types` (planner-class amendment) or seed it observational-only.
   See "Non-goals / known couplings".
3. **Override-config merge semantics** — how a per-agent `override_config` (e.g. a
   specific `max_rework`) composes with the template's `rules` (shallow merge / deep
   merge / replace). Needed before `enforcement-plugin` reads effective limits.
