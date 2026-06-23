# import-pipeline — END-TO-END IMPORT OF A FIXTURE AGENT → REGISTRY ROWS

**Phase:** import · **Kind:** work · **Depends on:** body-section-splitter · **Guard:** `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/import-pipeline.test.ts`

---

## Goal

An `importAgent(db, mdPath)` function wires the parser + splitter into the REAL
`@adhd/agent-registry` stores: it writes the `AGENT` row, one `PROMPT_COMPONENT`
row per body section (+ the `AGENT_COMPONENT` junction in position order), and the
`AGENT_TOOL` rows. The import-pipeline test proves the rows persist by closing and
REOPENING the DB. Proves `[dod.2]`.

---

## Semantic Distillation

- **Primitive:** ADD `src/import/import-agent.ts` + `import-pipeline.test.ts` —
  the `[def:import]` action for an agent `.md`.
- **Reference Pattern:** `[fix:store-usage]`, `[inv:real-deps-not-mocks]`,
  `[inv:reopen-proves-persistence]`. SEED_DATA §0 steps 5-6.
- **Delta Spec:**
  - `importAgent(db, mdPath)`:
    1. `parseFrontmatter` → `{ slug, description, tools, modelHint, flagged }`.
    2. `splitBody` → typed component candidates with positions.
    3. Write `AGENT` (slug, description, model_hint) via `AgentStore`.
    4. For each component candidate: hash the normalized text (`trim` + collapse
       whitespace); reuse an existing shared `PROMPT_COMPONENT` by hash if present
       else insert a new row (SEED_DATA §0 step 5 dedup) via `ComponentStore`.
    5. Insert `AGENT_COMPONENT` junction rows (`position`, `version_pin = null`,
       `context_condition = null`, `is_required = true`) via `CompositionStore`.
    6. Insert `AGENT_TOOL` rows for the resolved canonical tool ids.
    7. Return an import result including any `flagged` tokens for human review.
  - `import-pipeline.test.ts` — case `"import persists agent+components+tools after
    reopen"`: open an on-disk DB (tmp path), `importAgent` the `code-reviewer.md`
    fixture, CLOSE the handle, REOPEN from the same path, then read back via
    `AgentStore`/`ComponentStore`/`CompositionStore`/`AgentToolStore` and assert
    the agent, its components in position order, and its tools deep-equal the
    expected rows.

---

## Acceptance criteria

- [import-pipeline.1] import persists agent+component+tool rows recoverable after reopen
- [import-pipeline.2] import drives real registry stores (not mocks)

---

## Reservations

```text
read_only:  ["packages/ai/agent-registry-migration/src/parse/frontmatter.ts", "packages/ai/agent-registry-migration/src/parse/body-sections.ts", "packages/ai/agent-registry-migration/src/__fixtures__/code-reviewer.md"]
mutates:    ["packages/ai/agent-registry-migration/src/import/import-agent.ts", "packages/ai/agent-registry-migration/src/index.ts", "packages/ai/agent-registry-migration/src/__tests__/import-pipeline.test.ts"]
```

---

## Commit points

- `feat(agent-registry-migration): end-to-end agent import into the registry`

## Notes for executor

- Drive the REAL registry stores against a REAL on-disk SQLite file
  (`[inv:real-deps-not-mocks]`); prove persistence by REOPEN
  (`[inv:reopen-proves-persistence]`), never in-memory state.
- `[dod.2]` negative control: dropping the component-insert (or skipping the
  `AGENT_COMPONENT` rows) must make the reopened read return incomplete components
  and turn this test RED. Confirm it bites before declaring done.
- Gate on the vitest EXIT CODE (better-sqlite3 teardown segfault risk).
