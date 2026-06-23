# lookup-and-component-schema — PROMPT TYPES LOOKUP + COMPONENTS TABLE + STORE

**Phase:** schema · **Kind:** work · **Depends on:** scaffold-package · **Guard:** `npx --yes nx test agent-registry --testFile=packages/ai/agent-registry/src/__tests__/component-store.test.ts`

---

## Goal

The `prompt_types` lookup table and the `prompt_components` table exist in the
Drizzle schema, and `ComponentStore` can create / read / version components.
A component round-trips through a real DB and survives reopen.

---

## Semantic Distillation

- **Primitive:** ADD `prompt_types` + `prompt_components` tables and
  `ComponentStore`. See `[def:component]`, `[inv:lookup-not-enum]`,
  `[inv:version-retained]`, `[inv:reopen-proves-persistence]`.
- **Delta Spec** (`DATA_MODEL.md` Domain 1; field shapes per `decisions.md`):
  - `prompt_types` — text PK `slug`, `description`, `is_system` integer flag.
    NOT a SQL enum (`[inv:lookup-not-enum]`).
  - `prompt_components` — `slug` (human ref), `type` (FK → `prompt_types.slug`),
    integer `version` (default 1, increments on content change), text `content`,
    `is_shared` integer flag, `created_at`/`updated_at`. PK is `(slug, version)`
    so old versions are retained (`[inv:version-retained]`).
  - `ComponentStore` (`[ref:store-class]`): `create`, `read(slug)` (latest
    version), `readVersion(slug, n)`, `version(slug, newContent)` (writes a new
    row at `version+1`), `list({type?, shared?})`.
  - Tests (`component-store.test.ts`): create → read; version bump retains old
    row; **reopen the DB and assert the component is still there**
    (`[inv:reopen-proves-persistence]`).
- Generate the drizzle migration into `packages/ai/agent-registry/drizzle/`.

---

## Acceptance criteria

- [lookup-and-component-schema.1] prompt_types lookup table defined
- [lookup-and-component-schema.2] prompt_components table with integer version + is_shared
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
