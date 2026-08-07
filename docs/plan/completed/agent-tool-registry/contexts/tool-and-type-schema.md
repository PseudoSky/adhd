# tool-and-type-schema — tool_types LOOKUP + tools TABLE + ToolStore

**Phase:** schema · **Kind:** work · **Depends on:** scaffold-package · **Guard:** `npx --yes nx test agent-tool-registry --testFile=packages/ai/agent-tool-registry/src/__tests__/tool-store.test.ts`

---

## Goal

The `tool_types` seeded lookup table and the `tools` table exist, and a
`ToolStore` can create and read a canonical tool back from a real on-disk DB
after reopen. `tool_types` is a **text-PK lookup table, never a SQL enum**
(`[inv:lookup-not-enum]`). See `[def:tool]`, `[def:tool-type]`.

---

## Semantic Distillation / Delta Spec

- **Primitive:** ADD `tool_types` + `tools` tables and `ToolStore`. Source:
  `DATA_MODEL.md` Domain 2 "Tools"; `SEED_DATA.md` §2 (the 8 tool types).
- **Delta Spec** (`[ref:drizzle-schema]`, `[ref:store-class]`):
  - `tool_types` — `sqliteTable("tool_types", ...)`: `slug` text PK
    (`io`/`compute`/`network`/`memory`/`ui`/`meta`/`lsp`/`notebook` are seeded
    rows, NOT enum members), `description` text. NO `enum(...)` anywhere — the
    audit `grep_absent`s `enum('tool_type'...)` (`[inv:lookup-not-enum]`).
  - `tools` — `name` text PK (canonical: `file_read`, `shell_exec`, `web_fetch`,
    …), `type` text `.references(() => toolTypes.slug)` (within-package FK),
    `description` text, integer `version` default 1 (`[inv:version-retained]`),
    `requires_approval` + `is_destructive` boolean flags
    (`integer(...,{mode:'boolean'})`), `dependency_tool_ids`
    `text(...,{mode:'json'})` JSON array, `capabilities`
    `text(...,{mode:'json'})` JSON array.
  - `ToolStore` — `create(tool)`, `read(name)`, `list()`. Thin Drizzle queries.
  - `tool-store.test.ts` — against a real on-disk SQLite tmp file with migrations
    applied (`[inv:real-db-tests]`): create a tool, CLOSE the handle, REOPEN from
    the same path, `read('shell_exec')` deep-equals the written row including the
    JSON `capabilities` array and the boolean flags
    (`[inv:reopen-proves-persistence]`).

---

## Acceptance criteria

- [tool-and-type-schema.1] tool_types lookup table (text PK, not enum)
- [tool-and-type-schema.2] tools table
- [tool-and-type-schema.3] tool-store test passes

---

## Reservations

```text
read_only:  ["packages/ai/agent-tool-registry/src/db/client.ts"]
mutates:    ["packages/ai/agent-tool-registry/src/db/schema.ts", "packages/ai/agent-tool-registry/src/store/tool-store.ts", "packages/ai/agent-tool-registry/src/index.ts", "packages/ai/agent-tool-registry/src/__tests__/tool-store.test.ts", "packages/ai/agent-tool-registry/drizzle"]
```

---

## Commit points

- `feat(agent-tool-registry): tool_types lookup + tools table + ToolStore`

## Notes for executor

- Generate the drizzle migration into `drizzle/` after editing `schema.ts`;
  `migrate.ts` must apply it before any store call.
- Contributes to structural `[dod.5]` (the `tools` + `tool_types` portion) and is
  read by every later state's tests.
- `tool_types` MUST be a `sqliteTable`, never a drizzle enum or SQL `CHECK ... IN`
  enum — the `grep_absent` in the audit bites if you reach for an enum.
