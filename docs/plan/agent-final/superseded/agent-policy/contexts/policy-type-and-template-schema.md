# policy-type-and-template-schema — POLICY_TYPES LOOKUP + POLICY_TEMPLATES + PolicyTemplateStore

**Phase:** schema · **Kind:** work · **Depends on:** scaffold-package · **Guard:** `npx --yes nx test agent-policy --testFile=packages/ai/agent-policy/src/__tests__/policy-template-store.test.ts`

---

## Goal

The `policy_types` lookup table and the `policy_templates` table exist, and
`PolicyTemplateStore` can create + read a template whose `enforcement` is a
MULTI-VALUE JSON array — and that template round-trips identically after the DB is
closed and reopened. This is the policy library's foundation.

---

## Semantic Distillation

- **Primitive:** ADD `policy_types` + `policy_templates` tables + `PolicyTemplateStore`.
  See `[def:policy-type]`, `[def:policy-template]`, `[def:enforcement-mechanism]`,
  `[inv:lookup-not-enum]`, `[inv:enforcement-is-array]`.
- **Delta Spec** (`DATA_MODEL.md` Domain 3 "Policy Types" + "Policy Templates"):
  - `policy_types` — `slug` text PK, `description` text. A LOOKUP TABLE, not a SQL
    enum (`[inv:lookup-not-enum]`). Seeded values come later in `seed-and-roundtrip`.
  - `policy_templates` — `slug` text PK, `type` text FK → `policy_types.slug`,
    `description` text, `rules` JSON (`text({ mode: "json" })`), `enforcement` JSON
    ARRAY (`text({ mode: "json" })` holding e.g. `["agent","ci"]`), integer
    `version` (default 1), `is_system` integer flag. `[ref:drizzle-schema]`.
  - `PolicyTemplateStore` (`[ref:store-class]`) — `create(template)`,
    `read(slug)` → the full row with `rules` + `enforcement` deserialized to
    objects/arrays, `list(typeFilter?)`. Typed error codes
    (`POLICY_TEMPLATE_NOT_FOUND`, `POLICY_TEMPLATE_ALREADY_EXISTS`).
  - Tests (`policy-template-store.test.ts`), against a real on-disk DB:
    1. `"policy template round-trips after reopen"` — create a template with a
       MULTI-VALUE `enforcement` (e.g. `["agent","ci"]`) and structured `rules`,
       CLOSE the handle, reopen from the same path, `read(slug)` deep-equals the
       written template (proves `[inv:reopen-proves-persistence]`,
       `[inv:enforcement-is-array]`).
    2. `"enforcement is stored as a JSON array, not a scalar"` — assert
       `Array.isArray(read(slug).enforcement)` and length ≥ 2.

---

## Acceptance criteria

- [policy-type-and-template-schema.1] policy_types lookup table (text PK, not enum)
- [policy-type-and-template-schema.2] policy_templates table with rules + enforcement JSON + version + is_system
- [policy-type-and-template-schema.3] policy-template-store round-trip+reopen test passes

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-policy/src/db/schema.ts", "packages/ai/agent-policy/src/store/policy-template-store.ts", "packages/ai/agent-policy/src/index.ts", "packages/ai/agent-policy/src/__tests__/policy-template-store.test.ts", "packages/ai/agent-policy/drizzle"]
```

---

## Commit points

- `feat(agent-policy): policy_types lookup + policy_templates + PolicyTemplateStore`

## Notes for executor

- `enforcement` MUST be a JSON array column, never a single `text({ enum: [...] })`
  — a policy carries one OR MORE mechanisms (`SEED_DATA.md` §4;
  `[inv:enforcement-is-array]`). The audit `dod.5` grep_absent fails the build if
  `type`/`enforcement` is declared as a Drizzle enum.
- Generate the migration with drizzle-kit into `drizzle/` and run it before any
  store call (follow `agent-mcp/src/db/migrate.ts`).
- Proves part of `[dod.3]` (template round-trips after reopen) and `[dod.5]`.
- `better-sqlite3` vitest teardown can segfault — gate on EXIT CODE, not stdout.
