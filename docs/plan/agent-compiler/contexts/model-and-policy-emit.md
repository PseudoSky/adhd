# model-and-policy-emit — RESOLVE MODEL ALIAS + FOLD POLICY CONSTRAINTS

**Phase:** resolve · **Kind:** work · **Depends on:** tool-header-emit · **Guard:** `npx --yes nx test agent-compiler --testFile=packages/ai/agent-compiler/src/__tests__/model-policy.test.ts`

---

## Goal

The compiler resolves the agent's `model_hint` to the platform-specific model
string via `model_platform_bindings` (`claude_opus_4_8` → `opus` on `claude_code`,
`claude-opus-4-8` on `claude_api`), and folds each attached `agent_policy` row
(direct + inherited) into a constraint block rendered into the header/body. This
delivers the `model:` header field and is the spine of policy `[dod.3]`.

---

## Semantic Distillation

- **Primitive:** ADD `resolve/model.ts` (`resolveModel(db, agentSlug, platform) →
  platformModelId`) and `resolve/policy.ts` (`resolvePolicyConstraints(db,
  agentSlug) → Constraint[]`).
- **Reference Pattern:** `[up:provider]`, `[up:policy]`, `[ref:store-read]`,
  `[def:policy-constraint]`, `[inv:platform-shaped-observable]`.
- **Delta Spec:**
  - `resolveModel`: read the agent's `model_hint`, join
    `model_platform_bindings` for the target platform; if no binding, fall back to
    the canonical id (record the decision in `decisions.md`).
  - `resolvePolicyConstraints`: read `policy_*` `agent_policy` rows for the agent
    (direct + `inherited_from`), join the policy template's `rules`, and produce
    the constraint text the compiler renders (e.g. `no-credentials` → "Never write
    API keys or secrets…"). Respect the eager/lazy inheritance decision from plan 4.
  - Test (`model-policy.test.ts`): seed an agent with `model_hint:claude_opus_4_8`
    and an attached `no-credentials` policy; assert `resolveModel(...,'claude_code')
    === 'opus'`, `(...,'claude_api') === 'claude-opus-4-8'`, and
    `resolvePolicyConstraints(...)` includes the `no-credentials` constraint text.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [model-and-policy-emit.1] resolves model_hint via model_platform_bindings

- [model-and-policy-emit.2] folds agent_policy rows into header/body block
- [model-and-policy-emit.3] model+policy resolution test passes
---

## Reservations

```text
read_only:  ["packages/ai/agent-compiler/src/resolve/tools.ts"]
mutates:    ["packages/ai/agent-compiler/src/resolve/model.ts", "packages/ai/agent-compiler/src/resolve/policy.ts", "packages/ai/agent-compiler/src/index.ts", "packages/ai/agent-compiler/src/__tests__/model-policy.test.ts"]
```

---

## Commit points

- `feat(agent-compiler): resolve model alias + fold agent_policy constraints`

## Notes for executor

- The `[dod.3]` negative-control "return empty constraints" bites here — keep the
  `agent_policy` read as the single source of the constraint block.
- Seed `provider_*` and `policy_*` rows via the upstream packages' seed/store APIs
  (`[inv:real-rows-not-mocks]`).
