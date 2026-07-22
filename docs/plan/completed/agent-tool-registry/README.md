# Agent Registry — Tool & Platform Registry (@adhd/agent-tool-registry)

Designs and builds `@adhd/agent-tool-registry`: the normalized, database-backed
catalog of canonical tools, the platforms agents deploy to, and the
tool↔platform binding table that maps a single canonical tool name
(`shell_exec`) to its per-platform alias (`Bash` on `claude_code`, `bash` on
`claude_api`). This is the package that lets `@adhd/agent-compiler` build a
target platform's `tools:` header and `mcpServers` block from rows instead of
hardcoded per-platform name tables. Schema details in `DATA_MODEL.md` Domain 2
are a **requirements document**; the tables here mirror them with the topology
decision already taken by the schema plan (see below).

> **Plan set & ordering.** This is plan **2 of 7** for the Agent Registry
> initiative (source spec: `docs/plan/agent-registry/`). Ordering:
> `agent-registry-schema` → **`agent-tool-registry`**, `agent-provider`,
> `agent-policy` (parallel — all three depend on `agent-registry-schema`) →
> `agent-compiler` (depends on all four) → `agent-mcp-refactor` →
> `agent-registry-migration`. See `docs/plan/plan-index.json`.
>
> **Cross-plan dependency.** This plan **depends on `agent-registry-schema`**
> (plan 1). It is a SIBLING DB domain: per the schema plan's architecture
> decision, all registry packages share **one SQLite file with table-name
> prefixes** (`tool_*` here), with **no cross-package SQLite FKs** — the
> `agent_tools.agent_slug` reference to `agent-registry`'s `agents` table is a
> logical key resolved at **compile time** by `@adhd/agent-compiler`, not a
> SQLite foreign key. This package therefore builds and tests standalone against
> its own tables.

## Consumer

A compiler/registry engineer (and, transitively, `@adhd/agent-compiler`, which
joins `tool_platform_bindings` to emit a platform's `tools:` header, and the
migration tool, which resolves each `tools:` token in a `.md` agent's
frontmatter back to a canonical tool via the `claude_code` binding rows). Today
there is no tool catalog — agent `.md` files carry a flat `tools: Read, Write,
Bash` list of **platform-specific** names with no canonical form and no record
of what each tool requires. After this plan they have a relational store they
can `create` / `read` / `resolve` against, with persistence proven by reopening
the DB.

## Value delta

- **Before:** an agent's tools are a comma list of platform-specific names
  (`Read, Write, Bash`) duplicated across 346 `.md` files; there is no canonical
  tool identity, no record of which platform calls it what, no `requires_approval`
  / `is_destructive` metadata, and no way to retarget an agent from `claude_code`
  to `openai` without hand-editing every tool name.
- **After:** a tool is one canonical row (`shell_exec`, type `compute`,
  `is_destructive`) joined to N platform aliases through `tool_platform_bindings`;
  a single `BindingStore.resolve('shell_exec','claude_code')` returns `Bash` and
  survives a process restart (round-trips after reopen); an agent's tool grants
  live in the `agent_tools` junction at a typed permission level, queryable back.

## Execution model

- **Parallel execution:** No — states are a linear schema build with two audit
  hold points. `db/schema.ts` and `index.ts` are shared mutable files written by
  every state in sequence, so serialization is required (no merge protocol).
- **Implementer:** one `backend-developer` / `typescript-pro`-class executor with
  Nx + better-sqlite3 + Drizzle + zod in the environment.
- **Review:** the final audit (`audit-final`) is the acceptance gate, accepted by
  the requesting compiler engineer. `audit-schema` is the mid-plan hold point.
- **Automatic dispatch:** No — authored by the planner, executed by a separate
  executor agent across sessions. Hand off with the Dispatch line.

## Definition of Done

> Behavioral clauses are proven by vitest entrypoints that drive the REAL stores
> against a REAL on-disk SQLite DB and assert persistence by REOPENING the store.
> Each names a `negative-control:` that must turn the clause red if the guarantee
> regresses.

- `[dod.1]` A canonical tool resolves to its platform-specific name through
  `tool_platform_bindings` after the DB is closed and reopened — e.g. canonical
  `shell_exec` resolves to `Bash` on `claude_code`. This is the package's whole
  reason for existing. (behavioral)
  - entrypoint: `npx --yes nx test agent-tool-registry --testFile=packages/ai/agent-tool-registry/src/__tests__/binding-store.test.ts`
  - observable: vitest exits 0 and the `binding-store.test.ts` case "canonical tool resolves to platform alias after reopen" passes — it seeds the binding, CLOSES the better-sqlite3 handle, REOPENS from the same file path, and asserts `BindingStore.resolve('shell_exec','claude_code') === 'Bash'` (and `'claude_api' === 'bash'`).
  - delivered-by: `platform-and-binding-schema, seed-and-roundtrip`
  - negative-control: in `binding-store.test.ts`, have `BindingStore.resolve` ignore the `platform` argument (return the first binding for the tool) → `claude_code` and `claude_api` both return the same alias → `npx --yes nx test agent-tool-registry --testFile=...binding-store.test.ts` goes red.

- `[dod.2]` Seeding the tool catalog and platform bindings is idempotent and
  round-trips after reopen: running `seed()` twice against the same DB yields
  identical row counts, and a seeded canonical tool still resolves to its alias
  after the handle is reopened. (behavioral)
  - entrypoint: `npx --yes nx test agent-tool-registry --testFile=packages/ai/agent-tool-registry/src/__tests__/roundtrip.test.ts`
  - observable: vitest exits 0 and the `roundtrip.test.ts` cases "seed is idempotent on re-run" and "binding round-trips after reopen" pass — after two `seed()` runs the `tools` and `tool_platform_bindings` row counts are equal to a single run, and after reopen a canonical tool resolves to its platform alias.
  - delivered-by: `seed-and-roundtrip`
  - negative-control: in `roundtrip.test.ts`, make `seed()` use plain `INSERT` instead of upsert / `INSERT OR IGNORE` → the second run duplicates rows → `npx --yes nx test agent-tool-registry --testFile=...roundtrip.test.ts` goes red.

- `[dod.3]` An `agent_tools` junction row grants a canonical tool to an agent at
  a typed permission level (`full` | `read_only` | `restricted`) and is queryable
  back through `AgentToolStore` against a real DB after reopen. (behavioral)
  - entrypoint: `npx --yes nx test agent-tool-registry --testFile=packages/ai/agent-tool-registry/src/__tests__/agent-tool-store.test.ts`
  - observable: vitest exits 0 and the `agent-tool-store.test.ts` case "grant is queryable at its permission level after reopen" passes — `AgentToolStore.grant('code-reviewer','file_read','read_only')`, then after reopen `listForAgent('code-reviewer')` returns `file_read` at permission `read_only`.
  - delivered-by: `agent-tool-junction`
  - negative-control: in `agent-tool-store.test.ts`, have `grant` drop the `permission` column (hardcode `full`) → the read-back permission is `full`, not `read_only` → `npx --yes nx test agent-tool-registry --testFile=...agent-tool-store.test.ts` goes red.

- `[dod.4]` `@adhd/agent-tool-registry` is a `platform:node` Nx library,
  registered in `tsconfig.base.json` paths, that builds clean and imports no
  browser code. (structural)
  - Proven by `[scaffold-package.1..5]` and the `[dod.4]` grep checks in the
    audit: `project.json` exists and is tagged `platform:node`, the tsconfig path
    is present, `nx build agent-tool-registry` exits 0, and no
    `react`/`document.`/`window.` import appears in `src/`.
  - delivered-by: `scaffold-package`

- `[dod.5]` The Drizzle schema contains `tools`, `platforms`,
  `tool_platform_bindings`, `mcp_servers`, and `agent_tools` tables with the
  fields `DATA_MODEL.md` Domain 2 requires (canonical-name PK, `requires_approval`
  / `is_destructive` flags, JSON dependency/capability arrays; platform
  `header_format` + `supports_tool_selection`; binding `availability` +
  `requires_mcp` + `invocation_note`; mcp `transport` + JSON config schema;
  junction `permission` level), and `tool_types` is a **seeded text-PK lookup
  table, never a SQL enum**. (structural)
  - Proven by the `[dod.5]` grep checks plus the `present` criteria on
    `db/schema.ts` across the schema states (`[tool-and-type-schema.1..2]`,
    `[platform-and-binding-schema.1..2]`, `[mcp-server-schema.1]`,
    `[agent-tool-junction.1]`), including a `grep_absent` proving no
    `enum('tool_type'...)` exists.
  - delivered-by: `tool-and-type-schema, platform-and-binding-schema, mcp-server-schema, agent-tool-junction`

---

## State graph

`scaffold-package` → `tool-and-type-schema` → `platform-and-binding-schema` →
`mcp-server-schema` → `agent-tool-junction` → `audit-schema` →
`seed-and-roundtrip` → `audit-final` → done. See `state-machine.md` and
`dag.json`.

## Source spec

- Conceptual model: `docs/plan/agent-registry/DATA_MODEL.md` **Domain 2 (Tool
  Registry)**.
- Concrete seed values: `docs/plan/agent-registry/SEED_DATA.md` **§2 (Tool
  Types)**, **§5 (Platforms)**, **§6 (Canonical Tools + Platform Bindings)**.
- Package boundary: `docs/plan/agent-registry/SCOPE.md` row
  `@adhd/agent-tool-registry` → tables `tools, platforms,
  tool_platform_bindings, mcp_servers, agent_tools`.
