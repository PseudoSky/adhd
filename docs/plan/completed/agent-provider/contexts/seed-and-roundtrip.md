# seed-and-roundtrip — SEED PROVIDERS+MODELS+BINDINGS, IDEMPOTENT + REOPEN

**Phase:** seed · **Kind:** work · **Depends on:** runtime-tool-forwarding · **Guard:** `npx --yes nx test agent-provider --testFile=packages/ai/agent-provider/src/__tests__/roundtrip.test.ts`

---

## Goal

Seeding populates every provider, model, and model-platform binding from
`SEED_DATA.md` into a fresh DB; a second seed run is idempotent (no duplicate
rows, no version drift); and every seeded row round-trips after the store is
reopened.

---

## Semantic Distillation

- **Primitive:** ADD the seeders + a real-DB round-trip/idempotency suite. See
  `[inv:reopen-proves-persistence]`, `[inv:real-db-tests]`.
- **Delta Spec** (`SEED_DATA.md` §5 Platforms, §7 Models + Platform Bindings;
  `DATA_MODEL.md` Domain 2b):
  - `seed/providers.ts` — the five providers (`anthropic`, `openai`, `bedrock`,
    `lmstudio`, `claudecli`) with transport/auth/base-url.
  - `seed/models.ts` — the canonical models from §7
    (`claude_sonnet_4_6`, `claude_opus_4_8`, `claude_haiku_4_5`, `claude_fable_5`)
    with context window / output limit / capability flags / pricing tier.
  - `seed/bindings.ts` — the `claude_code` aliases (`opus`, `sonnet`, `haiku`,
    `fable`) and the `claude_api` full ids (`claude-opus-4-8`, `claude-sonnet-4-6`,
    `claude-haiku-4-5-20251001`, `claude-fable-5`) — exact §7 values.
  - `seed/index.ts` — `seed(db)` using **upsert / `INSERT OR IGNORE`** so a second
    run is a no-op (the single place the idempotency negative-control bites).
  - Tests (`roundtrip.test.ts`): run `seed()` twice over one real on-disk DB,
    assert `providers` / `models` / `model_platform_bindings` row counts are
    identical to a single run (no duplicates, no version drift); then CLOSE +
    REOPEN and assert the seeded rows read back deep-equal to what was written
    (including the `claude_opus_4_8 → claude-opus-4-8 / opus` bindings).

---

## Acceptance criteria

- [seed-and-roundtrip.1] seed/reopen/idempotency suite passes
- [seed-and-roundtrip.2] seed lists canonical models from SEED_DATA
- [seed-and-roundtrip.3] seed lists providers from SEED_DATA
- [seed-and-roundtrip.4] negative-control: seed idempotency has teeth

---

## Reservations

```text
read_only:  ["packages/ai/agent-provider/src/store/provider-store.ts", "packages/ai/agent-provider/src/store/model-store.ts", "packages/ai/agent-provider/src/store/tool-format-store.ts"]
mutates:    ["packages/ai/agent-provider/src/seed/providers.ts", "packages/ai/agent-provider/src/seed/models.ts", "packages/ai/agent-provider/src/seed/bindings.ts", "packages/ai/agent-provider/src/seed/index.ts", "packages/ai/agent-provider/src/__tests__/roundtrip.test.ts", "packages/ai/agent-provider/src/index.ts"]
```

---

## Commit points

- `feat(agent-provider): seed providers/models/bindings + round-trip suite`

## Notes for executor

- Proves `[dod.3]` (idempotency + reopen) and contributes the seeded data half of
  `[dod.1]` (the binding-store test relies on these exact §7 values).
- The negative-control in README dod.3 swaps the upsert for a plain `INSERT` so
  the second run duplicates rows — keep upsert/`INSERT OR IGNORE` the single
  insertion path so the control bites.
- Gate on the runner's EXIT CODE (`[inv]`/project memory): better-sqlite3 can
  segfault on teardown; do not `grep -q passed`.
