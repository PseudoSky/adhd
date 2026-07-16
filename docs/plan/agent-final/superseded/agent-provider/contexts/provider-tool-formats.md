# provider-tool-formats — PROVIDER_TOOL_FORMATS TABLE + STORE

**Phase:** schema · **Kind:** work · **Depends on:** model-platform-bindings · **Guard:** `npx --yes nx test agent-provider --testFile=packages/ai/agent-provider/src/__tests__/tool-format-store.test.ts`

---

## Goal

The `provider_tool_formats` table exists and `ToolFormatStore` captures the
per-provider tool schema shape — specifically the **type-tagged server-side**
shape (Anthropic `web_search`) vs the **function-def / custom** shape — so the
runtime emitter (next phase) can branch on it.

---

## Semantic Distillation

- **Primitive:** ADD `provider_tool_formats` + `ToolFormatStore`. See
  `[def:tool-format]`, `[def:server-side-tool]`, `[def:unsupported-native]`.
- **Delta Spec** (`DATA_MODEL.md` Domain 2b "Provider Tool Formats";
  `RUNTIME_GAPS.md` Gap 2):
  - `provider_tool_formats` — `provider_id` (FK → `provider_providers.id`),
    `canonical_tool` text (e.g. `web_search`, `shell_exec`), `emit_shape` text
    enum-by-lookup (`custom` | `server_side` | `unsupported`), `type_tag` text
    (nullable — the versioned `type` string for server-side tools, e.g.
    `web_search_20250305`; null for custom), `note` text (nullable — actionable
    message for `unsupported`, e.g. "Anthropic bash requires a local execution
    loop; not supported"). PK `(provider_id, canonical_tool)`.
  - `ToolFormatStore` — `create` / `read` / `getShape(providerId, canonicalTool)`.
  - Tests (`tool-format-store.test.ts`): insert an Anthropic `web_search` row
    (`emit_shape = server_side`, `type_tag = web_search_20250305`) and an
    Anthropic `bash` row (`emit_shape = unsupported`, `note` set); CLOSE + REOPEN;
    assert both read back with the right `emit_shape` and that `type_tag` is
    populated only for the server-side row.

---

## Acceptance criteria

- [provider-tool-formats.1] provider_tool_formats table present in schema
- [provider-tool-formats.2] tool-format store test passes

---

## Reservations

```text
read_only:  ["packages/ai/agent-provider/src/store/provider-store.ts", "packages/ai/agent-provider/src/store/model-store.ts"]
mutates:    ["packages/ai/agent-provider/src/db/schema.ts", "packages/ai/agent-provider/src/store/tool-format-store.ts", "packages/ai/agent-provider/src/index.ts", "packages/ai/agent-provider/src/__tests__/tool-format-store.test.ts", "packages/ai/agent-provider/drizzle"]
```

---

## Commit points

- `feat(agent-provider): provider_tool_formats table and ToolFormatStore`

## Notes for executor

- This table is the DATA half of FEAT-007; the BEHAVIOR (the emitter that reads
  `emit_shape` and produces a type-tagged entry or throws) is the next runtime
  state. Keep `emit_shape`/`type_tag`/`note` exactly as the emitter expects.
- The three `emit_shape` values are a seeded lookup, not a SQL enum
  (`[inv:lookup-not-enum]`).
- Contributes the `provider_tool_formats` half of `[dod.5]`; the emitter that
  consumes it proves `[dod.2]`.
