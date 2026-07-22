# policy-inheritance — CATEGORY-LEVEL ATTACH PROPAGATES TO AGENTS

**Phase:** schema · **Kind:** work · **Depends on:** agent-policy-junction · **Guard:** `npx --yes nx test agent-policy --testFile=packages/ai/agent-policy/src/__tests__/inheritance.test.ts`

---

## Goal

Attaching a MANDATORY policy to a taxonomy CATEGORY propagates it to every agent in
that category, INCLUDING a new agent added afterward: that agent's
`AgentPolicyStore.listForAgent` returns the policy with `inherited_from` = the
category slug — and the inheritance survives a DB reopen. This proves GOAL.md
"Policy Inheritance".

---

## Semantic Distillation

- **Primitive:** ADD `AgentPolicyStore.attachToCategory` + inheritance resolution.
  See `[def:inheritance]`. Strategy (eager fanout vs. lazy resolve) follows
  `decisions.md` EXACTLY.
- **Delta Spec:**
  - Schema: enough to associate agents with a category — either reference the
    `taxonomy_categories` + agent-category membership owned by
    `agent-registry-schema`, or stand up the minimal membership locally for the
    test (do NOT redefine taxonomy tables; reference slugs).
  - `AgentPolicyStore.attachToCategory({ categorySlug, policySlug, isMandatory })`:
    - EAGER: write `agent_policy` rows (`inherited_from = categorySlug`) for every
      current member, AND register a fanout on agent-create / category-join so a
      NEW member also gets the row.
    - LAZY: record the category→policy attachment; `listForAgent` LEFT JOINs the
      agent's category memberships to category policies and synthesizes rows with
      `inherited_from = categorySlug` at query time.
    - Either way the resolved inherited row carries `inherited_from = categorySlug`
      and `is_mandatory = true`.
  - Test (`inheritance.test.ts`), real on-disk DB, named case
    `"new category member inherits the mandatory policy after reopen"`:
    1. create category `quality-security`, attach mandatory `reviewer-posture` to it;
    2. add a NEW agent to `quality-security` (added AFTER the category attach);
    3. CLOSE the handle, reopen from the same path;
    4. assert `listForAgent(newAgent)` includes `reviewer-posture` with
       `inherited_from === "quality-security"` and `is_mandatory === true`.

---

## Acceptance criteria

- [policy-inheritance.1] category-level attach propagates via inherited_from
- [policy-inheritance.2] inheritance test: new agent in category inherits mandatory policy after reopen
- [policy-inheritance.3] inheritance test has teeth: skipping fanout/resolution drops inherited_from and fails

---

## Reservations

```text
read_only:  ["packages/ai/agent-policy/src/store/policy-template-store.ts"]
mutates:    ["packages/ai/agent-policy/src/db/schema.ts", "packages/ai/agent-policy/src/store/agent-policy-store.ts", "packages/ai/agent-policy/src/index.ts", "packages/ai/agent-policy/src/__tests__/inheritance.test.ts", "packages/ai/agent-policy/drizzle"]
```

---

## Commit points

- `feat(agent-policy): category-level policy inheritance with inherited_from provenance`

## Notes for executor

- The inheritance strategy MUST match `decisions.md` (eager vs. lazy). If
  under-specified there, escalate (planner-class amendment) — do NOT invent.
- The "added AFTER" ordering is load-bearing: it proves "agents added in the
  future inherit" (GOAL.md), not just a snapshot fanout. For eager strategy this
  forces you to wire the agent-create/category-join fanout; for lazy it is free.
- `[policy-inheritance.3]` is a NEGATIVE CONTROL: the audit runs
  `scripts/nc_break_inheritance.mjs` to disable the fanout/join so `inherited_from`
  is never populated, confirms `inheritance.test.ts` goes RED, then
  `scripts/nc_restore_inheritance.mjs` restores. Author both tiny scripts so the
  teeth are real (CLAUDE.md verification standard #2). If you skip them the
  criterion cannot fail and proves nothing.
- Proves `[dod.1]`. Reopen the DB before the assertion.
