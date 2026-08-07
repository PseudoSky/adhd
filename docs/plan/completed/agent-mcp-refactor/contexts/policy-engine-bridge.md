# policy-engine-bridge — PolicyEngine reads policy templates; reconcile claudecli tool model

**Phase:** integration · **Kind:** work · **Depends on:** agent-store-retire · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/policy-tool-reconcile.test.ts`

See `contexts/_shared.md` for definitions, invariants, and the caller map.

---

## Goal

`PolicyEngine` can read limits from agent-policy templates rather than only
hardcoded `PolicyConfig`, and the already-shipped `claudecli` tool-permission
features are reconciled with the registry tool model (`[inv:no-third-tool-model]`).
After this state: `PolicyEngine.check()` resolves rate/permission limits from
agent-policy templates (falling back to `PolicyConfig` defaults), and
`claudecli`'s `allowedBuiltinTools` / `systemPromptIsAgentSpec` reference the
compiled `composed.tools` / `AGENT_TOOL` model instead of being a competing third
tool-permission scheme.

## Semantic Distillation

- **Primitive:** EXTEND `PolicyEngine.check()` to read from agent-policy templates;
  RECONCILE the two `claudecli` provider fields per `decisions.md` question 4.
- **Delta spec** (`REFERENCES.md` "PolicyEngine"; `RUNTIME_GAPS.md` "Relationship
  to Already-Shipped agent-mcp Features"; `decisions.md`):
  - `engine/policy.ts`: `check()` reads `rate` (recursion/loop) + `permission`
    (allowedAgents) limits from agent-policy template rules when present; the
    hardcoded `PolicyConfig` becomes the DEFAULT, not the only source. (Reuse the
    `@adhd/agent-policy` template shape; do not re-derive policy semantics.)
  - `providers/claudecli.ts` + `validation/agent.ts`: `allowedBuiltinTools` /
    `systemPromptIsAgentSpec` are mapped onto the compiled `composed.tools` /
    `AGENT_TOOL` declaration model so there is one tool-permission source of truth
    (criterion `.2` greps claudecli for the compiled-tools/`AGENT_TOOL` reference).
  - Test (`policy-tool-reconcile.test.ts`): a policy-template limit overrides the
    `PolicyConfig` default through `PolicyEngine.check()`; and the claudecli tool
    set derives from compiled tools (not an independent third list).

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [policy-engine-bridge.1] PolicyEngine can read limits from agent-policy templates (not only hardcoded PolicyConfig)

- [policy-engine-bridge.2] claudecli reconciles allowedBuiltinTools/systemPromptIsAgentSpec with the registry AGENT_TOOL/compiled-tools model
- [policy-engine-bridge.3] policy/tool reconciliation test passes (no competing third tool-permission model)
---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp/src/engine/policy.ts", "packages/ai/agent-mcp/src/providers/claudecli.ts", "packages/ai/agent-mcp/src/validation/agent.ts", "packages/ai/agent-mcp/src/__tests__/policy-tool-reconcile.test.ts", "packages/ai/agent-mcp/package.json", "tsconfig.base.json"]
```

---

## Changes (brownfield)

- RESIGN `PolicyEngine` (`engine/policy.ts`): hardcoded-`PolicyConfig`-only →
  reads limits from agent-policy templates with `PolicyConfig` as default.
- RESIGN `claudecliProviderSchema.allowedBuiltinTools` /
  `.systemPromptIsAgentSpec` (`validation/agent.ts`): reconciled with the registry
  `AGENT_TOOL` / compiled-tools model. (All declared in dag.json `changes.resigns`.)

## Commit points

- `refactor(agent-mcp): PolicyEngine reads agent-policy templates; reconcile claudecli tool model with AGENT_TOOL`

## Notes for executor

- `[inv:no-third-tool-model]` is the point of this state: do NOT leave
  `allowedBuiltinTools` as an independent list with no link to `AGENT_TOOL` /
  `composed.tools`. The criterion greps `claudecli.ts` for that linkage.
- Backward compatibility (`[dod.3]`): existing `PolicyConfig` defaults MUST still
  apply when no policy template is attached — keep the env-var defaults working so
  the existing policy tests stay green.
- `@adhd/agent-policy` is a shipped sibling package (`published` in plan-index);
  reuse its template shape, do not re-implement enforcement here.
- Gate on EXIT CODE (`[inv:exit-code-gate]`).
