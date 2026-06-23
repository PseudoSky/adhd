# agent-tool-junction — agent_tools JUNCTION + AgentToolStore (permission levels)

**Phase:** schema · **Kind:** work · **Depends on:** mcp-server-schema · **Guard:** `npx --yes nx test agent-tool-registry --testFile=packages/ai/agent-tool-registry/src/__tests__/agent-tool-store.test.ts`

---

## Goal

The `agent_tools` junction exists and `AgentToolStore` grants a canonical tool to
an agent at a typed permission level (`full` | `read_only` | `restricted`) and
reads it back after reopen. This is the table the compiler joins with
`tool_platform_bindings` to build an agent's per-platform `tools:` header.
Proves `[dod.3]`. See `[def:agent-tool-grant]`, `[inv:no-cross-pkg-fk]`.

---

## Semantic Distillation / Delta Spec

- **Primitive:** ADD `agent_tools` junction + `AgentToolStore`. Source:
  `DATA_MODEL.md` Domain 2 "Agent-Tool Junctions".
- **Delta Spec** (`[ref:drizzle-schema]`, `[ref:store-class]`):
  - `agent_tools` — `agent_slug` text (LOGICAL key into `agent-registry`'s
    `agents` table — NOT a SQLite FK, `[inv:no-cross-pkg-fk]`), `tool_name` text
    `.references(() => tools.name)` (within-package FK is fine), `permission`
    text (`full` | `read_only` | `restricted` — seeded text value, NOT an enum),
    `context_condition` `text(...,{mode:'json'})` nullable (`null` = always).
    PK `(agent_slug, tool_name)`.
  - `AgentToolStore` — `grant(agentSlug, toolName, permission, contextCondition?)`,
    `listForAgent(agentSlug)` → grants at their permission level, `revoke(...)`.
    `grant` MUST persist the `permission` argument verbatim — this is the line the
    `[dod.3]` negative-control breaks (hardcode `full` → read-back wrong).
  - `agent-tool-store.test.ts` — against a real on-disk DB with migrations
    (`[inv:real-db-tests]`): `grant('code-reviewer','file_read','read_only')`,
    CLOSE the handle, REOPEN from the same path
    (`[inv:reopen-proves-persistence]`), `listForAgent('code-reviewer')` returns
    `file_read` at permission `read_only` (NOT `full`).

---

## Acceptance criteria

- [agent-tool-junction.1] agent_tools junction with permission level
- [agent-tool-junction.2] agent-tool-store permission-level test passes

---

## Reservations

```text
read_only:  ["packages/ai/agent-tool-registry/src/store/tool-store.ts"]
mutates:    ["packages/ai/agent-tool-registry/src/db/schema.ts", "packages/ai/agent-tool-registry/src/store/agent-tool-store.ts", "packages/ai/agent-tool-registry/src/index.ts", "packages/ai/agent-tool-registry/src/__tests__/agent-tool-store.test.ts", "packages/ai/agent-tool-registry/drizzle"]
```

---

## Commit points

- `feat(agent-tool-registry): agent_tools junction + AgentToolStore permission levels`

## Notes for executor

- `agent_slug` is a LOGICAL key — do NOT add `.references()` to a table in
  another package; there is no `agents` table in THIS package
  (`[inv:no-cross-pkg-fk]`). Tests use a free-string agent slug.
- Proves `[dod.3]`; contributes to structural `[dod.5]`. Keep `grant`'s
  permission write in one place so the negative-control bites.
