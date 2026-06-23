# agent-and-taxonomy-schema — AGENTS + TAXONOMY_CATEGORIES TABLES + STORE

**Phase:** schema · **Kind:** work · **Depends on:** lookup-and-component-schema · **Guard:** `npx --yes nx test agent-registry --testFile=packages/ai/agent-registry/src/__tests__/agent-store.test.ts`

---

## Goal

The `agents` and `taxonomy_categories` tables exist and `AgentStore` can CRUD
agent identity rows. Agents hold metadata only — no prompt text (all content
arrives through the junction in the next state).

---

## Semantic Distillation

- **Primitive:** ADD `agents` + `taxonomy_categories` tables and `AgentStore`.
- **Delta Spec** (`DATA_MODEL.md` Domain 1 "Agents"):
  - `agents` — `slug` PK, `display_name`, `description`, `status`
    (`draft|active|deprecated`, plain text not enum), `model_hint` (text — a
    canonical model id resolved later by `@adhd/agent-provider`; NO cross-package
    FK at the DB layer per `decisions.md` topology), `taxonomy_category` (FK →
    `taxonomy_categories.slug`), `default_posture` (`approve|needs_work`),
    `created_at`/`updated_at`.
  - `taxonomy_categories` — `slug` PK, `name`, `description`, integer `position`
    (ordering replaces the `01-`/`02-` directory prefix convention,
    `SCOPE.md` "Category Folders"), `parent_slug` (nullable, self-FK for
    subcategories like `cto-system/`).
  - `AgentStore` (`[ref:store-class]`): `create`, `read`, `update`, `delete`,
    `list({category?, status?})`; `TaxonomyStore` (may live in same file):
    `createCategory`, `listCategories` ordered by `position`.
  - Tests: create agent in a category; reopen and read back; list by category
    returns ordered categories.

---

## Acceptance criteria

- [agent-and-taxonomy-schema.1] agents table with slug PK, status, model_hint, taxonomy_category
- [agent-and-taxonomy-schema.2] taxonomy_categories table with ordering
- [agent-and-taxonomy-schema.3] agent-store test passes

---

## Reservations

```text
read_only:  ["packages/ai/agent-registry/src/store/component-store.ts"]
mutates:    ["packages/ai/agent-registry/src/db/schema.ts", "packages/ai/agent-registry/src/store/agent-store.ts", "packages/ai/agent-registry/src/index.ts", "packages/ai/agent-registry/src/__tests__/agent-store.test.ts", "packages/ai/agent-registry/drizzle"]
```

---

## Commit points

- `feat(agent-registry): agents + taxonomy_categories schema and AgentStore`

## Notes for executor

- `model_hint` is a STRING, not an FK to a provider table — the model registry
  lives in `@adhd/agent-provider` (separate plan, separate DB domain per
  `decisions.md`). Cross-package resolution happens at compile time, not via a
  SQLite FK. Do not add a foreign key here.
