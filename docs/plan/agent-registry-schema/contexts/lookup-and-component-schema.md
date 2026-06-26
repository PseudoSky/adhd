# lookup-and-component-schema — PROMPT TYPES LOOKUP + COMPONENTS TABLE + STORE

**Phase:** schema · **Kind:** work · **Depends on:** scaffold-package · **Guard:** `npx --yes nx test agent-registry --testFile=packages/ai/agent-registry/src/__tests__/component-store.test.ts`

---

## Goal

The `prompt_types` lookup table and the component tables exist in the Drizzle
schema, and `ComponentStore` can create / read / version components. A component
round-trips through a real DB and survives reopen.

> **Post-execution architecture correction (Decision 5, decisions.md).** This state
> originally shipped a single `registry_prompt_components` table keyed by a composite
> PK `(slug, version)`. Because `slug` was then not a unique column it could not be an
> FK target, leaving every component reference a logical-only FK. The table was split
> into **`registry_components`** (identity / head, single-column `slug` PK) +
> **`registry_component_versions`** (history, `version_id` PK + `UNIQUE(slug, version)`),
> making `slug` and `version_id` real FK targets. The store API names/semantics below
> are unchanged; the prose is updated to the corrected tables. The state's
> state.json/dag.json are NOT changed — this is a doc-accuracy correction.

---

## Semantic Distillation

- **Primitive:** ADD `prompt_types` + the component tables (`registry_components` +
  `registry_component_versions`, Decision 5) and `ComponentStore`. See
  `[def:component]`, `[inv:lookup-not-enum]`, `[inv:version-retained]`,
  `[inv:reopen-proves-persistence]`.
- **Delta Spec** (`DATA_MODEL.md` Domain 1; field shapes per `decisions.md` incl.
  Decision 5):
  - `prompt_types` — text PK `slug`, `description`, `is_system` integer flag.
    NOT a SQL enum (`[inv:lookup-not-enum]`).
  - `registry_components` (identity / head) — `slug` **single-column text PK**,
    `type` (enforced FK → `prompt_types.slug`), `is_shared` integer flag,
    `created_at`. Identity-level facts only — they do not change per version.
  - `registry_component_versions` (history) — `version_id` **integer PK
    autoincrement** (single-column surrogate, FK-able), `slug` (enforced FK →
    `registry_components.slug`), integer `version` (default 1, increments on content
    change), text `content`, `created_at`/`updated_at`, and a real
    **`UNIQUE(slug, version)`** index so old versions are retained with DB teeth
    (`[inv:version-retained]`).
  - `ComponentStore` (`[ref:store-class]`): `create` (writes head + v1 atomically),
    `read(slug)` (head joined to latest version), `readVersion(slug, n)`,
    `version(slug, newContent)` (appends a version row at `version+1`),
    `list({type?, shared?})`, plus `resolveVersionId(slug, n)` → the version's
    `version_id`. The returned `PromptComponent` carries a `versionId`.
  - Tests (`component-store.test.ts`): create → read; version bump retains old
    row; **reopen the DB and assert the component is still there**
    (`[inv:reopen-proves-persistence]`).
- Generate the drizzle migration into `packages/ai/agent-registry/drizzle/`.

---

## Acceptance criteria

- [lookup-and-component-schema.1] prompt_types lookup table defined
- [lookup-and-component-schema.2] registry_components (head) + registry_component_versions (integer version) tables defined; is_shared on the head (Decision 5)
- [lookup-and-component-schema.3] component-store round-trip test passes

---

## Reservations

```text
read_only:  ["packages/ai/agent-registry/src/db/client.ts"]
mutates:    ["packages/ai/agent-registry/src/db/schema.ts", "packages/ai/agent-registry/src/store/component-store.ts", "packages/ai/agent-registry/src/index.ts", "packages/ai/agent-registry/src/__tests__/component-store.test.ts", "packages/ai/agent-registry/drizzle"]
```

---

## Commit points

- `feat(agent-registry): prompt_types + prompt_components schema and ComponentStore`

## Notes for executor

- `schema.ts` and `index.ts` are appended to by every subsequent state — add
  your tables/exports, never rewrite the file.
- Test must REOPEN (close handle, new `Database(path)`) — `:memory:` cannot prove
  persistence. Gate on the vitest EXIT CODE, not stdout.
