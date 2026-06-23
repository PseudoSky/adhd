# body-section-splitter — SPLIT MARKDOWN BODY → TYPED PROMPT_COMPONENT ROWS

**Phase:** parse · **Kind:** work · **Depends on:** frontmatter-parser · **Guard:** `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/body-sections.test.ts`

---

## Goal

A `splitBody(body)` function walks the markdown body, splits on `##` headings, and
classifies each section into a typed component candidate `{ type, content,
position }` using the SEED_DATA §0 heading → `prompt_type` table — including the
un-headed opening `You are a…` paragraph → `role`. Tested against the real
`code-reviewer.md` fixture body.

---

## Semantic Distillation

- **Primitive:** ADD `src/parse/body-sections.ts` + `body-sections.test.ts`.
  Contributes to `[dod.2]` (the typed components the importer persists).
- **Reference Pattern:** `[fix:body-mapping]`. SEED_DATA §0 "Body → prompt
  components" + step 4.
- **Delta Spec:**
  - Parse the body with a markdown AST parser (remark/unified); split at `##`
    headings.
  - The leading text before the first heading (`You are a…`) → one `role`
    component at position 1.
  - Each `##` section → a component whose `type` is the heading-pattern match:
    `## Identity`/`## Mission` → `identity`; `## Capabilities`/`## Expertise` →
    `capability`; `## Rules`/`## Constraints`/`## Never`/`## Always` → `rule`;
    `## Style`/`## Format`/`## Output` → `style`; `## Process`/`## Workflow`/`##
    Steps` → `process`; `## Invocation`/`## When to use`/`## Trigger` →
    `invocation`; `## Success Criteria`/`## Done When`/`## Acceptance` →
    `success_criteria`; `## Handoff`/`## After Completing` → `handoff`;
    `## Escalation` → `escalation`; `## Deliverable`/`## Output Format` →
    `deliverable`; `## Boundaries`/`## What I Will Not Do` → `boundary`.
  - `position` = order of appearance (1-indexed). `context_condition = null`,
    `version = 1` are defaults applied at import (next state).
  - An unrecognized heading → a documented fallback type (record the choice in
    `decisions.md`); never crash, never drop content.
  - `body-sections.test.ts` — split the `code-reviewer.md` body and assert the
    opening paragraph types as `role` at position 1, and that a known heading
    (e.g. the security/review section) types per the table, in order.

---

## Acceptance criteria

- [body-section-splitter.1] body section typing test passes
- [body-section-splitter.2] heading->prompt_type mapping per SEED_DATA table

---

## Reservations

```text
read_only:  ["packages/ai/agent-registry-migration/src/__fixtures__/code-reviewer.md", "packages/ai/agent-registry-migration/src/parse/frontmatter.ts"]
mutates:    ["packages/ai/agent-registry-migration/src/parse/body-sections.ts", "packages/ai/agent-registry-migration/src/index.ts", "packages/ai/agent-registry-migration/src/__tests__/body-sections.test.ts"]
```

---

## Commit points

- `feat(agent-registry-migration): split markdown body into typed prompt components`

## Notes for executor

- Heading classification is the most lossy step in the corpus (a mis-typed
  heading is a silent content move). The round-trip gate (`[dod.1]`) is what
  catches it — but bias toward the documented table and flag ambiguous headings.
- Preserve exact section content (including code fences + list formatting) so the
  round-trip diff can be empty.
