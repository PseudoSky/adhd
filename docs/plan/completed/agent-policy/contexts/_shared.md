# Shared context — Agent Policy (@adhd/agent-policy)

> Single source of truth for definitions. Reference entries here from any
> context file instead of restating them.

## Source of truth

- The conceptual model is `docs/plan/agent-registry/DATA_MODEL.md` Domain 3
  (Policy Management).
- Seed values: `docs/plan/agent-registry/SEED_DATA.md` §3 (Policy Types), §4
  (Enforcement Mechanisms), §9 (Policy Templates, with real `rules` JSON).
- Behavioral intent: `GOAL.md` "Variable Policy Enforcement" + "Policy
  Inheritance"; integration constraints: `REFERENCES.md` "Plugin Architecture —
  Reuse, Not Replace" and "`PolicyEngine`".
- These are **requirements, not a frozen schema** — the `policy-design` state
  resolves the open inheritance / `EnforcementEvent` / override-merge questions
  and writes `decisions.md`, which every later state treats as binding.

## Glossary

- **[def:policy-type]** — a row in the `policy_types` LOOKUP table with a text PK:
  `permission`, `safety`, `audit`, `rate`, `scope`, `compliance`, `quality`
  (`SEED_DATA.md` §3). New types are added by seeding a row, never a migration.
- **[def:policy-template]** — a reusable rule definition: a row in
  `policy_templates` with `slug`, `type` (FK to `policy_types`), `description`,
  `rules` (structured JSON), `enforcement` (a JSON ARRAY of one or more
  mechanism values — see `[def:enforcement-mechanism]`), integer `version`, and an
  `is_system` flag.
- **[def:enforcement-mechanism]** — one of `runtime`, `hook`, `settings`, `agent`,
  `dispatcher`, `ci`, `convention`, `human` (`SEED_DATA.md` §4). A template can
  carry MORE THAN ONE (e.g. `no-credentials` = `["agent","ci"]`), so `enforcement`
  is stored as a JSON array, never a single column / enum.
- **[def:agent-policy-row]** — one `agent_policy` junction row: `(agent_slug,
  policy_slug, override_config?, is_mandatory, inherited_from?)`. `inherited_from`
  is the taxonomy category slug a policy cascaded from, or null if attached
  directly to the agent. `override_config` is per-agent JSON that customizes the
  template's `rules` (e.g. a specific `max_rework`).
- **[def:inheritance]** — attaching a policy to a taxonomy CATEGORY propagates it
  to every agent in that category, including agents added LATER. The propagation
  strategy (eager fanout vs. lazy resolve) is decided in `decisions.md`; either
  way the resolved row carries `inherited_from` = the category slug.
- **[def:enforcement-plugin]** — an agent-mcp plugin (mirroring
  `@adhd/agent-mcp-budget`) that exports `configSchema` (zod) + a named & default
  `createPlugin`, and whose `install(hooks)` registers an enforcement handler via
  `hooks.registerEnforcement("pre:model_request", ...)` that THROWS an
  `IEnforcementError` when a `rate` limit is crossed (throws propagate — they are
  NOT swallowed like observational `register()` handlers).
- **[def:store]** — a TypeScript class wrapping Drizzle queries for one table
  group (`PolicyTemplateStore`, `AgentPolicyStore`), mirroring
  `packages/ai/agent-mcp/src/store/*.ts`.

## Cross-cutting invariants

- **[inv:platform-node]** — `@adhd/agent-policy` is `platform:node`. It MUST NOT
  import browser code (`react`, `window`, `document`, CSS). Pure Node + SQLite.
- **[inv:lookup-not-enum]** — `policy_types` (and enforcement mechanism values)
  are seeded LOOKUP rows with a text PK, never SQL enums — new values are added by
  seeding, no migration. (`DATA_MODEL.md` Domain 3, "Policy Types".)
- **[inv:enforcement-is-array]** — `policy_templates.enforcement` is a JSON ARRAY;
  a single policy can be enforced by multiple mechanisms simultaneously
  (`SEED_DATA.md` §4). Round-trip tests assert the array survives reopen intact.
- **[inv:reopen-proves-persistence]** — every store test proves persistence by
  CLOSING the better-sqlite3 handle and REOPENING from the same file path, then
  asserting the read-back row — never by reading in-memory state. (Project
  CLAUDE.md verification standard #3.)
- **[inv:enforcement-throws-propagate]** — enforcement handlers registered via
  `registerEnforcement()` THROW on violation and the throw propagates through
  `IHookRegistry.enforce()` (unlike `register()`/`emit()`, which swallow). The
  enforcement test MUST assert the rejection, not a logged warning.
- **[inv:real-registry-not-mock]** — the enforcement test drives the REAL
  `HookRegistry` exported from `@adhd/agent-mcp-types` (which lives there
  precisely so plugin packages can instantiate it without a circular dep), not a
  hand-rolled fake. (`REFERENCES.md` "Plugin Architecture"; CLAUDE.md
  verification standard #1.)
- **[inv:enforcement-event-pre-model-only]** — `@adhd/agent-mcp-types`'s
  `EnforcementEvent` is the single literal `"pre:model_request"`. Any policy whose
  `hook` enforcement needs another point requires extending that type — a
  cross-package amendment captured in `decisions.md`, never silently assumed.

## Reference patterns

- **[ref:drizzle-schema]** — Drizzle table style mirrors
  `packages/ai/agent-mcp/src/db/schema.ts`: `sqliteTable(...)`,
  `text().primaryKey()`, `integer().notNull().default(...)`, `index(...)`,
  `.references(...)`. JSON columns are `text({ mode: "json" })`. Reuse it.
- **[ref:store-class]** — store classes mirror
  `packages/ai/agent-mcp/src/store/agent-store.ts`: constructor takes a
  `BetterSQLite3Database`, methods are thin Drizzle queries, errors are typed
  `ToolError`-style codes.
- **[ref:budget-plugin]** — the enforcement plugin mirrors
  `packages/ai/agent-mcp-budget/src/index.ts` EXACTLY: `export const configSchema
  = z.object({...})`; a `Plugin` class with `install(hooks: IHookRegistry)` that
  registers observational `register(...)` handlers (try/caught) AND one
  `hooks.registerEnforcement("pre:model_request", p => this.enforce(p))` (NO
  try/catch — throws propagate); and `const createPlugin: PluginFactory = ({ db,
  config }) => new Plugin(...)` exported as BOTH `default` and named `createPlugin`.
- **[ref:hook-registry]** — the real `HookRegistry` is exported from
  `@adhd/agent-mcp-types` (`src/registry.ts`). Tests:
  `new HookRegistry(); plugin.install(hooks); await hooks.enforce("pre:model_request", payload)`.

## Notes for every executor

- Run migrations before any store call: follow `agent-mcp/src/db/migrate.ts` and
  generate migrations with drizzle-kit into `packages/ai/agent-policy/drizzle/`.
- Keep `src/index.ts` the single public barrel; export each new store, the schema
  tables, the seed function, and the plugin `createPlugin` as they are added
  (every state mutates `index.ts`).
- `policy_*` table prefix in the shared SQLite file (the topology decided by
  `agent-registry-schema`'s `decisions.md`).
- `better-sqlite3` under vitest can segfault on teardown: gate on the runner's
  EXIT CODE, never on stdout `grep -q passed` (project memory
  `feedback_plan_execution_pitfalls`; CLAUDE.md verification standard #4).
