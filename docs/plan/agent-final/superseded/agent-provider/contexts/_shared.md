# Shared context — Agent Registry — Provider Registry (@adhd/agent-provider)

> Single source of truth for definitions. Reference entries here from any
> context file instead of restating them.

## Source of truth

- The conceptual model is `docs/plan/agent-registry/DATA_MODEL.md` **Domain 2b
  (Provider Registry)**.
- Concrete seed values (providers, models, model-platform bindings, platforms)
  are in `docs/plan/agent-registry/SEED_DATA.md` §5 (Platforms) and §7 (Models +
  Platform Bindings); provider format rows derive from §5 `header_format`.
- The compile↔runtime boundary + the three tricky native-tool cases are in
  `docs/plan/agent-registry/RUNTIME_GAPS.md` (FEAT-007).
- Dependency direction + package placement: `docs/plan/agent-registry/REFERENCES.md`
  ("New Package: agent-provider", "Collaborator: agent-mcp").
- These are **requirements, not a frozen schema** — the upstream
  `agent-registry-schema` plan already froze the **DB topology** (one shared
  SQLite file, per-package **table-name prefixes**); this package uses the
  `provider_*` prefix in that same file.

## Glossary

- **[def:provider]** — a row in `providers`: a seeded AI API provider
  (`anthropic`, `openai`, `bedrock`, `lmstudio`, `claudecli`) with a text PK,
  transport type (`HTTP` | `stdio`), auth pattern, and base URL / endpoint
  template. The concrete runtime adapter classes live in this package alongside
  the table. (`DATA_MODEL.md` Domain 2b "Providers".)
- **[def:model]** — a row in `models`: a canonical model record independent of any
  provider naming, with a canonical text PK (e.g. `claude_sonnet_4_6`,
  `claude_opus_4_8`), `context_window`, `output_limit`, capability flags (`vision`,
  `prompt_caching`, `extended_thinking`), and a `pricing_tier`. (`DATA_MODEL.md`
  Domain 2b "Models"; `SEED_DATA.md` §7.)
- **[def:model-binding]** — a row in `model_platform_bindings`: one
  `(model, platform)` pair → a provider-specific string `platform_model_id`
  (e.g. `claude-opus-4-8` on `claude_api`, `opus` as the `claude_code` alias, a
  Bedrock ARN). `AGENT.model_hint` resolves through this at compile time.
- **[def:tool-format]** — a row in `provider_tool_formats`: the per-provider tool
  schema *shape* (Anthropic tool def vs OpenAI function vs Bedrock Converse), plus
  whether a given canonical tool is emitted as a **type-tagged server-side** entry
  (Anthropic `web_search`/`code_execution`), a **custom** tool def, or is an
  **unsupported native** that must be gated behind an explicit error.
- **[def:provider-adapter]** — the `ProviderAdapter` interface
  (`stream(messages, tools, model): AsyncIterable<StreamChunk>`) **defined in
  `@adhd/agent-mcp-types`** (to avoid a cycle) and **implemented** in this package.
  agent-mcp receives a `ProviderAdapter` and calls `adapter.stream()`.
- **[def:server-side-tool]** — an Anthropic API tool that **executes on
  Anthropic's servers** and is submitted as a versioned, type-tagged entry
  (`{type:"web_search_20250305", name:"web_search"}`) with **no `input_schema`**.
  The runtime "cheap win" of FEAT-007 is emitting these; no local execution loop
  is needed. (`RUNTIME_GAPS.md` Gap 2.)
- **[def:unsupported-native]** — a provider-native tool this plan does NOT execute:
  OpenAI built-ins (`code_interpreter`) and Anthropic **client-executed** tools
  (`bash`, `text_editor`, `computer`) which would require a local execution loop.
  The emitter must throw an explicit, actionable error for these — never a silent
  no-op. (`RUNTIME_GAPS.md` Gap 1 + Recommended Handoff #2.)
- **[def:store]** — a TypeScript class wrapping Drizzle queries for one table group
  (`ProviderStore`, `ModelStore`, `ToolFormatStore`), mirroring
  `packages/ai/agent-mcp/src/store/*.ts`.

## Cross-cutting invariants

- **[inv:platform-node]** — `@adhd/agent-provider` is `platform:node`. It MUST NOT
  import browser code (`react`, `window`, `document`, CSS). Pure Node + SQLite.
- **[inv:adapter-in-types]** — the `ProviderAdapter` interface is DEFINED in
  `@adhd/agent-mcp-types`, never re-declared in `agent-provider`. The dependency
  direction is `agent-mcp-types ← agent-provider ← agent-mcp`; declaring the
  interface here would invert it. agent-provider only IMPLEMENTS it.
- **[inv:shared-db-prefix]** — tables use the `provider_*` table-name prefix in the
  single shared SQLite file decided by `agent-registry-schema`. No second DB file,
  no `ATTACH DATABASE`.
- **[inv:lookup-not-enum]** — `providers` ids and `platform` ids are seeded
  lookup-table text PKs, never SQL enums — a new provider/platform is a seeded
  row, not a migration.
- **[inv:reopen-proves-persistence]** — every store test proves persistence by
  CLOSING the better-sqlite3 handle and REOPENING from the same file path, then
  asserting the read-back row — never by reading in-memory state. (Project
  CLAUDE.md verification standard #3.)
- **[inv:real-db-tests]** — store tests run against a real on-disk SQLite file (a
  `tmp` path) with real migrations applied — not a mock.
- **[inv:server-side-shape]** — a server-side tool is emitted as a type-tagged
  entry with NO `input_schema`; a custom tool is `{name, description, input_schema}`.
  These two shapes are mutually exclusive and asserted distinctly.
- **[inv:gate-not-noop]** — an unsupported native tool causes the emitter to THROW
  an explicit error naming the tool + provider — never a silent drop. (RUNTIME_GAPS.)

## Reference patterns

- **[ref:drizzle-schema]** — Drizzle table style mirrors
  `packages/ai/agent-mcp/src/db/schema.ts`: `sqliteTable("provider_…", …)`,
  `text().primaryKey()`, `integer({mode:"boolean"})` for flags, `index(...)`,
  `.references(...)`. Reuse it; prefix every table name `provider_`.
- **[ref:store-class]** — store classes mirror
  `packages/ai/agent-mcp/src/store/agent-store.ts`: constructor takes a
  `BetterSQLite3Database`, methods are thin Drizzle queries, errors are typed
  `ToolError`-style codes.
- **[ref:provider-config]** — the existing `ProviderConfig` union in
  `@adhd/agent-mcp-types/src/domain.ts` (`anthropic | openai | lmstudio |
  claudecli`) already generalizes provider config; the adapter implements against
  it. The existing `ToolDefinition` (`{name, description, inputSchema}`) is the
  custom-tool shape the emitter branches away from for server-side tools.
- **[ref:runtime-gap]** — `packages/ai/agent-mcp/src/providers/anthropic.ts`
  `toAnthropicTools()` is the concrete gap: it maps every tool to
  `{name, description, input_schema}` and never emits a `{type:…}` server-side
  entry. The emitter in `runtime-tool-forwarding` is the strategic replacement
  (delivered standalone here; wired into anthropic.ts by plan 6).

## Notes for every executor

- Run migrations before any store call: follow `agent-mcp/src/db/migrate.ts` and
  generate migrations with drizzle-kit into `packages/ai/agent-provider/drizzle/`.
- Keep `src/index.ts` the single public barrel; export each new store + schema
  table + the adapter + the emitter as it is added (every state mutates `index.ts`).
- `better-sqlite3` under vitest can segfault on teardown: gate on the runner's
  EXIT CODE, never on stdout `grep -q passed` (project memory
  `feedback_plan_execution_pitfalls`).
- `tsconfig.base.json` is a shared mutable file touched by every registry plan's
  scaffold; add ONLY the `@adhd/agent-provider` line.
