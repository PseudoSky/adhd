# skills-migration — IMPORT A FIXTURE SKILL.md → process/invocation COMPONENT

**Phase:** import · **Kind:** work · **Depends on:** import-pipeline · **Guard:** `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/skills-migration.test.ts`

---

## Goal

An `importSkill(db, skillPath)` function migrates a `.claude/skills/*/SKILL.md`
file into a `PROMPT_COMPONENT` of type `process` or `invocation` (SCOPE.md
"Skills", REFERENCES.md "Skills"), preserving the skill body content and lifting
the skill's invocation trigger / cost class into component (or use-case) metadata.
The test proves the component persists by REOPEN. Proves `[dod.3]`.

---

## Semantic Distillation

- **Primitive:** ADD `src/import/import-skill.ts` + `skills-migration.test.ts`.
- **Reference Pattern:** `[fix:store-usage]`, `[inv:reopen-proves-persistence]`.
  SCOPE.md "Skills and Non-Code Plugins"; REFERENCES.md "Skills".
- **Delta Spec:**
  - `importSkill(db, skillPath)`:
    1. Parse the `SKILL.md` frontmatter (`name`, `description`, trigger/cost-class
       metadata if present) + body (reuse `parseFrontmatter`/`splitBody`).
    2. Insert ONE `PROMPT_COMPONENT` typed `process` (workflow-shaped skills) or
       `invocation` (activation-card-shaped skills) — choose by the same heading /
       shape heuristics as `[fix:body-mapping]`; default `process` for a runbook-
       style skill like `ticket-creation`.
    3. Body content preserved verbatim in `content`; trigger/cost-class → component
       (or `use_case`) metadata.
    4. Return the inserted component slug + type.
  - `skills-migration.test.ts` — case `"skill migrates to process/invocation
    component after reopen"`: on-disk DB, `importSkill` the
    `ticket-creation.SKILL.md` fixture, CLOSE + REOPEN, read the component back and
    assert its `type ∈ {process, invocation}` and that its `content` contains the
    skill body (e.g. the "Pre-creation checklist" text).

---

## Acceptance criteria

- [skills-migration.1] skill imports to process/invocation component recoverable after reopen
- [skills-migration.2] skill body typed as process/invocation component

---

## Reservations

```text
read_only:  ["packages/ai/agent-registry-migration/src/parse/frontmatter.ts", "packages/ai/agent-registry-migration/src/parse/body-sections.ts", "packages/ai/agent-registry-migration/src/__fixtures__/ticket-creation.SKILL.md"]
mutates:    ["packages/ai/agent-registry-migration/src/import/import-skill.ts", "packages/ai/agent-registry-migration/src/index.ts", "packages/ai/agent-registry-migration/src/__tests__/skills-migration.test.ts"]
```

---

## Commit points

- `feat(agent-registry-migration): migrate SKILL.md into a process/invocation component`

## Notes for executor

- `[dod.3]` negative control: writing the WRONG `prompt_type` (e.g. `role`) must
  fail the type assertion and turn this test RED. Confirm it bites.
- Skills are reusable behaviors shared by N agents — favor a SHARED component
  (dedup by content hash) so the skill is authored once (SEED_DATA §0 step 5).
- Gate on the vitest EXIT CODE.
