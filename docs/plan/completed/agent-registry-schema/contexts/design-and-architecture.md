# design-and-architecture — STATE_NAME

**Phase:** architecture · **Kind:** work · **Depends on:** none · **Guard:** `python3 docs/plan/agent-registry-schema/scripts/audit_registry_schema.py --phase architecture`

---

## Goal

The four open cross-domain design questions from `DATA_MODEL.md` are RESOLVED and
recorded in `decisions.md` before any table is frozen. After this state, every
later state has a binding answer for DB topology, context-condition evaluation
semantics, junction-vs-context_rules unification, and version-pin semantics —
so the schema does not get redesigned mid-build.

This state exists FIRST because `DATA_MODEL.md` is explicitly a requirements
doc, not a schema. The team-lead mandate requires an architecture pass, not an
assumption that the data model is final.

---

## Semantic Distillation

- **Primitive:** WRITE `decisions.md` — the architecture decision record for this
  package. No code yet.
- **Reference Pattern:** `[ref:drizzle-schema]`. The DB topology decision
  constrains how `@adhd/agent-compiler` will join across the four registry
  packages — coordinate with the `agent-compiler` plan's `cross-package-join`
  assumption (it assumes whatever this state decides).
- **Delta Spec — `decisions.md` must answer, each with a rationale:**
  1. **DB topology** (`DATA_MODEL.md` "DB topology"): one shared SQLite file with
     table-name prefixes vs. separate files via `ATTACH DATABASE` vs. in-process
     API. RECOMMENDATION to evaluate: single file, table-name prefixed per package
     (`registry_*`, `tool_*`, `provider_*`, `policy_*`) — simplest compile-time
     joins; record the trade-off. This is the decision the other 3 schema plans
     and the compiler depend on, so it must be made here and cited.
  2. **Context-condition evaluation semantics** (`DATA_MODEL.md` "Context condition
     evaluation"): when multiple components target the same `position` with
     different conditions and >1 matches — all included / last-wins / error? Pick
     one deterministic rule (avoids non-deterministic assembly) and state it.
  3. **Junction `context_condition` vs. free-standing `context_rules`** — unify or
     keep both. `DATA_MODEL.md` flags them as "the same underlying need."
  4. **Component version-pin semantics** consistent across junction rows, policy
     references, and experiments.
- Escalate to the requester (planner-class amendment) if a decision changes the
  DAG (e.g. choosing separate DB files would change `agent-compiler`'s join state).

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [design-and-architecture.1] decisions.md records the resolved topology + context-eval semantics

- [design-and-architecture.2] DB topology decision recorded
- [design-and-architecture.3] context-condition evaluation precedence recorded
---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-registry-schema/decisions.md", "docs/plan/agent-registry-schema/contexts/design-and-architecture.md"]
```

---

## Commit points

- After writing `decisions.md`: `docs(agent-registry-schema): record architecture decisions`.
- Post-guard mandatory commit recorded by `state-transition.js --complete`.

## Notes for executor

- This is a judgment state. Read `DATA_MODEL.md` "Cross-Domain Design Decisions
  (Open)" in full. Have `architect-reviewer` sign off on `decisions.md` before
  advancing — the README Execution model assigns it as reviewer here.
- If you pick separate DB files (ATTACH), flag it to the planner: it reshapes the
  `agent-compiler` plan's join strategy (a planner-class amendment).
