# platform-and-binding-schema — platforms + tool_platform_bindings + BindingStore.resolve

**Phase:** schema · **Kind:** work · **Depends on:** tool-and-type-schema · **Guard:** `npx --yes nx test agent-tool-registry --testFile=packages/ai/agent-tool-registry/src/__tests__/binding-store.test.ts`

---

## Goal

The `platforms` table and the `tool_platform_bindings` table exist, and
`BindingStore.resolve(canonicalTool, platform)` returns the platform-specific
name (canonical `shell_exec` → `Bash` on `claude_code`, `bash` on `claude_api`)
after the DB is closed and reopened. This is the heart of the package and proves
`[dod.1]`. See `[def:platform]`, `[def:binding]`, `[def:resolve]`.

---

## Semantic Distillation / Delta Spec

- **Primitive:** ADD `platforms` + `tool_platform_bindings` tables and
  `BindingStore`. Source: `DATA_MODEL.md` Domain 2 "Platforms" + "Tool-Platform
  Bindings"; `SEED_DATA.md` §5 (platforms) + §6 (bindings).
- **Delta Spec** (`[ref:drizzle-schema]`, `[ref:store-class]`):
  - `platforms` — `id` text PK (`claude_code`, `claude_api`, `openai`,
    `bedrock`, `cursor`, `vscode`), `name` text, `header_format` text
    (`yaml_frontmatter` | `json_object` | `none` — stored as a plain text column,
    a seeded value, NOT an enum), `supports_tool_selection` boolean.
  - `tool_platform_bindings` — `tool_name` text `.references(() => tools.name)`,
    `platform_id` text `.references(() => platforms.id)`, `platform_tool_name`
    text (e.g. `Bash`, `bash_tool`), `availability` text (`available` |
    `restricted` | `unavailable` | `requires_permission`), `requires_mcp`
    boolean, `invocation_note` text nullable (e.g. "requires --chrome"). PK
    `(tool_name, platform_id)`. Both `.references` are within-package FKs;
    `agent_slug` is NOT involved here (`[inv:no-cross-pkg-fk]`).
  - `BindingStore.resolve(canonicalToolName, platformId)` → `platform_tool_name`
    for that `(tool, platform)` pair, or a typed not-found error. MUST filter on
    BOTH `tool_name` AND `platform_id` — this is the line the negative-control
    breaks (`[dod.1]` negative-control: ignoring `platform` returns the wrong
    alias). Also `listForPlatform(platformId)` for the compiler's header build.
  - `binding-store.test.ts` — against a real on-disk DB with migrations
    (`[inv:real-db-tests]`): seed `tools` rows + a `claude_code` and a
    `claude_api` binding for `shell_exec`, CLOSE the handle, REOPEN from the same
    path (`[inv:reopen-proves-persistence]`), assert
    `resolve('shell_exec','claude_code') === 'Bash'` AND
    `resolve('shell_exec','claude_api') === 'bash'` (proves the platform argument
    is honored, not ignored).

---

## Acceptance criteria

- [platform-and-binding-schema.1] platforms table with header_format
- [platform-and-binding-schema.2] tool_platform_bindings table
- [platform-and-binding-schema.3] binding-store resolves canonical to platform name test passes

---

## Reservations

```text
read_only:  ["packages/ai/agent-tool-registry/src/store/tool-store.ts"]
mutates:    ["packages/ai/agent-tool-registry/src/db/schema.ts", "packages/ai/agent-tool-registry/src/store/binding-store.ts", "packages/ai/agent-tool-registry/src/index.ts", "packages/ai/agent-tool-registry/src/__tests__/binding-store.test.ts", "packages/ai/agent-tool-registry/drizzle"]
```

---

## Commit points

- `feat(agent-tool-registry): platforms + tool_platform_bindings + BindingStore.resolve`

## Notes for executor

- `resolve` is the single place the `(tool, platform)` filter happens — keep it
  there so the `[dod.1]` negative-control (ignore the platform arg) bites in one
  place. Proves `[dod.1]`; contributes to structural `[dod.5]`.
- The actual `tools:` HEADER assembly (joining bindings into a platform header) is
  `@adhd/agent-compiler`'s job, NOT this state — here you return the resolved
  per-platform NAME, not a rendered header.
