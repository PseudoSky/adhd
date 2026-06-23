# agent-policy-junction — AGENT_POLICY JUNCTION + AgentPolicyStore (DIRECT ATTACH)

**Phase:** schema · **Kind:** work · **Depends on:** policy-type-and-template-schema · **Guard:** `npx --yes nx test agent-policy --testFile=packages/ai/agent-policy/src/__tests__/agent-policy-store.test.ts`

---

## Goal

The `agent_policy` junction exists and `AgentPolicyStore` can attach a policy
DIRECTLY to an agent (with optional `override_config`, `is_mandatory`, and
`inherited_from = null`), and that attachment round-trips after the DB is reopened.
This is the direct-attach half; category inheritance is the next state.

---

## Semantic Distillation

- **Primitive:** ADD `agent_policy` junction + `AgentPolicyStore.attach` /
  `listForAgent`. See `[def:agent-policy-row]`.
- **Delta Spec** (`DATA_MODEL.md` Domain 3 "Agent-Policy Junctions"):
  - `agent_policy` — `agent_slug` text FK, `policy_slug` text FK →
    `policy_templates.slug`, `override_config` nullable JSON
    (`text({ mode: "json" })`), `is_mandatory` integer flag, `inherited_from`
    nullable text (taxonomy category slug, or null when attached directly). PK
    `(agent_slug, policy_slug)`. `[ref:drizzle-schema]`.
  - `AgentPolicyStore` (`[ref:store-class]`):
    - `attach({ agentSlug, policySlug, overrideConfig?, isMandatory? })` — inserts
      a DIRECT row with `inherited_from = null`.
    - `listForAgent(agentSlug)` → all `agent_policy` rows for the agent (direct +,
      after the next state, inherited), with `override_config` deserialized.
    - typed errors (`AGENT_POLICY_ALREADY_ATTACHED`).
  - Tests (`agent-policy-store.test.ts`), real on-disk DB: seed a template + an
    `agents` row (stand up a minimal `agents` row locally until
    `agent-registry-schema` shares the file), `attach` a mandatory direct policy
    with an `override_config` (e.g. `{ "max_rework": 5 }`), CLOSE + reopen,
    `listForAgent` returns the row with `inherited_from === null`,
    `is_mandatory === true`, and the deserialized `override_config` intact.

---

## Acceptance criteria

- [agent-policy-junction.1] agent_policy junction (agent, policy, override_config, is_mandatory, inherited_from)
- [agent-policy-junction.2] AgentPolicyStore attaches a direct policy
- [agent-policy-junction.3] agent-policy-store direct-attach round-trip after reopen test passes

---

## Reservations

```text
read_only:  ["packages/ai/agent-policy/src/store/policy-template-store.ts"]
mutates:    ["packages/ai/agent-policy/src/db/schema.ts", "packages/ai/agent-policy/src/store/agent-policy-store.ts", "packages/ai/agent-policy/src/index.ts", "packages/ai/agent-policy/src/__tests__/agent-policy-store.test.ts", "packages/ai/agent-policy/drizzle"]
```

---

## Commit points

- `feat(agent-policy): agent_policy junction + AgentPolicyStore direct attach`

## Notes for executor

- `inherited_from` MUST exist on the table now even though only `policy-inheritance`
  populates it — the column is the observable for `[dod.1]`. Direct attach sets it
  to `null`.
- The `agents` / `taxonomy_categories` rows are owned by `agent-registry-schema`.
  Until that plan shares the file, the test stands up the minimal rows it needs;
  see README "Cross-plan dependencies". Do NOT redefine those tables here — only
  reference their slugs as FKs.
- Proves `[dod.5]` (junction exists) and feeds `[dod.1]` (the store the inheritance
  test queries).
