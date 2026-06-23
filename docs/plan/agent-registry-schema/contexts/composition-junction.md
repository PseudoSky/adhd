# composition-junction — AGENT_COMPONENTS JUNCTION + resolveComposition

**Phase:** composition · **Kind:** work · **Depends on:** agent-and-taxonomy-schema · **Guard:** `npx --yes nx test agent-registry --testFile=packages/ai/agent-registry/src/__tests__/composition-store.test.ts`

---

## Goal

The `agent_components` junction exists and `CompositionStore.resolveComposition`
returns an agent's components in assembly order, with `version_pin` and
`context_condition` honored. This is the heart of the registry — it proves a
prompt can be reconstructed from rows.

---

## Semantic Distillation

- **Primitive:** ADD `agent_components` junction + `CompositionStore`. See
  `[def:junction-row]`, `[def:context-condition]`, `[def:composition]`.
- **Delta Spec** (`DATA_MODEL.md` Domain 1 "Agent-Component Junction"):
  - `agent_components` — `agent_slug` (FK), `component_slug` (FK), integer
    `position` (assembly order), `version_pin` (nullable integer — null = latest,
    int = pin to that version), `context_condition` (nullable JSON text), and
    `is_required` integer flag. PK `(agent_slug, component_slug, position)`.
  - `CompositionStore.resolveComposition(agentSlug, context)` →
    ordered component list:
    1. read all junction rows for the agent ordered by `position`;
    2. for each, pick the pinned version (or latest if `version_pin` null) from
       `prompt_components`;
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

- [composition-junction.1] agent_components junction with position, version_pin, context_condition, is_required
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
