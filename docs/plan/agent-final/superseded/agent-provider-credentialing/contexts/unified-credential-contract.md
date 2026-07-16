# unified-credential-contract — the canonical unified provider contract

**Phase:** contract · **Kind:** work · **Depends on:** none · **Guard:** `python3 docs/plan/agent-provider-credentialing/scripts/audit_credentialing.py --phase contract`

---

## Goal

The canonical provider contract gains the unified credential fields **additively** and
the registry stops seeding a `lmstudio` provider. After this state:

- `@adhd/agent-mcp-types/src/domain.ts` declares `credentialEnv?: string` and
  `credentialType?: "api_key" | "auth_token"` on the `openai` and `anthropic` members,
  and `baseURL?: string` on `anthropic` and `claudecli` (openai already has it). See
  [shape:unified-provider-config] and [def:credentialEnv] / [def:credentialType].
- `@adhd/agent-provider` no longer seeds an `lmstudio` provider row; LM Studio is just an
  `openai` provider pointed at a `baseURL`.

**Additive only here.** The legacy `apiKeyEnv`/`authTokenEnv` fields and the `lmstudio`
union member are **kept** in this state — removing the union member now would break
`nx build agent-mcp` ([inv:build-green-on-removal]); that removal lands in
`lmstudio-removal`.

## Semantic distillation

This is the type/registry seam. The runtime states build against these fields, so they
must exist first. Mirror [ref:provider-discriminated-union] — the `domain.ts` union is
the source of truth that `validation/agent.ts` tracks. Keep `RetryConfig`, `temperature`,
`maxTokens`, `timeoutMs`, `useClaudeOauth` exactly as they are.

## Contract promise

- **Added:** `credentialEnv?`, `credentialType?` on openai+anthropic; `baseURL?` on
  anthropic+claudecli (domain.ts).
- **Modified:** `agent-provider` seed/providers.ts (drop the `lmstudio` row → 4 providers);
  `agent-provider` db/schema.ts comment list; the `agent-provider` tests that referenced
  the seeded `lmstudio` row (`roundtrip.test.ts`, `model-store.test.ts`).
- **Deleted:** nothing yet (additive state).

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [unified-credential-contract.1] domain.ts declares credentialEnv on the unified provider config

- [unified-credential-contract.2] domain.ts declares optional credentialType override
- [unified-credential-contract.3] registry seed no longer seeds a lmstudio provider row
- [unified-credential-contract.4] agent-provider registry round-trip test passes after the lmstudio seed row is removed
---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src/validation/agent.ts"]
mutates:    ["packages/ai/agent-mcp-types/src/domain.ts", "packages/ai/agent-provider/src/seed/providers.ts", "packages/ai/agent-provider/src/db/schema.ts", "packages/ai/agent-provider/src/__tests__/roundtrip.test.ts", "packages/ai/agent-provider/src/__tests__/model-store.test.ts", "docs/plan/agent-provider-credentialing/scripts/audit_credentialing.py"]
```

---

## Commit points

1. After the additive domain.ts fields + registry seed change compile and the
   `agent-provider` round-trip test passes: `git commit -m "feat(agent-mcp-types): unified credentialEnv/credentialType/baseURL on provider contract; drop lmstudio registry seed"`.

## Notes for executor

- **Do not touch the agent-mcp zod schema here** — that is `provider-credential-runtime`'s
  mutate. This state owns only the TS type contract + the registry seed.
- **Do not remove the `lmstudio` union member yet** ([inv:build-green-on-removal]).
- The `agent-provider/src/db/schema.ts` change is a comment-only edit (lookup-not-enum;
  no SQL enum, no migration) — just drop `lmstudio` from the example provider id list.
- The audit guard's `unified-credential-contract.4` re-runs the real `agent-provider`
  round-trip suite, so the seed change must keep that suite green (update the fixtures
  that asserted a 5th `lmstudio` provider).
