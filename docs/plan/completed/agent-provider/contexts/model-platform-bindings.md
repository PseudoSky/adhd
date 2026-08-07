# model-platform-bindings — MODEL_PLATFORM_BINDINGS + resolveModelId

**Phase:** schema · **Kind:** work · **Depends on:** provider-and-model-schema · **Guard:** `npx --yes nx test agent-provider --testFile=packages/ai/agent-provider/src/__tests__/binding-store.test.ts`

---

## Goal

The `model_platform_bindings` table exists and `ModelStore.resolveModelId` maps a
canonical model id + platform to the correct provider-specific string. This is the
package's **core value**: `claude_opus_4_8` resolves to `claude-opus-4-8` on
`claude_api` AND to `opus` on `claude_code`, proven after a DB reopen.

---

## Semantic Distillation

- **Primitive:** ADD `model_platform_bindings` + `ModelStore.resolveModelId`. See
  `[def:model-binding]`.
- **Delta Spec** (`DATA_MODEL.md` Domain 2b "Model-Platform Bindings";
  `SEED_DATA.md` §7 binding tables):
  - `provider_model_platform_bindings` — `model_id` (FK → `provider_models.id`),
    `platform` text (`claude_api`, `claude_code`, `openai`, `bedrock`, …),
    `platform_model_id` text. PK `(model_id, platform)`. One row per `(model,
    platform)` pair.
  - `ModelStore.resolveModelId(canonicalId, platform) → string` — a single
    Drizzle query `WHERE model_id = ? AND platform = ?` returning
    `platform_model_id`; throw a typed `ToolError` (`MODEL_BINDING_NOT_FOUND`) if
    absent. The `WHERE platform = ?` clause is the single place the negative
    control bites — keep it here.
  - Tests (`binding-store.test.ts`): seed two bindings for `claude_opus_4_8`
    (`claude_api → claude-opus-4-6`/`claude-opus-4-8` and `claude_code → opus`),
    CLOSE + REOPEN, then assert BOTH `resolveModelId("claude_opus_4_8",
    "claude_api") === "claude-opus-4-8"` and `resolveModelId("claude_opus_4_8",
    "claude_code") === "opus"`. (`[inv:reopen-proves-persistence]`.) Use the exact
    `SEED_DATA.md` §7 values.

---

## Acceptance criteria

- [model-platform-bindings.1] model_platform_bindings table present in schema
- [model-platform-bindings.2] resolveModelId reads binding by platform
- [model-platform-bindings.3] binding resolution test passes (canonical->per-platform after reopen)
- [model-platform-bindings.4] negative-control: binding resolution has teeth

---

## Reservations

```text
read_only:  ["packages/ai/agent-provider/src/store/provider-store.ts"]
mutates:    ["packages/ai/agent-provider/src/db/schema.ts", "packages/ai/agent-provider/src/store/model-store.ts", "packages/ai/agent-provider/src/index.ts", "packages/ai/agent-provider/src/__tests__/binding-store.test.ts", "packages/ai/agent-provider/drizzle"]
```

---

## Commit points

- `feat(agent-provider): model_platform_bindings table and resolveModelId`

## Notes for executor

- Proves `[dod.1]`. The negative-control in README dod.1 drops the
  `WHERE platform = ?` filter so both platforms collapse to the first binding —
  keep `resolveModelId` the single place the platform filter happens so the
  control bites and the test goes red.
- `model-store.ts` is shared with the previous state (append-only): add the
  resolver method, don't rewrite the create/read methods.
- Use the canonical/per-platform values verbatim from `SEED_DATA.md` §7 so seeding
  (later state) and this test agree.
