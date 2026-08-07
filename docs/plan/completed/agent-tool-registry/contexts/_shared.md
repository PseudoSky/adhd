# Shared context — Agent Registry — Tool & Platform Registry (@adhd/agent-tool-registry)

> Single source of truth for definitions. Reference entries here from any
> context file instead of restating them.

## Source of truth

- The conceptual model is `docs/plan/agent-registry/DATA_MODEL.md` **Domain 2**.
- Concrete seed values are in `docs/plan/agent-registry/SEED_DATA.md` **§2** (tool
  types), **§5** (platforms), **§6** (canonical tools + platform bindings).
- These are **requirements, not a frozen schema** — but unlike plan 1, the
  cross-cutting topology decision is already made: see `[inv:shared-db]`.

## Glossary

- **[def:tool]** — a canonical, platform-independent agent capability: a row in
  `tools` keyed by canonical `name` (e.g. `shell_exec`, `file_read`,
  `web_fetch`), with a `type` (FK to `tool_types`), `description`, integer
  `version`, `requires_approval` + `is_destructive` boolean flags, a JSON
  `dependency_tool_ids` array, and a JSON `capabilities` array.
- **[def:tool-type]** — a seeded classification of a tool's function (`io`,
  `compute`, `network`, `memory`, `ui`, `meta`, `lsp`, `notebook`): a row in the
  `tool_types` **lookup table** with a text PK, NOT a SQL enum (`[inv:lookup-not-enum]`).
- **[def:platform]** — a runtime environment an agent deploys to (`claude_code`,
  `claude_api`, `openai`, `bedrock`, `cursor`, `vscode`): a row in `platforms`
  with a `header_format` (`yaml_frontmatter` | `json_object` | `none`) and a
  `supports_tool_selection` flag.
- **[def:binding]** — one `tool_platform_bindings` row: `(tool_name, platform_id)`
  → `platform_tool_name` (e.g. `shell_exec`/`claude_code` → `Bash`), plus
  `availability` (`available` | `restricted` | `unavailable` | `requires_permission`),
  a `requires_mcp` flag, and a nullable `invocation_note`. This is the table the
  compiler joins to build a platform's `tools:` header.
- **[def:mcp-server]** — a row in `mcp_servers`: `transport` (`stdio` | `SSE` |
  `HTTP`), a JSON `provided_tool_ids` array (canonical tools it provides), and a
  JSON-Schema `config_schema`. Read by the compiler to build the `mcpServers`
  block when a binding has `requires_mcp = true`.
- **[def:agent-tool-grant]** — one `agent_tools` junction row: `(agent_slug,
  tool_name)` at a `permission` level (`full` | `read_only` | `restricted`) with
  an optional `context_condition`. `agent_slug` is a LOGICAL key into
  `agent-registry`'s `agents` table, NOT a SQLite FK (`[inv:no-cross-pkg-fk]`).
- **[def:store]** — a TypeScript class wrapping Drizzle queries for one table
  group (`ToolStore`, `BindingStore`, `McpServerStore`, `AgentToolStore`),
  mirroring `packages/ai/agent-mcp/src/store/agent-store.ts`.
- **[def:resolve]** — `BindingStore.resolve(canonicalToolName, platformId)` →
  the `platform_tool_name` for that pair (or a typed not-found error). The single
  primitive the compiler depends on; proves `[dod.1]`.

## Cross-cutting invariants

- **[inv:platform-node]** — `@adhd/agent-tool-registry` is `platform:node`. It
  MUST NOT import browser code (`react`, `window`, `document`, CSS). It is pure
  Node + SQLite.
- **[inv:lookup-not-enum]** — `tool_types` is a **seeded lookup table with a text
  PK**, never a SQL enum — a new tool type is added by seeding a row, no
  migration. (`DATA_MODEL.md` Domain 2, "Tools"; `SEED_DATA.md` §2.) The audit
  proves this with a `grep_absent` on `enum('tool_type'...)`.
- **[inv:shared-db]** — per the `agent-registry-schema` architecture decision, all
  registry packages share **one SQLite file** with **table-name prefixes**
  (`tool_*` for this package's prefixed concept tables where collision is
  possible). This package builds/tests standalone against its own tables.
- **[inv:no-cross-pkg-fk]** — there are **no cross-package SQLite foreign keys**.
  `agent_tools.agent_slug` is a logical reference to `agent-registry`'s `agents`
  table resolved at COMPILE time by `@adhd/agent-compiler`, never a SQLite FK.
  Within-package FKs (binding → tool, binding → platform) ARE real FKs.
- **[inv:reopen-proves-persistence]** — every store test proves persistence by
  CLOSING the better-sqlite3 handle and REOPENING from the same file path, then
  asserting the read-back row — never by reading in-memory state. (Project
  CLAUDE.md verification standard #3.)
- **[inv:real-db-tests]** — store tests run against a real on-disk SQLite file (a
  `tmp` path) with real migrations applied — not a mock. Use `:memory:` only for
  assertions that do not involve reopen.
- **[inv:version-retained]** — bumping a tool's `version` never deletes the prior
  version's row; old versions are retained for audit/rollback.

## Reference patterns

- **[ref:drizzle-schema]** — Drizzle table style mirrors
  `packages/ai/agent-mcp/src/db/schema.ts`: `sqliteTable(...)`,
  `text().primaryKey()`, `integer(...,{mode:'boolean'})` for flags,
  `text(...,{mode:'json'})` for JSON arrays/schemas, `index(...)`,
  `.references(...)` for within-package FKs. Reuse it.
- **[ref:store-class]** — store classes mirror
  `packages/ai/agent-mcp/src/store/agent-store.ts`: constructor takes a
  `BetterSQLite3Database`, methods are thin Drizzle queries, errors are typed
  codes.

## Notes for every executor

- Run migrations before any store call: follow `agent-mcp/src/db/migrate.ts` and
  generate migrations with drizzle-kit into
  `packages/ai/agent-tool-registry/drizzle/`.
- Keep `src/index.ts` the single public barrel; export each new store + schema
  table as it is added (every state mutates `index.ts`).
- `better-sqlite3` under vitest can segfault on teardown: gate on the runner's
  EXIT CODE, never on stdout `grep -q passed` (project memory
  `feedback_plan_execution_pitfalls`).
