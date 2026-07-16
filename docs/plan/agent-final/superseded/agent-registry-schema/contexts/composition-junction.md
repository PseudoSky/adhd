# composition-junction — AGENT_COMPONENTS JUNCTION + resolveComposition

**Phase:** composition · **Kind:** work · **Depends on:** agent-and-taxonomy-schema · **Guard:** `npx --yes nx test agent-registry --testFile=packages/ai/agent-registry/src/__tests__/composition-store.test.ts`

---

## Goal

The `agent_components` junction exists and `CompositionStore.resolveComposition`
returns an agent's components in assembly order, with `version_pin` and
`context_condition` honored. This is the heart of the registry — it proves a
prompt can be reconstructed from rows.

> **Post-execution architecture correction (Decision 5, decisions.md).** After this
> state executed, the component model was split into `registry_components` (head) +
> `registry_component_versions` (history). The junction's `component_slug` and
> `version_pin` are now **DB-enforced** FKs (component_slug → `registry_components.slug`;
> version_pin → `registry_component_versions.version_id`), not logical-only refs.
> `version_pin` now stores a `version_id`. `resolveComposition` semantics (order, pin,
> context filter, is_required) are unchanged. state.json/dag.json are NOT changed.

---

## Semantic Distillation

- **Primitive:** ADD `agent_components` junction + `CompositionStore`. See
  `[def:junction-row]`, `[def:context-condition]`, `[def:composition]`.
- **Delta Spec** (`DATA_MODEL.md` Domain 1 "Agent-Component Junction"; FKs per
  Decision 5):
  - `agent_components` — `agent_slug` (enforced FK → `registry_agents.slug`),
    `component_slug` (enforced FK → `registry_components.slug`, Decision 5), integer
    `position` (assembly order), `version_pin` (nullable integer — a
    `registry_component_versions.version_id`, enforced nullable FK; null = latest,
    set = pin to that exact version row), `context_condition` (nullable JSON text),
    and `is_required` integer flag. PK `(agent_slug, component_slug, position)`.
    Two SEPARATE FKs are used for component_slug + version_pin (a composite FK with a
    nullable column is not enforced in SQLite) — see Decision 5.
  - `CompositionStore.resolveComposition(agentSlug, context)` →
    ordered component list:
    1. read all junction rows for the agent ordered by `position`;
    2. for each, pick the pinned version by its `version_id` (asserting the version
       row's `slug` matches the junction's `component_slug`), or the latest version
       for the slug if `version_pin` is null, joining `registry_components` to
       `registry_component_versions`;
    3. EVALUATE `context_condition` against the supplied `context` using the
       deterministic rule recorded in `decisions.md` (precedence when two rows
       target the same position) — exclude non-matching rows;
    4. if a row is `is_required` and excluded by its condition → throw a
       composition error (per `DATA_MODEL.md`).
  - Tests (`composition-store.test.ts`): one test that proves ALL THREE — order
    by position, pinned version returned, unmatched-context row excluded — and a
    test that `is_required` + unmatched throws. Reopen the DB first.

---

## Acceptance criteria

- [composition-junction.1] agent_components junction with position, version_pin (enforced FK → registry_component_versions.version_id), context_condition, is_required; component_slug enforced FK → registry_components.slug (Decision 5)
- [composition-junction.2] resolveComposition reads ordered components
- [composition-junction.3] composition ordering/pin/context test passes

---

## Reservations

```text
read_only:  ["packages/ai/agent-registry/src/store/agent-store.ts", "packages/ai/agent-registry/src/store/component-store.ts"]
mutates:    ["packages/ai/agent-registry/src/db/schema.ts", "packages/ai/agent-registry/src/store/composition-store.ts", "packages/ai/agent-registry/src/index.ts", "packages/ai/agent-registry/src/__tests__/composition-store.test.ts", "packages/ai/agent-registry/drizzle"]
```

---

## Commit points

- `feat(agent-registry): agent_components junction and CompositionStore.resolveComposition`

## Notes for executor

- The actual MARKDOWN assembly (joining content into a flat prompt + emitting a
  platform header) is `@adhd/agent-compiler`'s job, NOT this state — here you
  return the ORDERED, FILTERED component list, not a rendered prompt.
- The context-condition evaluator must match `decisions.md` exactly. If the rule
  is under-specified there, escalate (planner-class amendment), don't invent.
- Proves `[dod.2]`. The negative-control in README dod.2 removes the order/filter
  — keep `resolveComposition` the single place those happen so the control bites.
