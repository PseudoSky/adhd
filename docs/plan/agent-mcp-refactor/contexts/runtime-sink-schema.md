# runtime-sink-schema — composed_prompts cache + experiment_assignments + sessions.composed_prompt_id

**Phase:** schema · **Kind:** work · **Depends on:** refactor-design · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/composed-prompt-schema.test.ts`

See `contexts/_shared.md` for definitions, invariants, and reference patterns.

---

## Goal

The agent-mcp runtime sink (`db/schema.ts`) gains the cache tables and FK the
compiler integration needs. After this state: a `composed_prompts` table
(`[def:composed-prompt]`), an `experiment_assignments` table, and a
`sessions.composed_prompt_id` FK column exist, with a generated drizzle migration;
a `ComposedPromptStore` round-trips a composed-prompt row through a REAL on-disk DB
proven by REOPEN (`[inv:reopen-proves-cache]`).

## Semantic Distillation

- **Primitive:** ADD `composed_prompts` + `experiment_assignments` tables +
  `sessions.composed_prompt_id` column + `ComposedPromptStore`. Per the ownership
  decision in `decisions.md` (question 2).
- **Delta spec** (`DATA_MODEL.md` Domain 5; mirror the Drizzle table + migration style of `packages/ai/agent-mcp/src/db/schema.ts` — see "Reference patterns" in `_shared.md`):
  - `composed_prompts` — `id` PK, `agent_slug`, `context_hash`, `content` (flat
    prompt), `component_versions` (JSON), `created_at`; unique/index on
    `(agent_slug, context_hash)` for the cache lookup.
  - `experiment_assignments` — `session_id` (FK), `experiment_slug`, `variant`,
    `created_at`.
  - `sessions.composed_prompt_id` — nullable FK → `composed_prompts.id` (nullable
    so the migration is backward-compatible with existing session rows).
  - `ComposedPromptStore` — `upsert(row)`, `findByAgentContext(agentSlug,
    contextHash)`, `read(id)` — mirror the store-class pattern of `store/agent-store.ts` (see "Reference patterns" in `_shared.md`).
  - Test (`composed-prompt-schema.test.ts`): write a composed-prompt row, CLOSE
    the handle, REOPEN from the same file path, deep-equal the read-back row, and
    assert `findByAgentContext` returns it.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [runtime-sink-schema.1] composed_prompts cache table in schema

- [runtime-sink-schema.2] experiment_assignments table in schema
- [runtime-sink-schema.3] sessions.composed_prompt_id FK column in schema
- [runtime-sink-schema.4] a drizzle migration file exists for the new tables/column
- [runtime-sink-schema.5] composed-prompt-store reopen roundtrip test passes (real on-disk DB)
---

## Reservations

```text
read_only:  ["docs/plan/agent-mcp-refactor/decisions.md", "packages/ai/agent-mcp/src/store/session-store.ts"]
mutates:    ["packages/ai/agent-mcp/src/db/schema.ts", "packages/ai/agent-mcp/src/store/composed-prompt-store.ts", "packages/ai/agent-mcp/src/index.ts", "packages/ai/agent-mcp/drizzle", "packages/ai/agent-mcp/src/__tests__/composed-prompt-schema.test.ts"]
```

---

## Commit points

- `feat(agent-mcp): composed_prompts cache + experiment_assignments + sessions.composed_prompt_id schema and ComposedPromptStore`

## Notes for executor

- `db/schema.ts` and `index.ts` are SHARED mutable files (append-only across
  states) — add tables/exports, do not rewrite existing ones.
- Generate the migration with drizzle-kit into `packages/ai/agent-mcp/drizzle/`
  and ensure `db/migrate.ts` runs it (criterion `.4` greps for a `.sql` file).
- `sessions.composed_prompt_id` MUST be nullable — existing session rows have no
  composed prompt; a non-null column would break the migration and every existing
  session test (regression risk for `[dod.3]`).
- The cache lookup key is `(agent_slug, context_hash)` per `decisions.md` — keep
  the hash derivation in ONE place so `compiler-integration` and `session-e2e`
  agree on it.
- Gate on EXIT CODE (`[inv:exit-code-gate]`).
