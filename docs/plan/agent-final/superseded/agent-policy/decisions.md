# Architecture Decisions — `@adhd/agent-policy`

> **Status:** binding. Written in the `policy-design` state of the `agent-policy`
> plan, BEFORE any `policy_*` table is frozen and before the enforcement plugin is
> built. Every later state in this plan — `policy-type-and-template-schema`,
> `agent-policy-junction`, `policy-inheritance`, and `enforcement-plugin` — treats
> these decisions as the resolution of the open design questions and MUST NOT
> re-decide them locally. Re-deciding any of these downstream is a planner-class
> amendment, not a local choice.
>
> **Source requirements:** `docs/plan/agent-registry/DATA_MODEL.md` Domain 3 +
> "Cross-Domain Design Decisions (Open)"; `SEED_DATA.md` §3/§4/§9;
> `REFERENCES.md` "Plugin Architecture — Reuse, Not Replace" + "`PolicyEngine`";
> the `EnforcementEvent` constraint in `@adhd/agent-mcp-types/src/hooks.ts`.

---

## Decision 0 — Inherited topology (cite, do NOT re-decide)

The DB topology is **inherited** from `agent-registry-schema`'s `decisions.md`
(Decision 1, `[inv:one-db-handle]`) and is NOT re-opened here:

- **One shared SQLite file.** `@adhd/agent-policy` owns the `policy_` prefix:
  `policy_policy_types`, `policy_policy_templates`, `policy_agent_policies`.
- **No cross-package SQLite FKs.** A `policy_agent_policies.agent_slug` referencing
  a `registry_agents.slug` is a **plain text column** joined in application SQL —
  never a Drizzle `.references()` FK across prefixes. Same for `inherited_from`
  (a taxonomy category slug owned by `agent-registry`). In-package FKs are normal
  (`policy_policy_templates.type` → `policy_policy_types.slug`).
- **One handle.** `@adhd/agent-compiler` opens exactly one `better-sqlite3` handle
  and reads `policy_*` rows through it. No `ATTACH DATABASE`.

This is the substrate the three decisions below assume. `[ref:budget-plugin]`,
`[ref:hook-registry]`, and `[ref:drizzle-schema]` from `_shared.md` carry over
unchanged.

---

## Decision 1 — Policy inheritance: **LAZY resolution at query time** (NOT eager fanout)

**Question (`DATA_MODEL.md` "Eager vs. lazy policy inheritance").** When a policy is
attached to a taxonomy CATEGORY, every agent in that category — *including agents
added later* — must carry that policy. Do we **fan out** `policy_agent_policies`
rows at category-attach time (eager — fast point-reads, but write amplification and
a re-fanout trigger needed on every new-agent-create and every category move), or do
we resolve the category→agent join **lazily at query time** (always accurate, join
cost paid on read)?

### Binding decision

**Lazy resolution at query time.** Category-level attachments are stored ONCE
against the category (logically: a `policy_agent_policies` row whose
`inherited_from` = the category slug and whose `agent_slug` is resolved from the
category membership at read time, OR an equivalent category-scoped attachment that
the resolver fans into per-agent results on read). The `AgentPolicyStore` exposes a
**resolver method** (`resolveForAgent(agentSlug)` / `listEffectivePolicies`) that:

1. reads policies attached **directly** to the agent (`inherited_from IS NULL`), AND
2. reads policies attached to **any category the agent belongs to**, joining
   category membership at query time, and
3. returns each inherited policy as a **resolved row carrying `inherited_from` =
   the category slug** it cascaded from.

There is **no fanout trigger**. A NEW agent added to a category after the policy was
attached inherits automatically the next time `resolveForAgent` runs — the join
simply sees the new membership. No re-write, no migration, no `agent:mutated` hook
wiring.

### Rationale

- **"A new agent inherits automatically" is the headline requirement** (`GOAL.md`
  "Policy Inheritance"; `_shared.md` `[def:inheritance]`) and the behavioral DoD —
  `inheritance.test.ts` (audit `[dod.1]`) **adds an agent to a category AFTER the
  policy is attached, reopens the DB, and asserts the agent inherited the mandatory
  policy with `inherited_from` set.** Lazy makes that case *trivially correct by
  construction*: the join cannot be stale because there is no materialized copy to
  go stale. Eager would require a re-fanout hook to fire on agent-create — exactly
  the kind of "must remember to re-run the trigger" coupling that produces the
  silent-staleness bug the DoD is written to catch.
- **No write amplification, no re-fanout on category move.** Eager fanout writes
  O(agents × policies) junction rows and must DELETE+re-INSERT them whenever an
  agent changes category or a category's policy set changes. Lazy stores O(direct
  attachments + category attachments) and pays a bounded JOIN on read. The registry
  is small (tens of agents, tens of policies, seeded mostly at build time) and the
  dominant consumer is `@adhd/agent-compiler` doing a **single batch compile**, so
  read-time join cost is negligible and never on a hot per-request path.
- **Correctness over micro-latency.** "Always accurate" (`DATA_MODEL.md`) beats
  "fast but needs careful cache invalidation" for a config/governance store whose
  wrong answer is a *missing safety/permission policy on an agent* — a correctness,
  not performance, failure.

### `inherited_from` invariant (holds either way, REQUIRED)

Independent of lazy vs. eager, **every resolved row for an inherited policy MUST
carry `inherited_from` = the category slug**, and a directly-attached policy MUST
carry `inherited_from = NULL`. This is observable in `[dod.1]` and is the field the
compiler uses to label a permission/rule as "inherited from category X" vs. "set on
the agent." `is_mandatory` is carried through the resolution unchanged (a mandatory
category policy stays mandatory on every inheriting agent).

### Downstream implications

- **Schema (`policy-type-and-template-schema`, `agent-policy-junction`).** No
  materialized per-agent fanout table is added. The `policy_agent_policies` schema
  carries `inherited_from TEXT` (nullable, plain text — the logical category-slug
  link, no cross-prefix FK per Decision 0).
- **`AgentPolicyStore` (`agent-policy-junction` / `policy-inheritance`).** Ships the
  query-time **resolver** as its primary read path; there is no fanout writer and no
  `agent:mutated`/`agent:create` re-fanout hook to register.
- **`inheritance.test.ts`** asserts the lazy contract: attach to category → add a
  new agent later → reopen → resolver returns the inherited mandatory policy with
  `inherited_from` set. (`[inv:reopen-proves-persistence]`.)

---

## Decision 2 — `EnforcementEvent` stays **`"pre:model_request"`-only**; non-`pre:model_request` `hook` policies seed **observational-only** (no agent-mcp-types amendment)

**Question (`[inv:enforcement-event-pre-model-only]`).** `@adhd/agent-mcp-types`
(`src/hooks.ts`) types `EnforcementEvent` as the single literal
`"pre:model_request"` — the ONLY event `IHookRegistry.registerEnforcement()` /
`.enforce()` accept (throws-propagate). Some seeded policies declare `hook`
enforcement at a *different* point: `sox-audit-trail` (`SEED_DATA.md` §9) has
`enforcement: ["hook"]` with `rules.hook_event: "TOOL_CALL"` and
`rules.hook_type: "observational"`. For each such policy, is its required point
`pre:model_request` (enforceable now) or something else — and if something else, do
we (a) seed it observational-only, or (b) raise a planner-class amendment to extend
`EnforcementEvent` in `@adhd/agent-mcp-types`?

### Binding decision

**Do NOT extend `EnforcementEvent`. Seed non-`pre:model_request` `hook` policies as
OBSERVATIONAL-only.**

- The enforcement plugin this plan ships (`enforcement-plugin`, `[ref:budget-plugin]`)
  registers its **blocking** handler ONLY via
  `hooks.registerEnforcement("pre:model_request", …)` — used for the `rate`-type
  budget/limit policy (the one whose throw must propagate through the REAL
  `HookRegistry.enforce("pre:model_request", …)`, audit `[dod.2]`).
- Any seeded policy whose `enforcement` array includes `hook` AND whose intended
  point is **not** `pre:model_request` (concretely `sox-audit-trail`'s `TOOL_CALL`,
  already flagged `hook_type: "observational"`) is registered via the
  **observational** `hooks.register("pre:tool_call"/"post:tool_call", …)` path
  (throws swallowed and logged), NOT `registerEnforcement`. It logs/audits; it does
  NOT block. This matches its own `hook_type: "observational"` declaration, so no
  semantics are lost.

We do **not** open a cross-package `agent-mcp-types` change in this plan because
no *currently seeded* policy needs a **blocking** enforcement point other than
`pre:model_request`. Extending `EnforcementEvent` would add a cross-package state to
the DAG (a real edit to `@adhd/agent-mcp-types/src/hooks.ts` + `registry.ts` + every
consumer's type-check) for zero current behavioral gain.

### Forcing function (the trigger that REVERSES this decision)

This deferral is explicit and gated. **The first seeded policy that requires
*blocking* (throws-propagate) enforcement at a point other than `pre:model_request`
forces a planner-class amendment** to extend `EnforcementEvent` in
`@adhd/agent-mcp-types`. Concretely, the trigger is:

> a `policy_templates` row whose `enforcement` array includes `hook`, whose
> `rules.hook_event` is **not** `pre:model_request` (e.g. `pre:tool_call` for a
> `scope`/`read-only` permission policy gating tool use, or `post:tool_call`), AND
> whose `rules.hook_type` is **`enforcement`** (not `observational`).

Until such a row exists, the plan is sound with `EnforcementEvent =
"pre:model_request"`. When one is introduced, the amendment is: add the new literal
to `EnforcementEvent` in `@adhd/agent-mcp-types/src/hooks.ts`, ensure
`HookRegistry.enforce`/`registerEnforcement` accept it (the `registry.ts`
implementation is already generic over `EnforcementEvent`, so this is a type-surface
change plus the orchestrator calling `enforce()` at the new point), and re-run the
enforcement test against the new event. That is a cross-package change escalated to
the requester, **never silently assumed** here. `policy-design.3` greps this file
for `EnforcementEvent` / `pre:model_request` so this coupling cannot be dropped.

### Downstream implications

- **`enforcement-plugin`.** Exactly one `registerEnforcement("pre:model_request",
  …)` (the `rate`/budget throw, `[dod.2]`); all other `hook` policies use
  observational `register(...)`. No `EnforcementEvent` import beyond the single
  literal.
- **Seed (`policy-type-and-template-schema`).** `sox-audit-trail` is seeded with its
  `hook_type: "observational"` rules JSON intact and round-trips (`[inv:enforcement-is-array]`,
  `[dod.3]`); it is documented as observational-only, not as a blocking enforcement
  hook.
- **DAG unchanged.** No new cross-package state is added; `agent-mcp-types` is not
  modified by this plan. (Extending the runtime `PolicyEngine` to read limits from
  the policy store remains `agent-mcp-refactor`'s job per `README.md` Non-goals.)

---

## Decision 3 — Override-config merge semantics: **shallow merge at the top level of `rules`** (override keys replace template keys)

**Question.** A per-agent `policy_agent_policies.override_config` (JSON) customizes
the template's `rules` (e.g. a specific `max_rework` overriding `max-rework-3`'s
`max_rework: 3`). Does it compose by **shallow merge**, **deep merge**, or **replace**?

### Binding decision

**Shallow merge at the top level of the `rules` object.** The effective rules an
enforcement reader (the plugin, the runtime `PolicyEngine`, the compiler) sees are:

```
effectiveRules = { ...template.rules, ...overrideConfig }
```

- Keys present in `override_config` **replace** the same top-level key in
  `template.rules`. Keys absent from `override_config` fall through to the template.
- The merge is **one level deep only** (`Object.assign` / object-spread semantics):
  a top-level key whose value is itself an object/array is replaced **wholesale**,
  not recursively merged. `override_config = {}` (or `NULL`) means "use the template
  unchanged."

This is the single function `resolveEffectiveRules(template.rules, override_config)`
that the `AgentPolicyStore` exposes and the `enforcement-plugin` calls to read the
EFFECTIVE limit.

### Rationale

- **Predictability over cleverness.** Deep merge has notoriously ambiguous semantics
  for arrays (concatenate? replace? merge-by-index?) and nested objects, which makes
  "what is the effective `max_rework`?" hard to reason about and audit. The seeded
  override use case (`allowed-delegation` says *"Populate per-agent via
  `override_config`"*; `max-rework-3` overriding `max_rework`) is a flat scalar /
  whole-array swap — shallow merge expresses it exactly.
- **Arrays are replaced, which is what governance wants.** An override that narrows
  `read-only`'s `disallow_tools` or replaces `allowed-delegation`'s `allowlist`
  means "use THIS list," not "append to the template's list." Shallow replace gives
  that; deep merge would silently union and could *widen* a safety/permission list —
  a security-relevant footgun. Shallow merge is the safer default for a policy store.
- **Cheap and stateless.** No recursion, no merge library, trivially testable, and
  deterministic — the effective value is a pure function of two JSON objects.

### Downstream implications

- **`agent-policy-junction` / `policy-inheritance`.** `AgentPolicyStore` ships
  `resolveEffectiveRules(templateRules, overrideConfig)` (top-level spread). The
  resolved-policy shape the compiler/plugin consume carries `effectiveRules`, not
  raw template rules, when an override is present.
- **`enforcement-plugin` (`[dod.2]`).** Reads the EFFECTIVE limit via this function:
  e.g. a `rate` policy with `override_config = { "max_rework": 1 }` over a template
  `{ "max_rework": 3, … }` yields effective `max_rework: 1` (and the test can assert
  the override-tightened limit throws where the template limit would not).
- **Schema.** `override_config` is a nullable `text({ mode: "json" })` column on
  `policy_agent_policies`; `NULL`/absent ⇒ template rules used verbatim.

---

## Summary of bindings

| # | Open question | Decision |
| :- | :------------- | :-------- |
| 0 | DB topology | **Inherited** (one shared file, `policy_` prefix, no cross-prefix FK) — cite `agent-registry-schema/decisions.md`, do not re-decide |
| 1 | Eager vs. lazy policy **inheritance resolution** | **Lazy** — resolve category→agent join at query time; no fanout, no re-fanout trigger; resolved row carries `inherited_from` = category slug |
| 2 | `EnforcementEvent` extension | **Keep `pre:model_request`-only**; seed non-`pre:model_request` `hook` policies observational-only; forcing function = first **blocking** `hook` policy at another point ⇒ planner-class amendment to `@adhd/agent-mcp-types` |
| 3 | `override_config` merge semantics | **Shallow merge** at top level of `rules` (override keys replace; arrays/nested objects replaced wholesale; empty/NULL ⇒ template unchanged) |

These are frozen for the remainder of the `agent-policy` plan.
