# lmstudio-removal — delete the lmstudio provider type everywhere

**Phase:** runtime · **Kind:** work · **Depends on:** provider-credential-runtime · **Guard:** `npx --yes nx build agent-mcp && python3 docs/plan/agent-provider-credentialing/scripts/audit_credentialing.py --phase runtime`

---

## Goal

The `lmstudio` provider **type** is gone from the codebase; LM Studio is reached purely as
an `openai` provider with `baseURL` + `credentialEnv`. After this state ([inv:lmstudio-gone]):

- `packages/ai/agent-mcp/src/providers/lmstudio.ts` is **deleted**.
- `domain.ts` drops the `{ type: "lmstudio"; … }` union member (done HERE, atomically with the
  runtime deletes, so `nx build agent-mcp` stays green — [inv:build-green-on-removal]).
- `validation/agent.ts` drops `lmstudioProviderSchema` and its entry in the
  `z.discriminatedUnion`.
- `providers/factory.ts` drops `case "lmstudio"` and the `LMStudioProvider` import.
- `providers/index.ts` drops `export { LMStudioProvider }`.
- `server.ts` USAGE_GUIDE drops the `lmstudio` provider row / mentions.
- Comment-only cleanups in `providers/types.ts`, `engine/orchestrator.ts`, `db/schema.ts`.
- The tests that referenced the `lmstudio` type are migrated to `openai`+`baseURL`
  (`debt-005-sdk-timeout.test.ts`, the three `integration/live-*.e2e.test.ts`).

## Semantic distillation

This is a pure removal of a closed-set member. The retained env-var **names**
`LMSTUDIO_API_KEY` / `LMSTUDIO_BASE_URL` stay (back-compat relies on them — [def:normalize-on-load]);
only the provider *type* `"lmstudio"` is removed. The build guard is the forcing function: you
cannot drop the union member without removing every type-level reference, or `nx build agent-mcp`
fails. The `--phase runtime` audit then proves the negatives (no `case "lmstudio"`, no
`lmstudioProviderSchema`, no `LMStudioProvider` export, no `type: "lmstudio"`).

## Contract promise

- **Deleted:** `providers/lmstudio.ts`; `LMStudioProvider` (class + export); `lmstudioProviderSchema`;
  the `lmstudio` union member in domain.ts; `case "lmstudio"` in factory.ts.
- **Modified:** factory.ts, index.ts, validation/agent.ts, server.ts USAGE_GUIDE, openai.ts
  (comment cleanup of the old placeholder rationale), comment lists in types.ts/orchestrator.ts/db.schema.ts;
  the lmstudio-referencing tests migrated to `openai`+`baseURL`.

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [lmstudio-removal.1] providers/lmstudio.ts is deleted

- [lmstudio-removal.2] factory.ts has no case "lmstudio"
- [lmstudio-removal.3] validation/agent.ts has no lmstudioProviderSchema
- [lmstudio-removal.4] domain.ts union no longer contains a lmstudio member
- [lmstudio-removal.5] providers/index.ts no longer exports LMStudioProvider
- [lmstudio-removal.6] agent-mcp builds clean after lmstudio is fully removed
---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp-types/src/domain.ts", "packages/ai/agent-mcp/src/providers/lmstudio.ts", "packages/ai/agent-mcp/src/providers/factory.ts", "packages/ai/agent-mcp/src/providers/index.ts", "packages/ai/agent-mcp/src/validation/agent.ts", "packages/ai/agent-mcp/src/server.ts", "packages/ai/agent-mcp/src/providers/types.ts", "packages/ai/agent-mcp/src/engine/orchestrator.ts", "packages/ai/agent-mcp/src/db/schema.ts", "packages/ai/agent-mcp/src/providers/openai.ts", "packages/ai/agent-mcp/src/__tests__/debt-005-sdk-timeout.test.ts", "packages/ai/agent-mcp/src/__tests__/integration/live-oauth.e2e.test.ts", "packages/ai/agent-mcp/src/__tests__/integration/live-budget.e2e.test.ts", "packages/ai/agent-mcp/src/__tests__/integration/live-dag.e2e.test.ts", "packages/ai/agent-mcp/CHANGELOG.md", "packages/ai/agent-mcp/BACKLOG.md", "packages/ai/agent-mcp/SPEC.md", "packages/ai/agent-mcp/PLAN-MEMORY.md"]
```

> **Serialization.** `domain.ts`, `validation/agent.ts`, and `openai.ts` are shared with the
> contract/runtime states this one `depends_on`; serial execution means no merge conflict. Treat
> the inherited edits as the baseline and apply only the deletions described here.

---

## Commit points

1. After `nx build agent-mcp` is green AND `--phase runtime` reports all negatives clean:
   `git commit -m "refactor(agent-mcp)!: remove the lmstudio provider type; LM Studio is a plain openai provider"`.

## Notes for executor

- **Whole-word care:** delete the type literal `"lmstudio"` and the symbols, but DO NOT remove
  `LMSTUDIO_API_KEY` / `LMSTUDIO_BASE_URL` — those env-var names are retained for back-compat
  ([inv:lmstudio-gone]). The audit's `lmstudio-removal.*` greps target the type forms
  (`type: "lmstudio"`, `case "lmstudio"`, `lmstudioProviderSchema`, `LMStudioProvider`), not the
  env-var names.
- The three `integration/live-*.e2e.test.ts` and `debt-005-sdk-timeout.test.ts` currently build a
  `{ type:"lmstudio", … }` provider — rewrite each to `{ type:"openai", baseURL, credentialEnv:"LMSTUDIO_API_KEY" }`.
- `db/schema.ts` keeps `provider_type` as free text ([inv:lmstudio-gone]); the only change is the
  `// "openai" | "anthropic" | "lmstudio" | "claudecli"` comment → drop `lmstudio`.
- **Package docs that name `LMStudioProvider` (surfaced by `gap-check --discover`):** record the
  removal in `CHANGELOG.md` (a `### Removed` entry — this entry MAY name `LMStudioProvider`, that is
  the deliberate record, not a leak); **scrub stale current-tense mentions** in `SPEC.md`,
  `PLAN-MEMORY.md`, and `BACKLOG.md` (close any open "remove lmstudio" backlog item). A historical
  reference annotated "(removed in this change)" is acceptable; a present-tense claim that the type
  exists is not.
