# usecase-and-context-rules — USE_CASES + COMPONENT_USAGE + CONTEXT_RULES

**Phase:** composition · **Kind:** work · **Depends on:** composition-junction · **Guard:** `npx --yes nx test agent-registry --testFile=packages/ai/agent-registry/src/__tests__/usecase-store.test.ts`

---

## Goal

The annotation + free-standing-rule tables exist: `use_cases`,
`component_usage`, and `context_rules`. These are the seed data for the future
suggestion engine and the agent-level conditional-inclusion layer.

---

## Semantic Distillation

- **Primitive:** ADD `use_cases`, `component_usage`, `context_rules` + `UseCaseStore`.
- **Delta Spec** (`DATA_MODEL.md` Domain 1 "Use Cases and Component Usage",
  "Context Rules"):
  - `use_cases` — `slug` PK, `name`, `description` (e.g. `code-review`,
    `security-audit`, `data-migration`).
  - `component_usage` — junction `(component_slug, use_case_slug, weight?)`;
    records which components are valuable in which scenarios. Annotation only —
    does NOT affect runtime composition.
  - `context_rules` — `(agent_slug, condition JSON, component_slug)`: "for agent
    X, when condition Y, additionally include component Z." Per `decisions.md`,
    EITHER a distinct table OR unified with junction `context_condition` — follow
    the recorded decision. If unified, this state instead documents the unified
    path and adds only `use_cases` + `component_usage`.
  - `UseCaseStore`: `createUseCase`, `linkComponent(component, useCase, weight)`,
    `componentsFor(useCase)`, `addContextRule`, `contextRulesFor(agent)`.
  - Tests: link a component to a use case with weight; reopen; query back.

---

## Acceptance criteria

- [usecase-and-context-rules.1] use_cases + component_usage + context_rules tables
- [usecase-and-context-rules.2] usecase-store test passes

---

## Reservations

```text
read_only:  ["packages/ai/agent-registry/src/store/composition-store.ts"]
mutates:    ["packages/ai/agent-registry/src/db/schema.ts", "packages/ai/agent-registry/src/store/usecase-store.ts", "packages/ai/agent-registry/src/index.ts", "packages/ai/agent-registry/src/__tests__/usecase-store.test.ts", "packages/ai/agent-registry/drizzle"]
```

---

## Commit points

- `feat(agent-registry): use_cases, component_usage, context_rules and UseCaseStore`

## Notes for executor

- `component_usage` is annotation only — keep it out of `resolveComposition`'s
  hot path (it informs the future suggestion engine, GOAL.md "Knowledge Graph").
- If `decisions.md` unified `context_rules` into the junction, do NOT create a
  duplicate table — the grep criterion accepts either `context_rules` present in
  schema OR a documented unification; adjust the criterion via an executor-class
  amendment if you take the unified path.
