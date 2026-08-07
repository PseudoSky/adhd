# provider-and-model-schema — PROVIDERS + MODELS TABLES + STORES

**Phase:** schema · **Kind:** work · **Depends on:** scaffold-package · **Guard:** `npx --yes nx test agent-provider --testFile=packages/ai/agent-provider/src/__tests__/model-store.test.ts`

---

## Goal

The `providers` and `models` tables exist (prefixed `provider_*`) with their
stores, and a model created through `ModelStore` round-trips identical after the
store is closed and reopened.

---

## Semantic Distillation

- **Primitive:** ADD `providers` + `models` tables + `ProviderStore`/`ModelStore`.
  See `[def:provider]`, `[def:model]`, `[ref:drizzle-schema]`, `[ref:store-class]`.
- **Delta Spec** (`DATA_MODEL.md` Domain 2b "Providers"/"Models"; `SEED_DATA.md`
  §7):
  - `provider_providers` — `id` text PK (`anthropic`, `openai`, `bedrock`,
    `lmstudio`, `claudecli`), `transport` (`HTTP` | `stdio`), `auth_pattern` text,
    `base_url` / `endpoint_template` text (nullable). `[inv:lookup-not-enum]`.
  - `provider_models` — `id` text PK (canonical, e.g. `claude_opus_4_8`),
    `context_window` integer, `output_limit` integer, `vision` / `prompt_caching` /
    `extended_thinking` boolean flags (`integer({mode:"boolean"})`), `pricing_tier`
    text.
  - `ProviderStore` — `create` / `read` / `list`.
  - `ModelStore` — `create` / `read` / `list` (binding resolution is added in the
    NEXT state; this state only does the model table itself).
  - Tests (`model-store.test.ts`): create a model, CLOSE the handle, REOPEN from
    the same file path, read back, deep-equal (`[inv:reopen-proves-persistence]`,
    `[inv:real-db-tests]`). Assert capability-flag booleans survive the reopen as
    booleans, not 0/1.

---

## Acceptance criteria

- [provider-and-model-schema.1] providers table present in schema
- [provider-and-model-schema.2] models table present in schema
- [provider-and-model-schema.3] model-store round-trip+reopen test passes

---

## Reservations

```text
read_only:  ["packages/ai/agent-provider/src/db/client.ts"]
mutates:    ["packages/ai/agent-provider/src/db/schema.ts", "packages/ai/agent-provider/src/store/provider-store.ts", "packages/ai/agent-provider/src/store/model-store.ts", "packages/ai/agent-provider/src/index.ts", "packages/ai/agent-provider/src/__tests__/model-store.test.ts", "packages/ai/agent-provider/drizzle"]
```

---

## Commit points

- `feat(agent-provider): providers + models tables and stores`

## Notes for executor

- Prefix every table name `provider_` (`[inv:shared-db-prefix]`). The Drizzle JS
  symbol can be `providers`/`models`; the SQL `sqliteTable("provider_providers", …)`
  carries the prefix — the audit greps either the symbol or the prefixed name.
- Generate a drizzle migration into `drizzle/` and apply it before the test runs.
- Contributes the `providers`/`models` half of `[dod.5]`.
