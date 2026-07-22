# mcp-server-schema — mcp_servers TABLE + McpServerStore

**Phase:** schema · **Kind:** work · **Depends on:** platform-and-binding-schema · **Guard:** `npx --yes nx test agent-tool-registry --testFile=packages/ai/agent-tool-registry/src/__tests__/mcp-server-store.test.ts`

---

## Goal

The `mcp_servers` table exists and `McpServerStore` round-trips an MCP server
registration (transport, provided canonical tool IDs, JSON-Schema config) after
reopen. This is the table the compiler reads to build the `mcpServers` block when
a binding has `requires_mcp = true`. See `[def:mcp-server]`.

---

## Semantic Distillation / Delta Spec

- **Primitive:** ADD `mcp_servers` table + `McpServerStore`. Source:
  `DATA_MODEL.md` Domain 2 "MCP Servers".
- **Delta Spec** (`[ref:drizzle-schema]`, `[ref:store-class]`):
  - `mcp_servers` — `id` text PK (server package identifier), `transport` text
    (`stdio` | `SSE` | `HTTP` — a seeded text value, NOT an enum), `name` text,
    `provided_tool_ids` `text(...,{mode:'json'})` JSON array of canonical tool
    names (logical references to `tools.name`; resolved at compile time —
    `[inv:no-cross-pkg-fk]` extends to JSON arrays, no FK on JSON), `config_schema`
    `text(...,{mode:'json'})` JSON Schema object.
  - `McpServerStore` — `create(server)`, `read(id)`, `list()`. Thin Drizzle
    queries.
  - `mcp-server-store.test.ts` — against a real on-disk DB with migrations
    (`[inv:real-db-tests]`): create a server with a non-trivial JSON
    `config_schema` and a `provided_tool_ids` array, CLOSE the handle, REOPEN
    from the same path (`[inv:reopen-proves-persistence]`), `read(id)`
    deep-equals — proving the JSON columns survive serialization + reopen.

---

## Acceptance criteria

- [mcp-server-schema.1] mcp_servers table with transport
- [mcp-server-schema.2] mcp-server-store test passes

---

## Reservations

```text
read_only:  ["packages/ai/agent-tool-registry/src/store/tool-store.ts"]
mutates:    ["packages/ai/agent-tool-registry/src/db/schema.ts", "packages/ai/agent-tool-registry/src/store/mcp-server-store.ts", "packages/ai/agent-tool-registry/src/index.ts", "packages/ai/agent-tool-registry/src/__tests__/mcp-server-store.test.ts", "packages/ai/agent-tool-registry/drizzle"]
```

---

## Commit points

- `feat(agent-tool-registry): mcp_servers table + McpServerStore`

## Notes for executor

- `provided_tool_ids` is a JSON array of canonical tool NAMES — do NOT add a
  SQLite FK on a JSON column; cross-table tool resolution is a compile-time join
  (`[inv:no-cross-pkg-fk]`). Contributes to structural `[dod.5]`.
- Assert the JSON `config_schema` round-trips as a deep-equal object, not a
  string — this is what proves drizzle's `{mode:'json'}` survives reopen.
