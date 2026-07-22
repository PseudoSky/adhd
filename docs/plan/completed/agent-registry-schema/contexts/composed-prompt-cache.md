# composed-prompt-cache — COMPOSED_PROMPTS TABLE + STORE

**Phase:** composition · **Kind:** work · **Depends on:** usecase-and-context-rules · **Guard:** `npx --yes nx test agent-registry --testFile=packages/ai/agent-registry/src/__tests__/composed-prompt-store.test.ts`

---

## Goal

The `composed_prompts` table exists and `ComposedPromptStore` can write and
look up a composed prompt by `(agent_slug, context_hash)`. This is the audit
trail + cache bridge between the design layer and agent-mcp's runtime.

---

## Semantic Distillation

- **Primitive:** ADD `composed_prompts` + `ComposedPromptStore`. See
  `[def:composed-prompt]`.
- **Delta Spec** (`DATA_MODEL.md` Domain 1 "Composed Prompts", Domain 5):
  - `composed_prompts` — `id` PK, `agent_slug`, `context_hash` (hash of the
    context inputs used at assembly, for cache lookup), `content` (the final flat
    prompt text), `component_versions` (JSON: which version of each component was
    used — the audit record), `created_at`.
  - Index on `(agent_slug, context_hash)` for O(1) cache lookup.
  - `ComposedPromptStore`: `write({agentSlug, contextHash, content, componentVersions})`,
    `lookup(agentSlug, contextHash)` → row | null, `read(id)`.
  - This table is WRITTEN by `@adhd/agent-compiler` and READ by `@adhd/agent-mcp`
    at session start (Domain 5). This state only provides the storage + store API.
  - Tests: write a composed prompt; reopen; `lookup` returns it; a different
    context_hash returns null.

---

## Acceptance criteria

- [composed-prompt-cache.1] composed_prompts table: agent slug, context hash, content, component versions JSON
- [composed-prompt-cache.2] composed-prompt-store cache lookup test passes

---

## Reservations

```text
read_only:  ["packages/ai/agent-registry/src/store/composition-store.ts"]
mutates:    ["packages/ai/agent-registry/src/db/schema.ts", "packages/ai/agent-registry/src/store/composed-prompt-store.ts", "packages/ai/agent-registry/src/index.ts", "packages/ai/agent-registry/src/__tests__/composed-prompt-store.test.ts", "packages/ai/agent-registry/drizzle"]
```

---

## Commit points

- `feat(agent-registry): composed_prompts cache table and ComposedPromptStore`

## Notes for executor

- `component_versions` is the audit trail GOAL.md "Audit Trail" depends on —
  store the exact `{componentSlug: version}` map used, so a behavior regression
  is traceable to a component version. Per Decision 5 (decisions.md) this audit map
  deliberately records the human `version` number (not the
  `registry_component_versions.version_id` surrogate): it is a human-readable audit
  record, not an FK, and `ComponentStore.resolveVersionId(slug, version)` maps a
  `(slug, version)` to its `version_id` whenever the stable surrogate is needed.
- The `context_hash` algorithm should be deterministic + stable (sorted-key JSON
  → sha256). `@adhd/agent-compiler` will reuse the same hash; export the helper.
