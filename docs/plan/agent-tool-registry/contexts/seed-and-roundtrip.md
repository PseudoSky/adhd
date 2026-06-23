# seed-and-roundtrip — SEED THE TOOL CATALOG + PROVE END-TO-END ROUND-TRIP

**Phase:** seed · **Kind:** work · **Depends on:** audit-schema · **Guard:** `npx --yes nx test agent-tool-registry --testFile=packages/ai/agent-tool-registry/src/__tests__/roundtrip.test.ts`

---

## Goal

A `seed()` function populates the 8 tool types, the canonical tools, the
platforms, and the platform bindings from `SEED_DATA.md` §2/§5/§6 into a fresh
DB, idempotently. The `roundtrip.test.ts` suite proves the package's reason for
existing: after `seed()` + reopen, a canonical tool name resolves to its correct
per-platform alias; and a second `seed()` is idempotent. Proves `[dod.1]` and
`[dod.2]`.

---

## Semantic Distillation / Delta Spec

- **Primitive:** ADD `src/seed/{tool-types,platforms,tools,bindings,index}.ts` +
  the end-to-end `roundtrip.test.ts`. Source: `SEED_DATA.md` §2 (tool types),
  §5 (platforms), §6 (canonical tools + claude_code / claude_api bindings).
- **Delta Spec:**
  - `seed/tool-types.ts` — array of all 8 types from `SEED_DATA.md` §2: `io`,
    `compute`, `network`, `memory`, `ui`, `meta`, `lsp`, `notebook` (each with
    its description).
  - `seed/platforms.ts` — the platforms from §5: `claude_code`
    (`yaml_frontmatter`, supports selection), `claude_api` (`json_object`),
    `openai` (`json_object`), `bedrock` (`json_object`), `cursor` (`none`, no
    selection), `vscode` (`none`).
  - `seed/tools.ts` — the canonical tools from §6 with their `type`,
    `requires_approval`, `is_destructive`: `file_read`, `file_write`,
    `file_edit`, `file_glob`, `file_grep`, `shell_exec` (compute, destructive,
    requires approval), `web_fetch`, `web_search`, `mcp_list_resources`,
    `mcp_read_resource`, `mcp_wait`, `human_input`, `process_monitor`,
    `code_analysis`, `notebook_edit`. Use REAL §6 values, not placeholders.
  - `seed/bindings.ts` — the §6 `claude_code` bindings (`shell_exec`→`Bash`,
    `file_read`→`Read`, `web_fetch`→`WebFetch`, …) AND the `claude_api` bindings
    (`shell_exec`→`bash`, `file_read`→`read_file`, `human_input`→unavailable, …)
    including `availability` flags.
  - `seed/index.ts` — `seed(db)`: idempotent upsert (`INSERT OR IGNORE` /
    `onConflictDoNothing`) of types → platforms → tools → bindings, in FK order.
    Running twice is a no-op (`[inv:version-retained]` — never bump version on
    re-seed).
  - `roundtrip.test.ts` — named cases against a real on-disk DB
    (`[inv:real-db-tests]`):
    1. `"binding round-trips after reopen"` — `seed()`, CLOSE the handle, REOPEN
       from the same path, `BindingStore.resolve('shell_exec','claude_code') ===
       'Bash'` and `resolve('shell_exec','claude_api') === 'bash'` (proves
       `[dod.1]`, `[inv:reopen-proves-persistence]`).
    2. `"seed is idempotent on re-run"` — count `tools` + `tool_platform_bindings`
       rows after one seed; run `seed()` again; counts identical (proves
       `[dod.2]`).

---

## Acceptance criteria

- [seed-and-roundtrip.1] seed + reopen + idempotency + binding-resolution round-trip suite passes
- [seed-and-roundtrip.2] tool seed lists canonical tools from SEED_DATA
- [seed-and-roundtrip.3] binding resolution round-trip has teeth: corrupting the persisted alias fails the reopen assertion

---

## Reservations

```text
read_only:  ["packages/ai/agent-tool-registry/src/store/tool-store.ts", "packages/ai/agent-tool-registry/src/store/binding-store.ts", "packages/ai/agent-tool-registry/src/db/schema.ts"]
mutates:    ["packages/ai/agent-tool-registry/src/seed/tool-types.ts", "packages/ai/agent-tool-registry/src/seed/platforms.ts", "packages/ai/agent-tool-registry/src/seed/tools.ts", "packages/ai/agent-tool-registry/src/seed/bindings.ts", "packages/ai/agent-tool-registry/src/seed/index.ts", "packages/ai/agent-tool-registry/src/__tests__/roundtrip.test.ts", "packages/ai/agent-tool-registry/src/index.ts"]
```

---

## Commit points

- `feat(agent-tool-registry): seed tool catalog + platform bindings + end-to-end round-trip suite`

## Notes for executor

- The `[seed-and-roundtrip.3]` criterion is a NEGATIVE CONTROL: the audit runs
  `scripts/nc_mutate.mjs` to corrupt a persisted binding alias (e.g. overwrite
  `shell_exec`/`claude_code`'s `platform_tool_name` to a wrong value), confirms
  the round-trip test goes RED, then `nc_restore.mjs` restores it. Author both
  tiny scripts so the teeth are real, per CLAUDE.md verification standard #2. If
  you skip them, the criterion can't fail and proves nothing.
- Pull real values from `SEED_DATA.md` §6 — placeholders defeat `[dod.2]`
  (idempotency of the ACTUAL catalog).
- Export `seed` from `src/index.ts`.
