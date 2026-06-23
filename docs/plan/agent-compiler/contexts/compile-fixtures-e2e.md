# compile-fixtures-e2e — SEED A REAL AGENT, COMPILE END-TO-END

**Phase:** e2e · **Kind:** work · **Depends on:** audit-engine · **Guard:** `npx --yes nx test agent-compiler --testFile=packages/ai/agent-compiler/src/__tests__/compile-e2e.test.ts`

---

## Goal

A REAL agent (the `USAGE.md` / `SEED_DATA.md` §14 `api-design-reviewer`-style
fixture) is seeded from shared components + tool grants + a model hint + an
attached policy across all four DB prefixes, and `compileAgent` is driven
end-to-end across TWO platforms (`claude_code`, `claude_api`) and TWO contexts
(default + `{ticket_type:security}`). This is the convergence proof — it carries
the headline `[dod.1]` plus `[dod.2]` (context-conditional) and `[dod.3]` (policy
constraint) through real rows, exactly as the team-lead called out.

---

## Semantic Distillation

- **Primitive:** ADD `seed/fixtures.ts` (`seedFixtureAgent(db)`) and
  `compile-e2e.test.ts`.
- **Reference Pattern:** `[inv:real-rows-not-mocks]`, `[def:tools-header]`,
  `[def:junction-order]`, `[def:policy-constraint]`,
  `[inv:platform-shaped-observable]`, `[up:registry]`/`[up:tools]`/`[up:provider]`/
  `[up:policy]`.
- **Delta Spec:**
  - `seedFixtureAgent`: seed an agent with ordered components including TWO
    `success_criteria` components conditioned on `{ticket_type:"review"}` vs.
    `{ticket_type:"security"}`; tool grants (`file_read`,`file_grep`,`web_search`);
    `model_hint:claude_sonnet_4_6`; an attached `no-credentials` policy. Uses the
    upstream packages' seed/store APIs against ONE shared DB (`[inv:one-db-handle]`).
  - Test (`compile-e2e.test.ts`), one suite covering the three behavioral clauses:
    - **[dod.1]** `compileAgent(...,'claude_code')` → frontmatter `tools:` equals the
      `claude_code` aliases; body sections in junction `position` order.
    - **[dod.2]** same agent, context `{ticket_type:security}` → body has the
      security criteria text, NOT the general; default/empty context → the inverse.
    - **[dod.3]** the `no-credentials` constraint text appears in the compiled output;
      with the attachment removed it is absent.
    - **claude_api** → `JSON.parse` yields `{systemPrompt, tools}` (proves both
      `header_format`s emit from the SAME rows).

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [compile-fixtures-e2e.1] seeds a real agent from shared components across four domains

- [compile-fixtures-e2e.2] e2e: compile across two platforms + two contexts from real rows
---

## Reservations

```text
read_only:  ["packages/ai/agent-compiler/src/compile.ts", "packages/ai/agent-compiler/src/cli/compile.ts"]
mutates:    ["packages/ai/agent-compiler/src/seed/fixtures.ts", "packages/ai/agent-compiler/src/__tests__/compile-e2e.test.ts", "packages/ai/agent-compiler/src/index.ts"]
```

---

## Commit points

- `test(agent-compiler): e2e compile of a real seeded agent across platforms+contexts`

## Notes for executor

- This is the plan's headline proof. Every assertion keys on a platform-shaped,
  consumer-visible property (`[inv:platform-shaped-observable]`), driven through the
  REAL `compileAgent` against REAL rows in all four prefixes
  (`[inv:real-rows-not-mocks]`). No mocks under test.
- The negative controls for `[dod.1]`/`[dod.2]`/`[dod.3]` live in the resolve
  layers (ordering, context filter, policy read); confirm each bites (revert →
  red) before declaring done (CLAUDE.md verification standard #2).
- Gate on the runner EXIT CODE (better-sqlite3 teardown segfault risk).
