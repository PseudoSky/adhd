# Shared context — Agent Registry — Prompt Component Schema (@adhd/agent-registry)

> Single source of truth for definitions. Reference entries here from any
> context file instead of restating them.

## Source of truth

- The conceptual model is `docs/plan/agent-registry/DATA_MODEL.md` Domain 1.
- Concrete seed values (prompt types, shared components with real text) are in
  `docs/plan/agent-registry/SEED_DATA.md` §1, §7+.
- These are **requirements, not a frozen schema** — the `design-and-architecture`
  state resolves the open field/topology questions and writes `decisions.md`,
  which every later state treats as binding.

## Glossary

- **[def:component]** — an atomic unit of prompt content: a row in
  `prompt_components` with `slug` (human ref), `type` (FK to `prompt_types`),
  integer `version` (increments on content change; old versions retained for
  audit/rollback), text `content`, and an `is_shared` flag.
- **[def:composition]** — the ordered, filtered set of components attached to an
  agent through the `agent_components` junction, resolved for a given context.
- **[def:junction-row]** — one `agent_components` row: `(agent_slug,
  component_slug, position, version_pin?, context_condition?, is_required)`.
- **[def:context-condition]** — a JSON predicate on the junction row (or a
  `context_rules` row) that decides whether the component is included for a given
  runtime context (e.g. `{"ticket_type":"security"}`). `null` = always include.
- **[def:composed-prompt]** — a `composed_prompts` row capturing the runtime
  output of assembly: `(agent_slug, context_hash, content, component_versions
  JSON)`. The bridge between the design layer and agent-mcp's runtime.
- **[def:store]** — a TypeScript class wrapping Drizzle queries for one table
  group (e.g. `ComponentStore`, `AgentStore`, `CompositionStore`), mirroring the
  pattern in `packages/ai/agent-mcp/src/store/*.ts`.

## Cross-cutting invariants

- **[inv:platform-node]** — `@adhd/agent-registry` is `platform:node`. It MUST
  NOT import browser code (`react`, `window`, `document`, CSS). It is pure
  Node + SQLite.
- **[inv:lookup-not-enum]** — `prompt_types`, tool types, and policy types are
  **seeded lookup tables with a text PK**, never SQL enums — new types are added
  by seeding a row, no migration. (`DATA_MODEL.md` Domain 1, "Prompt Types".)
- **[inv:version-retained]** — bumping a component's `version` never deletes the
  prior version's row; old versions are retained for audit/rollback.
- **[inv:reopen-proves-persistence]** — every store test proves persistence by
  CLOSING the better-sqlite3 handle and REOPENING from the same file path, then
  asserting the read-back row — never by reading in-memory state. (Project
  CLAUDE.md verification standard #3.)
- **[inv:real-db-tests]** — store tests run against a real on-disk SQLite file
  (a `tmp` path), with real migrations applied — not a mock. Use `:memory:` only
  for assertions that do not involve reopen.

## Reference patterns

- **[ref:drizzle-schema]** — Drizzle table style mirrors
  `packages/ai/agent-mcp/src/db/schema.ts`: `sqliteTable(...)`, `text().primaryKey()`,
  `integer().notNull().default(...)`, `index(...)`, `.references(...)`. Reuse it.
- **[ref:store-class]** — store classes mirror
  `packages/ai/agent-mcp/src/store/agent-store.ts`: constructor takes
  `BetterSQLite3Database`, methods are thin Drizzle queries, errors are typed
  `ToolError`-style codes.

## Notes for every executor

- Run migrations before any store call: follow `agent-mcp/src/db/migrate.ts` and
  generate migrations with drizzle-kit into `packages/ai/agent-registry/drizzle/`.
- Keep `src/index.ts` the single public barrel; export each new store + schema
  table as it is added (every state mutates `index.ts`).
- `better-sqlite3` under vitest can segfault on teardown: gate on the runner's
  EXIT CODE, never on stdout `grep -q passed` (project memory
  `feedback_plan_execution_pitfalls`).
