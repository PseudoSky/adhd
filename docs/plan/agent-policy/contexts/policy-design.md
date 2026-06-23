# policy-design — RESOLVE INHERITANCE + ENFORCEMENT-EVENT DECISIONS

**Phase:** architecture · **Kind:** work · **Depends on:** none · **Guard:** `python3 docs/plan/agent-policy/scripts/audit_policy.py --phase architecture`

---

## Goal

The open design questions for `@adhd/agent-policy` are RESOLVED and recorded in
`decisions.md` before any table is frozen: (1) eager vs. lazy policy inheritance,
(2) whether/how to extend `EnforcementEvent` beyond `pre:model_request`, and
(3) override-config merge semantics. After this state every later state has a
binding answer, so the schema and the enforcement plugin do not get redesigned
mid-build.

This state exists FIRST because `DATA_MODEL.md` Domain 3 is explicitly a
requirements doc, not a schema, and because the enforcement design collides with
a hard constraint in `@adhd/agent-mcp-types` that must be acknowledged up front.

---

## Semantic Distillation

- **Primitive:** WRITE `decisions.md` — the architecture decision record. No code.
- **Reference Pattern:** `[ref:budget-plugin]`, `[ref:hook-registry]`,
  `[inv:enforcement-event-pre-model-only]`, `[inv:lookup-not-enum]`.
- **Delta Spec — `decisions.md` must answer, each with a rationale:**
  1. **Eager vs. lazy policy inheritance** (`DATA_MODEL.md` "Eager vs. lazy policy
     inheritance"): fan out `agent_policy` rows at category-attach time (eager —
     fast queries, write amplification, must re-fanout when an agent's category
     changes or a new agent joins) vs. resolve the category→agent join at query
     time (lazy — always accurate, join cost). PICK ONE deterministically and
     state it; whichever you pick, the resolved row for an inherited policy MUST
     carry `inherited_from` = the category slug so `[dod.1]` is observable.
     RECOMMENDATION to evaluate: **lazy resolve at query time** keeps "a new agent
     added later inherits automatically" trivially correct without a re-fanout
     trigger — but if eager is chosen, record the fanout hook (on agent-create and
     on category-attach) so a NEW member still inherits.
  2. **`EnforcementEvent` extension** — `[inv:enforcement-event-pre-model-only]`:
     `@adhd/agent-mcp-types` types `EnforcementEvent` as ONLY `"pre:model_request"`.
     Decide, for each seeded policy with `hook` enforcement, whether its required
     point is `pre:model_request` (enforceable now) or something else
     (`sox-audit-trail`'s `rules.hook_event` is `TOOL_CALL`). For non-`pre:model_request`
     hook policies, choose EITHER: seed as observational-only (`register`, not
     `registerEnforcement`) OR raise a planner-class amendment to extend
     `EnforcementEvent` in `@adhd/agent-mcp-types` (a real cross-package change).
     Record the choice AND the forcing function (see README "Non-goals").
  3. **Override-config merge semantics** — how a per-agent `override_config` (e.g.
     a specific `max_rework`) composes with the template `rules` (shallow merge /
     deep merge / replace). The `enforcement-plugin` reads the EFFECTIVE limit, so
     this must be pinned here.
- Escalate to the requester (planner-class amendment) if a decision changes the
  DAG — e.g. choosing to extend `EnforcementEvent` adds a cross-package state.

---

## Acceptance criteria

- [policy-design.1] decisions.md exists
- [policy-design.2] eager-vs-lazy inheritance decision recorded
- [policy-design.3] EnforcementEvent pre:model_request limitation + extension forcing-function recorded

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-policy/decisions.md", "docs/plan/agent-policy/contexts/policy-design.md"]
```

---

## Commit points

- After writing `decisions.md`: `docs(agent-policy): record policy architecture decisions`.
- Post-guard mandatory commit recorded by `state-transition.js --complete`.

## Notes for executor

- This is a judgment state. Read `DATA_MODEL.md` "Cross-Domain Design Decisions
  (Open)" and `REFERENCES.md` "Plugin Architecture" + "`PolicyEngine`" in full,
  and read `@adhd/agent-mcp-types/src/hooks.ts` so the `EnforcementEvent`
  constraint is concrete. Have `architect-reviewer` sign off on `decisions.md`
  before advancing (README Execution model assigns it as reviewer here).
- The DB topology (single shared file, `policy_*` prefix) is INHERITED from
  `agent-registry-schema`'s `decisions.md` — cite it, don't re-decide it.
- `policy-design.2` greps `decisions.md` for `eager|lazy|fanout|inheritance
  resolution`; `policy-design.3` greps for `EnforcementEvent|pre:model_request`.
  The prose must literally contain those tokens so the coupling cannot be
  silently dropped.
